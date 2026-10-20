import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { FastifyBaseLogger } from "fastify";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { CLOUD_STT, STT_PROVIDERS, cleanAssemblyTurn, type AssemblyTurn, type SttProvider } from "@board/shared";
import { LineRecorder, type ClipStore } from "./clips";

/**
 * Cloud speech-to-text behind the WebSocket /api/stt. It speaks the same protocol as the Moonshine sidecar
 * (stt/server.py's docstring), so the browser's voice hook works with either; this side relays the audio to
 * Deepgram or AssemblyAI and turns their messages into partial/final lines. The `start` message picks the
 * provider (else STT_PROVIDER) and may carry the browser's own key (else the .env one for that provider).
 * With `record: true` (Settings "Keep voice clips") and a clip store, each final line's audio is cut out of the
 * relayed stream by the provider's word times and saved like the sidecar's Moonshine clips (see clips.ts).
 */

export type CloudStt = "deepgram" | "assemblyai";

/** Server -> browser messages (stt/server.py protocol). */
export type SttOut =
  | { type: "ready"; model: string; recording: boolean }
  | { type: "partial"; id: string; text: string }
  /** `span` = the line's first word start and last word end, in seconds of the stream (relay-only, not sent). */
  | { type: "final"; id: string; text: string; ms: number; span?: Span; clip?: string }
  | { type: "stopped" }
  | { type: "error"; message: string };

export interface SttSettings {
  /** STT_PROVIDER: what the browser uses when its Settings say "server". */
  provider: SttProvider;
  keys: Partial<Record<CloudStt, string>>;
  models: Record<CloudStt, string>;
  /** Upstream WebSocket URLs; tests point them at a fake. */
  urls: Record<CloudStt, string>;
}

export const STT_NAMES: Record<SttProvider, string> = {
  moonshine: "Moonshine",
  deepgram: "Deepgram",
  assemblyai: "AssemblyAI",
  browser: "Browser",
};
const KEY_VARS: Record<CloudStt, string> = { deepgram: "DEEPGRAM_API_KEY", assemblyai: "ASSEMBLYAI_API_KEY" };

export function sttSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): SttSettings {
  const provider = (env.STT_PROVIDER?.trim().toLowerCase() || "moonshine") as SttProvider;
  if (!STT_PROVIDERS.includes(provider))
    throw new Error(`STT_PROVIDER must be one of ${STT_PROVIDERS.join(", ")} (got "${env.STT_PROVIDER}")`);
  return {
    provider,
    keys: { deepgram: env.DEEPGRAM_API_KEY?.trim() || undefined, assemblyai: env.ASSEMBLYAI_API_KEY?.trim() || undefined },
    models: {
      deepgram: env.DEEPGRAM_MODEL?.trim() || "nova-3",
      // The fast, cheap English streaming model; AssemblyAI's own default is a slower "pro" one.
      assemblyai: env.ASSEMBLYAI_MODEL?.trim() || "universal-streaming-english",
    },
    urls: { deepgram: "wss://api.deepgram.com/v1/listen", assemblyai: "wss://streaming.assemblyai.com/v3/ws" },
  };
}

export const sttKeyed = (s: SttSettings) => CLOUD_STT.filter((p) => s.keys[p as CloudStt]);

const MAX_KEYTERMS = 50;

/** Board labels as key terms: one line, deduplicated, capped (as stt/server.py does). */
export function cleanKeyterms(terms: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of Array.isArray(terms) ? terms : []) {
    const term = String(t).replace(/,/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
    if (term && !seen.has(term.toLowerCase())) {
      seen.add(term.toLowerCase());
      out.push(term);
    }
  }
  return out.slice(-MAX_KEYTERMS);
}

/** Browser frames are float32 at the AudioContext's rate; both services take 16-bit little-endian PCM. */
export function toPcm16(frame: Buffer): Buffer {
  const n = frame.length >> 2;
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, frame.readFloatLE(i * 4)));
    out.writeInt16LE(Math.round(v < 0 ? v * 0x8000 : v * 0x7fff), i * 2);
  }
  return out;
}

/** [start, end] in seconds of audio sent since the stream began. */
export type Span = [number, number];

const delay = (sentS: number, endS: number | undefined) => (endS === undefined ? 0 : Math.max(0, Math.round((sentS - endS) * 1000)));

/** Upstream message -> browser lines. `sentS` = seconds of audio sent so far, for the final's delay. */
interface Lines {
  take(msg: any, sentS: number): SttOut[];
  /** The stream ended: the line being spoken, if any, as a final. */
  flush(sentS: number): SttOut[];
}

/**
 * Deepgram: `is_final` results are settled pieces of the line; the line ends at `speech_final` (endpointing),
 * an `UtteranceEnd` (silence after noisy speech) or a result answering our Finalize.
 */
export class DeepgramLines implements Lines {
  private done: string[] = [];
  private line = 1;
  private end?: number;
  private span?: Span;

  take(msg: any, sentS: number): SttOut[] {
    if (msg?.type === "UtteranceEnd") return this.flush(sentS, msg.last_word_end);
    if (msg?.type !== "Results") return [];
    const alt = msg.channel?.alternatives?.[0];
    const text = String(alt?.transcript ?? "").trim();
    if (msg.is_final && text) {
      this.done.push(text);
      const start: number = msg.start ?? 0;
      const end = start + (msg.duration ?? 0);
      this.end = end;
      // Word times when given (they skip the silence around the words), else the result's window.
      const words: { start?: number; end?: number }[] = Array.isArray(alt?.words) ? alt.words : [];
      const span: Span = words.length ? [words[0].start ?? start, words[words.length - 1].end ?? end] : [start, end];
      this.span = [this.span?.[0] ?? span[0], span[1]];
    }
    if (msg.is_final && (msg.speech_final || msg.from_finalize)) return this.flush(sentS);
    const shown = [...this.done, ...(msg.is_final ? [] : [text])].filter(Boolean).join(" ");
    return shown ? [{ type: "partial", id: String(this.line), text: shown }] : [];
  }

  flush(sentS: number, endS = this.end): SttOut[] {
    if (!this.done.length) return [];
    const out: SttOut = { type: "final", id: String(this.line++), text: this.done.join(" "), ms: delay(sentS, endS), span: this.span };
    this.done = [];
    this.span = undefined;
    return [out];
  }
}

/**
 * AssemblyAI v3: one `Turn` id per line. The line is final at `end_of_turn` once formatted (with format_turns the
 * unformatted end comes first; the Universal-3 models only send formatted ones).
 */
export class AssemblyLines implements Lines {
  private last = -1;
  private pending?: { id: string; text: string; end?: number; span?: Span };

  take(msg: any, sentS: number): SttOut[] {
    if (msg?.type === "Termination") return this.flush(sentS);
    if (msg?.type !== "Turn" || typeof msg.turn_order !== "number" || msg.turn_order <= this.last) return [];
    const id = String(msg.turn_order);
    const words: { text?: string; start?: number; end?: number }[] = Array.isArray(msg.words) ? msg.words : [];
    const end = words.length ? (words[words.length - 1].end ?? 0) / 1000 : undefined;
    const span: Span | undefined = end === undefined ? undefined : [(words[0].start ?? 0) / 1000, end];
    if (msg.end_of_turn && msg.turn_is_formatted) {
      this.last = msg.turn_order;
      this.pending = undefined;
      const text = String(msg.transcript ?? "").trim();
      return text ? [{ type: "final", id, text, ms: delay(sentS, end), span }] : [];
    }
    const text = (
      words
        .map((w) => w.text ?? "")
        .join(" ")
        .trim() || String(msg.transcript ?? "")
    ).trim();
    if (!text) return [];
    this.pending = { id, text, end, span };
    return [{ type: "partial", id, text }];
  }

  flush(sentS: number): SttOut[] {
    const p = this.pending;
    this.pending = undefined;
    if (!p) return [];
    this.last = Number(p.id);
    return [{ type: "final", id: p.id, text: p.text, ms: delay(sentS, p.end), span: p.span }];
  }
}

/** How to talk to one service. */
interface Upstream {
  url: string;
  headers: Record<string, string>;
  model: string;
  lines: Lines;
  /** Messages that finish the line being spoken and end the stream. */
  stop: object[];
  /** A message replacing the key terms mid-stream, if the service has one. */
  keyterms?: (terms: string[]) => object;
}

export function upstreamFor(
  provider: CloudStt,
  s: SttSettings,
  key: string,
  rate: number,
  terms: string[],
  turn: AssemblyTurn = {},
): Upstream {
  const model = s.models[provider];
  if (provider === "deepgram") {
    const q = new URLSearchParams({
      model,
      encoding: "linear16",
      sample_rate: String(rate),
      channels: "1",
      interim_results: "true",
      endpointing: "300",
      utterance_end_ms: "1000",
      smart_format: "true",
    });
    // Key terms are Nova-3 only, and fixed for the stream (mid-stream updates are a Flux feature).
    if (model.startsWith("nova-3")) terms.forEach((t) => q.append("keyterm", t));
    return {
      url: `${s.urls.deepgram}?${q}`,
      headers: { Authorization: `Token ${key}` },
      model: `deepgram:${model}`,
      lines: new DeepgramLines(),
      stop: [{ type: "Finalize" }, { type: "CloseStream" }],
    };
  }
  const q = new URLSearchParams({ sample_rate: String(rate), encoding: "pcm_s16le", speech_model: model });
  if (model.startsWith("universal-streaming")) q.set("format_turns", "true");
  if (terms.length) q.set("keyterms_prompt", JSON.stringify(terms));
  // Turn detection from the browser's Settings; unset ones stay at AssemblyAI's defaults.
  if (turn.confidence !== undefined) q.set("end_of_turn_confidence_threshold", String(turn.confidence));
  if (turn.minSilenceMs !== undefined) q.set("min_end_of_turn_silence_when_confident", String(turn.minSilenceMs));
  if (turn.maxSilenceMs !== undefined) q.set("max_turn_silence", String(turn.maxSilenceMs));
  return {
    url: `${s.urls.assemblyai}?${q}`,
    headers: { Authorization: key },
    model: `assemblyai:${model}`,
    lines: new AssemblyLines(),
    stop: [{ type: "ForceEndpoint" }, { type: "Terminate" }],
    keyterms: (keyterms_prompt) => ({ type: "UpdateConfiguration", keyterms_prompt }),
  };
}

export type Connect = (url: string, headers: Record<string, string>) => WebSocket;
const connectWs: Connect = (url, headers) => new WebSocket(url, { headers, handshakeTimeout: 10_000 });

/** A recorded line starts a little before its first word and ends a little after its last: word times are tight. */
export const CLIP_PAD_S: Span = [0.25, 0.35];

/** One browser connection = one listening session = one upstream stream. */
function session(ws: WebSocket, s: SttSettings, log: FastifyBaseLogger, connect: Connect, clips?: ClipStore) {
  let up: WebSocket | undefined;
  let u: Upstream | undefined;
  let name = "";
  let source: CloudStt = "deepgram";
  let rate = 16000;
  let samples = 0;
  let stopping = false;
  let finished = false;
  let upstreamError: string | undefined;
  let recorder: LineRecorder | undefined;
  const queue: Buffer[] = [];
  const sentS = () => samples / rate;

  /** Save a final line's audio (when recording) and name the clip in the message. */
  const keep = (m: SttOut): SttOut => {
    if (m.type !== "final") return m;
    const { span, ...out } = m;
    if (!recorder || !clips || !span || !out.text) return out;
    try {
      const audio = recorder.cut(span[0] - CLIP_PAD_S[0], span[1] + CLIP_PAD_S[1]);
      if (audio) out.clip = clips.save(audio, out.text, source, u?.model ?? source);
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : err }, "couldn't save the voice clip");
    }
    return out;
  };
  const send = (msgs: SttOut[]) => {
    for (const m of msgs) {
      const out = keep(m);
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(out));
    }
  };
  const finish = (msgs: SttOut[]) => {
    if (finished) return;
    finished = true;
    send(msgs);
    ws.close();
    if (up && up.readyState !== WebSocket.CLOSED) up.terminate();
  };
  const sendStop = () => u?.stop.forEach((m) => up?.send(JSON.stringify(m)));

  function start(m: any) {
    const provider = (m.provider ?? s.provider) as SttProvider;
    if (!CLOUD_STT.includes(provider))
      return finish([{ type: "error", message: `Pick a cloud speech provider for /api/stt (got "${provider}").` }]);
    name = STT_NAMES[provider];
    const p = provider as CloudStt;
    const key = (typeof m.apiKey === "string" && m.apiKey.trim()) || s.keys[p];
    if (!key) return finish([{ type: "error", message: `No ${name} API key: add one in Settings or set ${KEY_VARS[p]} in .env.` }]);
    rate = Math.min(96000, Math.max(8000, Math.round(Number(m.sampleRate) || 16000)));
    const cur = (u = upstreamFor(p, s, key, rate, cleanKeyterms(m.keyterms), cleanAssemblyTurn(m.turn)));
    source = p;
    if (m.record === true && clips) recorder = new LineRecorder(rate);
    const sock = (up = connect(cur.url, cur.headers));
    log.info({ model: cur.model, rate, recording: Boolean(recorder) }, "cloud speech session");

    sock.on("open", () => {
      queue.splice(0).forEach((b) => sock.send(b));
      send([{ type: "ready", model: cur.model, recording: Boolean(recorder) }]);
      if (stopping) sendStop();
    });
    sock.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) return;
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg?.type === "Error" || typeof msg?.error === "string") upstreamError = msg.description ?? msg.message ?? msg.error;
      send(cur.lines.take(msg, sentS()));
    });
    sock.on("unexpected-response", (req, res) => {
      // ws hands the failed handshake to us and emits nothing more; terminate() would fail on it.
      req.destroy();
      res.resume();
      up = undefined;
      const why = res.headers["dg-error"] ?? (res.statusCode === 401 || res.statusCode === 403 ? "check the API key" : "");
      finish([{ type: "error", message: `${name} refused the connection (HTTP ${res.statusCode})${why ? `: ${why}` : ""}.` }]);
    });
    sock.on("error", (err) => finish([{ type: "error", message: `${name}: ${err.message}` }]));
    sock.on("close", (code, reason) => {
      const tail = cur.lines.flush(sentS());
      if (stopping) return finish([...tail, { type: "stopped" }]);
      const why = upstreamError ?? reason.toString();
      finish([...tail, { type: "error", message: `${name} ended the stream${why ? `: ${why}` : ""} (${code}).` }]);
    });
  }

  ws.on("message", (data: RawData, isBinary: boolean) => {
    if (finished) return;
    if (isBinary) {
      if (!u || stopping) return;
      const pcm = toPcm16(Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[]));
      samples += pcm.length / 2;
      recorder?.push(new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2)); // toPcm16's Buffer.alloc is aligned
      if (up?.readyState === WebSocket.OPEN) up.send(pcm);
      else queue.push(pcm);
      return;
    }
    let m: any;
    try {
      m = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (m?.type === "start" && !u) start(m);
    else if (m?.type === "keyterms" && u?.keyterms && up?.readyState === WebSocket.OPEN)
      up.send(JSON.stringify(u.keyterms(cleanKeyterms(m.terms))));
    else if (m?.type === "stop" && !stopping) {
      stopping = true;
      if (!u) finish([{ type: "stopped" }]);
      else if (up?.readyState === WebSocket.OPEN) sendStop();
    }
  });

  ws.on("close", () => {
    finished = true;
    if (up?.readyState === WebSocket.OPEN) {
      sendStop();
      up.close();
    } else up?.terminate();
  });
}

/** A browser on another site could otherwise use the server's .env speech key: WebSockets skip CORS. */
function sameOrigin(req: IncomingMessage) {
  const origin = req.headers.origin;
  if (!origin) return true; // not a browser
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/** Serves /api/stt on the Fastify app's HTTP server. */
export function attachStt(server: Server, s: SttSettings, log: FastifyBaseLogger, connect: Connect = connectWs, clips?: ClipStore) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = req.url?.split("?")[0];
    if (path !== "/api/stt" || !sameOrigin(req)) {
      socket.end(`HTTP/1.1 ${path === "/api/stt" ? "403 Forbidden" : "404 Not Found"}\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => session(ws, s, log, connect, clips));
  });
  return wss;
}
