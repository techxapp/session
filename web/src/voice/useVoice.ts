import { useEffect, useMemo, useRef, useState } from "react";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { isTopLevel, labelOf } from "../board/executor";
import { CLOUD_STT } from "@board/shared";
import type { SpeechConfig } from "../settings";
// SttMessage: from the speech servers (the Moonshine sidecar or the API server's cloud relay) or the browser's own.
import { browserRecognition, listenInBrowser, type RecognitionCtor, type SttMessage } from "./browserSpeech";

/** "dozing": nothing was heard for a while, so recognition is paused; the mic stays open and speaking resumes it. */
export type VoiceState = "off" | "starting" | "listening" | "dozing" | "stopping";

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

/** Frames (~100 ms each, so 2 s) kept while dozing and sent on waking, so the words that woke the mic still count. */
export const PREROLL_FRAMES = 20;
/** Loud frames in a row that wake a dozing session: a click or a knock is shorter. */
export const WAKE_FRAMES = 2;

export function rms(frame: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return frame.length ? Math.sqrt(sum / frame.length) : 0;
}

/** Watches the mic while dozing: keeps the last PREROLL_FRAMES frames and says when speech-loud audio starts. */
export class WakeDetector {
  readonly frames: Float32Array[] = [];
  private loud = 0;
  constructor(private readonly threshold: number) {}
  /** True once WAKE_FRAMES frames in a row reach the threshold. */
  push(frame: Float32Array): boolean {
    this.frames.push(frame);
    if (this.frames.length > PREROLL_FRAMES) this.frames.shift();
    this.loud = rms(frame) >= this.threshold ? this.loud + 1 : 0;
    return this.loud >= WAKE_FRAMES;
  }
}

/** A finished line worth running: noise can complete a line of only punctuation ("." or "..."). */
export const isCommand = (text: string) => /[\p{L}\p{N}]/u.test(text);

/**
 * Words a spoken command doesn't end on: when a final line ends with one ("draw a box and", "put it next to"),
 * the speaker most likely paused mid-command, so the line is held and the next one joined to it. Left out on
 * purpose: words that also end real commands ("zoom in", "scroll up", "start over", "put it below", "delete that").
 */
export const JOIN_WORDS = new Set(
  (
    "and or but plus then with without to into onto from of between beside besides near toward towards " +
    "a an the some another its their my your our called named labelled labeled saying titled is are as than for by at on via"
  ).split(" "),
);
/** How long a held line waits for the speaker to carry on (no new speech) before it runs as it is. */
export const HOLD_MS = 1500;
/** How long it waits while the next line is being spoken (in case that line never completes). */
export const HOLD_SPEAKING_MS = 8000;

/** Does this finished line look cut off mid-command (ends on a JOIN_WORD, a comma, dash, colon or "...")? */
export function looksIncomplete(text: string): boolean {
  const t = text.trim();
  if (/(,|:|;|-|\u2013|\u2014|\.\.\.|\u2026)$/.test(t)) return true;
  const last =
    t
      .replace(/[.?!]+$/, "")
      .split(/\s+/)
      .pop()
      ?.toLowerCase() ?? "";
  return JOIN_WORDS.has(last);
}

/** "Draw a box and." + "Next to the database." -> "Draw a box and Next to the database." (case is kept: it may be a name). */
export function joinLines(held: string, next: string): string {
  return `${dropStop(held)} ${next.trim()}`.trim();
}

const dropStop = (text: string) => text.trim().replace(/(\.\.\.|\u2026|[.?!])$/, "");

/**
 * Turns finished speech lines into commands, holding a line that looksIncomplete until the next one arrives
 * (they are joined) or the speaker stays quiet for HOLD_MS. `show` gets what the command bar should display.
 */
export class LineJoiner {
  private held?: string;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private run: (text: string) => void,
    private show: (text: string) => void,
  ) {}

  final(text: string) {
    if (!isCommand(text)) {
      if (this.held) this.wait(HOLD_MS); // noise ended a line; keep waiting for real words
      return;
    }
    const line = this.held ? joinLines(this.held, text) : text.trim();
    this.clear();
    if (looksIncomplete(line)) {
      this.held = dropStop(line);
      this.show(`${this.held} \u2026`);
      this.wait(HOLD_MS);
    } else {
      this.show("");
      this.run(line);
    }
  }

  /** The next line is being spoken: show it after the held part and wait for it to finish. */
  partial(text: string) {
    if (!this.held) return this.show(text);
    this.show(joinLines(this.held, text));
    this.wait(HOLD_SPEAKING_MS);
  }

  /** Run whatever is held now (the mic stopped, the session dozed or ended). */
  flush() {
    const line = this.held;
    this.clear();
    if (line) {
      this.show("");
      this.run(line);
    }
  }

  /** Drop whatever is held without running it. */
  clear() {
    clearTimeout(this.timer);
    this.timer = this.held = undefined;
  }

  get holding() {
    return this.held !== undefined;
  }

  private wait(ms: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), ms);
  }
}

interface Session {
  speech: SpeechConfig; // read once per mic start
  media?: MediaStream;
  ctx?: AudioContext;
  frame?: (f: Float32Array) => void; // where mic frames go: the socket, a connect buffer or the wake detector
  ws?: WebSocket;
  rec?: ReturnType<typeof listenInBrowser>; // the browser's own recognition, instead of mic + socket
  line?: string; // id of the line being spoken
  terms?: string; // key terms last sent
  idle?: number; // timer that dozes the session
  joiner: LineJoiner; // holds a line that ended mid-command until the next one joins it
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

/** Opens the mic and posts its ~100 ms frames to `s.frame`. */
async function openMic(s: Session) {
  s.media = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  if (s.closed) return closeMic(s); // stopped while the permission prompt was open
  s.ctx = new AudioContext();
  const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
  await s.ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  const node = new AudioWorkletNode(s.ctx, "pcm-capture");
  s.ctx.createMediaStreamSource(s.media).connect(node);
  node.connect(s.ctx.destination); // outputs silence; an unconnected node may never be run
  node.port.onmessage = (e) => s.frame?.(e.data);
}

function closeMic(s: Session) {
  s.media?.getTracks().forEach((t) => t.stop());
  if (s.ctx && s.ctx.state !== "closed") void s.ctx.close();
  s.media = s.ctx = undefined;
}

/**
 * Streams the mic to the speech provider `getSpeech` picks (read on each start). `onFinal` gets each completed
 * spoken command (a line that ends mid-command, e.g. on "and", is joined with the next; see LineJoiner);
 * `getKeyterms` is read when a new line starts, so recognition follows the labels on the board.
 * After `idleMs` with nothing heard the session dozes: the speech socket (or browser recognition) closes, the mic
 * stays open, and the first speech-loud audio reconnects, sending the last 2 s first so those words still count.
 */
export function useVoice(onFinal: (text: string) => void, getKeyterms: () => string[], getSpeech: () => SpeechConfig) {
  const [state, setState] = useState<VoiceState>("off");
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const session = useRef<Session | null>(null);
  const cb = useRef({ onFinal, getKeyterms, getSpeech });
  cb.current = { onFinal, getKeyterms, getSpeech };

  // The functions call each other (a message resets the idle timer, which dozes, and waking reconnects), and
  // they only use refs and state setters, so they're made once.
  const voice = useMemo(() => {
    /** Release everything the session holds; safe to call more than once. */
    const end = (s: Session) => {
      s.joiner.flush(); // the mic stopped (or failed) after a line ending in "and...": run what was said
      s.closed = true;
      window.clearTimeout(s.idle);
      s.frame = undefined;
      s.rec?.abort();
      closeMic(s);
      if (s.ws && s.ws.readyState <= WebSocket.OPEN) s.ws.close();
      if (session.current === s) {
        session.current = null;
        setState("off");
        setInterim("");
      }
    };

    const fail = (s: Session, message: string) => {
      if (session.current === s) setError(message);
      end(s);
    };

    /** Something was heard (or recognition just started): doze after idleMs more of nothing. */
    const heard = (s: Session) => {
      window.clearTimeout(s.idle);
      if (s.speech.idleMs > 0) s.idle = window.setTimeout(() => void doze(s), s.speech.idleMs);
    };

    const onMessage = (s: Session, msg: SttMessage) => {
      if (msg.type === "ready") {
        setState("listening");
        heard(s);
      } else if (msg.type === "partial") {
        heard(s);
        if (msg.id !== s.line) {
          s.line = msg.id;
          const terms = cb.current.getKeyterms();
          if (terms.join("\n") !== s.terms && s.ws?.readyState === WebSocket.OPEN) {
            s.terms = terms.join("\n");
            s.ws.send(JSON.stringify({ type: "keyterms", terms }));
          }
        }
        s.joiner.partial(msg.text);
      } else if (msg.type === "final") {
        heard(s);
        s.joiner.final(msg.text);
      } else if (msg.type === "error") s.error = msg.message;
      else if (msg.type === "stopped") end(s);
    };

    /** Opens the speech socket and sends `early` (frames captured before and while it connects) first. */
    const connect = async (s: Session, early: Float32Array[]) => {
      s.frame = (f) => early.push(f);
      const cloud = CLOUD_STT.includes(s.speech.provider);
      const ws = await openSocket(
        sttUrl(cloud),
        cloud ? "The API server isn't reachable." : "Speech server isn't running (start stt/server.py).",
      );
      s.ws = ws;
      if (s.closed || !s.ctx) return end(s);
      const terms = cb.current.getKeyterms();
      s.terms = terms.join("\n");
      s.line = undefined;
      const which = cloud ? { provider: s.speech.provider, apiKey: s.speech.apiKey, turn: s.speech.turn } : {};
      ws.send(JSON.stringify({ type: "start", sampleRate: s.ctx.sampleRate, keyterms: terms, ...which }));
      early.forEach((frame) => ws.send(frame));
      s.frame = (f) => ws.readyState === WebSocket.OPEN && ws.send(f);
      ws.onmessage = (e) => onMessage(s, JSON.parse(e.data) as SttMessage);
      ws.onclose = (e) => {
        if (session.current !== s) return;
        if (!s.closed) setError(s.error ?? (e.reason || "Speech server disconnected."));
        end(s);
      };
    };

    const listenBrowser = (s: Session, Rec: RecognitionCtor) => {
      // It asks for the mic itself and owns the audio, so no capture or socket here.
      const rec = listenInBrowser(Rec, {
        message: (m) => onMessage(s, m),
        end: (err) => {
          if (session.current !== s || s.rec !== rec) return;
          if (err) setError(err);
          end(s);
        },
      });
      s.rec = rec;
    };

    /** Nothing heard for idleMs: stop recognising but keep the mic, and wake on speech-loud audio. */
    const doze = async (s: Session) => {
      if (session.current !== s || s.closed) return;
      setState("dozing");
      s.joiner.flush();
      setInterim("");
      const wake = new WakeDetector(s.speech.wakeRms);
      s.frame = (f) => {
        if (wake.push(f)) void resume(s, wake.frames);
      };
      if (s.ws) {
        // Nothing has been said for idleMs, so there's no line to finish: just drop the socket.
        const ws = s.ws;
        s.ws = undefined;
        ws.onmessage = ws.onclose = null;
        ws.close();
      }
      if (s.rec) {
        s.rec.abort();
        s.rec = undefined;
        try {
          await openMic(s); // browser recognition has no level to watch, so open the mic just for that
        } catch (err) {
          fail(s, micError(err));
        }
      }
    };

    const resume = async (s: Session, preroll: Float32Array[]) => {
      if (s.speech.provider === "browser") {
        // Recognition takes a moment to start and can't be given the pre-roll, so the first word may be lost.
        s.frame = undefined;
        closeMic(s);
        setState("starting");
        return listenBrowser(s, browserRecognition()!);
      }
      setState("listening"); // the audio is already being kept, so the speaker can carry on
      try {
        await connect(s, [...preroll]);
      } catch (err) {
        fail(s, err instanceof Error ? err.message : "Speech server disconnected.");
      }
    };

    const start = async () => {
      if (session.current) return;
      const s: Session = {
        closed: false,
        speech: cb.current.getSpeech(),
        joiner: new LineJoiner(
          (text) => cb.current.onFinal(text),
          (text) => session.current === s && setInterim(text),
        ),
      };
      session.current = s;
      setError(null);
      setState("starting");
      if (s.speech.provider === "browser") {
        const Rec = browserRecognition();
        if (!Rec) return fail(s, "This browser has no built-in speech recognition (try Chrome, Edge or Safari, or pick another provider).");
        return listenBrowser(s, Rec);
      }
      try {
        // Keep what is said while the socket connects: people start talking as soon as they click.
        const early: Float32Array[] = [];
        s.frame = (f) => early.push(f);
        await openMic(s);
        if (s.closed) return end(s);
        await connect(s, early);
      } catch (err) {
        fail(s, micError(err));
      }
    };

    /** Stop the mic now, but let the speech server finish the line being spoken (it may still run as a command). */
    const stop = () => {
      const s = session.current;
      if (!s) return;
      window.clearTimeout(s.idle);
      if (s.rec) s.rec.stop();
      else if (s.ws?.readyState !== WebSocket.OPEN)
        return end(s); // includes a dozing session: nothing to finish
      else {
        s.frame = undefined;
        closeMic(s);
        s.ws.send(JSON.stringify({ type: "stop" }));
      }
      setState("stopping");
      window.setTimeout(() => end(s), 3000);
    };

    return { end, start, stop, toggle: () => (session.current ? stop() : void start()) };
  }, []);

  useEffect(
    () => () => {
      const s = session.current;
      if (!s) return;
      s.joiner.clear(); // unmounting: don't run a held half-command
      voice.end(s);
    },
    [voice],
  );

  return { state, interim, error, toggle: voice.toggle };
}
