import { beforeAll, describe, expect, it } from "vitest";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { NormalizedZoomValue } from "@excalidraw/excalidraw/types";
import type { BoardAction } from "@board/shared";
import { ActionError, applyAction, type ExecContext } from "./executor";
import { isInSafeArea, planScroll, safeArea, type View, type ViewState } from "./view";

beforeAll(async () => {
  const { setCustomTextMetricsProvider } = await import("@excalidraw/excalidraw");
  setCustomTextMetricsProvider({ getLineWidth: (text: string, font: string) => text.length * (parseFloat(font) || 20) * 0.55 });
});

const ctx = (): ExecContext => ({ viewport: { x: 0, y: 0, w: 1600, h: 900 }, recentIds: [], idMap: new Map() });
const view = (zoom = 1, scrollX = 0, scrollY = 0): ViewState => ({
  scrollX,
  scrollY,
  zoom: { value: zoom as NormalizedZoomValue },
  width: 1600,
  height: 900,
});
const asState = (v: View): ViewState => view(v.zoom, v.scrollX, v.scrollY);
type Scroll = Extract<BoardAction, { name: "scroll_view" }>["input"];

function board(): ExcalidrawElement[] {
  const c = ctx();
  let els: readonly ExcalidrawElement[] = [];
  for (const [id, x, y] of [
    ["a", 0, 0],
    ["far", 3000, 2000],
  ] as const) {
    els = applyAction(els, { name: "add_shape", input: { id, kind: "rectangle", placement: { x, y } } }, c).elements;
  }
  return [...els];
}

describe("planScroll", () => {
  it("scrolls by a screen fraction in each direction, in scene units", () => {
    const plan = (input: Scroll, zoom = 1) => planScroll([], view(zoom), input, ctx());
    expect(plan({ direction: "down" })).toEqual({ scrollX: 0, scrollY: -450, zoom: 1 });
    expect(plan({ direction: "up", distance: "little" })).toEqual({ scrollX: 0, scrollY: 225, zoom: 1 });
    expect(plan({ direction: "right", distance: "far" })).toEqual({ scrollX: -1600, scrollY: 0, zoom: 1 });
    expect(plan({ direction: "left" }, 0.5)).toEqual({ scrollX: 1600, scrollY: 0, zoom: 0.5 });
  });

  it("brings an element into the safe area, keeping the zoom", () => {
    const els = board();
    const next = planScroll(els, view(), { to: "far" }, ctx());
    expect(next.zoom).toBe(1);
    const far = els.find((e) => e.id === "far")!;
    expect(isInSafeArea(asState(next), { x1: far.x, y1: far.y, x2: far.x + far.width, y2: far.y + far.height })).toBe(true);
  });

  it("goes to an edge of the content on one axis only", () => {
    const els = board();
    const s = safeArea(view());
    expect(planScroll(els, view(1, 50, 50), { edge: "top" }, ctx())).toEqual({ scrollX: 50, scrollY: s.top, zoom: 1 });
    const right = planScroll(els, view(1, 50, 50), { edge: "right" }, ctx());
    expect(right.scrollY).toBe(50);
    const far = els.find((e) => e.id === "far")!;
    expect((far.x + far.width + right.scrollX) * right.zoom).toBeCloseTo(s.left + s.w);
  });

  it("fits everything, zooming out only as far as needed", () => {
    const els = board();
    const next = planScroll(els, view(), { fit: "all" }, ctx());
    expect(next.zoom).toBeLessThan(1);
    expect(isInSafeArea(asState(next), { x1: 0, y1: 0, x2: 3200, y2: 2100 })).toBe(true);
    // Already small content keeps the current zoom.
    expect(
      planScroll(
        els.filter((e) => e.id === "a"),
        view(0.8),
        { fit: "all" },
        ctx(),
      ).zoom,
    ).toBe(0.8);
  });

  it("throws ActionError for an empty board or an unknown element", () => {
    expect(() => planScroll([], view(), { fit: "all" }, ctx())).toThrow(ActionError);
    expect(() => planScroll([], view(), { edge: "top" }, ctx())).toThrow(ActionError);
    expect(() => planScroll(board(), view(), { to: "nope" }, ctx())).toThrow(ActionError);
  });

  it("is never applied by the executor", () => {
    expect(() => applyAction([], { name: "scroll_view", input: { direction: "down" } }, ctx())).toThrow(ActionError);
  });
});
