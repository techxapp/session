import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { BoardAction } from "@board/shared";
import { applyAction, type ExecContext } from "../board/executor";
import { HOLD_MS, HOLD_SPEAKING_MS } from "../settings";
import { LineJoiner, PREROLL_FRAMES, WakeDetector, boardKeyterms, isCommand, joinLines, looksIncomplete, rms } from "./useVoice";

beforeAll(async () => {
  const { setCustomTextMetricsProvider } = await import("@excalidraw/excalidraw");
  setCustomTextMetricsProvider({ getLineWidth: (text: string, font: string) => text.length * (parseFloat(font) || 20) * 0.55 });
});

function board(actions: BoardAction[]) {
  const ctx: ExecContext = { viewport: { x: 0, y: 0, w: 1600, h: 900 }, recentIds: [], idMap: new Map() };
  let els: readonly ExcalidrawElement[] = [];
  for (const a of actions) els = applyAction(els, a, ctx).elements;
  return els;
}

describe("boardKeyterms", () => {
  it("lists shape and text labels once, without commas or clip-art names", () => {
    const els = board([
      { name: "add_shape", input: { id: "db", kind: "rectangle", label: "Postgres" } },
      { name: "add_shape", input: { id: "db2", kind: "ellipse", label: "postgres" } },
      { name: "add_text", input: { text: "Auth, v2", style: "title" } },
      { name: "add_object", input: { object: "tree" } },
      { name: "add_arrow", input: { from: "db", to: "db2" } },
    ]);
    expect(boardKeyterms(els)).toEqual(["draw", "flower", "Postgres", "Auth v2"]);
  });

  it("always keeps the command words, and caps the total at 50", () => {
    const els = board([
      { name: "add_shape", input: { kind: "rectangle", label: "Flower" } },
      ...Array.from({ length: 60 }, (_, i) => ({ name: "add_shape" as const, input: { kind: "rectangle" as const, label: `Box ${i}` } })),
    ]);
    const terms = boardKeyterms(els);
    expect(terms).toHaveLength(50);
    expect(terms.slice(0, 2)).toEqual(["draw", "flower"]);
    expect(terms).not.toContain("Flower");
    expect(terms.at(-1)).toBe("Box 59");
  });
});

describe("isCommand", () => {
  it("drops lines with no words", () => {
    expect(isCommand("Undo that.")).toBe(true);
    expect(isCommand("...")).toBe(false);
    expect(isCommand(" ")).toBe(false);
  });
});

describe("WakeDetector", () => {
  const frame = (level: number) => new Float32Array(1600).fill(level); // rms = |level|

  it("wakes on two loud frames in a row, not on one click", () => {
    expect(rms(frame(-0.1))).toBeCloseTo(0.1);
    const wake = new WakeDetector(0.01);
    expect(wake.push(frame(0.001))).toBe(false);
    expect(wake.push(frame(0.05))).toBe(false);
    expect(wake.push(frame(0.001))).toBe(false);
    expect(wake.push(frame(0.05))).toBe(false);
    expect(wake.push(frame(0.02))).toBe(true);
  });

  it("keeps only the last 2 s as pre-roll", () => {
    const wake = new WakeDetector(1);
    for (let i = 0; i < PREROLL_FRAMES + 5; i++) wake.push(frame(i / 1000));
    expect(wake.frames).toHaveLength(PREROLL_FRAMES);
    expect(wake.frames[0][0]).toBeCloseTo(5 / 1000);
  });
});

describe("looksIncomplete / joinLines", () => {
  it("spots lines cut off mid-command", () => {
    for (const t of [
      "draw a box and",
      "Draw a box and.",
      "put it next to",
      "add a note labelled",
      "connect the API with",
      "a circle,",
      "add a box...",
      "draw the",
    ])
      expect(looksIncomplete(t), t).toBe(true);
    for (const t of ["draw a box", "Draw a blue box.", "zoom in", "scroll up", "delete that", "start over", "move it below", "undo"])
      expect(looksIncomplete(t), t).toBe(false);
  });

  it("joins without the recogniser's full stop, keeping case", () => {
    expect(joinLines("Draw a box and.", "Next to the database.")).toBe("Draw a box and Next to the database.");
    expect(joinLines("connect it to", "Postgres")).toBe("connect it to Postgres");
    expect(joinLines("draw a box and", "I want it red")).toBe("draw a box and I want it red");
    expect(joinLines("add a box...", "a red one")).toBe("add a box a red one");
  });
});

describe("LineJoiner", () => {
  afterEach(() => vi.useRealTimers());
  const setup = (waits?: { holdMs: number; holdSpeakingMs: number }) => {
    vi.useFakeTimers();
    const ran: string[] = [];
    const shown: string[] = [];
    const j = new LineJoiner(
      (t) => ran.push(t),
      (t) => shown.push(t),
      waits,
    );
    return { j, ran, shown };
  };

  it("runs complete lines at once and skips noise", () => {
    const { j, ran } = setup();
    j.final("Draw a blue box.");
    j.final("...");
    expect(ran).toEqual(["Draw a blue box."]);
  });

  it("holds a line ending in a join word and joins the next one", () => {
    const { j, ran, shown } = setup();
    j.final("Draw a box and.");
    expect(ran).toEqual([]);
    expect(shown.at(-1)).toBe("Draw a box and \u2026");
    j.partial("Next to");
    expect(shown.at(-1)).toBe("Draw a box and Next to");
    vi.advanceTimersByTime(HOLD_MS + 100); // still speaking: keeps waiting
    expect(ran).toEqual([]);
    j.final("Next to the database.");
    expect(ran).toEqual(["Draw a box and Next to the database."]);
    expect(j.holding).toBe(false);
  });

  it("keeps holding while the joined line is still incomplete", () => {
    const { j, ran } = setup();
    j.final("add a note labelled");
    j.final("deploy and");
    expect(ran).toEqual([]);
    j.final("ship it");
    expect(ran).toEqual(["add a note labelled deploy and ship it"]);
  });

  it("runs the held line as is after a silence, or when flushed", () => {
    const { j, ran } = setup();
    j.final("draw a circle and");
    vi.advanceTimersByTime(HOLD_MS - 1);
    expect(ran).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(ran).toEqual(["draw a circle and"]);

    j.final("connect it with");
    j.partial("the");
    vi.advanceTimersByTime(HOLD_SPEAKING_MS);
    expect(ran.at(-1)).toBe("connect it with");

    j.final("put it next to");
    j.flush();
    expect(ran.at(-1)).toBe("put it next to");
    j.final("draw a box and");
    j.clear();
    vi.runAllTimers();
    expect(ran).toHaveLength(3);
  });

  it("uses the configured waits, and holdMs 0 turns joining off", () => {
    const { j, ran } = setup({ holdMs: 500, holdSpeakingMs: 2000 });
    j.final("draw a box and");
    vi.advanceTimersByTime(499);
    expect(ran).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(ran).toEqual(["draw a box and"]);
    j.final("connect it to");
    j.partial("the");
    vi.advanceTimersByTime(2000);
    expect(ran.at(-1)).toBe("connect it to");

    const off = setup({ holdMs: 0, holdSpeakingMs: HOLD_SPEAKING_MS });
    off.j.final("draw a box and");
    expect(off.ran).toEqual(["draw a box and"]);
    expect(off.j.holding).toBe(false);
  });

  it("passes on the voice clips of every line a command was joined from", () => {
    vi.useFakeTimers();
    const ran: [string, string[]][] = [];
    const j = new LineJoiner(
      (t, clips) => ran.push([t, clips]),
      () => undefined,
    );
    j.final("draw a box", "c1");
    j.final("put it next to", "c2");
    j.final("...", "c3"); // noise: not part of the command
    j.final("the database", "c4");
    j.final("connect them and", "c5");
    j.flush();
    j.final("undo"); // not recorded
    j.final("draw a box and", "c6");
    j.clear();
    j.final("zoom in", "c7");
    expect(ran).toEqual([
      ["draw a box", ["c1"]],
      ["put it next to the database", ["c2", "c4"]],
      ["connect them and", ["c5"]],
      ["undo", []],
      ["zoom in", ["c7"]],
    ]);
  });
});
