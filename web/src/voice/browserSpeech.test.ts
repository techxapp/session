import { describe, expect, it } from "vitest";
import { listenInBrowser, resultMessages, type RecognitionCtor, type SttMessage } from "./browserSpeech";

const result = (transcript: string, isFinal = false) => ({ isFinal, 0: { transcript } });

describe("resultMessages", () => {
  it("turns final results into lines and the rest into the line being spoken", () => {
    const results = [result("undo", true), result(" draw a"), result(" blue box")];
    expect(resultMessages(results, 0, 2)).toEqual([
      { type: "final", id: "2-0", text: "undo", ms: 0 },
      { type: "partial", id: "2-1", text: "draw a blue box" },
    ]);
    expect(resultMessages(results, 1, 2)).toEqual([{ type: "partial", id: "2-1", text: "draw a blue box" }]);
    expect(resultMessages([result(" ", true)], 0, 0)).toEqual([]);
  });
});

/** A stand-in for SpeechRecognition that records instances; tests fire its events by hand. */
function fakeRecognition() {
  const made: Fake[] = [];
  class Fake {
    continuous = false;
    interimResults = false;
    lang = "";
    maxAlternatives = 0;
    onstart: (() => void) | null = null;
    onresult: ((e: { resultIndex: number; results: ReturnType<typeof result>[] }) => void) | null = null;
    onerror: ((e: { error: string }) => void) | null = null;
    onend: (() => void) | null = null;
    calls: string[] = [];
    constructor() {
      made.push(this);
    }
    start() {
      this.calls.push("start");
    }
    stop() {
      this.calls.push("stop");
    }
    abort() {
      this.calls.push("abort");
    }
  }
  return { Rec: Fake as unknown as RecognitionCtor, made };
}

function listen() {
  const { Rec, made } = fakeRecognition();
  const msgs: SttMessage[] = [];
  const ends: (string | undefined)[] = [];
  const handle = listenInBrowser(Rec, { message: (m) => msgs.push(m), end: (e) => ends.push(e) });
  return { handle, made, msgs, ends };
}

const later = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("listenInBrowser", () => {
  it("restarts after the browser ends a recognition, and ends once when stopped", async () => {
    const { handle, made, msgs, ends } = listen();
    expect(made[0]).toMatchObject({ continuous: true, interimResults: true, lang: "en-US", calls: ["start"] });
    made[0].onstart!();
    made[0].onresult!({ resultIndex: 0, results: [result("draw a flower", true)] });
    await later(1050); // a recognition that ran a while
    made[0].onend!();
    expect(made).toHaveLength(2);
    made[1].onstart!();
    handle.stop();
    expect(made[1].calls).toEqual(["start", "stop"]);
    made[1].onend!();
    expect(made).toHaveLength(2);
    expect(msgs).toEqual([
      { type: "ready", model: "browser" },
      { type: "final", id: "0-0", text: "draw a flower", ms: 0 },
    ]);
    expect(ends).toEqual([undefined]);
  });

  it("ends with a message on a fatal error, but not on silence", () => {
    const { made, ends } = listen();
    made[0].onerror!({ error: "no-speech" });
    made[0].onend!();
    expect(ends).toEqual([]);
    made[1].onerror!({ error: "not-allowed" });
    made[1].onend!();
    expect(ends).toEqual(["Microphone access was blocked."]);
  });

  it("gives up when recognition keeps ending at once", () => {
    const { made, ends } = listen();
    for (let i = 0; i < 3; i++) made[i].onend!();
    expect(made).toHaveLength(3);
    expect(ends).toEqual(["The browser's speech recognition keeps stopping."]);
  });

  it("abort ends without a callback", () => {
    const { handle, made, ends } = listen();
    handle.abort();
    made[0].onend!();
    expect(made[0].calls).toEqual(["start", "abort"]);
    expect(ends).toEqual([]);
  });
});
