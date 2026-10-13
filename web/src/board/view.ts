import { getCommonBounds } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, ExcalidrawImperativeAPI, NormalizedZoomValue } from "@excalidraw/excalidraw/types";
import type { BoardAction } from "@board/shared";
import { easeInOut } from "./animate";
import { ActionError, type ExecContext, isTopLevel, resolve } from "./executor";

/** What scroll_view changes: the camera, never the elements. */
export interface View {
  scrollX: number;
  scrollY: number;
  zoom: number;
}
export type ViewState = Pick<AppState, "scrollX" | "scrollY" | "zoom" | "width" | "height">;
type ScrollInput = Extract<BoardAction, { name: "scroll_view" }>["input"];
type Bounds = { x1: number; y1: number; x2: number; y2: number };

const MIN_ZOOM = 0.1;
const SCREEN_FRACTION = { little: 0.25, some: 0.5, far: 1 } as const;

/** Unobstructed screen area (screen px): below the toolbar, above the command dock + activity feed. */
export function safeArea(st: Pick<AppState, "width" | "height">) {
  const left = 24;
  const top = 96;
  return { left, top, w: Math.max(200, st.width - 24 - left), h: Math.max(160, st.height - 300 - top) };
}

/** True when `b` (scene coords) is fully inside the safe area at the current view. */
export function isInSafeArea(st: ViewState, b: Bounds): boolean {
  const s = safeArea(st);
  const z = st.zoom.value;
  const sx = (x: number) => (x + st.scrollX) * z;
  const sy = (y: number) => (y + st.scrollY) * z;
  return sx(b.x1) >= s.left && sy(b.y1) >= s.top && sx(b.x2) <= s.left + s.w && sy(b.y2) <= s.top + s.h;
}

/** Centre `b` in the safe area, keeping the zoom unless it can't fit, then zooming out just enough. */
export function frame(st: ViewState, b: Bounds): View {
  const s = safeArea(st);
  const fit = Math.min((s.w / Math.max(1, b.x2 - b.x1)) * 0.9, (s.h / Math.max(1, b.y2 - b.y1)) * 0.9);
  const zoom = Math.max(MIN_ZOOM, Math.min(st.zoom.value, fit));
  return {
    zoom,
    scrollX: (s.left + s.w / 2) / zoom - (b.x1 + b.x2) / 2,
    scrollY: (s.top + s.h / 2) / zoom - (b.y1 + b.y2) / 2,
  };
}

export function boundsOf(elements: readonly ExcalidrawElement[]): Bounds | null {
  const live = elements.filter(isTopLevel);
  if (!live.length) return null;
  const [x1, y1, x2, y2] = getCommonBounds(live);
  return { x1, y1, x2, y2 };
}

/** The view a scroll_view action ends at. Pure; throws ActionError when there is nothing to go to. */
export function planScroll(elements: readonly ExcalidrawElement[], st: ViewState, input: ScrollInput, ctx: ExecContext): View {
  const z = st.zoom.value;
  const here = { scrollX: st.scrollX, scrollY: st.scrollY, zoom: z };
  if (input.direction) {
    const f = SCREEN_FRACTION[input.distance ?? "some"];
    const dx = (f * st.width) / z;
    const dy = (f * st.height) / z;
    // "scroll down" shows what is further down: the viewport moves down, so scrollY goes down.
    switch (input.direction) {
      case "down":
        return { ...here, scrollY: st.scrollY - dy };
      case "up":
        return { ...here, scrollY: st.scrollY + dy };
      case "right":
        return { ...here, scrollX: st.scrollX - dx };
      case "left":
        return { ...here, scrollX: st.scrollX + dx };
    }
  }
  if (input.to) {
    const el = resolve(elements, input.to, ctx);
    const b = boundsOf([el])!;
    return frame(st, b);
  }
  const all = boundsOf(elements);
  if (!all) throw new ActionError("Nothing on the board to scroll to.");
  if (input.fit) return frame(st, all);
  const s = safeArea(st);
  switch (input.edge) {
    case "top":
      return { ...here, scrollY: s.top / z - all.y1 };
    case "bottom":
      return { ...here, scrollY: (s.top + s.h) / z - all.y2 };
    case "left":
      return { ...here, scrollX: s.left / z - all.x1 };
    case "right":
      return { ...here, scrollX: (s.left + s.w) / z - all.x2 };
  }
  throw new ActionError("Give exactly one of direction, to, edge or fit.");
}

/**
 * Glide the view to `target` (ease-in-out, 300-500 ms). Interpolates the scene point at the centre of the
 * screen and the zoom, so a zoom-out doesn't swing sideways. An abort (barge-in) jumps straight to `target`.
 */
export function playScroll(api: ExcalidrawImperativeAPI, target: View, signal: AbortSignal): Promise<void> {
  const st = api.getAppState();
  const centre = (v: View) => ({ x: st.width / (2 * v.zoom) - v.scrollX, y: st.height / (2 * v.zoom) - v.scrollY });
  const from = { scrollX: st.scrollX, scrollY: st.scrollY, zoom: st.zoom.value };
  const a = centre(from);
  const b = centre(target);
  const show = (v: View) =>
    api.updateScene({ appState: { scrollX: v.scrollX, scrollY: v.scrollY, zoom: { value: v.zoom as NormalizedZoomValue } } });
  const screenPx = Math.hypot(b.x - a.x, b.y - a.y) * from.zoom;
  if (screenPx < 1 && Math.abs(target.zoom - from.zoom) < 1e-3) return Promise.resolve();
  const durationMs = Math.min(500, 300 + screenPx / 5 + (target.zoom !== from.zoom ? 100 : 0));

  return new Promise((done) => {
    const t0 = performance.now();
    const finish = () => {
      signal.removeEventListener("abort", finish);
      show(target);
      done();
    };
    if (signal.aborted) return finish();
    signal.addEventListener("abort", finish);
    const step = (now: number) => {
      if (signal.aborted) return;
      const t = Math.min(1, (now - t0) / durationMs);
      if (t >= 1) return finish();
      const p = easeInOut(t);
      const zoom = from.zoom + (target.zoom - from.zoom) * p;
      const cx = a.x + (b.x - a.x) * p;
      const cy = a.y + (b.y - a.y) * p;
      show({ zoom, scrollX: st.width / (2 * zoom) - cx, scrollY: st.height / (2 * zoom) - cy });
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}
