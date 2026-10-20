import { describe, expect, it } from "vitest";
import type { ClipItem, ClipSource, ClipStatus } from "@board/shared";
import { DEFAULT_FILTERS, facetCounts, filterItems, initialText, minutes } from "./clipFilter";

const item = (key: string, source: ClipSource, status: ClipStatus, heard: string, text?: string): ClipItem => ({
  key,
  clips: [{ id: key, heard, seconds: 30, source, model: `${source}:m`, at: "2026-10-20T10:00:00" }],
  heard,
  text,
  status,
  source,
  seconds: 30,
  at: "2026-10-20T10:00:00",
});

const items = [
  item("a", "moonshine", "unreviewed", "set june"),
  item("b", "moonshine", "fixed", "draw a fox", "draw a box"),
  item("c", "deepgram", "confirmed", "zoom in", "zoom in"),
  item("d", "assemblyai", "unreviewed", "Undo."),
];

describe("clips dashboard filters", () => {
  it("filters by transcript source, review state and text (heard or label)", () => {
    expect(filterItems(items, { ...DEFAULT_FILTERS, source: "moonshine" }).map((i) => i.key)).toEqual(["a", "b"]);
    expect(filterItems(items, { ...DEFAULT_FILTERS, source: "moonshine", status: "unreviewed" }).map((i) => i.key)).toEqual(["a"]);
    expect(filterItems(items, { ...DEFAULT_FILTERS, query: "BOX" }).map((i) => i.key)).toEqual(["b"]);
    expect(filterItems(items, { ...DEFAULT_FILTERS, query: "fox" }).map((i) => i.key)).toEqual(["b"]);
    expect(minutes(filterItems(items, DEFAULT_FILTERS))).toBe(2);
  });

  it("counts each chip with the other filters applied", () => {
    const { sources, statuses } = facetCounts(items, { ...DEFAULT_FILTERS, status: "unreviewed" });
    expect(sources).toEqual({ all: 2, moonshine: 1, deepgram: 0, assemblyai: 1 });
    expect(statuses).toEqual({ all: 4, unreviewed: 2, fixed: 1, confirmed: 1 });
    expect(facetCounts(items, { ...DEFAULT_FILTERS, source: "deepgram" }).statuses).toEqual({
      all: 1,
      unreviewed: 0,
      fixed: 0,
      confirmed: 1,
    });
  });

  it("starts the text box at the label, else what was heard", () => {
    expect(initialText(items[1])).toBe("draw a box");
    expect(initialText(items[0])).toBe("set june");
  });
});
