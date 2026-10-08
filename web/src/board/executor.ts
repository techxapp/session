import { convertToExcalidrawElements, newElementWith } from "@excalidraw/excalidraw";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type { ExcalidrawElement, ExcalidrawLinearElement } from "@excalidraw/excalidraw/element/types";
import type { BoardAction, Placement, Side } from "@board/shared";
import { type Box, besides, connector, findFreeSpot, regionPoint } from "./geometry";
import { OBJECT_SIZES, objectFileId, objectOf } from "./objects";
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
}

export class ActionError extends Error {}

/** Elements visible to the model: not deleted, not a label bound inside a container/arrow. */
export const isTopLevel = (e: El) => !e.isDeleted && !(e.type === "text" && e.containerId);
export const boxOf = (e: El): Box => ({ x: e.x, y: e.y, w: e.width, h: e.height });

/** An element's text: its own (text), its bound label (shapes, arrows), or the object it draws (clip-art). */
export function labelOf(elements: readonly El[], el: El): string | undefined {
  if (el.type === "text") return el.originalText ?? el.text;
  if (el.type === "image") return objectOf(el);
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
    case "move_element":
      return moveElement(elements, action.input, ctx);
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
  return { elements: [...next, ...created], touched: [id] };
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

/** Recompute geometry for arrows bound to any of `ids` (and move their labels to the new midpoint). */
export function rerouteArrows(elements: readonly El[], ids: Set<string>): El[] {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const labelShift = new Map<string, { x: number; y: number }>();
  const out = elements.map((e) => {
    if (e.type !== "arrow" || e.isDeleted) return e;
    const s = e.startBinding?.elementId;
    const t = e.endBinding?.elementId;
    if (!s || !t || !(ids.has(s) || ids.has(t))) return e;
    const from = byId.get(s);
    const to = byId.get(t);
    if (!from || !to) return e;
    const geo = connector(boxOf(from), boxOf(to));
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
  const target = resolve(elements, input.target, ctx);
  let dx = 0;
  let dy = 0;
  if (input.placement) {
    const pos = place(elements, input.placement, target.width, target.height, ctx, target.id);
    dx = pos.x - target.x;
    dy = pos.y - target.y;
  } else if (input.direction) {
    const d = NUDGE[input.distance ?? "some"];
    dx = DIR[input.direction][0] * d;
    dy = DIR[input.direction][1] * d;
  } else {
    throw new ActionError("Where should it move?");
  }
  if (target.type === "arrow") throw new ActionError("Arrows follow the shapes they connect; move a shape instead.");
  touch(ctx, target.id);
  return { elements: translate(elements, new Set([target.id]), dx, dy), touched: [target.id] };
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
  return { elements: next, touched: [] };
}
