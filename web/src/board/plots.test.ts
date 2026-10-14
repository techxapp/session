import { beforeAll, describe, expect, it } from "vitest";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { type BoardAction, equationError, parseAction, parseEquation } from "@board/shared";
import { type ChartSpec, chartLayout, renderChartSvg } from "./chart";
import { applyAction, labelOf, type ExecContext } from "./executor";
import { type GraphSpec, fitY, plotArea, renderGraphSvg } from "./graph";
import { formatNumber, ticks } from "./plot-base";
import { hoverAt, plotOf } from "./plots";
import { summarize } from "./summary";

beforeAll(async () => {
  const { setCustomTextMetricsProvider } = await import("@excalidraw/excalidraw");
  setCustomTextMetricsProvider({ getLineWidth: (text: string, font: string) => text.length * (parseFloat(font) || 20) * 0.55 });
});

const ctx = (): ExecContext => ({ viewport: { x: 0, y: 0, w: 1600, h: 900 }, recentIds: [], idMap: new Map() });

/** Validate like the server does, then apply. */
function run(calls: [string, unknown][], c = ctx(), start: readonly ExcalidrawElement[] = []) {
  let els = start;
  for (const [name, input] of calls) {
    const parsed = parseAction(name, input);
    if (!parsed.ok) throw new Error(parsed.error);
    els = applyAction(els, parsed.action as BoardAction, c).elements;
  }
  return els;
}
const byId = (els: readonly ExcalidrawElement[], id: string) => els.find((e) => e.id === id)!;

describe("parseEquation", () => {
  const at = (eq: string, x: number) => parseEquation(eq).f(x);

  it("reads the usual ways of writing y = f(x)", () => {
    expect(at("y = x^2", 3)).toBe(9);
    expect(at("y=2x+1", 2)).toBe(5);
    expect(at("f(x) = 3x", 2)).toBe(6);
    expect(at("x**3 = y", 2)).toBe(8);
    expect(at("-x^2", 2)).toBe(-4);
    expect(at("2^3^2", 0)).toBe(512);
    expect(at("x^-1", 4)).toBe(0.25);
    expect(at("(x+1)(x-1)", 3)).toBe(8);
    expect(at("3(x+1)", 1)).toBe(6);
    expect(at("x sin x", Math.PI / 2)).toBeCloseTo(Math.PI / 2);
    expect(at("xsinx", Math.PI / 2)).toBeCloseTo(Math.PI / 2);
    expect(at("2sin(2x)", Math.PI / 4)).toBeCloseTo(2);
    expect(at("sin(x)/x", 1e-9)).toBeCloseTo(1);
    expect(at("|x - 2|", 0)).toBe(2);
    expect(at("2|x|+|x-1|", -1)).toBe(4);
    expect(at("e^x", 1)).toBeCloseTo(Math.E);
    expect(at("ln(e) + log(100) + log2(8)", 0)).toBeCloseTo(6);
    expect(at("2πx", 1)).toBeCloseTo(2 * Math.PI);
    expect(at("√x", 9)).toBe(3);
    expect(at("x²", 3)).toBe(9);
    expect(at("sinh(x) + cosh(x)", 1)).toBeCloseTo(Math.E);
    expect(at("x^(1/3)", -8)).toBeCloseTo(-2);
    expect(parseEquation("x^2").label).toBe("y = x^2");
    expect(parseEquation(" y =  2x  + 1 ").label).toBe("y = 2x + 1");
  });

  it("returns NaN outside the domain", () => {
    expect(at("sqrt(x)", -1)).toBeNaN();
    expect(at("ln(x)", 0)).toBeNaN();
    expect(at("1/x", 0)).toBeNaN();
  });

  it("rejects what it can't plot, with a reason", () => {
    for (const bad of ["x^2 + y^2 = 1", "y = foo(x)", "2 +", "(x", "y = 1 = 2", "", "y = x $ 2", "y = 2y"])
      expect(equationError(bad), bad).toBeTruthy();
    expect(equationError("y = cos(x)")).toBeNull();
  });
});

describe("axis helpers", () => {
  it("picks 1/2/5 steps and formats to their precision", () => {
    expect(ticks(-10, 10, 5)).toEqual({ step: 5, values: [-10, -5, 0, 5, 10] });
    expect(ticks(0, 1, 4).step).toBe(0.5);
    expect(formatNumber(2, 0.5)).toBe("2.0");
    expect(formatNumber(-0.0001, 1)).toBe("0");
  });

  it("fits y to the curve, ignoring asymptotes", () => {
    const [lo, hi] = fitY(["x^2"], [-5, 5]);
    expect(lo).toBeLessThan(0);
    expect(hi).toBeGreaterThan(25);
    expect(hi).toBeLessThan(28);
    const [tlo, thi] = fitY(["tan(x)"], [-6, 6]);
    expect(thi - tlo).toBeLessThan(200);
    expect(fitY(["5"], [-1, 1])).toEqual([4, 6]);
  });
});

describe("plot_graph", () => {
  it("draws one image element carrying the spec, named by its equation", () => {
    const els = run([["plot_graph", { id: "g", equations: ["y = x^2"], x_min: -5, x_max: 5 }]]);
    const g = byId(els, "g");
    const spec = plotOf(g) as GraphSpec;
    expect(g.type).toBe("image");
    expect(g.type === "image" && g.fileId).toMatch(/^graph:/);
    expect(spec).toMatchObject({ kind: "graph", equations: ["y = x^2"], x: [-5, 5], yAuto: true, colors: ["#1971c2"] });
    expect(spec.y[0]).toBeLessThan(0);
    expect(labelOf(els, g)).toBe("y = x^2");
    expect(summarize(els, [], [], { x: 0, y: 0, w: 1600, h: 900 }).elements[0]).toMatchObject({ type: "graph", label: "y = x^2" });
  });

  it("adds curves to an existing graph and refits y", () => {
    const c = ctx();
    let els = run([["plot_graph", { id: "g", equations: ["x"], x_min: 0, x_max: 4 }]], c);
    els = run([["plot_graph", { equations: ["x^2"], add_to: "g" }]], c, els);
    const spec = plotOf(byId(els, "g")) as GraphSpec;
    expect(els.filter((e) => !e.isDeleted)).toHaveLength(1);
    expect(spec.equations).toEqual(["y = x", "y = x^2"]);
    expect(spec.x).toEqual([0, 4]);
    expect(spec.y[1]).toBeGreaterThan(16);
    expect(spec.colors[1]).toBe("#e03131");
    expect(() => run([["plot_graph", { equations: ["x"], add_to: "nope" }]], c, els)).toThrow();
  });

  it("keeps the given y range, fills a missing x end and fixes a reversed one", () => {
    const els = run([["plot_graph", { id: "g", equations: ["x"], y_min: -1, y_max: 1, x_min: 20 }]]);
    expect(plotOf(byId(els, "g"))).toMatchObject({ x: [20, 40], y: [-1, 1], yAuto: false });
  });

  it("update_element retitles, recolours (new file) and resizes around the centre", () => {
    const c = ctx();
    let els = run([["plot_graph", { id: "g", equations: ["x"] }]], c);
    const before = byId(els, "g");
    els = run([["update_element", { target: "g", color: "green", label: "Line", size: "large" }]], c, els);
    const g = byId(els, "g");
    expect(plotOf(g)).toMatchObject({ title: "Line", colors: ["#2f9e44"] });
    expect(g.type === "image" && before.type === "image" && g.fileId !== before.fileId).toBe(true);
    expect(g.width).toBe(640);
    expect(g.x + g.width / 2).toBeCloseTo(before.x + before.width / 2);
    expect(labelOf(els, g)).toBe("Line");
  });

  it("renders curves, axes and an escaped legend", () => {
    const els = run([["plot_graph", { id: "g", equations: ["1/x", "abs(x)"], title: "a<b" }]]);
    const svg = renderGraphSvg(plotOf(byId(els, "g")) as GraphSpec);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.match(/<path /g)).toHaveLength(2);
    expect(svg).toContain("a&lt;b");
    for (const tag of svg.match(/<[a-z]+ [^>]*>/g)!) {
      const names = [...tag.matchAll(/ ([a-z-]+)="/g)].map((m) => m[1]);
      expect(new Set(names).size, tag).toBe(names.length);
    }
    // 1/x is broken at 0 rather than joined across it.
    expect((svg.match(/<path d="([^"]+)"/)![1].match(/M/g) ?? []).length).toBeGreaterThan(1);
  });
});

/** Scene point at graph coordinates (x, y) on element g. */
function scenePoint(g: ExcalidrawElement, x: number, y: number) {
  const spec = plotOf(g) as GraphSpec;
  const a = plotArea(spec);
  const fx = (x - spec.x[0]) / (spec.x[1] - spec.x[0]);
  const fy = (spec.y[1] - y) / (spec.y[1] - spec.y[0]);
  return {
    x: g.x + (a.left + fx * (a.right - a.left)) * (g.width / spec.w),
    y: g.y + (a.top + fy * (a.bottom - a.top)) * (g.height / spec.h),
  };
}

describe("hover readout", () => {
  it("reads x and every curve's y off a graph", () => {
    const els = run([["plot_graph", { id: "g", equations: ["x^2", "2x"], x_min: -5, x_max: 5 }]]);
    const g = byId(els, "g");
    const r = hoverAt(els, scenePoint(g, 2, 3.5))!;
    expect(r.heading).toBe("x = 2.0");
    expect(r.rows.map((row) => row.value)).toEqual(["y = 4.0", "y = 4.0"]);
    expect(r.marks.filter((m) => m.type === "dot")).toHaveLength(2);
    const r2 = hoverAt(els, scenePoint(g, -1, 0.9))!;
    expect(r2.rows.find((row) => row.strong)?.label).toBe("y = x^2"); // nearest to the pointer
  });

  it("still maps correctly on a resized graph, and ignores the margins and covered parts", () => {
    let els = run([["plot_graph", { id: "g", equations: ["x"], x_min: 0, x_max: 10 }]]);
    els = els.map((e) => (e.id === "g" ? { ...e, width: e.width * 2, height: e.height * 1.5 } : e));
    const g = byId(els, "g");
    expect(hoverAt(els, scenePoint(g, 7, 5))!.heading).toBe("x = 7.0");
    expect(hoverAt(els, { x: g.x + 4, y: g.y + 4 })).toBeNull();
    const p = scenePoint(g, 7, 5);
    const covered = run([["add_shape", { id: "box", kind: "rectangle", placement: { x: p.x - 10, y: p.y - 10 } }]], ctx(), els);
    expect(hoverAt(covered, p)).toBeNull();
  });

  const chart = (input: object) => {
    const els = run([["add_chart", { id: "c", ...input }]]);
    const el = byId(els, "c");
    const spec = plotOf(el) as ChartSpec;
    return { els, el, spec, L: chartLayout(spec) };
  };
  /** Design point -> scene point. */
  const at = (el: ExcalidrawElement, spec: ChartSpec, x: number, y: number) => ({
    x: el.x + (x * el.width) / spec.w,
    y: el.y + (y * el.height) / spec.h,
  });

  it("reads a column chart's bar, with every series of that category", () => {
    const { els, el, spec, L } = chart({
      kind: "column",
      title: "Sales",
      unit: "$",
      labels: ["Q1", "Q2", "Q3"],
      series: [
        { name: "2024", values: [10, 15, 12] },
        { name: "2025", values: [11, 18, -3] },
      ],
    });
    expect(labelOf(els, el)).toBe("Sales");
    expect(summarize(els, [], [], { x: 0, y: 0, w: 1600, h: 900 }).elements[0].type).toBe("chart");
    if (L.type !== "axes") throw new Error("axes layout");
    const bar = L.bars.find((b) => b.s === 1 && b.i === 1)!;
    const r = hoverAt(els, at(el, spec, bar.x + bar.w / 2, bar.y + bar.h / 2))!;
    expect(r.heading).toBe("Q2");
    expect(r.rows).toMatchObject([
      { label: "2024", value: "$15", strong: false },
      { label: "2025", value: "$18", strong: true },
    ]);
    expect(r.marks).toHaveLength(1);
    expect([L.lo, L.hi]).toEqual([-5, 20]); // whole ticks, no empty tick past the data
    const neg = L.bars.find((b) => b.s === 1 && b.i === 2)!;
    expect(neg.y).toBeCloseTo(L.pos(0)); // a negative bar hangs from the baseline
    expect(hoverAt(els, at(el, spec, neg.x + neg.w / 2, neg.y + 2))!.rows[1].value).toBe("-$3");
  });

  it("reads a pie slice with its share, and nothing in a donut's hole", () => {
    const { els, el, spec, L } = chart({ kind: "donut", labels: ["Rent", "Food", "Other"], series: [{ values: [50, 25, 25] }], unit: "%" });
    if (L.type !== "pie") throw new Error("pie layout");
    const r = hoverAt(els, at(el, spec, L.cx + L.r * 0.8, L.cy + 2))!; // just below 3 o'clock: still in the first half
    expect(r.heading).toBe("Rent");
    expect(r.rows[0].value).toBe("50%");
    expect(hoverAt(els, at(el, spec, L.cx - L.r * 0.8, L.cy - 2))!.heading).toBe("Other");
    expect(hoverAt(els, at(el, spec, L.cx, L.cy))).toBeNull();
    expect(spec.colors).toHaveLength(3); // one per slice
  });

  it("reads the nearest category of a line chart", () => {
    const { els, el, spec, L } = chart({ kind: "line", labels: ["Mon", "Tue", "Wed"], series: [{ values: [3, 5, 4] }] });
    if (L.type !== "axes") throw new Error("axes layout");
    expect(L.lo).toBe(3); // a line far from 0 is fitted to its data
    const p = L.points[0][2];
    const r = hoverAt(els, at(el, spec, p.x - L.band * 0.3, p.y + 20))!;
    expect(r.heading).toBe("Wed");
    expect(r.rows).toMatchObject([{ label: "Value", value: "4" }]);
  });

  it("renders every chart kind", () => {
    const base = { labels: ["A", "B", "C"], series: [{ values: [1, 2, 3] }] };
    for (const kind of ["column", "bar", "line", "area", "pie", "donut"]) {
      const { spec } = chart({ kind, ...base });
      const svg = renderChartSvg(spec);
      expect(svg, kind).toMatch(/^<svg.*<\/svg>$/);
      expect(svg, kind).toMatch(/>A( |<)/);
      // Well-formed: no element repeats an attribute (an invalid SVG would never load as an image).
      for (const tag of svg.match(/<[a-z]+ [^>]*>/g)!) {
        const names = [...tag.matchAll(/ ([a-z-]+)="/g)].map((m) => m[1]);
        expect(new Set(names).size, tag).toBe(names.length);
      }
    }
    const { spec } = chart({ kind: "pie", labels: ["All"], series: [{ values: [5] }] });
    expect(renderChartSvg(spec)).toContain("100%"); // a single full slice is still drawn
  });
});

describe("editing a chart (add_chart replace)", () => {
  const sales = {
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

  it("shows the data in the scene summary", () => {
    const els = run([["add_chart", { id: "c", ...sales }]]);
    expect(summarize(els, [], [], { x: 0, y: 0, w: 1600, h: 900 }).elements[0].data).toBe(
      'column; labels ["Q1","Q2","Q3"]; series "2024" [10,15,12]; series "2025" [11,18,9]; unit "$"; colors green, orange',
    );
  });

  it("redraws in place: same id, position and arrows; title, unit and colours kept by series name", () => {
    const c = ctx();
    let els = run(
      [
        ["add_chart", { id: "c", ...sales }],
        ["add_shape", { id: "box", kind: "rectangle", placement: { relative_to: "c", side: "right" } }],
        ["add_arrow", { id: "a", from: "box", to: "c" }],
      ],
      c,
    );
    const before = byId(els, "c");
    els = run(
      [
        [
          "add_chart",
          {
            replace: "c",
            kind: "line",
            labels: ["Q1", "Q2", "Q3", "Q4"],
            series: [
              { name: "2025", values: [11, 20, 9, 14] },
              { name: "2026", values: [1, 2, 3, 4] },
              { name: "2024", values: [10, 15, 12, 13] },
            ],
          },
        ],
      ],
      c,
      els,
    );
    const after = byId(els, "c");
    expect(els.filter((e) => plotOf(e))).toHaveLength(1);
    expect([after.x, after.y, after.width, after.height]).toEqual([before.x, before.y, before.width, before.height]);
    expect(after.type === "image" && before.type === "image" && after.fileId !== before.fileId).toBe(true);
    expect(plotOf(after)).toMatchObject({
      chart: "line",
      title: "Sales",
      unit: "$",
      labels: ["Q1", "Q2", "Q3", "Q4"],
      colors: ["#e8590c", "#1971c2", "#2f9e44"], // 2025 orange, new 2026 the first free default (blue), 2024 green
    });
    expect(after.boundElements?.some((b) => b.id === "a")).toBe(true);
    expect(c.recentIds[0]).toBe("c");
  });

  it("keeps pie slice colours by label, resizes around the centre and clears a title with ''", () => {
    const c = ctx();
    let els = run(
      [["add_chart", { id: "p", kind: "pie", title: "Spend", labels: ["Rent", "Food", "Other"], series: [{ values: [40, 30, 30] }] }]],
      c,
    );
    const before = byId(els, "p");
    const old = plotOf(before) as ChartSpec;
    els = run(
      [["add_chart", { replace: "p", kind: "donut", title: "", size: "large", labels: ["Rent", "Other"], series: [{ values: [60, 40] }] }]],
      c,
      els,
    );
    const after = byId(els, "p");
    expect(plotOf(after)).toMatchObject({ chart: "donut", colors: [old.colors[0], old.colors[2]], w: 640, h: 480 });
    expect((plotOf(after) as ChartSpec).title).toBeUndefined();
    expect(after.x + after.width / 2).toBeCloseTo(before.x + before.width / 2);
    expect(after.width).toBe(640);
  });

  it("gives fresh colours when switching between pie and series charts, and refuses non-charts", () => {
    const c = ctx();
    let els = run([["add_chart", { id: "c", ...sales }]], c);
    els = run([["add_chart", { replace: "c", kind: "pie", labels: ["Q1", "Q2", "Q3"], series: [{ values: [1, 2, 3] }] }]], c, els);
    expect((plotOf(byId(els, "c")) as ChartSpec).colors).toHaveLength(3);
    els = run([["plot_graph", { id: "g", equations: ["x"] }]], c, els);
    expect(() => run([["add_chart", { replace: "g", kind: "pie", labels: ["A"], series: [{ values: [1] }] }]], c, els)).toThrow(
      /Only a data chart/,
    );
  });
});
