import { useCallback, useEffect, useRef, useState } from "react";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { isTopLevel, labelOf } from "../board/executor";

export type VoiceState = "off" | "starting" | "listening" | "stopping";

/** Messages from the speech sidecar (stt/server.py). */
type SttMessage =
  | { type: "ready"; model: string }
  | { type: "partial"; id: string; text: string }
  | { type: "final"; id: string; text: string; ms: number }
  | { type: "stopped" }
  | { type: "error"; message: string };

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

/** Board labels to bias recognition toward ("Postgres", "Auth service"); clip-art names are ordinary words. */
export function boardKeyterms(elements: readonly ExcalidrawElement[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const el of elements) {
    if (!isTopLevel(el) || el.type === "image") continue;
    const label = labelOf(elements, el)?.replace(/,/g, " ").replace(/\s+/g, " ").trim();
    if (label && label.length <= 40 && !seen.has(label.toLowerCase())) {
      seen.add(label.toLowerCase());
      out.push(label);
    }
  }
  return out.slice(-MAX_KEYTERMS);
}

/** A finished line worth running: noise can complete a line of only punctuation ("." or "..."). */
export const isCommand = (text: string) => /[\p{L}\p{N}]/u.test(text);

interface Session {
  media?: MediaStream;
  ctx?: AudioContext;
  ws?: WebSocket;
  line?: string; // id of the line being spoken
  terms?: string; // key terms last sent
  error?: string;
  closed: boolean;
}

function sttUrl() {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/stt`;
}

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("Speech server isn't running (start stt/server.py)."));
  });
}

function micError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError") return "Microphone access was blocked.";
  if (name === "NotFoundError") return "No microphone found.";
  return err instanceof Error ? err.message : "Couldn't start the microphone.";
}

/**
 * Streams the mic to the local Moonshine sidecar. `onFinal` gets each completed spoken line;
 * `getKeyterms` is read when a new line starts, so recognition follows the labels on the board.
 */
export function useVoice(onFinal: (text: string) => void, getKeyterms: () => string[]) {
  const [state, setState] = useState<VoiceState>("off");
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const session = useRef<Session | null>(null);
  const cb = useRef({ onFinal, getKeyterms });
  cb.current = { onFinal, getKeyterms };

  /** Release everything the session holds; safe to call more than once. */
  const end = useCallback((s: Session) => {
    s.closed = true;
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
      const ws = await openSocket(sttUrl());
      s.ws = ws;
      if (s.closed) return end(s);
      const terms = cb.current.getKeyterms();
      s.terms = terms.join("\n");
      ws.send(JSON.stringify({ type: "start", sampleRate: s.ctx.sampleRate, keyterms: terms }));
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

  /** Stop the mic now, but let the sidecar finish the line being spoken (it may still run as a command). */
  const stop = useCallback(() => {
    const s = session.current;
    if (!s) return;
    if (s.ws?.readyState !== WebSocket.OPEN) return end(s);
    s.media?.getTracks().forEach((t) => t.stop());
    s.ws.send(JSON.stringify({ type: "stop" }));
    setState("stopping");
    window.setTimeout(() => end(s), 3000);
  }, [end]);

  const toggle = useCallback(() => (session.current ? stop() : void start()), [start, stop]);

  useEffect(() => () => void (session.current && end(session.current)), [end]);

  return { state, interim, error, toggle };
}
