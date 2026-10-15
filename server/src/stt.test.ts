import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { buildApp } from "./app";
import { anthropicProvider } from "./provider";
import { cleanAssemblyTurn } from "@board/shared";
import { AssemblyLines, DeepgramLines, cleanKeyterms, sttSettingsFromEnv, toPcm16, upstreamFor, type SttSettings } from "./stt";

describe("speech settings", () => {
  it("reads STT_PROVIDER and the keys, and rejects unknown providers", () => {
    const s = sttSettingsFromEnv({ STT_PROVIDER: "Deepgram", DEEPGRAM_API_KEY: " dg " });
    expect(s).toMatchObject({ provider: "deepgram", keys: { deepgram: "dg", assemblyai: undefined } });
    expect(sttSettingsFromEnv({}).provider).toBe("moonshine");
    expect(() => sttSettingsFromEnv({ STT_PROVIDER: "whisper" })).toThrow(/STT_PROVIDER/);
  });

  it("builds the upstream URLs with key terms", () => {
    const s = sttSettingsFromEnv({});
    const dg = new URL(upstreamFor("deepgram", s, "k", 48000, ["Postgres", "Auth service"]).url);
    expect(dg.searchParams.get("model")).toBe("nova-3");
    expect(dg.searchParams.get("sample_rate")).toBe("48000");
    expect(dg.searchParams.getAll("keyterm")).toEqual(["Postgres", "Auth service"]);
    const aai = upstreamFor("assemblyai", s, "k", 48000, ["Postgres"]);
    const q = new URL(aai.url).searchParams;
    expect(q.get("keyterms_prompt")).toBe('["Postgres"]');
    expect(q.get("format_turns")).toBe("true");
    expect(aai.headers).toEqual({ Authorization: "k" });
    expect(aai.keyterms?.(["Redis"])).toEqual({ type: "UpdateConfiguration", keyterms_prompt: ["Redis"] });
    expect(q.has("end_of_turn_confidence_threshold")).toBe(false);
    expect(q.has("min_end_of_turn_silence_when_confident")).toBe(false);
    expect(q.has("max_turn_silence")).toBe(false);
  });

  it("sends AssemblyAI turn detection settings, clamped, and only the ones given", () => {
    const s = sttSettingsFromEnv({});
    const turn = cleanAssemblyTurn({ confidence: 0.7, minSilenceMs: 812.4, maxSilenceMs: 99_999, extra: 1 });
    expect(turn).toEqual({ confidence: 0.7, minSilenceMs: 812, maxSilenceMs: 10_000 });
    const q = new URL(upstreamFor("assemblyai", s, "k", 16000, [], turn).url).searchParams;
    expect(q.get("end_of_turn_confidence_threshold")).toBe("0.7");
    expect(q.get("min_end_of_turn_silence_when_confident")).toBe("812");
    expect(q.get("max_turn_silence")).toBe("10000");
    expect(cleanAssemblyTurn({ confidence: "0.5", minSilenceMs: NaN, maxSilenceMs: -5 })).toEqual({ maxSilenceMs: 0 });
    expect(cleanAssemblyTurn(null)).toEqual({});
    const partial = new URL(upstreamFor("assemblyai", s, "k", 16000, [], { minSilenceMs: 700 }).url).searchParams;
    expect(partial.get("min_end_of_turn_silence_when_confident")).toBe("700");
    expect(partial.has("end_of_turn_confidence_threshold")).toBe(false);
    // Deepgram ignores them.
    expect(new URL(upstreamFor("deepgram", s, "k", 16000, [], turn).url).searchParams.has("max_turn_silence")).toBe(false);
  });

  it("cleans key terms and converts float32 to int16", () => {
    expect(cleanKeyterms(["a,b", " A B ", "", 3])).toEqual(["a b", "3"]);
    const f = Buffer.alloc(16);
    [0, 1, -1, 2].forEach((v, i) => f.writeFloatLE(v, i * 4));
    const pcm = toPcm16(f);
    expect([0, 1, 2, 3].map((i) => pcm.readInt16LE(i * 2))).toEqual([0, 32767, -32768, 32767]);
  });
});

const dgResult = (text: string, flags: { is_final?: boolean; speech_final?: boolean; from_finalize?: boolean } = {}) => ({
  type: "Results",
  start: 0,
  duration: 1,
  channel: { alternatives: [{ transcript: text }] },
  ...flags,
});

describe("Deepgram lines", () => {
  it("joins final pieces into one line that ends at speech_final", () => {
    const l = new DeepgramLines();
    expect(l.take(dgResult("draw a"), 1)).toEqual([{ type: "partial", id: "1", text: "draw a" }]);
    expect(l.take(dgResult("draw a blue", { is_final: true }), 1)).toEqual([{ type: "partial", id: "1", text: "draw a blue" }]);
    expect(l.take(dgResult("box"), 1.2)).toEqual([{ type: "partial", id: "1", text: "draw a blue box" }]);
    expect(l.take(dgResult("box", { is_final: true, speech_final: true }), 1.3)).toEqual([
      { type: "final", id: "1", text: "draw a blue box", ms: 300 },
    ]);
    expect(l.take(dgResult("undo", { is_final: true }), 2)).toEqual([{ type: "partial", id: "2", text: "undo" }]);
    expect(l.take({ type: "UtteranceEnd", last_word_end: 1.5 }, 2)).toEqual([{ type: "final", id: "2", text: "undo", ms: 500 }]);
    expect(l.take({ type: "UtteranceEnd" }, 3)).toEqual([]);
  });
});

const turn = (order: number, text: string, end_of_turn = false, turn_is_formatted = false) => ({
  type: "Turn",
  turn_order: order,
  end_of_turn,
  turn_is_formatted,
  transcript: text,
  words: text.split(" ").map((w, i) => ({ text: w, end: (i + 1) * 100 })),
});

describe("AssemblyAI lines", () => {
  it("finalizes on the formatted end of turn, and flushes on termination", () => {
    const l = new AssemblyLines();
    expect(l.take(turn(0, "draw a"), 1)).toEqual([{ type: "partial", id: "0", text: "draw a" }]);
    expect(l.take(turn(0, "draw a box", true), 1)).toEqual([{ type: "partial", id: "0", text: "draw a box" }]);
    expect(l.take(turn(0, "Draw a box.", true, true), 1)).toEqual([{ type: "final", id: "0", text: "Draw a box.", ms: 700 }]);
    expect(l.take(turn(0, "Draw a box.", true, true), 1)).toEqual([]);
    expect(l.take(turn(1, "undo"), 1)).toEqual([{ type: "partial", id: "1", text: "undo" }]);
    expect(l.take({ type: "Termination" }, 1)).toEqual([{ type: "final", id: "1", text: "undo", ms: 900 }]);
  });
});

describe("/api/stt", () => {
  const closers: (() => Promise<unknown>)[] = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((c) => c()));
  });

  /** The API server with a fake Deepgram; returns its port and what the fake received. */
  async function setup(keys: SttSettings["keys"] = { deepgram: "env-dg" }) {
    const fake = new WebSocketServer({ port: 0 });
    closers.push(() => new Promise((r) => fake.close(r)));
    const got = { url: "", auth: "", audio: 0, control: [] as string[] };
    fake.on("connection", (ws, req) => {
      got.url = req.url ?? "";
      got.auth = String(req.headers.authorization);
      ws.on("message", (d, bin) => {
        if (bin) {
          got.audio += (d as Buffer).length;
          if (got.audio === 4) ws.send(JSON.stringify(dgResult("draw a box", { is_final: true, speech_final: true })));
          return;
        }
        const m = JSON.parse(d.toString());
        got.control.push(m.type);
        if (m.type === "Finalize") ws.send(JSON.stringify(dgResult("undo", { is_final: true, from_finalize: true })));
        if (m.type === "CloseStream") ws.close();
      });
    });
    const settings = { ...sttSettingsFromEnv({}), keys };
    settings.urls = { ...settings.urls, deepgram: `ws://127.0.0.1:${(fake.address() as AddressInfo).port}` };
    const app = buildApp(anthropicProvider({} as never), { logger: false, stt: settings });
    await app.listen({ port: 0, host: "127.0.0.1" });
    closers.push(() => app.close());
    return { port: (app.server.address() as AddressInfo).port, got };
  }

  function client(port: number, headers?: Record<string, string>) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/stt`, { headers });
    const msgs: any[] = [];
    const closed = new Promise<void>((resolve) => ws.on("close", () => resolve()));
    ws.on("message", (d) => msgs.push(JSON.parse(d.toString())));
    const opened = new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    return { ws, msgs, closed, opened };
  }

  it("relays audio to the cloud service and its lines back, finishing the last line on stop", async () => {
    const { port, got } = await setup();
    const c = client(port);
    await c.opened;
    c.ws.send(JSON.stringify({ type: "start", provider: "deepgram", sampleRate: 16000, keyterms: ["Postgres"] }));
    c.ws.send(new Float32Array([0.5, -0.5]).buffer);
    await new Promise((r) => setTimeout(r, 200));
    c.ws.send(JSON.stringify({ type: "stop" }));
    await c.closed;
    expect(got.auth).toBe("Token env-dg");
    expect(got.url).toContain("keyterm=Postgres");
    expect(got.audio).toBe(4);
    expect(got.control).toEqual(["Finalize", "CloseStream"]);
    expect(c.msgs.map((m) => m.type)).toEqual(["ready", "final", "final", "stopped"]);
    expect(c.msgs.filter((m) => m.type === "final").map((m) => m.text)).toEqual(["draw a box", "undo"]);
    const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
    expect(health.stt).toEqual({ provider: "moonshine", keyed: ["deepgram"] });
  });

  it("uses the browser's key over .env, and says when there is none", async () => {
    const { port, got } = await setup({});
    const a = client(port);
    await a.opened;
    a.ws.send(JSON.stringify({ type: "start", provider: "assemblyai", sampleRate: 16000 }));
    await a.closed;
    expect(a.msgs).toEqual([{ type: "error", message: expect.stringMatching(/No AssemblyAI API key.*ASSEMBLYAI_API_KEY/) }]);
    const b = client(port);
    await b.opened;
    b.ws.send(JSON.stringify({ type: "start", provider: "deepgram", sampleRate: 16000, apiKey: "ui-key" }));
    b.ws.send(JSON.stringify({ type: "stop" }));
    await b.closed;
    expect(got.auth).toBe("Token ui-key");
  });

  it("refuses another site's page", async () => {
    const { port } = await setup();
    const c = client(port, { Origin: "https://evil.example" });
    await expect(c.opened).rejects.toThrow(/403/);
  });
});
