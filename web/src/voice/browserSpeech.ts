/**
 * The browser's built-in Web Speech API (SpeechRecognition / webkitSpeechRecognition) as a speech provider.
 * It produces the same messages as the speech servers (see SttMessage in useVoice.ts), so the hook treats it
 * like the others. Chrome sends the audio to Google and Edge to Microsoft; Firefox has no implementation.
 * Key terms aren't supported: Chrome ignores `grammars`, and its newer `phrases` only work on-device.
 */

export type SttMessage =
  | { type: "ready"; model: string; recording?: boolean }
  | { type: "partial"; id: string; text: string }
  | { type: "final"; id: string; text: string; ms: number; clip?: string } // clip: the saved audio (stt/server.py, "record")
  | { type: "stopped" }
  | { type: "error"; message: string };

/** The parts of SpeechRecognition used here (lib.dom has only the result types). */
interface Recognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onresult: ((e: { resultIndex: number; results: ResultList }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
export type RecognitionCtor = new () => Recognition;
type ResultList = ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;

export function browserRecognition(): RecognitionCtor | undefined {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

/** Errors that end the session; others (no-speech, aborted) just mean "nothing heard", and recognition restarts. */
const FATAL: Record<string, string> = {
  "not-allowed": "Microphone access was blocked.",
  "service-not-allowed": "The browser's speech recognition isn't allowed on this page.",
  "audio-capture": "No microphone found.",
  network: "The browser's speech service is unreachable (it needs the internet; some browsers, like Brave, have none).",
  "language-not-supported": "The browser's speech recognition doesn't support English here.",
};

/**
 * One result event -> messages. Each final result is a line; the non-final results after them are the line
 * being spoken. `run` tells apart the recognitions of one session, whose result indexes restart at 0.
 */
export function resultMessages(results: ResultList, from: number, run: number): SttMessage[] {
  const out: SttMessage[] = [];
  let interim = "";
  let interimId = "";
  for (let i = from; i < results.length; i++) {
    const text = results[i][0].transcript.trim();
    if (results[i].isFinal) {
      if (text) out.push({ type: "final", id: `${run}-${i}`, text, ms: 0 });
    } else if (text) {
      interimId ||= `${run}-${i}`;
      interim = interim ? `${interim} ${text}` : text;
    }
  }
  if (interim) out.push({ type: "partial", id: interimId, text: interim });
  return out;
}

/**
 * Listens until stopped. Browsers end a "continuous" recognition after a pause or about a minute, so a new one
 * starts whenever one ends; `end` is called once, with a message if it failed. `stop` lets the line being
 * spoken finish (its final still arrives), `abort` drops it.
 */
export function listenInBrowser(Rec: RecognitionCtor, on: { message(m: SttMessage): void; end(error?: string): void }) {
  let rec: Recognition;
  let run = 0;
  let ready = false;
  let stopping = false;
  let done = false;
  let fatal: string | undefined;
  let startedAt = 0;
  let quickEnds = 0;

  const begin = () => {
    const r = run++;
    rec = new Rec();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US"; // commands are English, whatever the browser's language
    rec.maxAlternatives = 1;
    rec.onstart = () => {
      if (!ready) on.message({ type: "ready", model: "browser" });
      ready = true;
    };
    rec.onresult = (e) => resultMessages(e.results, e.resultIndex, r).forEach(on.message);
    rec.onerror = (e) => {
      fatal ??= FATAL[e.error];
    };
    rec.onend = () => {
      if (done) return;
      // A recognition that ends at once, over and over, isn't going to work (e.g. no speech service).
      quickEnds = Date.now() - startedAt < 1000 ? quickEnds + 1 : 0;
      if (stopping || fatal || quickEnds >= 3) {
        done = true;
        on.end(fatal ?? (stopping ? undefined : "The browser's speech recognition keeps stopping."));
      } else begin();
    };
    startedAt = Date.now();
    rec.start();
  };
  begin();

  return {
    stop() {
      stopping = true;
      rec.stop();
    },
    abort() {
      done = true;
      rec.abort();
    },
  };
}
