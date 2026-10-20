import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { CLIP_SOURCES, type ClipInfo, type ClipItem, type ClipSource, type ClipStatus } from "@board/shared";

/**
 * The voice-clip folder (fine-tuning data; see stt/build_manifest.py), shared with the Moonshine sidecar:
 *   audio/<id>.wav   16 kHz mono int16, one spoken line
 *   clips.jsonl      {id, audio, heard, seconds, source, model, at} per clip; `heard` is the transcript from `source`
 *   labels.jsonl     {clips, heard, text, from, at}: the true text for one or more clips; the last one for a clip wins
 * The sidecar appends Moonshine's clips; this server appends Deepgram's/AssemblyAI's (the relay in stt.ts), writes
 * every label (activity panel Fix/Save, the clips dashboard) and deletes clips. All writes are appends, except a
 * delete, which rewrites the two .jsonl files.
 */

export const CLIP_RATE = 16000;
export const CLIP_ID = /^[\w-]{1,64}$/;
const MAX_TEXT = 500;
const REPO = fileURLToPath(new URL("../../", import.meta.url));

/** STT_CLIPS_DIR (relative = from the repo root, as the sidecar reads it), default stt/clips. */
export const clipsDirFromEnv = (env: NodeJS.ProcessEnv = process.env) => path.resolve(REPO, env.STT_CLIPS_DIR?.trim() || "stt/clips");

export const oneLine = (text: unknown) =>
  String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TEXT);

/** Rows written before `source` existed are Moonshine's ("moonshine:small"). */
export const sourceOf = (row: { source?: string; model?: string }): ClipSource => {
  const s = (row.source ?? row.model?.split(":")[0] ?? "") as ClipSource;
  return CLIP_SOURCES.includes(s) ? s : "moonshine";
};

/** Same words, ignoring case and punctuation: a label that only confirms what was heard. */
const sameWords = (a: string, b: string) => {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}' ]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  return norm(a) === norm(b);
};

export function wavBytes(pcm: Int16Array, rate: number): Buffer {
  const out = Buffer.alloc(44 + pcm.length * 2);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + pcm.length * 2, 4);
  out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(1, 22); // mono
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(pcm.length * 2, 40);
  for (let i = 0; i < pcm.length; i++) out.writeInt16LE(pcm[i], 44 + i * 2);
  return out;
}

const TAPS = 16; // windowed-sinc half-width, in output-rate samples

/** Band-limited resampling (Hann-windowed sinc, low-passed below the lower Nyquist), e.g. the mic's 48 kHz to 16 kHz. */
export function resample(x: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return x.slice();
  const ratio = to / from;
  const cutoff = Math.min(1, ratio) * 0.95; // of the input's Nyquist
  const half = Math.ceil(TAPS / cutoff); // in input samples
  const out = new Float32Array(Math.floor(x.length * ratio));
  for (let i = 0; i < out.length; i++) {
    const t = i / ratio;
    const c = Math.floor(t);
    let sum = 0;
    let norm = 0;
    for (let k = Math.max(0, c - half + 1); k <= Math.min(x.length - 1, c + half); k++) {
      const d = t - k;
      if (Math.abs(d) >= half) continue;
      const a = Math.PI * cutoff * d;
      const h = (d === 0 ? 1 : Math.sin(a) / a) * (0.5 + 0.5 * Math.cos((Math.PI * d) / half));
      sum += x[k] * h;
      norm += h;
    }
    out[i] = norm ? sum / norm : 0;
  }
  return out;
}

export const toInt16 = (x: Float32Array) => Int16Array.from(x, (v) => Math.round(Math.max(-1, Math.min(1, v)) * 32767));

/**
 * The last `keepS` seconds of a relayed stream (int16 at the browser's rate), so a finished line can be cut out of it
 * by the provider's word times, which count seconds of audio sent from the stream's start.
 */
export class LineRecorder {
  private chunks: Int16Array[] = [];
  private first = 0; // stream sample index of chunks[0][0]
  private total = 0;

  constructor(
    readonly rate: number,
    private keepS = 60,
  ) {}

  push(pcm: Int16Array) {
    this.chunks.push(pcm);
    this.total += pcm.length;
    while (this.chunks.length > 1 && this.total - this.first - this.chunks[0].length >= this.keepS * this.rate)
      this.first += this.chunks.shift()!.length;
  }

  /** Seconds [startS, endS) of the stream, as float at CLIP_RATE; undefined if none of it is still kept. */
  cut(startS: number, endS: number): Float32Array | undefined {
    const a = Math.max(this.first, Math.floor(startS * this.rate));
    const b = Math.min(this.total, Math.ceil(endS * this.rate));
    if (b - a < this.rate * 0.1) return undefined;
    const x = new Float32Array(b - a);
    let pos = this.first;
    for (const c of this.chunks) {
      const lo = Math.max(a, pos);
      const hi = Math.min(b, pos + c.length);
      for (let i = lo; i < hi; i++) x[i - a] = c[i - pos] / 32768;
      pos += c.length;
      if (pos >= b) break;
    }
    return resample(x, this.rate, CLIP_RATE);
  }
}

interface ClipRow extends Partial<ClipInfo> {
  id: string;
  audio: string;
}
interface LabelRow {
  clips: string[];
  heard?: string;
  text: string;
  from?: string;
  at?: string;
}
export interface LabelIn {
  clips: string[];
  heard?: string;
  text: string;
}

const stamp = (d = new Date()) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
const now = (d = new Date()) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

function parseJsonl<T>(text: string): T[] {
  const out: T[] = [];
  for (const line of text.split("\n"))
    if (line.trim())
      try {
        out.push(JSON.parse(line));
      } catch {
        /* a broken line (e.g. cut off by a crash) is skipped, as build_manifest.py does */
      }
  return out;
}

/**
 * Clips + labels -> the examples build_manifest.py would train on: the last label for a set of clips wins, a clip
 * in a later label leaves any earlier one it was part of, and unlabelled clips stand alone. Newest first.
 */
export function itemsOf(rows: ClipRow[], labels: LabelRow[]): ClipItem[] {
  const clips = new Map<string, ClipInfo>();
  for (const r of rows)
    clips.set(r.id, {
      id: r.id,
      heard: r.heard ?? "",
      seconds: r.seconds ?? 0,
      source: sourceOf(r),
      model: r.model ?? "",
      at: r.at ?? "",
    });
  const latest = new Map<string, LabelRow>();
  for (const l of labels) {
    if (!l.clips?.length || !l.clips.every((c) => clips.has(c))) continue;
    for (const key of [...latest.keys()]) if (key.split("+").some((c) => l.clips.includes(c))) latest.delete(key);
    latest.set(l.clips.join("+"), l);
  }
  const items: ClipItem[] = [];
  const item = (cs: ClipInfo[], text?: string): ClipItem => {
    const heard = cs.map((c) => c.heard).join(" ");
    const status: ClipStatus = text === undefined ? "unreviewed" : sameWords(text, heard) ? "confirmed" : "fixed";
    const seconds = Math.round(cs.reduce((s, c) => s + c.seconds, 0) * 100) / 100;
    return { key: cs.map((c) => c.id).join("+"), clips: cs, heard, text, status, source: cs[0].source, seconds, at: cs[0].at };
  };
  const used = new Set<string>();
  for (const [key, l] of latest) {
    const ids = key.split("+");
    ids.forEach((c) => used.add(c));
    items.push(
      item(
        ids.map((c) => clips.get(c)!),
        l.text,
      ),
    );
  }
  for (const c of clips.values()) if (!used.has(c.id)) items.push(item([c]));
  return items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.key < b.key ? 1 : -1));
}

export class ClipStore {
  private session = stamp();
  private count = 0;

  constructor(readonly dir: string) {}

  /** Write one line's audio (float at CLIP_RATE) and its row; returns the clip id. Synchronous: a line is ~100 kB. */
  save(audio: Float32Array, heard: string, source: ClipSource, model: string): string {
    const id = `${source}-${this.session}-${String(++this.count).padStart(3, "0")}`;
    mkdirSync(path.join(this.dir, "audio"), { recursive: true });
    writeFileSync(path.join(this.dir, "audio", `${id}.wav`), wavBytes(toInt16(audio), CLIP_RATE));
    const seconds = Math.round((audio.length / CLIP_RATE) * 100) / 100;
    this.append("clips.jsonl", { id, audio: `audio/${id}.wav`, heard: oneLine(heard), seconds, source, model, at: now() });
    return id;
  }

  /** Append labels; ones with no text are skipped. Returns how many were kept. */
  label(labels: LabelIn[], from: string): number {
    let kept = 0;
    for (const l of labels) {
      const text = oneLine(l.text);
      if (!text || !l.clips.length || !l.clips.every((c) => CLIP_ID.test(c))) continue;
      this.append("labels.jsonl", { clips: l.clips, heard: oneLine(l.heard), text, from, at: now() });
      kept++;
    }
    return kept;
  }

  /** Clips whose audio file is still there (a deleted or missing WAV drops its clip, as in build_manifest.py). */
  async rows(): Promise<ClipRow[]> {
    const rows = parseJsonl<ClipRow>(await this.read("clips.jsonl"));
    const present = new Set(await readdir(path.join(this.dir, "audio")).catch(() => [] as string[]));
    return rows.filter(
      (r) => typeof r.id === "string" && CLIP_ID.test(r.id) && present.has(`${r.id}.wav`) && r.audio === `audio/${r.id}.wav`,
    );
  }

  async list(): Promise<ClipItem[]> {
    return itemsOf(await this.rows(), parseJsonl<LabelRow>(await this.read("labels.jsonl")));
  }

  /** The WAV of a listed clip, or undefined. */
  async audioPath(id: string): Promise<string | undefined> {
    if (!CLIP_ID.test(id)) return undefined;
    const row = (await this.rows()).find((r) => r.id === id);
    return row ? path.join(this.dir, "audio", `${id}.wav`) : undefined;
  }

  /**
   * Delete clips for good: their WAVs, joined WAVs made from them, their clips.jsonl rows and any label naming
   * them. Returns how many clips were removed.
   */
  async delete(ids: string[]): Promise<number> {
    const gone = new Set(ids.filter((id) => CLIP_ID.test(id)));
    let removed = 0;
    for (const id of gone)
      await unlink(path.join(this.dir, "audio", `${id}.wav`)).then(
        () => removed++,
        () => undefined,
      );
    const joined = path.join(this.dir, "joined");
    for (const f of await readdir(joined).catch(() => [] as string[]))
      if (
        f
          .replace(/\.wav$/, "")
          .split("+")
          .some((id) => gone.has(id))
      )
        await unlink(path.join(joined, f)).catch(() => undefined);
    await this.rewrite("clips.jsonl", (r: ClipRow) => !gone.has(r.id));
    await this.rewrite("labels.jsonl", (l: LabelRow) => !l.clips?.some((c) => gone.has(c)));
    return removed;
  }

  private append(name: string, row: object) {
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(path.join(this.dir, name), JSON.stringify(row) + "\n", "utf8");
  }

  private read(name: string) {
    return readFile(path.join(this.dir, name), "utf8").catch(() => "");
  }

  /**
   * Keep only the lines `keep` accepts. The sidecar may append to clips.jsonl meanwhile, so the file is checked
   * just before the swap and the filter redone if it grew. Unparseable lines are kept as they were.
   */
  private async rewrite<T>(name: string, keep: (row: T) => boolean) {
    const file = path.join(this.dir, name);
    if (!existsSync(file)) return;
    for (let attempt = 0; attempt < 5; attempt++) {
      const before = await stat(file);
      const text = await readFile(file, "utf8");
      const lines = text.split("\n").filter((line) => {
        if (!line.trim()) return false;
        try {
          return keep(JSON.parse(line));
        } catch {
          return true;
        }
      });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, lines.map((l) => l + "\n").join(""), "utf8");
      if ((await stat(file)).size !== before.size) continue;
      try {
        await rename(tmp, file);
        return;
      } catch {
        // Windows: the sidecar has the file open for a moment; try again.
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    await unlink(`${file}.tmp`).catch(() => undefined);
    throw new Error(`couldn't rewrite ${name}`);
  }
}

const Id = z.string().regex(CLIP_ID);
const LabelsBody = z.object({
  labels: z
    .array(z.object({ clips: z.array(Id).min(1).max(20), heard: z.string().max(2000).optional(), text: z.string().max(2000) }))
    .max(100),
  from: z.enum(["activity", "dashboard"]).default("activity"),
});
const DeleteBody = z.object({ clips: z.array(Id).min(1).max(1000) });

/**
 * These routes read and write the user's voice recordings. Another site's page can't read the answers (no CORS),
 * but it could still send a request or embed the audio, so cross-site requests are refused.
 */
function crossSite(req: FastifyRequest) {
  if (req.headers["sec-fetch-site"] === "cross-site") return true;
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host !== req.headers.host;
  } catch {
    return true;
  }
}

/** /api/clips: list, play, label and delete saved voice clips (the clips dashboard, the activity panel's labels). */
export function clipRoutes(app: FastifyInstance, store: ClipStore) {
  app.addHook("onRequest", async (req, reply) => {
    if (req.url.startsWith("/api/clips") && crossSite(req)) return reply.code(403).send({ error: "Cross-site request refused." });
  });

  app.get("/api/clips", async () => ({ dir: store.dir, items: await store.list() }));

  app.get<{ Params: { id: string } }>("/api/clips/audio/:id", async (req, reply) => {
    const file = await store.audioPath(req.params.id.replace(/\.wav$/, ""));
    if (!file) return reply.code(404).send({ error: "No such clip." });
    return reply
      .type("audio/wav")
      .header("cache-control", "no-store")
      .send(await readFile(file));
  });

  app.post("/api/clips/labels", async (req, reply) => {
    const body = LabelsBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: z.prettifyError(body.error) });
    return { count: store.label(body.data.labels, body.data.from) };
  });

  app.post("/api/clips/delete", async (req, reply) => {
    const body = DeleteBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: z.prettifyError(body.error) });
    return { deleted: await store.delete(body.data.clips) };
  });
}
