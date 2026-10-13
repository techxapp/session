import type { FileId } from "@excalidraw/excalidraw/element/types";

/**
 * Shared pieces of the drawn plots (equation graphs in graph.ts, data charts in chart.ts): sizes, axis ticks,
 * number formatting, SVG helpers and the hover readout both produce.
 */

/** Design sizes; the image element may later be scaled from these. */
export const PLOT_SIZES = { small: { w: 320, h: 240 }, medium: { w: 480, h: 360 }, large: { w: 640, h: 480 } } as const;

/** Default series colours, in order (PALETTE strokes: blue, red, green, purple, orange, teal, yellow, pink, gray). */
export const SERIES_COLORS = ["blue", "red", "green", "purple", "orange", "teal", "yellow", "pink", "gray"] as const;

export const FONT_ATTR = `font-family="Nunito, 'Segoe UI', system-ui, sans-serif"`;

/** Tick values at a 1/2/5 x 10^k step, about `target` of them across the range. */
export function ticks(lo: number, hi: number, target: number): { step: number; values: number[] } {
  const raw = (hi - lo) / Math.max(1, target);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw * 0.999)!;
  const values: number[] = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + step * 1e-9; v += step) values.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return { step, values };
}

/** A number with as many decimals as `step` needs. */
export function formatNumber(v: number, step: number): string {
  const decimals = Math.min(6, Math.max(0, -Math.floor(Math.log10(step) + 1e-9)));
  const s = v.toFixed(decimals);
  return /^-0(\.0*)?$/.test(s) ? s.slice(1) : s;
}

/** A data value as typed: up to 4 significant decimals, no trailing zeros, thousands separated. */
export function formatValue(v: number): string {
  return Number(v.toPrecision(Math.abs(v) >= 1e4 ? 12 : 6)).toLocaleString("en-US", { maximumFractionDigits: 4 });
}

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const r1 = (v: number) => Math.round(v * 10) / 10;

/** Shorten text to about `maxPx` wide at `fontSize` (rough average glyph width), with an ellipsis. */
export function fitText(s: string, maxPx: number, fontSize: number): string {
  const max = Math.max(1, Math.floor(maxPx / (fontSize * 0.56)));
  return s.length <= max ? s : `${s.slice(0, Math.max(1, max - 1))}…`;
}

/** File id from a spec: the same drawing shares one PNG, a changed one gets a new file. */
export function specFileId(prefix: string, spec: unknown): FileId {
  const s = JSON.stringify(spec);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return `${prefix}${(h >>> 0).toString(36)}` as FileId;
}

/** Overlay marks in scene coordinates, drawn by the hover layer. */
export type HoverMark =
  | { type: "dot"; x: number; y: number; color: string }
  | { type: "vline"; x: number; top: number; bottom: number }
  | { type: "rect"; x: number; y: number; w: number; h: number; color: string }
  | { type: "path"; d: string; color: string };

/** What the pointer reads off a graph or chart. */
export interface HoverReadout {
  id: string;
  heading: string;
  rows: { color: string; label: string; value: string; strong?: boolean }[];
  marks: HoverMark[];
  /** Scene point the tooltip sits beside. */
  anchor: { x: number; y: number };
}

/** Maps design units of a drawing onto its (possibly scaled) image element. */
export function toScene(el: { x: number; y: number; width: number; height: number }, spec: { w: number; h: number }) {
  const kx = el.width / spec.w;
  const ky = el.height / spec.h;
  return {
    x: (v: number) => el.x + v * kx,
    y: (v: number) => el.y + v * ky,
    /** Scene point -> design units. */
    inv: (p: { x: number; y: number }) => ({ x: (p.x - el.x) / kx, y: (p.y - el.y) / ky }),
    kx,
    ky,
  };
}
