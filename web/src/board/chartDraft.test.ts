import { beforeAll, describe, expect, it } from "vitest";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { type BoardAction, parseAction } from "@board/shared";
import type { ChartSpec } from "./chart";
import {
  type ChartDraft,
  addRow,
  addSeries,
  draftFromSpec,
  draftToAction,
  parseValue,
  pasteCells,
  previewSpec,
  removeRow,
  removeSeries,
} from "./chartDraft";
import { applyAction, type ExecContext } from "./executor";
import { plotOf } from "./plots";

beforeAll(async () => {
  const { setCustomTextMetricsProvider } = await import("@excalidraw/excalidraw");
  setCustomTextMetricsProvider({ getLineWidth: (text: string, font: string) => text.length * (parseFloat(font) || 20) * 0.55 });
});

const ctx = (): ExecContext => ({ viewport: { x: 0, y: 0, w: 1600, h: 900 }, recentIds: [], idMap: new Map() });

function apply(els: readonly ExcalidrawElement[], name: string, input: unknown) {
  const parsed = parseAction(name, input);
  if (!parsed.ok) throw new Error(parsed.error);
  return applyAction(els, parsed.action as BoardAction, ctx()).elements;
}
const specOf = (els: readonly ExcalidrawElement[], id = "c") => plotOf(els.find((e) => e.id === id)!) as ChartSpec;

const sales = {
  id: "c",
  kind: "column",
  title: "Sales",
  unit: "$",
  labels: ["Q1", "Q2", "Q3"],
  series: [
    { name: "2024", values: [10, 15, 12] },
    { name: "2025", values: [11, 18, 9] },
  ],
  colors: ["green", "orange"],
};
const pie = { id: "c", kind: "pie", labels: ["Rent", "Food"], series: [{ values: [60, 40] }], colors: ["purple", "teal"] };

/** Draft -> action -> executor, like the editor's Apply. */
function edit(els: readonly ExcalidrawElement[], fn: (d: ChartDraft) => ChartDraft) {
  const res = draftToAction(fn(draftFromSpec(specOf(els))), "c");
  if (!res.ok) throw new Error(res.error);
  return apply(els, res.action.name, res.action.input);
}

describe("chart editor draft", () => {
  it("reads a chart's data, colours by name and values as text", () => {
    const d = draftFromSpec(specOf(apply([], "add_chart", sales)));
    expect(d).toMatchObject({ kind: "column", title: "Sales", unit: "$", labels: ["Q1", "Q2", "Q3"] });
    expect(d.series).toEqual([
      { name: "2024", color: "green", values: ["10", "15", "12"] },
      { name: "2025", color: "orange", values: ["11", "18", "9"] },
    ]);
    expect(draftFromSpec(specOf(apply([], "add_chart", pie))).labelColors).toEqual(["purple", "teal"]);
  });

  it("applies an edited value in place, keeping everything else", () => {
    const els = apply([], "add_chart", sales);
    const before = els[0];
    const next = edit(els, (d) => ({ ...d, series: d.series.map((s, i) => (i === 0 ? { ...s, values: ["10", "20", "12"] } : s)) }));
    const after = next.find((e) => e.id === "c")!;
    expect([after.x, after.y, after.width]).toEqual([before.x, before.y, before.width]);
    expect(specOf(next)).toEqual({ ...specOf(els), series: [{ name: "2024", values: [10, 20, 12] }, sales.series[1]] });
  });

  it("adds and removes rows and series, giving new series an unused colour", () => {
    const els = apply([], "add_chart", sales);
    let d = addSeries(addRow(draftFromSpec(specOf(els))));
    expect(d.labels).toEqual(["Q1", "Q2", "Q3", ""]);
    expect(d.series[2]).toEqual({ name: "Series 3", color: "blue", values: ["", "", "", ""] });
    expect(draftToAction(d, "c")).toEqual({ ok: false, error: '"Q1" needs a number for Series 3.' });
    expect(draftToAction(addRow(draftFromSpec(specOf(els))), "c")).toEqual({ ok: false, error: "Row 4 needs a label." });
    d = removeSeries(removeRow(d, 0), 1);
    expect(d.labels).toEqual(["Q2", "Q3", ""]);
    expect(d.series.map((s) => s.name)).toEqual(["2024", "Series 3"]);
  });

  it("says what to fix: a missing number, a bad pie", () => {
    const d = draftFromSpec(specOf(apply([], "add_chart", sales)));
    const bad = { ...d, series: d.series.map((s, i) => (i === 1 ? { ...s, values: ["11", "lots", "9"] } : s)) };
    expect(draftToAction(bad, "c")).toEqual({ ok: false, error: '"Q2" needs a number for 2025.' });
    const negative = {
      ...draftFromSpec(specOf(apply([], "add_chart", pie))),
      series: [{ name: "", color: "blue" as const, values: ["-1", "4"] }],
    };
    expect(draftToAction(negative, "c")).toMatchObject({ ok: false, error: expect.stringMatching(/zero or more/) });
  });

  it("parses typed numbers leniently but not loosely", () => {
    expect(parseValue(" 1,200 ")).toBe(1200);
    expect(parseValue("-3.5")).toBe(-3.5);
    expect(parseValue(".5")).toBe(0.5);
    expect(parseValue("2e3")).toBe(2000);
    for (const s of ["", "-", "1.2.3", "12%", "abc", "0x10"]) expect(parseValue(s)).toBeUndefined();
  });

  it("switching to a pie uses the first series and per-slice colours", () => {
    const els = edit(apply([], "add_chart", sales), (d) => ({ ...d, kind: "donut" }));
    const spec = specOf(els);
    expect(spec.chart).toBe("donut");
    expect(spec.series).toEqual([{ name: "2024", values: [10, 15, 12] }]);
    expect(spec.colors).toHaveLength(3);
  });

  it("pastes a block of spreadsheet cells, growing rows and series", () => {
    const d = draftFromSpec(specOf(apply([], "add_chart", sales)));
    const pasted = pasteCells(d, 2, -1, "Q3\t1\t2\t3\r\nQ4\t4\t5\t6\r\n");
    expect(pasted.labels).toEqual(["Q1", "Q2", "Q3", "Q4"]);
    expect(pasted.series.map((s) => s.values)).toEqual([
      ["10", "15", "1", "4"],
      ["11", "18", "2", "5"],
      ["", "", "3", "6"],
    ]);
    // A pie keeps one series: extra columns are dropped.
    const p = pasteCells(draftFromSpec(specOf(apply([], "add_chart", pie))), 0, 0, "1\t2\n3\t4");
    expect(p.series).toHaveLength(1);
    expect(p.series[0].values).toEqual(["1", "3"]);
  });

  it("previews exactly what the executor draws", () => {
    const els = apply([], "add_chart", sales);
    const draft = { ...draftFromSpec(specOf(els)), title: "Revenue", unit: "", kind: "line" as const };
    const res = draftToAction(draft, "c");
    if (!res.ok) throw new Error(res.error);
    expect(previewSpec(draft, specOf(els))).toEqual(specOf(apply(els, "add_chart", res.action.input)));
  });
});
