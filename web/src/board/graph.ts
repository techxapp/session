import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { parseEquation } from "@board/shared";
import { FONT_ATTR, type HoverReadout, esc, formatNumber, r1, specFileId, ticks, toScene } from "./plot-base";

/**
 * Equation graphs (`plot_graph`): y = f(x) curves on axes. A graph is one image element whose customData is
 * the whole spec; the PNG is drawn from it (plots.ts#loadPlotFiles) and the hover readout evaluates the same
 * equations at the pointer.
 */
export interface GraphSpec {
  kind: "graph";
  /** Display form, "y = x^2"; parsed again wherever needed. */
  equations: string[];
  /** Stroke colours (hex), one per equation. */
  colors: string[];
  x: [number, number];
  y: [number, number];
  /** y range was fitted to the curves (refit when curves are added). */
  yAuto: boolean;
  title?: string;
  /** Design size in px. */
  w: number;
  h: number;
}

export const DEFAULT_X: [number, number] = [-10, 10];
const SAMPLES = 480;

export function graphOf(el: ExcalidrawElement): GraphSpec | undefined {
  return el.type === "image" && el.customData?.kind === "graph" ? (el.customData as GraphSpec) : undefined;
}

export const graphFileId = (s: GraphSpec) => specFileId("graph:", [s.equations, s.colors, s.x, s.y, s.title ?? "", s.w, s.h]);

/**
 * A y range that shows the curves: their full extent, unless a few samples shoot off (tan, 1/x), then the
 * middle 96% of values. Padded so the curve doesn't run along the frame.
 */
export function fitY(equations: string[], x: [number, number]): [number, number] {
  const ys: number[] = [];
  for (const eq of equations) {
    const { f } = parseEquation(eq);
    for (let i = 0; i <= SAMPLES; i++) {
      const v = f(x[0] + ((x[1] - x[0]) * i) / SAMPLES);
      if (!Number.isNaN(v)) ys.push(v);
    }
  }
  if (!ys.length) return [-10, 10];
  ys.sort((a, b) => a - b);
  const q = (p: number) => ys[Math.round(p * (ys.length - 1))];
  let [lo, hi] = [ys[0], ys.at(-1)!];
  const [qlo, qhi] = [q(0.02), q(0.98)];
  if (qhi > qlo && hi - lo > 3 * (qhi - qlo)) [lo, hi] = [qlo, qhi];
  if (hi - lo < 1e-9) return [lo - 1, hi + 1];
  const pad = (hi - lo) * 0.06;
  return [lo - pad, hi + pad];
}

/** Where the plot area sits inside the design size. */
export function plotArea(spec: Pick<GraphSpec, "w" | "h" | "title">) {
  return { left: 54, top: spec.title ? 40 : 18, right: spec.w - 18, bottom: spec.h - 32 };
}

function axisTicks(spec: GraphSpec) {
  const a = plotArea(spec);
  return {
    xt: ticks(spec.x[0], spec.x[1], Math.max(4, Math.round((a.right - a.left) / 70))),
    yt: ticks(spec.y[0], spec.y[1], Math.max(3, Math.round((a.bottom - a.top) / 50))),
  };
}

/** The graph as an SVG document (white card, grid, axes, ticks, curves, legend, title). */
export function renderGraphSvg(spec: GraphSpec): string {
  const { w, h } = spec;
  const a = plotArea(spec);
  const [x0, x1] = spec.x;
  const [y0, y1] = spec.y;
  const sx = (x: number) => a.left + ((x - x0) / (x1 - x0)) * (a.right - a.left);
  const sy = (y: number) => a.bottom - ((y - y0) / (y1 - y0)) * (a.bottom - a.top);
  const { xt, yt } = axisTicks(spec);
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
    `<defs><clipPath id="plot"><rect x="${a.left}" y="${a.top}" width="${a.right - a.left}" height="${a.bottom - a.top}"/></clipPath></defs>`,
    `<rect x="0.75" y="0.75" width="${w - 1.5}" height="${h - 1.5}" rx="10" fill="#ffffff" stroke="#ced4da" stroke-width="1.5"/>`,
  ];
  // Grid + tick labels (labels sit on the frame, so they stay readable wherever the axes are).
  for (const v of xt.values) {
    const X = r1(sx(v));
    parts.push(`<line x1="${X}" y1="${a.top}" x2="${X}" y2="${a.bottom}" stroke="#eef0f2"/>`);
    parts.push(
      `<text x="${X}" y="${a.bottom + 18}" font-size="12" fill="#495057" text-anchor="middle" ${FONT_ATTR}>${formatNumber(v, xt.step)}</text>`,
    );
  }
  for (const v of yt.values) {
    const Y = r1(sy(v));
    parts.push(`<line x1="${a.left}" y1="${Y}" x2="${a.right}" y2="${Y}" stroke="#eef0f2"/>`);
    parts.push(
      `<text x="${a.left - 8}" y="${Y + 4}" font-size="12" fill="#495057" text-anchor="end" ${FONT_ATTR}>${formatNumber(v, yt.step)}</text>`,
    );
  }
  parts.push(`<rect x="${a.left}" y="${a.top}" width="${a.right - a.left}" height="${a.bottom - a.top}" fill="none" stroke="#dee2e6"/>`);
  // Axes through the origin, when it's in view.
  if (x0 <= 0 && x1 >= 0)
    parts.push(`<line x1="${r1(sx(0))}" y1="${a.top}" x2="${r1(sx(0))}" y2="${a.bottom}" stroke="#495057" stroke-width="1.5"/>`);
  if (y0 <= 0 && y1 >= 0)
    parts.push(`<line x1="${a.left}" y1="${r1(sy(0))}" x2="${a.right}" y2="${r1(sy(0))}" stroke="#495057" stroke-width="1.5"/>`);

  const span = y1 - y0;
  const clamp = (y: number) => Math.min(y1 + span, Math.max(y0 - span, y));
  const outside = (y: number) => y < y0 || y > y1;
  spec.equations.forEach((eq, i) => {
    const { f } = parseEquation(eq);
    let d = "";
    let prev: number | undefined;
    for (let k = 0; k <= SAMPLES; k++) {
      const x = x0 + ((x1 - x0) * k) / SAMPLES;
      const y = f(x);
      if (Number.isNaN(y)) {
        prev = undefined;
        continue;
      }
      // Break the line at jumps (tan, 1/x) instead of joining across them.
      const jump = prev !== undefined && (outside(y) || outside(prev)) && Math.abs(y - prev) > span;
      d += `${prev === undefined || jump ? "M" : "L"}${r1(sx(x))} ${r1(sy(clamp(y)))}`;
      prev = y;
    }
    if (d)
      parts.push(
        `<path d="${d}" fill="none" stroke="${spec.colors[i]}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" clip-path="url(#plot)"/>`,
      );
  });

  // Legend, top-left inside the plot.
  const lineH = 18;
  const legendW = Math.min(a.right - a.left - 16, 34 + Math.max(...spec.equations.map((e) => e.length)) * 7.2);
  parts.push(
    `<rect x="${a.left + 8}" y="${a.top + 8}" width="${r1(legendW)}" height="${spec.equations.length * lineH + 8}" rx="4" fill="#ffffff" fill-opacity="0.85" stroke="#e9ecef"/>`,
  );
  spec.equations.forEach((eq, i) => {
    const y = a.top + 12 + lineH * i + lineH / 2;
    parts.push(
      `<line x1="${a.left + 16}" y1="${y}" x2="${a.left + 32}" y2="${y}" stroke="${spec.colors[i]}" stroke-width="3" stroke-linecap="round"/>`,
    );
    parts.push(`<text x="${a.left + 38}" y="${y + 4}" font-size="13" fill="#212529" ${FONT_ATTR}>${esc(eq)}</text>`);
  });
  if (spec.title)
    parts.push(
      `<text x="${w / 2}" y="26" font-size="16" font-weight="700" fill="#212529" text-anchor="middle" ${FONT_ATTR}>${esc(spec.title)}</text>`,
    );
  parts.push("</svg>");
  return parts.join("");
}

/** The x under scene point p and every curve's y there; null outside the plot area. */
export function graphHover(el: ExcalidrawElement, spec: GraphSpec, p: { x: number; y: number }): HoverReadout | null {
  const a = plotArea(spec);
  const m = toScene(el, spec);
  const d = m.inv(p);
  if (d.x < a.left || d.x > a.right || d.y < a.top || d.y > a.bottom) return null;
  const [x0, x1] = spec.x;
  const [y0, y1] = spec.y;
  const x = x0 + ((d.x - a.left) / (a.right - a.left)) * (x1 - x0);
  const pointerY = y1 - ((d.y - a.top) / (a.bottom - a.top)) * (y1 - y0);
  const sceneY = (y: number) => m.y(a.bottom - ((y - y0) / (y1 - y0)) * (a.bottom - a.top));
  const { xt, yt } = axisTicks(spec);
  // More decimals than the ticks show, so readouts between ticks are still precise.
  const fmtX = (v: number) => formatNumber(v, xt.step / 10);
  const fmtY = (v: number) => formatNumber(v, yt.step / 100);

  const ys = spec.equations.map((eq) => parseEquation(eq).f(x));
  let nearest = -1;
  ys.forEach((y, k) => {
    if (!Number.isNaN(y) && (nearest < 0 || Math.abs(y - pointerY) < Math.abs(ys[nearest] - pointerY))) nearest = k;
  });
  const marks: HoverReadout["marks"] = [{ type: "vline", x: p.x, top: m.y(a.top), bottom: m.y(a.bottom) }];
  ys.forEach((y, k) => {
    if (!Number.isNaN(y) && y >= y0 && y <= y1) marks.push({ type: "dot", x: p.x, y: sceneY(y), color: spec.colors[k] });
  });
  const ny = nearest >= 0 ? ys[nearest] : NaN;
  return {
    id: el.id,
    heading: `x = ${fmtX(x)}`,
    rows: spec.equations.map((label, k) => ({
      color: spec.colors[k],
      label,
      value: Number.isNaN(ys[k]) ? "undefined" : `y = ${fmtY(ys[k])}`,
      strong: spec.equations.length > 1 && k === nearest,
    })),
    marks,
    anchor: { x: p.x, y: !Number.isNaN(ny) && ny >= y0 && ny <= y1 ? sceneY(ny) : p.y },
  };
}
