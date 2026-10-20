import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { buildApp } from "./app";
import { CLIP_RATE, ClipStore, LineRecorder, clipsDirFromEnv, itemsOf, resample } from "./clips";
import { anthropicProvider } from "./provider";
import { sttSettingsFromEnv } from "./stt";

const dirs: string[] = [];
const tempStore = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "clips-"));
  dirs.push(dir);
  return new ClipStore(dir);
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const tone = (hz: number, rate: number, seconds: number, amp = 0.5) =>
  Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / rate));
const rms = (x: Float32Array, from = 0, to = x.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / (to - from));
};
const rows = (file: string) =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

describe("resample", () => {
  it("keeps speech-band tones and filters out what 16 kHz can't hold", () => {
    const voice = resample(tone(440, 48000, 1), 48000, 16000);
    expect(voice).toHaveLength(16000);
    expect(rms(voice, 200, 15800)).toBeCloseTo(0.5 / Math.SQRT2, 2);
    const high = resample(tone(10000, 48000, 1), 48000, 16000); // would alias to 6 kHz
    expect(rms(high, 200, 15800)).toBeLessThan(0.01);
    expect(resample(tone(440, 44100, 0.5), 44100, 16000)).toHaveLength(8000);
  });
});

describe("LineRecorder", () => {
  it("cuts seconds of the stream at 16 kHz, from the audio it still keeps", () => {
    const r = new LineRecorder(16000, 2);
    for (let s = 0; s < 4; s++) r.push(Int16Array.from({ length: 16000 }, () => (s + 1) * 1000)); // second s = (s+1)*1000
    expect(r.cut(0, 1)).toBeUndefined(); // only the last 2 s are kept
    const cut = r.cut(2.5, 3.5)!;
    expect(cut).toHaveLength(16000);
    expect(Math.round(cut[100] * 32768)).toBe(3000);
    expect(Math.round(cut[15900] * 32768)).toBe(4000);
    expect(r.cut(3.5, 9)).toHaveLength(8000); // clamped to what was sent
  });
});

describe("ClipStore", () => {
  it("resolves STT_CLIPS_DIR from the repo root", () => {
    expect(clipsDirFromEnv({})).toMatch(/[\\/]stt[\\/]clips$/);
    expect(clipsDirFromEnv({ STT_CLIPS_DIR: "F:/data/clips" })).toBe(path.resolve("F:/data/clips"));
  });

  it("saves a clip with its source, and lists items: labels win, joined lines stay together", async () => {
    const store = tempStore();
    const [a, b, c, d] = ["set june", "put it next to", "the database", "zoom in"].map((heard) =>
      store.save(tone(300, CLIP_RATE, 0.5), heard, "deepgram", "deepgram:nova-3"),
    );
    expect(a).toMatch(/^deepgram-\d{8}-\d{6}-001$/);
    const [row] = rows(path.join(store.dir, "clips.jsonl"));
    expect(row).toMatchObject({
      id: a,
      audio: `audio/${a}.wav`,
      heard: "set june",
      seconds: 0.5,
      source: "deepgram",
      model: "deepgram:nova-3",
    });
    expect(readFileSync(path.join(store.dir, row.audio)).length).toBe(44 + 8000 * 2);

    expect(
      store.label(
        [
          { clips: [a], text: "set zoo" },
          { clips: [a], heard: "set june", text: " set  zoom " },
        ],
        "activity",
      ),
    ).toBe(2);
    expect(
      store.label(
        [
          { clips: [b, c], text: "put it next to the database" },
          { clips: [d], text: " " },
        ],
        "dashboard",
      ),
    ).toBe(1);
    const items = await store.list();
    const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
    expect(Object.keys(byKey).sort()).toEqual([a, `${b}+${c}`, d].sort());
    expect(byKey[a]).toMatchObject({ text: "set zoom", status: "fixed", source: "deepgram", seconds: 0.5 });
    expect(byKey[`${b}+${c}`]).toMatchObject({ heard: "put it next to the database", status: "confirmed", seconds: 1 });
    expect(byKey[d]).toMatchObject({ status: "unreviewed", text: undefined });

    // A later label for one line of the joined command takes that clip back out of it.
    store.label([{ clips: [c], text: "the databases" }], "dashboard");
    expect((await store.list()).map((i) => i.key).sort()).toEqual([a, b, c, d].sort());
  });

  it("reads the sidecar's rows (no source = Moonshine) and skips clips whose audio is gone", () => {
    const items = itemsOf(
      [
        { id: "x-1", audio: "audio/x-1.wav", heard: "draw a box", seconds: 1, model: "moonshine:small", at: "2026-10-20T10:00:00" },
        { id: "x-2", audio: "audio/x-2.wav", heard: "Undo.", seconds: 1, source: "assemblyai", at: "2026-10-20T11:00:00" },
      ],
      [
        { clips: ["x-2"], text: "undo" },
        { clips: ["missing"], text: "dropped" },
      ],
    );
    expect(items.map((i) => [i.key, i.source, i.status])).toEqual([
      ["x-2", "assemblyai", "confirmed"],
      ["x-1", "moonshine", "unreviewed"],
    ]);
  });

  it("deletes clips for good: audio, joined audio, rows and labels", async () => {
    const store = tempStore();
    const [a, b, c] = ["one", "two", "three"].map((h) => store.save(tone(300, CLIP_RATE, 0.2), h, "assemblyai", "assemblyai:u"));
    store.label(
      [
        { clips: [a, b], text: "one two" },
        { clips: [c], text: "three" },
      ],
      "activity",
    );
    mkdirSync(path.join(store.dir, "joined"));
    writeFileSync(path.join(store.dir, "joined", `${a}+${b}.wav`), "x");
    appendFileSync(path.join(store.dir, "clips.jsonl"), "{broken\n");
    expect(await store.delete([b, "nope"])).toBe(1);
    expect(existsSync(path.join(store.dir, "audio", `${b}.wav`))).toBe(false);
    expect(existsSync(path.join(store.dir, "joined", `${a}+${b}.wav`))).toBe(false);
    expect(readFileSync(path.join(store.dir, "clips.jsonl"), "utf8")).toContain("{broken"); // left as it was
    expect(rows(path.join(store.dir, "labels.jsonl")).map((l) => l.text)).toEqual(["three"]);
    expect((await store.list()).map((i) => [i.key, i.status])).toEqual([
      [c, "confirmed"],
      [a, "unreviewed"],
    ]);
  });
});

describe("/api/clips", () => {
  it("lists, plays, labels and deletes; refuses other sites", async () => {
    const store = tempStore();
    const id = store.save(tone(300, CLIP_RATE, 0.3), "draw a fox", "deepgram", "deepgram:nova-3");
    const app = buildApp(anthropicProvider({} as never), { logger: false, clips: store });
    const list = await app.inject({ url: "/api/clips" });
    expect(list.json().items).toMatchObject([{ key: id, heard: "draw a fox", status: "unreviewed" }]);
    const audio = await app.inject({ url: `/api/clips/audio/${id}` });
    expect(audio.headers["content-type"]).toBe("audio/wav");
    expect(audio.rawPayload.subarray(0, 4).toString()).toBe("RIFF");
    expect((await app.inject({ url: "/api/clips/audio/..%2F..%2Fsecret" })).statusCode).toBe(404);

    const label = await app.inject({
      method: "POST",
      url: "/api/clips/labels",
      payload: { labels: [{ clips: [id], text: "draw a box" }], from: "dashboard" },
    });
    expect(label.json()).toEqual({ count: 1 });
    expect(rows(path.join(store.dir, "labels.jsonl"))[0]).toMatchObject({ clips: [id], text: "draw a box", from: "dashboard" });
    expect(
      (await app.inject({ method: "POST", url: "/api/clips/labels", payload: { labels: [{ clips: ["../x"], text: "a" }] } })).statusCode,
    ).toBe(400);

    const evil = await app.inject({
      method: "POST",
      url: "/api/clips/delete",
      payload: { clips: [id] },
      headers: { origin: "https://evil.example", host: "localhost:8787" },
    });
    expect(evil.statusCode).toBe(403);
    expect((await app.inject({ url: `/api/clips/audio/${id}`, headers: { "sec-fetch-site": "cross-site" } })).statusCode).toBe(403);

    const del = await app.inject({ method: "POST", url: "/api/clips/delete", payload: { clips: [id] } });
    expect(del.json()).toEqual({ deleted: 1 });
    expect((await app.inject({ url: "/api/clips" })).json().items).toEqual([]);
    await app.close();
  });
});

describe("recording cloud speech", () => {
  it("cuts each final line out of the relayed audio by the word times and names the clip", async () => {
    const store = tempStore();
    const fake = new WebSocketServer({ port: 0 });
    let audio = 0;
    fake.on("connection", (ws) =>
      ws.on("message", (d, bin) => {
        if (bin) {
          audio += (d as Buffer).length;
          if (audio === 48000 * 2) {
            const words = [
              { word: "draw", start: 0.3, end: 0.45 },
              { word: "box", start: 0.5, end: 0.6 },
            ];
            const alt = { transcript: "draw box", words };
            ws.send(
              JSON.stringify({
                type: "Results",
                start: 0,
                duration: 1,
                is_final: true,
                speech_final: true,
                channel: { alternatives: [alt] },
              }),
            );
          }
        } else if (JSON.parse(d.toString()).type === "CloseStream") ws.close();
      }),
    );
    const settings = { ...sttSettingsFromEnv({}), keys: { deepgram: "k" } };
    settings.urls = { ...settings.urls, deepgram: `ws://127.0.0.1:${(fake.address() as AddressInfo).port}` };
    const app = buildApp(anthropicProvider({} as never), { logger: false, stt: settings, clips: store });
    await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/stt`);
      const msgs: any[] = [];
      ws.on("message", (d) => msgs.push(JSON.parse(d.toString())));
      const closed = new Promise((r) => ws.on("close", r));
      await new Promise((r) => ws.on("open", r));
      ws.send(JSON.stringify({ type: "start", provider: "deepgram", sampleRate: 48000, record: true }));
      ws.send(tone(440, 48000, 1).buffer);
      await new Promise((r) => setTimeout(r, 300));
      ws.send(JSON.stringify({ type: "stop" }));
      await closed;
      expect(msgs[0]).toEqual({ type: "ready", model: "deepgram:nova-3", recording: true });
      const fin = msgs.find((m) => m.type === "final");
      expect(fin).toMatchObject({ text: "draw box", clip: expect.stringMatching(/^deepgram-/) });
      expect(fin.span).toBeUndefined();
      const [row] = rows(path.join(store.dir, "clips.jsonl"));
      // 0.3-0.6 s of words, padded 0.25 s before and 0.35 s after.
      expect(row).toMatchObject({ id: fin.clip, heard: "draw box", source: "deepgram", model: "deepgram:nova-3", seconds: 0.9 });
    } finally {
      await app.close();
      await new Promise((r) => fake.close(r));
    }
  });
});
