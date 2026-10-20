/**
 * Voice clips for fine-tuning Moonshine on the user's voice. With Settings "Keep voice clips" on, the speech server
 * (Moonshine: stt/server.py; Deepgram/AssemblyAI: the API server's relay) saves each spoken line's audio and names
 * the clip in its final message; when the line is fixed in the activity panel, the fixed text goes to the API server
 * as a label (POST /api/clips/labels -> labels.jsonl; server/src/clips.ts). The clips dashboard (/clips.html) reviews
 * them all, and stt/build_manifest.py makes the training set.
 */

/** A command as it was spoken: what the recogniser heard and the clips it was saved in (several if lines were joined). */
export interface SpokenLine {
  heard: string;
  clips: string[];
}

export interface ClipLabel extends SpokenLine {
  /** What was actually said. */
  text: string;
}

const QUEUE_KEY = "voice-board:clip-labels:v1";
const MAX_QUEUED = 200;
const TIMEOUT_MS = 5000;

function loadQueue(): ClipLabel[] {
  try {
    const saved = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? "[]");
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function saveQueue(queue: ClipLabel[]) {
  try {
    if (queue.length) localStorage.setItem(QUEUE_KEY, JSON.stringify(queue.slice(-MAX_QUEUED)));
    else localStorage.removeItem(QUEUE_KEY);
  } catch {
    /* storage unavailable: unsent labels last for this page only */
  }
}

let pending: Promise<boolean> | null = null;

/**
 * Queue a label (if given) and send every queued one to the API server. Labels that can't be sent (server down)
 * stay queued in localStorage for the next call. Resolves true once they're stored.
 */
export function sendClipLabels(label?: ClipLabel): Promise<boolean> {
  if (label) saveQueue([...loadQueue(), label]);
  // One send at a time; a label queued meanwhile goes with the next call.
  pending ??= flush().finally(() => (pending = null));
  return pending;
}

async function flush(): Promise<boolean> {
  const labels = loadQueue();
  if (!labels.length) return true;
  let ok = false;
  try {
    const res = await fetch("/api/clips/labels", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ labels, from: "activity" }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    ok = res.ok;
  } catch {
    /* server unreachable: keep them queued */
  }
  // Keep what was queued while this batch was in flight.
  if (ok) saveQueue(loadQueue().slice(labels.length));
  return ok;
}
