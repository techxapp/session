import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { CHART_KINDS } from "@board/shared";
import {
  FONT_ATTR,
  type HoverMark,
  type HoverReadout,
  esc,
  fitText,
  formatNumber,
  formatValue,
  r1,
  specFileId,
  ticks,
  toScene,
} from "./plot-base";

/**
 * Data charts (`add_chart`): column, bar, line, area, pie, donut. Like equation graphs, a chart is one image
 * element whose customData is the spec; chartLayout() is the single source of geometry for both the drawing
 * and the hover readout, so they always agree.
 */
export interface ChartSpec {
  kind: "chart";
  chart: (typeof CHART_KINDS)[number];
  labels: string[];
  series: { name?: string; values: number[] }[];
  /** Hex colours: one per series, or one per slice for pie/donut. */
  colors: string[];
  title?: string;
  unit?: string;
  /** Design size in px. */
  w: number;
  h: number;
}

export function chartOf(el: ExcalidrawElement): ChartSpec | undefined {
  return el.type === "image" && el.customData?.kind === "chart" ? (el.customData as ChartSpec) : undefined;
}

export const chartFileId = (s: ChartSpec) =>
  specFileId("chart:", [s.chart, s.labels, s.series, s.colors, s.title ?? "", s.unit ?? "", s.w, s.h]);

const isPie = (s: ChartSpec) => s.chart === "pie" || s.chart === "donut";
const PREFIX_UNITS = new Set(["$", "€", "£", "¥", "₹"]);

export function withUnit(v: number, unit: string | undefined): string {
  const n = formatValue(v);
  if (!unit) return n;
  return PREFIX_UNITS.has(unit) ? (v < 0 ? `-${unit}${n.slice(1)}` : `${unit}${n}`) : `${n}${unit}`;
}

const seriesName = (s: ChartSpec, i: number) => s.series[i].name || (s.series.length > 1 ? `Series ${i + 1}` : "Value");

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
export interface Bar {
  s: number;
  i: number;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Slice {
  i: number;
  start: number;
  end: number;
  pct: number;
}

export type ChartLayout =
  | { type: "pie"; top: number; cx: number; cy: number; r: number; inner: number; slices: Slice[] }
  | {
      type: "axes";
      top: number;
      area: Box;
      /** Bar charts run their categories down the y axis. */
      horizontal: boolean;
      lo: number;
      hi: number;
      step: number;
      /** Category band width along the category axis. */
      band: number;
      bars: Bar[];
      /** Line/area points, per series. */
      points: { x: number; y: number }[][];
      /** Design position of value v along the value axis. */
      pos: (v: number) => number;
    };

/** Value axis: includes 0 (except a line far from it), rounded out to whole ticks. */
function valueRange(spec: ChartSpec, target: number) {
  const all = spec.series.flatMap((s) => s.values);
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  const keepZero = spec.chart !== "line" || (lo >= 0 && lo <= hi / 2) || (hi <= 0 && hi >= lo / 2);
  if (keepZero) [lo, hi] = [Math.min(0, lo), Math.max(0, hi)];
  if (hi - lo < 1e-9) [lo, hi] = lo === 0 ? [0, 1] : [lo - Math.abs(lo) * 0.1, hi + Math.abs(hi) * 0.1];
  const { step } = ticks(lo, hi, target);
  return { lo: Math.floor(lo / step + 1e-9) * step, hi: Math.ceil(hi / step - 1e-9) * step, step };
}

export function chartLayout(spec: ChartSpec): ChartLayout {
  const { w, h } = spec;
  const legendRow = !isPie(spec) && spec.series.length > 1;
  const top = (spec.title ? 38 : 14) + (legendRow ? 22 : 0);

  if (isPie(spec)) {
    const values = spec.series[0].values;
    const total = values.reduce((a, b) => a + Math.max(0, b), 0);
    const r = Math.max(20, Math.min((h - top - 16) / 2, w * 0.3));
    const slices: Slice[] = [];
    let at = 0;
    values.forEach((v, i) => {
      const frac = total > 0 ? Math.max(0, v) / total : 0;
      slices.push({ i, start: at, end: at + frac * 2 * Math.PI, pct: frac * 100 });
      at += frac * 2 * Math.PI;
    });
    return { type: "pie", top, cx: 18 + r, cy: top + (h - top - 8) / 2, r, inner: spec.chart === "donut" ? r * 0.58 : 0, slices };
  }

  const horizontal = spec.chart === "bar";
  const n = spec.labels.length;
  const longestLabel = Math.max(...spec.labels.map((l) => l.length));
  // First pass for tick labels' width; the axis length barely changes it.
  const vr0 = valueRange(spec, horizontal ? 5 : 5);
  const tickChars = Math.max(...[vr0.lo, vr0.hi].map((v) => withUnit(v, spec.unit).length));
  const area: Box = horizontal
    ? { left: 14 + Math.min(120, longestLabel * 7), top, right: w - 22, bottom: h - 28 }
    : { left: 14 + Math.max(24, tickChars * 7), top, right: w - 16, bottom: h - 30 };
  const valueLen = horizontal ? area.right - area.left : area.bottom - area.top;
  const vr = valueRange(spec, Math.max(3, Math.round(valueLen / (horizontal ? 80 : 50))));
  const pos = horizontal
    ? (v: number) => area.left + ((v - vr.lo) / (vr.hi - vr.lo)) * valueLen
    : (v: number) => area.bottom - ((v - vr.lo) / (vr.hi - vr.lo)) * valueLen;
  const band = (horizontal ? area.bottom - area.top : area.right - area.left) / n;
  const catStart = horizontal ? area.top : area.left;
  const zero = pos(Math.min(vr.hi, Math.max(vr.lo, 0)));

  const bars: Bar[] = [];
  const points: { x: number; y: number }[][] = [];
  if (spec.chart === "column" || spec.chart === "bar") {
    const group = band * 0.74;
    const barW = group / spec.series.length;
    spec.series.forEach((s, si) =>
      s.values.forEach((v, i) => {
        const along = catStart + band * i + (band - group) / 2 + barW * si;
        const [a, b] = [Math.min(zero, pos(v)), Math.max(zero, pos(v))];
        bars.push(horizontal ? { s: si, i, x: a, y: along, w: b - a, h: barW } : { s: si, i, x: along, y: a, w: barW, h: b - a });
      }),
    );
  } else {
    spec.series.forEach((s) => points.push(s.values.map((v, i) => ({ x: catStart + band * (i + 0.5), y: pos(v) }))));
  }
  return { type: "axes", top, area, horizontal, lo: vr.lo, hi: vr.hi, step: vr.step, band, bars, points, pos };
}

/** SVG path of a pie slice (angles clockwise from 12 o'clock), mapped by mx/my for scaled elements. */
export function slicePath(cx: number, cy: number, r: number, inner: number, start: number, end: number, kx = 1, ky = 1, ox = 0, oy = 0) {
  const pt = (rad: number, a: number) => `${r1(ox + (cx + rad * Math.sin(a)) * kx)} ${r1(oy + (cy - rad * Math.cos(a)) * ky)}`;
  const full = end - start >= 2 * Math.PI - 1e-6;
  // A full circle can't be one arc: draw it as two halves.
  const arc = (rad: number, a0: number, a1: number, sweep: 0 | 1) => {
    const large = Math.abs(a1 - a0) > Math.PI ? 1 : 0;
    return `A${r1(rad * kx)} ${r1(rad * ky)} 0 ${large} ${sweep} ${pt(rad, a1)}`;
  };
  if (full) {
    const mid = start + Math.PI;
    const outer = `M${pt(r, start)}${arc(r, start, mid, 1)}${arc(r, mid, start + 2 * Math.PI, 1)}Z`;
    return inner > 0 ? `${outer}M${pt(inner, start)}${arc(inner, start, mid, 0)}${arc(inner, mid, start, 0)}Z` : outer;
  }
  if (inner > 0) return `M${pt(r, start)}${arc(r, start, end, 1)}L${pt(inner, end)}${arc(inner, end, start, 0)}Z`;
  return `M${pt(0, 0)}L${pt(r, start)}${arc(r, start, end, 1)}Z`;
}

export function renderChartSvg(spec: ChartSpec): string {
  const { w, h } = spec;
  const L = chartLayout(spec);
  const text = (x: number, y: number, s: string, attrs = "") =>
    `<text x="${r1(x)}" y="${r1(y)}" ${attrs.includes("font-size") ? "" : `font-size="12" `}${attrs.includes("fill=") ? "" : `fill="#495057" `}${attrs} ${FONT_ATTR}>${esc(s)}</text>`;
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
    `<rect x="0.75" y="0.75" width="${w - 1.5}" height="${h - 1.5}" rx="10" fill="#ffffff" stroke="#ced4da" stroke-width="1.5"/>`,
  ];
  if (spec.title)
    parts.push(
      `<text x="${w / 2}" y="26" font-size="16" font-weight="700" fill="#212529" text-anchor="middle" ${FONT_ATTR}>${esc(spec.title)}</text>`,
    );

  if (L.type === "pie") {
    for (const s of L.slices) {
      if (s.end - s.start < 1e-9) continue;
      parts.push(
        `<path d="${slicePath(L.cx, L.cy, L.r, L.inner, s.start, s.end)}" fill="${spec.colors[s.i]}" stroke="#ffffff" stroke-width="2" fill-rule="evenodd"/>`,
      );
      if (s.pct >= 7) {
        const mid = (s.start + s.end) / 2;
        const rad = L.inner > 0 ? (L.r + L.inner) / 2 : L.r * 0.64;
        parts.push(
          text(
            L.cx + rad * Math.sin(mid),
            L.cy - rad * Math.cos(mid) + 4,
            `${Math.round(s.pct)}%`,
            `fill="#ffffff" font-weight="700" text-anchor="middle"`,
          ),
        );
      }
    }
    // Legend to the right of the pie.
    const lx = L.cx + L.r + 24;
    const n = spec.labels.length;
    const lineH = Math.min(22, (h - L.top - 12) / n);
    const y0 = L.cy - (lineH * n) / 2 + lineH / 2;
    spec.labels.forEach((label, i) => {
      const y = y0 + lineH * i;
      const value = withUnit(spec.series[0].values[i], spec.unit);
      parts.push(`<rect x="${r1(lx)}" y="${r1(y - 5)}" width="10" height="10" rx="2" fill="${spec.colors[i]}"/>`);
      parts.push(text(lx + 16, y + 4, fitText(`${label}  ${value}`, w - lx - 30, 12), `fill="#212529"`));
    });
    parts.push("</svg>");
    return parts.join("");
  }

  const { area, horizontal, pos, band } = L;
  const seriesColor = (si: number) => spec.colors[si];
  // Legend row under the title.
  if (spec.series.length > 1) {
    let x = area.left;
    const y = L.top - 12;
    spec.series.forEach((_, si) => {
      const name = fitText(seriesName(spec, si), 120, 12);
      parts.push(`<rect x="${r1(x)}" y="${y - 5}" width="10" height="10" rx="2" fill="${seriesColor(si)}"/>`);
      parts.push(text(x + 14, y + 4, name, `fill="#212529"`));
      x += 30 + name.length * 6.8;
    });
  }
  // Value grid + tick labels.
  for (let v = L.lo; v <= L.hi + L.step * 1e-6; v += L.step) {
    const p = r1(pos(v));
    const label = withUnit(Number(formatNumber(v, L.step)), spec.unit);
    if (horizontal) {
      parts.push(`<line x1="${p}" y1="${area.top}" x2="${p}" y2="${area.bottom}" stroke="#eef0f2"/>`);
      parts.push(text(p, area.bottom + 17, label, `text-anchor="middle"`));
    } else {
      parts.push(`<line x1="${area.left}" y1="${p}" x2="${area.right}" y2="${p}" stroke="#eef0f2"/>`);
      parts.push(text(area.left - 8, p + 4, label, `text-anchor="end"`));
    }
  }
  // Category labels (every nth when they'd collide).
  const every = horizontal ? Math.max(1, Math.ceil(14 / band)) : Math.max(1, Math.ceil(34 / band));
  spec.labels.forEach((label, i) => {
    if (i % every) return;
    const c = (horizontal ? area.top : area.left) + band * (i + 0.5);
    if (horizontal) parts.push(text(area.left - 8, c + 4, fitText(label, area.left - 18, 12), `text-anchor="end"`));
    else parts.push(text(c, area.bottom + 18, fitText(label, band * every - 4, 12), `text-anchor="middle"`));
  });

  const zero = pos(Math.min(L.hi, Math.max(L.lo, 0)));
  const showValues = L.bars.length > 0 && L.bars.length <= 16;
  for (const b of L.bars) {
    parts.push(
      `<rect x="${r1(b.x)}" y="${r1(b.y)}" width="${r1(Math.max(0.5, b.w))}" height="${r1(Math.max(0.5, b.h))}" rx="2" fill="${seriesColor(b.s)}"/>`,
    );
    if (!showValues) continue;
    const v = spec.series[b.s].values[b.i];
    const label = withUnit(v, spec.unit);
    if (horizontal)
      parts.push(
        text(v < 0 ? b.x - 4 : b.x + b.w + 4, b.y + b.h / 2 + 4, label, `font-size="11" text-anchor="${v < 0 ? "end" : "start"}"`),
      );
    else parts.push(text(b.x + b.w / 2, v < 0 ? b.y + b.h + 13 : b.y - 4, label, `font-size="11" text-anchor="middle"`));
  }
  L.points.forEach((pts, si) => {
    const line = pts.map((p, k) => `${k ? "L" : "M"}${r1(p.x)} ${r1(p.y)}`).join("");
    if (spec.chart === "area" && pts.length > 1)
      parts.push(
        `<path d="${line}L${r1(pts.at(-1)!.x)} ${r1(zero)}L${r1(pts[0].x)} ${r1(zero)}Z" fill="${seriesColor(si)}" fill-opacity="0.22"/>`,
      );
    parts.push(
      `<path d="${line}" fill="none" stroke="${seriesColor(si)}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`,
    );
    if (pts.length <= 30)
      for (const p of pts)
        parts.push(`<circle cx="${r1(p.x)}" cy="${r1(p.y)}" r="3.5" fill="#ffffff" stroke="${seriesColor(si)}" stroke-width="2"/>`);
  });
  // Baseline at 0.
  parts.push(
    horizontal
      ? `<line x1="${r1(zero)}" y1="${area.top}" x2="${r1(zero)}" y2="${area.bottom}" stroke="#495057" stroke-width="1.5"/>`
      : `<line x1="${area.left}" y1="${r1(zero)}" x2="${area.right}" y2="${r1(zero)}" stroke="#495057" stroke-width="1.5"/>`,
  );
  parts.push("</svg>");
  return parts.join("");
}

/** What the pointer reads off a chart: the slice, or the category (with every series' value) under it. */
export function chartHover(el: ExcalidrawElement, spec: ChartSpec, p: { x: number; y: number }): HoverReadout | null {
  const L = chartLayout(spec);
  const m = toScene(el, spec);
  const d = m.inv(p);

  if (L.type === "pie") {
    const dx = d.x - L.cx;
    const dy = d.y - L.cy;
    const dist = Math.hypot(dx, dy);
    if (dist > L.r || dist < L.inner) return null;
    let a = Math.atan2(dx, -dy);
    if (a < 0) a += 2 * Math.PI;
    const s = L.slices.find((sl) => a >= sl.start && a < sl.end);
    if (!s) return null;
    const mid = (s.start + s.end) / 2;
    // The share, unless the values are already percentages.
    const share = spec.unit === "%" ? "" : ` (${formatValue(Math.round(s.pct * 10) / 10)}%)`;
    return {
      id: el.id,
      heading: spec.labels[s.i],
      rows: [{ color: spec.colors[s.i], label: seriesName(spec, 0), value: `${withUnit(spec.series[0].values[s.i], spec.unit)}${share}` }],
      marks: [{ type: "path", d: slicePath(L.cx, L.cy, L.r, L.inner, s.start, s.end, m.kx, m.ky, el.x, el.y), color: spec.colors[s.i] }],
      anchor: { x: m.x(L.cx + L.r * Math.sin(mid)), y: m.y(L.cy - L.r * Math.cos(mid)) },
    };
  }

  const { area, horizontal, band } = L;
  if (d.x < area.left || d.x > area.right || d.y < area.top || d.y > area.bottom) return null;
  const along = horizontal ? d.y - area.top : d.x - area.left;
  const i = Math.min(spec.labels.length - 1, Math.max(0, Math.floor(along / band)));
  const marks: HoverMark[] = [];
  let hit = -1;
  let anchor = p;
  if (L.bars.length) {
    const bars = L.bars.filter((b) => b.i === i);
    const onBar = bars.find((b) => (horizontal ? d.y >= b.y && d.y <= b.y + b.h : d.x >= b.x && d.x <= b.x + b.w));
    hit = onBar?.s ?? -1;
    for (const b of onBar ? [onBar] : bars)
      marks.push({ type: "rect", x: m.x(b.x), y: m.y(b.y), w: b.w * m.kx, h: b.h * m.ky, color: spec.colors[b.s] });
    const tip = onBar ?? bars[0];
    anchor = horizontal ? { x: m.x(tip.x + tip.w), y: m.y(tip.y + tip.h / 2) } : { x: m.x(tip.x + tip.w / 2), y: m.y(tip.y) };
  } else {
    const cx = area.left + band * (i + 0.5);
    marks.push({ type: "vline", x: m.x(cx), top: m.y(area.top), bottom: m.y(area.bottom) });
    let best = Infinity;
    L.points.forEach((pts, si) => {
      const pt = pts[i];
      marks.push({ type: "dot", x: m.x(pt.x), y: m.y(pt.y), color: spec.colors[si] });
      if (Math.abs(pt.y - d.y) < best) [best, hit] = [Math.abs(pt.y - d.y), si];
    });
    const pt = L.points[hit][i];
    anchor = { x: m.x(pt.x), y: m.y(pt.y) };
  }
  return {
    id: el.id,
    heading: spec.labels[i],
    rows: spec.series.map((s, si) => ({
      color: spec.colors[si],
      label: seriesName(spec, si),
      value: withUnit(s.values[i], spec.unit),
      strong: spec.series.length > 1 && si === hit,
    })),
    marks,
    anchor,
  };
}
