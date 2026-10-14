import { Graph, layout } from "@dagrejs/dagre";
import { convertToExcalidrawElements, newElementWith } from "@excalidraw/excalidraw";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type { ExcalidrawElement, ExcalidrawLinearElement } from "@excalidraw/excalidraw/element/types";
import { type BoardAction, type Color, type Placement, type Side, parseEquation } from "@board/shared";
import { type Box, LANE, besides, connector, findFreeSpot, regionPoint } from "./geometry";
import type { ChartSpec } from "./chart";
import { DEFAULT_X, type GraphSpec, fitY, graphOf } from "./graph";
import { OBJECT_SIZES, objectFileId, objectOf } from "./objects";
import { PLOT_SIZES, SERIES_COLORS } from "./plot-base";
import { type PlotSpec, plotFileId, plotLabel, plotOf } from "./plots";
import { FONT, NUDGE, PALETTE, ROUGHNESS, SHAPE_SIZES, TEXT_SIZES, fitLabel } from "./style";

type El = ExcalidrawElement;
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export interface ExecContext {
  /** Visible scene area. */
  viewport: Box;
  /** Most recently created/changed ids, newest first. Updated in place. */
  recentIds: string[];
  /** Model-assigned id -> real element id (for when a requested id was already taken). */
  idMap: Map<string, string>;
}

export interface ExecResult {
  elements: El[];
  /** Element ids created or changed by this action. */
  touched: string[];
  /** Set by animate_element: `elements` is the end state; the runner plays the motion before showing it. */
  animation?: Animation;
  /** Parts of the action that were skipped (e.g. a diagram edge to an unknown element); shown in the activity log. */
  warnings?: string[];
}

export interface Animation {
  id: string;
  dx: number;
  dy: number;
  durationMs: number;
  style: "walk" | "slide";
}

export class ActionError extends Error {}

/** Elements visible to the model: not deleted, not a label bound inside a container/arrow. */
export const isTopLevel = (e: El) => !e.isDeleted && !(e.type === "text" && e.containerId);
export const boxOf = (e: El): Box => ({ x: e.x, y: e.y, w: e.width, h: e.height });

/** An element's text: its own (text), its bound label (shapes, arrows), or the object it draws (clip-art). */
export function labelOf(elements: readonly El[], el: El): string | undefined {
  if (el.type === "text") return el.originalText ?? el.text;
  if (el.type === "image") {
    const plot = plotOf(el);
    return plot ? plotLabel(plot) : objectOf(el);
  }
  const bound = elements.find((t) => t.type === "text" && !t.isDeleted && t.containerId === el.id);
  return bound && bound.type === "text" ? (bound.originalText ?? bound.text) : undefined;
}

/**
 * Apply one validated board action to the scene. Pure: returns a new element array.
 * `undo_last_command` is handled by the caller (it needs command history).
 */
export function applyAction(elements: readonly El[], action: BoardAction, ctx: ExecContext): ExecResult {
  switch (action.name) {
    case "add_shape":
      return addShape(elements, action.input, ctx);
    case "add_object":
      return addObject(elements, action.input, ctx);
    case "add_text":
      return addText(elements, action.input, ctx);
    case "add_arrow":
      return addArrow(elements, action.input, ctx);
    case "generate_diagram":
      return generateDiagram(elements, action.input, ctx);
    case "add_dimension":
      return addDimension(elements, action.input, ctx);
    case "plot_graph":
      return plotGraph(elements, action.input, ctx);
    case "add_chart":
      return addChart(elements, action.input, ctx);
    case "move_element":
      return moveElement(elements, action.input, ctx);
    case "animate_element":
      return animateElement(elements, action.input, ctx);
    case "update_element":
      return updateElement(elements, action.input, ctx);
    case "delete_elements":
      return deleteElements(
        elements,
        action.input.targets.map((t) => resolve(elements, t, ctx).id),
      );
    case "clear_board":
      return deleteElements(
        elements,
        elements.filter(isTopLevel).map((e) => e.id),
      );
    case "undo_last_command":
      throw new ActionError("undo is handled by the command runner");
    case "scroll_view":
    case "zoom_view":
      throw new ActionError("the view is handled by the command runner");
  }
}

// ---------- resolution & placement ----------

/** Resolve a model reference: real id, a model-assigned alias, or (fallback) a unique label match. */
export function resolve(elements: readonly El[], ref: string, ctx: ExecContext): El {
  const id = ctx.idMap.get(ref) ?? ref;
  const live = elements.filter(isTopLevel);
  const byId = live.find((e) => e.id === id);
  if (byId) return byId;
  const needle = ref.trim().toLowerCase();
  const byLabel = live.filter((e) => labelOf(elements, e)?.trim().toLowerCase() === needle);
  if (byLabel.length === 1) return byLabel[0];
  throw new ActionError(`Couldn't find "${ref}" on the board.`);
}

function allocateId(elements: readonly El[], wanted: string | undefined, ctx: ExecContext): string {
  const base = wanted || Math.random().toString(36).slice(2, 10);
  let id = base;
  for (let n = 2; elements.some((e) => e.id === id); n++) id = `${base}-${n}`;
  if (wanted && id !== wanted) ctx.idMap.set(wanted, id);
  return id;
}

function place(elements: readonly El[], placement: Placement | undefined, w: number, h: number, ctx: ExecContext, exclude?: string) {
  const obstacles = elements.filter((e) => isTopLevel(e) && e.type !== "arrow" && e.id !== exclude).map(boxOf);
  if (placement?.x !== undefined && placement?.y !== undefined) return { x: placement.x, y: placement.y };

  let side: Side = placement?.side ?? "right";
  let pos;
  if (placement?.relative_to) {
    pos = besides(boxOf(resolve(elements, placement.relative_to, ctx)), w, h, side);
  } else if (placement?.region) {
    pos = regionPoint(ctx.viewport, placement.region, w, h);
    side = "below";
  } else {
    const anchor = ctx.recentIds.map((id) => elements.find((e) => e.id === id && isTopLevel(e) && e.type !== "arrow")).find(Boolean);
    if (anchor) pos = besides(boxOf(anchor), w, h, "right");
    else {
      pos = regionPoint(ctx.viewport, "center", w, h);
      side = "below";
    }
  }
  return findFreeSpot({ ...pos, w, h }, obstacles, side);
}

function touch(ctx: ExecContext, id: string) {
  const i = ctx.recentIds.indexOf(id);
  if (i >= 0) ctx.recentIds.splice(i, 1);
  ctx.recentIds.unshift(id);
  ctx.recentIds.length = Math.min(ctx.recentIds.length, 12);
}

// ---------- actions ----------

function shapeStyle(kind: string, color: keyof typeof PALETTE | undefined) {
  if (kind === "sticky") {
    const c = PALETTE[color ?? "yellow"];
    return { strokeColor: c.stroke, backgroundColor: c.fill, fillStyle: "solid" as const, roughness: ROUGHNESS };
  }
  if (!color) return { strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid" as const, roughness: ROUGHNESS };
  const c = PALETTE[color];
  return { strokeColor: c.stroke, backgroundColor: c.fill, fillStyle: "solid" as const, roughness: ROUGHNESS };
}

function addShape(elements: readonly El[], input: Extract<BoardAction, { name: "add_shape" }>["input"], ctx: ExecContext): ExecResult {
  const size = fitLabel(SHAPE_SIZES[input.size ?? (input.kind === "sticky" ? "large" : "medium")], input.label, input.kind);
  const pos = place(elements, input.placement, size.w, size.h, ctx);
  const id = allocateId(elements, input.id, ctx);
  const skeleton = {
    type: input.kind === "sticky" ? "rectangle" : input.kind,
    id,
    x: pos.x,
    y: pos.y,
    width: size.w,
    height: size.h,
    roundness: input.kind === "rectangle" || input.kind === "sticky" ? { type: 3 } : null,
    customData: { kind: input.kind },
    ...shapeStyle(input.kind, input.color),
    ...(input.label ? { label: { text: input.label, fontSize: 20, fontFamily: FONT } } : {}),
  } as ExcalidrawElementSkeleton;
  const created = convertToExcalidrawElements([skeleton], { regenerateIds: false });
  touch(ctx, id);
  return { elements: [...elements, ...created], touched: [id] };
}

function addObject(elements: readonly El[], input: Extract<BoardAction, { name: "add_object" }>["input"], ctx: ExecContext): ExecResult {
  const side = OBJECT_SIZES[input.size ?? "medium"];
  const pos = place(elements, input.placement, side, side, ctx);
  const id = allocateId(elements, input.id, ctx);
  // The image file itself is added by loadObjectFiles; until then Excalidraw shows a placeholder.
  const created = convertToExcalidrawElements(
    [
      {
        type: "image",
        id,
        x: pos.x,
        y: pos.y,
        width: side,
        height: side,
        fileId: objectFileId(input.object),
        status: "saved",
        customData: { kind: "object", object: input.object },
      },
    ],
    { regenerateIds: false },
  );
  touch(ctx, id);
  return { elements: [...elements, ...created], touched: [id] };
}

function addText(elements: readonly El[], input: Extract<BoardAction, { name: "add_text" }>["input"], ctx: ExecContext): ExecResult {
  const fontSize = TEXT_SIZES[input.style ?? "body"];
  const lines = input.text.split("\n");
  const w = Math.max(...lines.map((l) => l.length)) * fontSize * 0.55;
  const h = lines.length * fontSize * 1.25;
  const pos = place(elements, input.placement, w, h, ctx);
  const id = allocateId(elements, input.id, ctx);
  const created = convertToExcalidrawElements(
    [
      {
        type: "text",
        id,
        x: pos.x,
        y: pos.y,
        text: input.text,
        fontSize,
        fontFamily: FONT,
        strokeColor: input.color ? PALETTE[input.color].stroke : "#1e1e1e",
      },
    ],
    { regenerateIds: false },
  );
  touch(ctx, id);
  return { elements: [...elements, ...created], touched: [id] };
}

function addArrow(elements: readonly El[], input: Extract<BoardAction, { name: "add_arrow" }>["input"], ctx: ExecContext): ExecResult {
  const from = resolve(elements, input.from, ctx);
  const to = resolve(elements, input.to, ctx);
  if (from.id === to.id) throw new ActionError("An arrow needs two different elements.");
  // Provisional geometry; the reroute below gives it (and any arrow it now runs beside) its lane.
  const geo = connector(boxOf(from), boxOf(to));
  const id = allocateId(elements, input.id, ctx);
  const created = convertToExcalidrawElements(
    [
      {
        type: "arrow",
        id,
        x: geo.x,
        y: geo.y,
        width: geo.width,
        height: geo.height,
        points: geo.points,
        strokeColor: input.color ? PALETTE[input.color].stroke : "#1e1e1e",
        strokeStyle: input.style ?? "solid",
        startArrowhead: input.bidirectional ? "arrow" : null,
        endArrowhead: "arrow",
        roughness: ROUGHNESS,
        ...(input.label ? { label: { text: input.label, fontSize: 16, fontFamily: FONT } } : {}),
      } as ExcalidrawElementSkeleton,
    ],
    { regenerateIds: false },
  );
  // Bind both ends so Excalidraw keeps the arrow attached when the user drags shapes by hand.
  const arrow = created.find((e) => e.id === id) as Mutable<ExcalidrawLinearElement>;
  arrow.startBinding = { elementId: from.id, focus: 0, gap: 8 };
  arrow.endBinding = { elementId: to.id, focus: 0, gap: 8 };
  const next = elements.map((e) =>
    e.id === from.id || e.id === to.id
      ? newElementWith(e, { boundElements: [...(e.boundElements ?? []), { id, type: "arrow" as const }] })
      : e,
  );
  touch(ctx, id);
  return { elements: rerouteArrows([...next, ...created], new Set([from.id, to.id])), touched: [id] };
}

const RANKDIR = { down: "TB", right: "LR", up: "BT", left: "RL" } as const;
/** dagre spacing: between boxes in one rank, between ranks (room for an arrow), between parallel edges. */
const DIAGRAM_SPACING = { nodesep: 50, ranksep: 80, edgesep: 20 };

/**
 * A whole diagram in one call. dagre lays the nodes out from the edges between them, the block is placed like
 * one big shape, then each node and edge is built by addShape / addArrow so it behaves like a hand-made one.
 * Arrows are straight (connector()), not dagre's routed paths, so they still re-route when a box moves.
 * Edges may also point at existing elements (not part of the layout); one that can't be drawn is skipped with a warning.
 */
function generateDiagram(
  elements: readonly El[],
  input: Extract<BoardAction, { name: "generate_diagram" }>["input"],
  ctx: ExecContext,
): ExecResult {
  const size = input.size ?? "small";
  const local = new Set(input.nodes.map((n) => n.id));
  const g = new Graph();
  g.setGraph({ rankdir: RANKDIR[input.direction ?? "down"], ...DIAGRAM_SPACING });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of input.nodes) {
    const s = fitLabel(SHAPE_SIZES[size], n.label, n.kind ?? "rectangle");
    g.setNode(n.id, { width: s.w, height: s.h });
  }
  for (const e of input.edges ?? []) {
    if (!local.has(e.from) || !local.has(e.to) || e.from === e.to) continue;
    // A labelled edge gets label room, so the label doesn't sit on a box.
    g.setEdge(e.from, e.to, e.label ? { width: e.label.length * 8 + 16, height: 24, labelpos: "c" } : {});
  }
  layout(g);

  const boxes = input.nodes.map((n) => {
    const p = g.node(n.id);
    return { node: n, x: p.x - p.width / 2, y: p.y - p.height / 2, w: p.width, h: p.height };
  });
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  const w = Math.max(...boxes.map((b) => b.x + b.w)) - minX;
  const h = Math.max(...boxes.map((b) => b.y + b.h)) - minY;
  const origin = place(elements, input.placement, w, h, ctx);

  let next: El[] = [...elements];
  const touched: string[] = [];
  const warnings: string[] = [];
  for (const b of boxes) {
    const { kind = "rectangle", ...node } = b.node;
    const placement = { x: origin.x + b.x - minX, y: origin.y + b.y - minY };
    const res = addShape(next, { ...node, kind, size, placement }, ctx);
    next = res.elements;
    touched.push(...res.touched);
  }
  for (const e of input.edges ?? []) {
    try {
      const res = addArrow(next, e, ctx);
      next = res.elements;
      touched.push(...res.touched);
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
      warnings.push(`Skipped the arrow ${e.from} -> ${e.to}: ${err.message}`);
    }
  }
  return { elements: next, touched, ...(warnings.length ? { warnings } : {}) };
}

const DIMENSION_OFFSET = 24;

/** Free-standing measurement line (bars at both ends, label on it): beside one element, or across the gap between two. */
function addDimension(
  elements: readonly El[],
  input: Extract<BoardAction, { name: "add_dimension" }>["input"],
  ctx: ExecContext,
): ExecResult {
  let start: { x: number; y: number };
  let end: { x: number; y: number };
  if (input.target !== undefined) {
    const target = resolve(elements, input.target, ctx);
    if (target.type === "arrow") throw new ActionError("Can't measure an arrow.");
    const b = boxOf(target);
    if (input.axis === "width") {
      const y = b.y + b.h + DIMENSION_OFFSET;
      start = { x: b.x, y };
      end = { x: b.x + b.w, y };
    } else {
      const x = b.x + b.w + DIMENSION_OFFSET;
      start = { x: x, y: b.y };
      end = { x, y: b.y + b.h };
    }
  } else {
    const a = boxOf(resolve(elements, input.from!, ctx));
    const b = boxOf(resolve(elements, input.to!, ctx));
    const gapX = Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w);
    const gapY = Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h);
    if (gapX <= 0 && gapY <= 0) throw new ActionError("Those elements overlap, so there's no gap to measure.");
    // Line across the larger gap, at the middle of where the two overlap on the other axis (else between their centres).
    const mid = (lo1: number, hi1: number, lo2: number, hi2: number) =>
      Math.max(lo1, lo2) < Math.min(hi1, hi2) ? (Math.max(lo1, lo2) + Math.min(hi1, hi2)) / 2 : (lo1 + hi1 + lo2 + hi2) / 4;
    if (gapX >= gapY) {
      const y = mid(a.y, a.y + a.h, b.y, b.y + b.h);
      const left = Math.min(a.x + a.w, b.x + b.w);
      start = { x: left, y };
      end = { x: left + gapX, y };
    } else {
      const x = mid(a.x, a.x + a.w, b.x, b.x + b.w);
      const top = Math.min(a.y + a.h, b.y + b.h);
      start = { x, y: top };
      end = { x, y: top + gapY };
    }
  }
  const id = allocateId(elements, input.id, ctx);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const created = convertToExcalidrawElements(
    [
      {
        type: "arrow",
        id,
        x: start.x,
        y: start.y,
        width: Math.abs(dx),
        height: Math.abs(dy),
        points: [
          [0, 0],
          [dx, dy],
        ],
        strokeColor: input.color ? PALETTE[input.color].stroke : "#1e1e1e",
        startArrowhead: "bar",
        endArrowhead: "bar",
        roughness: ROUGHNESS,
        customData: { kind: "dimension" },
        label: { text: input.label, fontSize: 16, fontFamily: FONT },
      } as ExcalidrawElementSkeleton,
    ],
    { regenerateIds: false },
  );
  touch(ctx, id);
  return { elements: [...elements, ...created], touched: [id] };
}

const colorHex = (names: readonly Color[] | undefined, n: number) =>
  Array.from({ length: n }, (_, i) => PALETTE[names?.[i] ?? SERIES_COLORS[i % SERIES_COLORS.length]].stroke);

/** A graph or chart image element for `spec` (its PNG is drawn by loadPlotFiles). */
function plotElement(id: string, spec: PlotSpec, box: { x: number; y: number; w: number; h: number }) {
  return convertToExcalidrawElements(
    [
      {
        type: "image",
        id,
        x: box.x,
        y: box.y,
        width: box.w,
        height: box.h,
        fileId: plotFileId(spec),
        status: "saved",
        customData: { ...spec },
      },
    ],
    { regenerateIds: false },
  );
}

/** Replace a plot's spec (and so its file), keeping id, position, size, z-order and arrow bindings. */
function respec(elements: readonly El[], target: El, spec: PlotSpec): El[] {
  return elements.map((e) =>
    e.id === target.id ? newElementWith(e, { customData: { ...spec }, fileId: plotFileId(spec) } as Partial<El>) : e,
  );
}

function plotGraph(elements: readonly El[], input: Extract<BoardAction, { name: "plot_graph" }>["input"], ctx: ExecContext): ExecResult {
  const labels = input.equations.map((eq) => parseEquation(eq).label);
  const xRange = (base: [number, number]): [number, number] => {
    let [lo, hi] = [input.x_min ?? base[0], input.x_max ?? base[1]];
    if (lo >= hi) [lo, hi] = input.x_min !== undefined ? [lo, lo + (base[1] - base[0])] : [hi - (base[1] - base[0]), hi];
    return [lo, hi];
  };
  const yRange = (equations: string[], x: [number, number], fallback?: [number, number]) => {
    if (input.y_min !== undefined && input.y_max !== undefined) return { y: [input.y_min, input.y_max] as [number, number], yAuto: false };
    if (fallback) return { y: fallback, yAuto: false };
    const fit = fitY(equations, x);
    const y: [number, number] = [input.y_min ?? fit[0], input.y_max ?? fit[1]];
    if (y[0] >= y[1]) return { y: fit, yAuto: true };
    return { y, yAuto: input.y_min === undefined && input.y_max === undefined };
  };

  if (input.add_to) {
    const target = resolve(elements, input.add_to, ctx);
    const old = graphOf(target);
    if (!old) throw new ActionError("Curves can only be added to a graph of equations.");
    const equations = [...old.equations, ...labels];
    if (equations.length > 6) throw new ActionError("A graph holds at most 6 curves.");
    const x = xRange(old.x);
    const xChanged = x[0] !== old.x[0] || x[1] !== old.x[1];
    const added = colorHex(undefined, equations.length).slice(old.colors.length);
    const colors = [...old.colors, ...added.map((c, j) => (input.colors?.[j] ? PALETTE[input.colors[j]].stroke : c))];
    const spec: GraphSpec = {
      ...old,
      equations,
      colors,
      x,
      ...yRange(equations, x, old.yAuto || xChanged ? undefined : old.y),
      ...(input.title ? { title: input.title } : {}),
    };
    touch(ctx, target.id);
    return { elements: respec(elements, target, spec), touched: [target.id] };
  }

  const size = PLOT_SIZES[input.size ?? "medium"];
  const x = xRange(DEFAULT_X);
  const spec: GraphSpec = {
    kind: "graph",
    equations: labels,
    colors: colorHex(input.colors, labels.length),
    x,
    ...yRange(labels, x),
    ...(input.title ? { title: input.title } : {}),
    w: size.w,
    h: size.h,
  };
  const pos = place(elements, input.placement, size.w, size.h, ctx);
  const id = allocateId(elements, input.id, ctx);
  touch(ctx, id);
  return { elements: [...elements, ...plotElement(id, spec, { ...pos, ...size })], touched: [id] };
}

const isPieKind = (kind: string) => kind === "pie" || kind === "donut";

/**
 * Colours for a redrawn chart without `colors`: each slice (by label) or series (by name, else position) keeps
 * its old colour; new ones get the first default colour not already in use.
 */
function keptColors(old: ChartSpec, input: Extract<BoardAction, { name: "add_chart" }>["input"]): string[] {
  const pie = isPieKind(input.kind);
  if (pie !== isPieKind(old.chart)) return colorHex(undefined, pie ? input.labels.length : input.series.length);
  const key = (name: string | undefined, i: number) => (name ? name.trim().toLowerCase() : `#${i}`);
  const oldKeys = pie ? old.labels.map((l, i) => key(l, i)) : old.series.map((s, i) => key(s.name, i));
  const newKeys = pie ? input.labels.map((l, i) => key(l, i)) : input.series.map((s, i) => key(s.name, i));
  const kept = newKeys.map((k) => old.colors[oldKeys.indexOf(k)] as string | undefined);
  const free = colorHex(undefined, SERIES_COLORS.length).filter((c) => !kept.includes(c));
  return kept.map((c, i) => c ?? free.shift() ?? colorHex(undefined, i + 1)[i]);
}

/** add_chart with `replace`: the chart is redrawn in place (id, position, arrows kept); omitted title/unit/colours/size are kept. */
function replaceChart(elements: readonly El[], input: Extract<BoardAction, { name: "add_chart" }>["input"], ctx: ExecContext): ExecResult {
  const target = resolve(elements, input.replace!, ctx);
  const old = plotOf(target);
  if (old?.kind !== "chart") throw new ActionError("Only a data chart can be redrawn with new data.");
  const size = input.size ? PLOT_SIZES[input.size] : { w: old.w, h: old.h };
  const title = input.title !== undefined ? input.title : old.title;
  const unit = input.unit !== undefined ? input.unit : old.unit;
  const pie = isPieKind(input.kind);
  const spec: ChartSpec = {
    kind: "chart",
    chart: input.kind,
    labels: input.labels,
    series: input.series.map((s) => ({ ...(s.name ? { name: s.name } : {}), values: s.values })),
    colors: input.colors ? colorHex(input.colors, pie ? input.labels.length : input.series.length) : keptColors(old, input),
    ...(title ? { title } : {}),
    ...(unit ? { unit } : {}),
    w: size.w,
    h: size.h,
  };
  let next = respec(elements, target, spec);
  if (input.size) {
    next = next.map((e) =>
      e.id === target.id
        ? newElementWith(e, { x: e.x + (e.width - size.w) / 2, y: e.y + (e.height - size.h) / 2, width: size.w, height: size.h })
        : e,
    );
    next = rerouteArrows(next, new Set([target.id]));
  }
  touch(ctx, target.id);
  return { elements: next, touched: [target.id] };
}

function addChart(elements: readonly El[], input: Extract<BoardAction, { name: "add_chart" }>["input"], ctx: ExecContext): ExecResult {
  if (input.replace) return replaceChart(elements, input, ctx);
  const size = PLOT_SIZES[input.size ?? "medium"];
  const pie = isPieKind(input.kind);
  const spec: ChartSpec = {
    kind: "chart",
    chart: input.kind,
    labels: input.labels,
    series: input.series.map((s) => ({ ...(s.name ? { name: s.name } : {}), values: s.values })),
    colors: colorHex(input.colors, pie ? input.labels.length : input.series.length),
    ...(input.title ? { title: input.title } : {}),
    ...(input.unit ? { unit: input.unit } : {}),
    w: size.w,
    h: size.h,
  };
  const pos = place(elements, input.placement, size.w, size.h, ctx);
  const id = allocateId(elements, input.id, ctx);
  touch(ctx, id);
  return { elements: [...elements, ...plotElement(id, spec, { ...pos, ...size })], touched: [id] };
}

/** Shift elements by (dx,dy) together with their bound labels, then re-route attached arrows. */
export function translate(elements: readonly El[], ids: Set<string>, dx: number, dy: number): El[] {
  const moved = elements.map((e) =>
    ids.has(e.id) || (e.type === "text" && e.containerId && ids.has(e.containerId) && !isArrowId(elements, e.containerId))
      ? newElementWith(e, { x: e.x + dx, y: e.y + dy })
      : e,
  );
  return rerouteArrows(moved, ids);
}

function isArrowId(elements: readonly El[], id: string) {
  return elements.some((e) => e.id === id && e.type === "arrow");
}

/**
 * Sideways offsets for arrows that share both ends with another arrow, so A -> B and B -> A (or two A -> B)
 * run side by side instead of on top of each other. Lanes are centred on the line between the shapes, in
 * scene order; arrows without a shared pair get no entry (offset 0).
 */
function arrowLanes(elements: readonly El[]): Map<string, number> {
  const pairs = new Map<string, ExcalidrawLinearElement[]>();
  for (const e of elements) {
    if (e.type !== "arrow" || e.isDeleted || !e.startBinding || !e.endBinding) continue;
    const [s, t] = [e.startBinding.elementId, e.endBinding.elementId];
    const key = s < t ? `${s}\n${t}` : `${t}\n${s}`;
    pairs.set(key, [...(pairs.get(key) ?? []), e]);
  }
  const lanes = new Map<string, number>();
  for (const arrows of pairs.values()) {
    if (arrows.length < 2) continue;
    arrows.forEach((a, i) => {
      const off = (i - (arrows.length - 1) / 2) * LANE;
      // connector() offsets along the arrow's own normal, which flips for an arrow drawn the other way.
      lanes.set(a.id, a.startBinding!.elementId < a.endBinding!.elementId ? off : -off);
    });
  }
  return lanes;
}

/** Recompute geometry for arrows bound to any of `ids` (and move their labels to the new midpoint). */
export function rerouteArrows(elements: readonly El[], ids: Set<string>): El[] {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const lanes = arrowLanes(elements);
  const labelShift = new Map<string, { x: number; y: number }>();
  const out = elements.map((e) => {
    if (e.type !== "arrow" || e.isDeleted) return e;
    const s = e.startBinding?.elementId;
    const t = e.endBinding?.elementId;
    if (!s || !t || !(ids.has(s) || ids.has(t))) return e;
    const from = byId.get(s);
    const to = byId.get(t);
    if (!from || !to) return e;
    const geo = connector(boxOf(from), boxOf(to), lanes.get(e.id) ?? 0);
    const oldMid = { x: e.x + (e.points.at(-1)?.[0] ?? 0) / 2, y: e.y + (e.points.at(-1)?.[1] ?? 0) / 2 };
    labelShift.set(e.id, { x: geo.mid.x - oldMid.x, y: geo.mid.y - oldMid.y });
    return newElementWith(e, {
      x: geo.x,
      y: geo.y,
      width: geo.width,
      height: geo.height,
      points: geo.points as unknown as ExcalidrawLinearElement["points"],
    });
  });
  return out.map((e) => {
    const shift = e.type === "text" && e.containerId ? labelShift.get(e.containerId) : undefined;
    return shift ? newElementWith(e, { x: e.x + shift.x, y: e.y + shift.y }) : e;
  });
}

const DIR = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] } as const;

function moveElement(
  elements: readonly El[],
  input: Extract<BoardAction, { name: "move_element" }>["input"],
  ctx: ExecContext,
): ExecResult {
  const target = movable(elements, input.target, ctx);
  const { dx, dy } = moveDelta(elements, target, input, ctx);
  touch(ctx, target.id);
  return { elements: translate(elements, new Set([target.id]), dx, dy), touched: [target.id] };
}

function movable(elements: readonly El[], ref: string, ctx: ExecContext) {
  const target = resolve(elements, ref, ctx);
  if (target.type === "arrow") throw new ActionError("Arrows follow the shapes they connect; move a shape instead.");
  return target;
}

/** Offset for a move to a placement or a nudge in a direction. */
function moveDelta(
  elements: readonly El[],
  target: El,
  input: { placement?: Placement; direction?: keyof typeof DIR; distance?: keyof typeof NUDGE },
  ctx: ExecContext,
) {
  if (input.placement) {
    const pos = place(elements, input.placement, target.width, target.height, ctx, target.id);
    return { dx: pos.x - target.x, dy: pos.y - target.y };
  }
  if (input.direction) {
    const d = NUDGE[input.distance ?? "some"];
    return { dx: DIR[input.direction][0] * d, dy: DIR[input.direction][1] * d };
  }
  throw new ActionError("Where should it move?");
}

/** Scene px per second. */
const SPEED = { slow: 150, normal: 300, fast: 600 } as const;
/** How close a mover stops beside what it walked towards (tighter than GAP, which leaves room for arrows). */
const ARRIVE_GAP = 30;

function animateElement(
  elements: readonly El[],
  input: Extract<BoardAction, { name: "animate_element" }>["input"],
  ctx: ExecContext,
): ExecResult {
  const target = movable(elements, input.target, ctx);
  const centre = (e: El) => ({ x: e.x + e.width / 2, y: e.y + e.height / 2 });
  let delta: { dx: number; dy: number };
  if (input.toward) {
    const other = resolve(elements, input.toward, ctx);
    if (other.id === target.id) throw new ActionError("It can't move towards itself.");
    const [a, b] = [centre(target), centre(other)];
    // Stop on the side of `other` that faces the mover.
    const side: Side = Math.abs(a.x - b.x) >= Math.abs(a.y - b.y) ? (a.x < b.x ? "left" : "right") : a.y < b.y ? "above" : "below";
    const obstacles = elements.filter((e) => isTopLevel(e) && e.type !== "arrow" && e.id !== target.id).map(boxOf);
    const pos = findFreeSpot(
      { ...besides(boxOf(other), target.width, target.height, side, ARRIVE_GAP), w: target.width, h: target.height },
      obstacles,
      side,
    );
    delta = { dx: pos.x - target.x, dy: pos.y - target.y };
  } else if (input.away_from) {
    const other = resolve(elements, input.away_from, ctx);
    const [a, b] = [centre(target), centre(other)];
    const len = Math.hypot(a.x - b.x, a.y - b.y);
    const [ux, uy] = len > 0 ? [(a.x - b.x) / len, (a.y - b.y) / len] : [1, 0];
    const d = NUDGE[input.distance ?? "some"];
    delta = { dx: Math.round(ux * d), dy: Math.round(uy * d) };
  } else {
    delta = moveDelta(elements, target, input, ctx);
  }
  touch(ctx, target.id);
  const dist = Math.hypot(delta.dx, delta.dy);
  const durationMs = Math.round(Math.min(2500, Math.max(300, (dist / SPEED[input.speed ?? "normal"]) * 1000)));
  return {
    elements: translate(elements, new Set([target.id]), delta.dx, delta.dy),
    touched: [target.id],
    animation: { id: target.id, ...delta, durationMs, style: input.style ?? (target.type === "image" ? "walk" : "slide") },
  };
}

function updateElement(
  elements: readonly El[],
  input: Extract<BoardAction, { name: "update_element" }>["input"],
  ctx: ExecContext,
): ExecResult {
  const target = resolve(elements, input.target, ctx);
  touch(ctx, target.id);
  const kind = (target.customData?.kind as string | undefined) ?? target.type;

  // Free text and arrows: patch in place.
  if (target.type === "text" || target.type === "arrow") {
    let next = elements.map((e) => {
      if (e.id !== target.id) return e;
      const patch: Partial<Mutable<El>> & Record<string, unknown> = {};
      if (input.color) patch.strokeColor = PALETTE[input.color].stroke;
      if (e.type === "text") {
        if (input.label) Object.assign(patch, { text: input.label, originalText: input.label });
        const factor = input.scale ?? (input.size ? { small: 0.75, medium: 1, large: 1.5 }[input.size] : 1);
        if (factor !== 1) Object.assign(patch, { fontSize: Math.round(e.fontSize * factor) });
        if (input.label || factor !== 1) {
          // Re-measure via a fresh conversion so width/height match the new text.
          const fresh = convertToExcalidrawElements(
            [
              {
                type: "text",
                x: e.x,
                y: e.y,
                text: input.label ?? e.originalText,
                fontSize: (patch.fontSize as number) ?? e.fontSize,
                fontFamily: e.fontFamily,
              },
            ],
            { regenerateIds: true },
          )[0];
          Object.assign(patch, { width: fresh.width, height: fresh.height });
        }
      }
      return newElementWith(e, patch as Partial<El>);
    });
    if (target.type === "arrow" && input.label) next = relabelArrow(next, target, input.label);
    return { elements: next, touched: [target.id] };
  }

  // Graphs/charts: label = title, colour = first curve/series/slice, size/scale resize (centre kept).
  const plot = plotOf(target);
  if (plot) {
    let next: El[] = [...elements];
    if (input.label !== undefined || input.color) {
      const spec = {
        ...plot,
        ...(input.label !== undefined ? { title: input.label || undefined } : {}),
        ...(input.color ? { colors: [PALETTE[input.color].stroke, ...plot.colors.slice(1)] } : {}),
      } as PlotSpec;
      next = respec(next, target, spec);
    }
    const factor = input.scale ?? (input.size ? PLOT_SIZES[input.size].w / target.width : undefined);
    if (factor) {
      const [w, h] = [target.width * factor, target.height * factor];
      next = next.map((e) =>
        e.id === target.id ? newElementWith(e, { x: e.x + (e.width - w) / 2, y: e.y + (e.height - h) / 2, width: w, height: h }) : e,
      );
      next = rerouteArrows(next, new Set([target.id]));
    }
    return { elements: next, touched: [target.id] };
  }

  // Pictures: only the size can change (keeping the centre fixed).
  if (target.type === "image") {
    const factor = input.scale ?? (input.size ? OBJECT_SIZES[input.size] / Math.max(target.width, target.height) : undefined);
    if (!factor) throw new ActionError("A picture's colour and text can't be changed; add a label next to it instead.");
    const w = target.width * factor;
    const h = target.height * factor;
    const next = elements.map((e) =>
      e.id === target.id ? newElementWith(e, { x: e.x + (e.width - w) / 2, y: e.y + (e.height - h) / 2, width: w, height: h }) : e,
    );
    return { elements: rerouteArrows(next, new Set([target.id])), touched: [target.id] };
  }

  // Shapes: rebuild (keeps id, position, z-order and arrow bindings) so the label re-wraps correctly.
  const label = input.label ?? labelOf(elements, target);
  let size = { w: target.width, h: target.height };
  if (input.scale) size = { w: target.width * input.scale, h: target.height * input.scale };
  else if (input.size) size = SHAPE_SIZES[input.size];
  if (input.label || input.size) size = fitLabel(size, label, kind);
  const style = input.color
    ? shapeStyle(kind, input.color)
    : { strokeColor: target.strokeColor, backgroundColor: target.backgroundColor, fillStyle: target.fillStyle };
  // Keep the centre fixed when resizing.
  const x = target.x + (target.width - size.w) / 2;
  const y = target.y + (target.height - size.h) / 2;
  const [container, ...text] = convertToExcalidrawElements(
    [
      {
        type: target.type,
        id: target.id,
        x,
        y,
        width: size.w,
        height: size.h,
        roundness: target.roundness,
        roughness: target.roughness,
        customData: target.customData,
        ...style,
        ...(label ? { label: { text: label, fontSize: 20, fontFamily: FONT } } : {}),
      } as ExcalidrawElementSkeleton,
    ],
    { regenerateIds: false },
  );
  const arrows = (target.boundElements ?? []).filter((b) => b.type === "arrow");
  // Fresh object from the converter; bump past the old version so Excalidraw treats it as newer.
  const rebuilt = {
    ...container,
    boundElements: [...arrows, ...(container.boundElements ?? [])],
    version: target.version + 1,
  } as El;
  const next: El[] = [];
  for (const e of elements) {
    if (e.id === target.id) next.push(rebuilt, ...text);
    else if (e.type === "text" && e.containerId === target.id) next.push(newElementWith(e, { isDeleted: true }));
    else next.push(e);
  }
  return { elements: rerouteArrows(next, new Set([target.id])), touched: [target.id] };
}

function relabelArrow(elements: El[], arrow: El, label: string): El[] {
  const rest = elements.map((e) => (e.type === "text" && e.containerId === arrow.id ? newElementWith(e, { isDeleted: true }) : e));
  const current = rest.find((e) => e.id === arrow.id)!;
  const mid = { x: current.x + current.width / 2, y: current.y + current.height / 2 };
  const [text] = convertToExcalidrawElements([{ type: "text", x: mid.x, y: mid.y, text: label, fontSize: 16, fontFamily: FONT }], {
    regenerateIds: true,
  });
  const placed = {
    ...text,
    containerId: arrow.id,
    x: mid.x - text.width / 2,
    y: mid.y - text.height / 2,
    textAlign: "center",
    verticalAlign: "middle",
  } as El;
  return [
    ...rest.map((e) =>
      e.id === arrow.id
        ? newElementWith(e, {
            boundElements: [...(e.boundElements ?? []).filter((b) => b.type !== "text"), { id: placed.id, type: "text" as const }],
          })
        : e,
    ),
    placed,
  ];
}

function deleteElements(elements: readonly El[], ids: string[]): ExecResult {
  const doomed = new Set(ids);
  // Arrows attached to deleted shapes go too.
  for (const e of elements) {
    if (e.type === "arrow" && (doomed.has(e.startBinding?.elementId ?? "") || doomed.has(e.endBinding?.elementId ?? ""))) doomed.add(e.id);
  }
  const next = elements.map((e) => {
    if (doomed.has(e.id) || (e.type === "text" && e.containerId && doomed.has(e.containerId)))
      return newElementWith(e, { isDeleted: true });
    if (e.boundElements?.some((b) => doomed.has(b.id)))
      return newElementWith(e, { boundElements: e.boundElements.filter((b) => !doomed.has(b.id)) });
    return e;
  });
  // An arrow that ran beside a deleted one moves back to the centre line.
  const ends = new Set<string>();
  for (const e of elements) {
    if (e.type !== "arrow" || !doomed.has(e.id)) continue;
    for (const end of [e.startBinding?.elementId, e.endBinding?.elementId]) if (end && !doomed.has(end)) ends.add(end);
  }
  return { elements: ends.size ? rerouteArrows(next, ends) : next, touched: [] };
}
