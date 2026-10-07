import type { Placement, Side } from "@board/shared";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Point {
  x: number;
  y: number;
}

/** Space between neighbouring shapes; wide enough for a short arrow label. */
export const GAP = 130;
const MARGIN = 24;

export const center = (b: Box): Point => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

export function overlaps(a: Box, b: Box, margin = MARGIN) {
  return a.x < b.x + b.w + margin && b.x < a.x + a.w + margin && a.y < b.y + b.h + margin && b.y < a.y + a.h + margin;
}

/** Top-left for a box of size (w,h) placed on `side` of `anchor`, centred on the shared axis. */
export function besides(anchor: Box, w: number, h: number, side: Side, gap = GAP): Point {
  const c = center(anchor);
  switch (side) {
    case "right":
      return { x: anchor.x + anchor.w + gap, y: c.y - h / 2 };
    case "left":
      return { x: anchor.x - gap - w, y: c.y - h / 2 };
    case "above":
      return { x: c.x - w / 2, y: anchor.y - gap - h };
    case "below":
      return { x: c.x - w / 2, y: anchor.y + anchor.h + gap };
  }
}

export function regionPoint(viewport: Box, region: NonNullable<Placement["region"]>, w: number, h: number): Point {
  const pad = Math.min(viewport.w, viewport.h) * 0.12;
  const xs = { left: viewport.x + pad, center: viewport.x + viewport.w / 2 - w / 2, right: viewport.x + viewport.w - pad - w };
  const ys = { top: viewport.y + pad, middle: viewport.y + viewport.h / 2 - h / 2, bottom: viewport.y + viewport.h - pad - h };
  const [v, hz] = region.includes("-")
    ? (region.split("-") as [keyof typeof ys, keyof typeof xs])
    : region === "top" || region === "bottom"
      ? [region, "center" as const]
      : region === "center"
        ? ["middle" as const, "center" as const]
        : ["middle" as const, region as "left" | "right"];
  return { x: xs[hz], y: ys[v] };
}

const STEP: Record<Side, Point> = { right: { x: 1, y: 0 }, left: { x: -1, y: 0 }, above: { x: 0, y: -1 }, below: { x: 0, y: 1 } };

/** Slide `box` along `side` until it no longer overlaps any obstacle. */
export function findFreeSpot(box: Box, obstacles: Box[], side: Side = "below"): Point {
  const step = STEP[side];
  let { x, y } = box;
  for (let i = 0; i < 40; i++) {
    const hit = obstacles.find((o) => overlaps({ x, y, w: box.w, h: box.h }, o));
    if (!hit) break;
    if (step.x > 0) x = hit.x + hit.w + MARGIN * 2;
    else if (step.x < 0) x = hit.x - box.w - MARGIN * 2;
    else if (step.y > 0) y = hit.y + hit.h + MARGIN * 2;
    else y = hit.y - box.h - MARGIN * 2;
  }
  return { x, y };
}

/** Point on the border of `box` along the line from its centre toward `toward`, pushed out by `gap`. */
export function edgePoint(box: Box, toward: Point, gap = 8): Point {
  const c = center(box);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const sx = dx === 0 ? Infinity : (box.w / 2 + gap) / Math.abs(dx);
  const sy = dy === 0 ? Infinity : (box.h / 2 + gap) / Math.abs(dy);
  const s = Math.min(sx, sy);
  return { x: c.x + dx * s, y: c.y + dy * s };
}

/** Straight connector between two boxes, as Excalidraw linear-element geometry. */
export function connector(from: Box, to: Box) {
  const start = edgePoint(from, center(to));
  const end = edgePoint(to, center(from));
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  return {
    x: start.x,
    y: start.y,
    width: Math.abs(dx),
    height: Math.abs(dy),
    points: [
      [0, 0],
      [dx, dy],
    ] as [number, number][],
    mid: { x: start.x + dx / 2, y: start.y + dy / 2 },
  };
}
