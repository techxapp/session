import { AddChart, type BoardAction, type CHART_KINDS, type Color } from "@board/shared";
import type { ChartSpec } from "./chart";
import { SERIES_COLORS } from "./plot-base";
import { PALETTE } from "./style";

/**
 * The chart editor's working copy (ChartEditor.tsx). Values stay as typed text so "-" or "1." can be typed;
 * draftToAction() turns it into the same `add_chart` + `replace` action the model sends, validated by the
 * shared schema, so a manual edit goes through the executor, undo and the activity log like any command.
 */
export type ChartKind = (typeof CHART_KINDS)[number];

export interface DraftSeries {
  name: string;
  color: Color;
  values: string[];
}

export interface ChartDraft {
  kind: ChartKind;
  title: string;
  unit: string;
  labels: string[];
  /** Slice colours for pie/donut, one per label (kept while the kind is a series chart, and the other way round). */
  labelColors: Color[];
  series: DraftSeries[];
}

export const MAX_LABELS = 24;
export const MAX_SERIES = 6;

export const isPie = (kind: ChartKind) => kind === "pie" || kind === "donut";

/** Series a chart of this kind shows: pie/donut use only the first. */
export const shownSeries = (d: ChartDraft) => (isPie(d.kind) ? d.series.slice(0, 1) : d.series);

const COLOR_NAMES = Object.keys(PALETTE) as Color[];
const nameOf = (hex: string | undefined): Color | undefined =>
  COLOR_NAMES.find((c) => PALETTE[c].stroke.toLowerCase() === hex?.toLowerCase());
const defaultColor = (i: number): Color => SERIES_COLORS[i % SERIES_COLORS.length];

/** First default colour not in `used`. */
export function nextColor(used: readonly Color[]): Color {
  return SERIES_COLORS.find((c) => !used.includes(c)) ?? defaultColor(used.length);
}

export function draftFromSpec(spec: ChartSpec): ChartDraft {
  const pie = isPie(spec.chart);
  return {
    kind: spec.chart,
    title: spec.title ?? "",
    unit: spec.unit ?? "",
    labels: [...spec.labels],
    labelColors: spec.labels.map((_, i) => (pie && nameOf(spec.colors[i])) || defaultColor(i)),
    series: spec.series.map((s, i) => ({
      name: s.name ?? "",
      color: (!pie && nameOf(spec.colors[i])) || defaultColor(i),
      values: s.values.map(String),
    })),
  };
}

/** A typed value as a number ("1,200" and " 3.5 " are fine); undefined if it isn't one. */
export function parseValue(text: string): number | undefined {
  const t = text.replace(/[,\s]/g, "");
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

export function addRow(d: ChartDraft): ChartDraft {
  if (d.labels.length >= MAX_LABELS) return d;
  return {
    ...d,
    labels: [...d.labels, ""],
    labelColors: [...d.labelColors, nextColor(d.labelColors)],
    series: d.series.map((s) => ({ ...s, values: [...s.values, ""] })),
  };
}

export function removeRow(d: ChartDraft, i: number): ChartDraft {
  if (d.labels.length <= 1) return d;
  const drop = <T>(a: T[]) => a.filter((_, j) => j !== i);
  return {
    ...d,
    labels: drop(d.labels),
    labelColors: drop(d.labelColors),
    series: d.series.map((s) => ({ ...s, values: drop(s.values) })),
  };
}

export function addSeries(d: ChartDraft): ChartDraft {
  if (d.series.length >= MAX_SERIES) return d;
  const color = nextColor(d.series.map((s) => s.color));
  return { ...d, series: [...d.series, { name: `Series ${d.series.length + 1}`, color, values: d.labels.map(() => "") }] };
}

export function removeSeries(d: ChartDraft, i: number): ChartDraft {
  if (d.series.length <= 1) return d;
  return { ...d, series: d.series.filter((_, j) => j !== i) };
}

/**
 * Paste a block of cells (tab-separated rows, as spreadsheets copy them) starting at a cell: `col` -1 is the
 * label column, 0.. the series. Adds rows and series as needed, up to the chart limits; pie/donut keep one series.
 */
export function pasteCells(d: ChartDraft, row: number, col: number, text: string): ChartDraft {
  const rows = text
    .replace(/\r\n?/g, "\n")
    .replace(/\n+$/, "")
    .split("\n")
    .map((r) => r.split("\t"));
  const maxSeries = isPie(d.kind) ? 1 : MAX_SERIES;
  let next = d;
  rows.forEach((cells, r) => {
    const at = row + r;
    if (at >= MAX_LABELS) return;
    while (next.labels.length <= at) next = addRow(next);
    cells.forEach((cell, c) => {
      const column = col + c;
      if (column >= maxSeries) return;
      const value = cell.trim();
      if (column < 0) {
        next = { ...next, labels: next.labels.map((l, j) => (j === at ? value : l)) };
        return;
      }
      while (next.series.length <= column) next = addSeries(next);
      next = {
        ...next,
        series: next.series.map((s, j) => (j === column ? { ...s, values: s.values.map((v, k) => (k === at ? value : v)) } : s)),
      };
    });
  });
  return next;
}

export type DraftResult = { ok: true; action: Extract<BoardAction, { name: "add_chart" }> } | { ok: false; error: string };

/** The draft as an `add_chart` that redraws chart `id` in place, or the first thing to fix. */
export function draftToAction(d: ChartDraft, id: string): DraftResult {
  const series = shownSeries(d);
  for (let i = 0; i < d.labels.length; i++) {
    if (!d.labels[i].trim()) return { ok: false, error: `Row ${i + 1} needs a label.` };
    for (const s of series) {
      if (parseValue(s.values[i]) === undefined) {
        const where = series.length > 1 ? ` for ${s.name.trim() || "a series"}` : "";
        return { ok: false, error: `"${d.labels[i].trim()}" needs a number${where}.` };
      }
    }
  }
  const parsed = AddChart.safeParse({
    replace: id,
    kind: d.kind,
    labels: d.labels.map((l) => l.trim()),
    series: series.map((s) => ({ ...(s.name.trim() ? { name: s.name.trim() } : {}), values: s.values.map((v) => parseValue(v)!) })),
    title: d.title.trim(),
    unit: d.unit.trim() ? d.unit.trimEnd() : "", // a leading space is part of a suffix unit (" kg")
    colors: isPie(d.kind) ? d.labelColors : series.map((s) => s.color),
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the chart data." };
  return { ok: true, action: { name: "add_chart", input: parsed.data } };
}

/** What the chart will look like after applying (same spec the executor builds), for the editor's preview. */
export function previewSpec(d: ChartDraft, base: ChartSpec): ChartSpec | undefined {
  const res = draftToAction(d, "preview");
  if (!res.ok) return undefined;
  const { input } = res.action;
  return {
    kind: "chart",
    chart: input.kind,
    labels: input.labels,
    series: input.series.map((s) => ({ ...(s.name ? { name: s.name } : {}), values: s.values })),
    colors: (input.colors ?? []).map((c) => PALETTE[c].stroke),
    ...(input.title ? { title: input.title } : {}),
    ...(input.unit ? { unit: input.unit } : {}),
    w: base.w,
    h: base.h,
  };
}
