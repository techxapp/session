import { beforeAll, describe, expect, it } from "vitest";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { NormalizedZoomValue } from "@excalidraw/excalidraw/types";
import type { BoardAction } from "@board/shared";
import { ActionError, applyAction, type ExecContext } from "./executor";
import { frame, isInSafeArea, planScroll, planZoom, safeArea, type View, type ViewState } from "./view";

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
type Zoom = Extract<BoardAction, { name: "zoom_view" }>["input"];

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

  it("frame can sit content lower in the safe area, and keeps it fully inside", () => {
    const s = safeArea(view());
    const box = { x1: 0, y1: 0, x2: 100, y2: 100 };
    const screenCentreY = (v: View) => (50 + v.scrollY) * v.zoom;
    expect(screenCentreY(frame(view(), box))).toBeCloseTo(s.top + s.h / 2);
    expect(screenCentreY(frame(view(), box, 0.72))).toBeCloseTo(s.top + s.h * 0.72);
    // A box nearly as tall as the area can't go lower than fits.
    const tall = { x1: 0, y1: 0, x2: 100, y2: s.h * 0.85 };
    expect(isInSafeArea(asState(frame(view(), tall, 0.9)), tall)).toBe(true);
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

describe("planZoom", () => {
  /** The scene point at screen point (x, y) for a view. */
  const at = (v: View, x: number, y: number) => ({ x: x / v.zoom - v.scrollX, y: y / v.zoom - v.scrollY });
  const plan = (input: Zoom, st = view()) => planZoom(board(), st, input, ctx());

  it("sets a level in percent, keeping the middle of the screen in place", () => {
    const st = view(1, -200, 100);
    const next = plan({ level: 200 }, st);
    expect(next.zoom).toBe(2);
    const before = at({ zoom: 1, scrollX: -200, scrollY: 100 }, 800, 450);
    const after = at(next, 800, 450);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
    expect(plan({ level: 100 }, view(0.4)).zoom).toBe(1);
  });

  it("steps in and out by the amount, within Excalidraw's limits", () => {
    expect(plan({ step: "in" }).zoom).toBe(1.5);
    expect(plan({ step: "out", amount: "little" }).zoom).toBeCloseTo(0.8);
    expect(plan({ step: "in", amount: "far" }, view(2)).zoom).toBe(5);
    expect(plan({ step: "out", amount: "far" }, view(0.15)).zoom).toBe(0.1);
    expect(plan({ step: "in", amount: "far" }, view(20)).zoom).toBe(30);
  });

  it("zooms on an element: its centre goes to the middle of the safe area", () => {
    const els = board();
    const far = els.find((e) => e.id === "far")!;
    const next = planZoom(els, view(), { step: "in", on: "far" }, ctx());
    const s = safeArea(view());
    const centre = at(next, s.left + s.w / 2, s.top + s.h / 2);
    expect(centre.x).toBeCloseTo(far.x + far.width / 2);
    expect(centre.y).toBeCloseTo(far.y + far.height / 2);
    expect(() => planZoom(els, view(), { level: 150, on: "nope" }, ctx())).toThrow(ActionError);
  });

  it("is never applied by the executor", () => {
    expect(() => applyAction([], { name: "zoom_view", input: { level: 100 } }, ctx())).toThrow(ActionError);
  });
});
