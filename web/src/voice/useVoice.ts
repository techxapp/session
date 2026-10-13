import { useCallback, useEffect, useRef, useState } from "react";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { isTopLevel, labelOf } from "../board/executor";
import { CLOUD_STT } from "@board/shared";
import type { SpeechConfig } from "../settings";
// SttMessage: from the speech servers (the Moonshine sidecar or the API server's cloud relay) or the browser's own.
import { browserRecognition, listenInBrowser, type SttMessage } from "./browserSpeech";

export type VoiceState = "off" | "starting" | "listening" | "stopping";

/** Collects mic samples into ~100 ms Float32 frames at the context's own rate (the sidecar resamples). */
const WORKLET = `
class PcmCapture extends AudioWorkletProcessor {
  constructor() { super(); this.size = Math.round(sampleRate / 10); this.buf = new Float32Array(this.size); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.size) { this.port.postMessage(this.buf, [this.buf.buffer]); this.buf = new Float32Array(this.size); this.n = 0; }
    }
    return true;
  }
}
registerProcessor("pcm-capture", PcmCapture);
`;

const MAX_KEYTERMS = 50;

/**
 * Command words always sent as key terms because recognisers often get them wrong. Keep this short: every
 * term takes a slot from the board labels, and a long list costs accuracy on words that aren't in it.
 */
export const COMMAND_KEYTERMS = ["draw", "flower"];

/**
 * Key terms to bias recognition toward: COMMAND_KEYTERMS, then the board labels ("Postgres", "Auth service"),
 * newest kept. Clip-art names are ordinary words, so they're left out.
 */
export function boardKeyterms(elements: readonly ExcalidrawElement[]): string[] {
  const seen = new Set(COMMAND_KEYTERMS.map((t) => t.toLowerCase()));
  const out: string[] = [];
  for (const el of elements) {
    if (!isTopLevel(el) || el.type === "image") continue;
    const label = labelOf(elements, el)?.replace(/,/g, " ").replace(/\s+/g, " ").trim();
    if (label && label.length <= 40 && !seen.has(label.toLowerCase())) {
      seen.add(label.toLowerCase());
      out.push(label);
    }
  }
  // The fixed words go first and the labels' share shrinks to fit, so the server's "newest 50" trim never drops them.
  return [...COMMAND_KEYTERMS, ...out.slice(-(MAX_KEYTERMS - COMMAND_KEYTERMS.length))];
}

/** A finished line worth running: noise can complete a line of only punctuation ("." or "..."). */
export const isCommand = (text: string) => /[\p{L}\p{N}]/u.test(text);

interface Session {
  media?: MediaStream;
  ctx?: AudioContext;
  ws?: WebSocket;
  rec?: ReturnType<typeof listenInBrowser>; // the browser's own recognition, instead of mic + socket
  line?: string; // id of the line being spoken
  terms?: string; // key terms last sent
  error?: string;
  closed: boolean;
}

/** Moonshine runs in its own sidecar; Deepgram and AssemblyAI are relayed by the API server (it holds the .env keys). */
function sttUrl(cloud: boolean) {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${cloud ? "/api/stt" : "/stt"}`;
}

function openSocket(url: string, down: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error(down));
  });
}

function micError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError") return "Microphone access was blocked.";
  if (name === "NotFoundError") return "No microphone found.";
  return err instanceof Error ? err.message : "Couldn't start the microphone.";
}

/**
 * Streams the mic to the speech provider `getSpeech` picks (read on each start). `onFinal` gets each completed
 * spoken line; `getKeyterms` is read when a new line starts, so recognition follows the labels on the board.
 */
export function useVoice(onFinal: (text: string) => void, getKeyterms: () => string[], getSpeech: () => SpeechConfig) {
  const [state, setState] = useState<VoiceState>("off");
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const session = useRef<Session | null>(null);
  const cb = useRef({ onFinal, getKeyterms, getSpeech });
  cb.current = { onFinal, getKeyterms, getSpeech };

  /** Release everything the session holds; safe to call more than once. */
  const end = useCallback((s: Session) => {
    s.closed = true;
    s.rec?.abort();
    s.media?.getTracks().forEach((t) => t.stop());
    if (s.ctx && s.ctx.state !== "closed") void s.ctx.close();
    if (s.ws && s.ws.readyState <= WebSocket.OPEN) s.ws.close();
    if (session.current === s) {
      session.current = null;
      setState("off");
      setInterim("");
    }
  }, []);

  const onMessage = useCallback(
    (s: Session, msg: SttMessage) => {
      if (msg.type === "ready") setState("listening");
      else if (msg.type === "partial") {
        if (msg.id !== s.line) {
          s.line = msg.id;
          const terms = cb.current.getKeyterms();
          if (terms.join("\n") !== s.terms && s.ws?.readyState === WebSocket.OPEN) {
            s.terms = terms.join("\n");
            s.ws.send(JSON.stringify({ type: "keyterms", terms }));
          }
        }
        setInterim(msg.text);
      } else if (msg.type === "final") {
        setInterim("");
        if (isCommand(msg.text)) cb.current.onFinal(msg.text);
      } else if (msg.type === "error") s.error = msg.message;
      else if (msg.type === "stopped") end(s);
    },
    [end],
  );

  const start = useCallback(async () => {
    if (session.current) return;
    const s: Session = { closed: false };
    session.current = s;
    setError(null);
    setState("starting");
    const speech = cb.current.getSpeech();
    if (speech.provider === "browser") {
      const Rec = browserRecognition();
      if (!Rec) {
        setError("This browser has no built-in speech recognition (try Chrome, Edge or Safari, or pick another provider).");
        return end(s);
      }
      // It asks for the mic itself and owns the audio, so no capture or socket here.
      s.rec = listenInBrowser(Rec, {
        message: (m) => onMessage(s, m),
        end: (err) => {
          if (session.current !== s) return;
          if (err) setError(err);
          end(s);
        },
      });
      return;
    }
    try {
      s.media = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (s.closed) return end(s); // stopped while the permission prompt was open
      s.ctx = new AudioContext();
      const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
      await s.ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const node = new AudioWorkletNode(s.ctx, "pcm-capture");
      s.ctx.createMediaStreamSource(s.media).connect(node);
      node.connect(s.ctx.destination); // outputs silence; an unconnected node may never be run
      // Keep what is said while the socket connects: people start talking as soon as they click.
      const early: Float32Array[] = [];
      node.port.onmessage = (e) => early.push(e.data);
      const cloud = CLOUD_STT.includes(speech.provider);
      const ws = await openSocket(
        sttUrl(cloud),
        cloud ? "The API server isn't reachable." : "Speech server isn't running (start stt/server.py).",
      );
      s.ws = ws;
      if (s.closed) return end(s);
      const terms = cb.current.getKeyterms();
      s.terms = terms.join("\n");
      const which = cloud ? { provider: speech.provider, apiKey: speech.apiKey } : {};
      ws.send(JSON.stringify({ type: "start", sampleRate: s.ctx.sampleRate, keyterms: terms, ...which }));
      early.forEach((frame) => ws.send(frame));
      node.port.onmessage = (e) => ws.readyState === WebSocket.OPEN && ws.send(e.data);
      ws.onmessage = (e) => onMessage(s, JSON.parse(e.data) as SttMessage);
      ws.onclose = (e) => {
        if (session.current !== s) return;
        if (!s.closed) setError(s.error ?? (e.reason || "Speech server disconnected."));
        end(s);
      };
    } catch (err) {
      if (session.current === s) setError(micError(err));
      end(s);
    }
  }, [end, onMessage]);

  /** Stop the mic now, but let the speech server finish the line being spoken (it may still run as a command). */
  const stop = useCallback(() => {
    const s = session.current;
    if (!s) return;
    if (s.rec) s.rec.stop();
    else if (s.ws?.readyState !== WebSocket.OPEN) return end(s);
    else {
      s.media?.getTracks().forEach((t) => t.stop());
      s.ws.send(JSON.stringify({ type: "stop" }));
    }
    setState("stopping");
    window.setTimeout(() => end(s), 3000);
  }, [end]);

  const toggle = useCallback(() => (session.current ? stop() : void start()), [start, stop]);

  useEffect(() => () => void (session.current && end(session.current)), [end]);

  return { state, interim, error, toggle };
}
