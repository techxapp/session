import { sttUrl } from "./useVoice";

/**
 * Voice clips for fine-tuning Moonshine on the user's voice. With Settings "Keep voice clips" on, the sidecar saves
 * each spoken line's audio and names the clip in its final message; when the line is fixed in the activity panel,
 * the fixed text goes back as a label (stt/server.py, labels.jsonl; stt/build_manifest.py makes the training set).
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
const TIMEOUT_MS = 3000;

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
 * Queue a label (if given) and send every queued one to the sidecar on a connection of its own. Labels that can't
 * be sent (sidecar not running) stay queued in localStorage for the next call. Resolves true once they're stored.
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
  const ok = await new Promise<boolean>((resolve) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(sttUrl(false));
    } catch {
      return resolve(false);
    }
    const done = (result: boolean) => {
      clearTimeout(timer);
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      if (ws.readyState <= WebSocket.OPEN) ws.close();
      resolve(result);
    };
    const timer = setTimeout(() => done(false), TIMEOUT_MS);
    ws.onopen = () => ws.send(JSON.stringify({ type: "label", labels }));
    ws.onmessage = (e) => done(JSON.parse(String(e.data))?.type === "labelled");
    ws.onerror = ws.onclose = () => done(false);
  });
  // Keep what was queued while this batch was in flight.
  if (ok) saveQueue(loadQueue().slice(labels.length));
  return ok;
}
