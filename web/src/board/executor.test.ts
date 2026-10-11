import { beforeAll, describe, expect, it } from "vitest";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { BoardAction } from "@board/shared";
import { ActionError, applyAction, isTopLevel, labelOf, type ExecContext } from "./executor";
import { summarize } from "./summary";

let setMetrics: typeof import("@excalidraw/excalidraw").setCustomTextMetricsProvider;

beforeAll(async () => {
  ({ setCustomTextMetricsProvider: setMetrics } = await import("@excalidraw/excalidraw"));
  // jsdom has no canvas; give Excalidraw a deterministic text measurer.
  setMetrics({ getLineWidth: (text: string, font: string) => text.length * (parseFloat(font) || 20) * 0.55 });
});

const ctx = (): ExecContext => ({ viewport: { x: 0, y: 0, w: 1600, h: 900 }, recentIds: [], idMap: new Map() });

function run(actions: BoardAction[], c = ctx(), start: readonly ExcalidrawElement[] = []) {
  let els = start;
  for (const a of actions) els = applyAction(els, a, c).elements;
  return { els, c };
}

const live = (els: readonly ExcalidrawElement[]) => els.filter(isTopLevel);
const byId = (els: readonly ExcalidrawElement[], id: string) => els.find((e) => e.id === id)!;

describe("applyAction", () => {
  it("adds a labelled shape at the viewport centre when the board is empty", () => {
    const { els } = run([{ name: "add_shape", input: { id: "api", kind: "rectangle", label: "API" } }]);
    const api = byId(els, "api");
    expect(api.type).toBe("rectangle");
    expect(labelOf(els, api)).toBe("API");
    expect(api.x + api.width / 2).toBeCloseTo(800, -1);
    expect(api.y + api.height / 2).toBeCloseTo(450, -1);
  });

  it("auto-places a chain left-to-right and binds arrows to both ends", () => {
    const { els } = run([
      { name: "add_shape", input: { id: "user", kind: "ellipse", label: "User" } },
      { name: "add_shape", input: { id: "web", kind: "rectangle", label: "Web app" } },
      { name: "add_arrow", input: { from: "user", to: "web", label: "HTTPS" } },
    ]);
    const user = byId(els, "user");
    const web = byId(els, "web");
    expect(web.x).toBeGreaterThan(user.x + user.width);
    const arrow = live(els).find((e) => e.type === "arrow")!;
    expect(arrow.type === "arrow" && arrow.startBinding?.elementId).toBe("user");
    expect(arrow.type === "arrow" && arrow.endBinding?.elementId).toBe("web");
    expect(user.boundElements?.some((b) => b.id === arrow.id)).toBe(true);
    expect(labelOf(els, arrow)).toBe("HTTPS");
  });

  it("draws clip-art objects that can be referenced, resized and connected", () => {
    const { els, c } = run([
      { name: "add_object", input: { id: "tree", object: "tree" } },
      { name: "add_object", input: { id: "kid", object: "child", size: "small", placement: { relative_to: "tree", side: "right" } } },
      { name: "add_arrow", input: { from: "kid", to: "tree" } },
    ]);
    const tree = byId(els, "tree");
    expect(tree).toMatchObject({
      type: "image",
      fileId: "object:tree",
      width: 120,
      height: 120,
      customData: { kind: "object", object: "tree" },
    });
    const kid = byId(els, "kid");
    expect(kid.width).toBe(64);
    expect(kid.x).toBeGreaterThan(tree.x + tree.width);
    // The object name is its label, so the model sees it in the scene and can refer to it by name.
    expect(summarize(els, [], c.recentIds, c.viewport).elements.find((e) => e.id === "tree")).toMatchObject({
      type: "image",
      label: "tree",
    });

    const centre = (e: ExcalidrawElement) => [e.x + e.width / 2, e.y + e.height / 2];
    const bigger = run([{ name: "update_element", input: { target: "tree", size: "large" } }], c, els).els;
    expect(byId(bigger, "tree").width).toBe(200);
    expect(centre(byId(bigger, "tree"))).toEqual(centre(tree));
    const arrow = live(bigger).find((e) => e.type === "arrow")!;
    expect(arrow.width).not.toBe(live(els).find((e) => e.type === "arrow")!.width); // re-routed to the resized tree
    expect(() => run([{ name: "update_element", input: { target: "tree", color: "red" } }], c, bigger)).toThrow(ActionError);
  });

  it("places relative to another element and avoids overlaps", () => {
    const { els } = run([
      { name: "add_shape", input: { id: "a", kind: "rectangle", label: "A" } },
      { name: "add_shape", input: { id: "b", kind: "rectangle", label: "B", placement: { relative_to: "a", side: "below" } } },
      { name: "add_shape", input: { id: "c", kind: "rectangle", label: "C", placement: { relative_to: "a", side: "below" } } },
    ]);
    const [a, b, c] = ["a", "b", "c"].map((id) => byId(els, id));
    expect(b.y).toBeGreaterThan(a.y + a.height);
    expect(c.y).toBeGreaterThan(b.y + b.height); // slid past b instead of overlapping
  });

  it("moves a shape with its label and re-routes attached arrows", () => {
    const { els, c } = run([
      { name: "add_shape", input: { id: "a", kind: "rectangle", label: "A" } },
      { name: "add_shape", input: { id: "b", kind: "rectangle", label: "B" } },
      { name: "add_arrow", input: { id: "ab", from: "a", to: "b" } },
    ]);
    const before = byId(els, "b");
    const labelBefore = els.find((e) => e.type === "text" && e.containerId === "b")!;
    const arrowBefore = byId(els, "ab");
    const { els: after } = run([{ name: "move_element", input: { target: "b", direction: "down", distance: "far" } }], c, els);
    expect(byId(after, "b").y).toBe(before.y + 320);
    expect(after.find((e) => e.type === "text" && e.containerId === "b")!.y).toBe(labelBefore.y + 320);
    const arrow = byId(after, "ab");
    expect(arrow.type === "arrow" && arrow.points[1][1]).toBeGreaterThan(arrowBefore.type === "arrow" ? arrowBefore.points[1][1] : 0);
  });

  it("updates a label and colour, keeping id and arrow bindings", () => {
    const { els, c } = run([
      { name: "add_shape", input: { id: "db", kind: "rectangle", label: "DB" } },
      { name: "add_shape", input: { id: "app", kind: "rectangle", label: "App" } },
      { name: "add_arrow", input: { from: "app", to: "db" } },
    ]);
    const { els: after } = run([{ name: "update_element", input: { target: "db", label: "Postgres", color: "green" } }], c, els);
    const db = byId(after, "db");
    expect(labelOf(after, db)).toBe("Postgres");
    expect(db.backgroundColor).toBe("#b2f2bb");
    expect(db.boundElements?.some((b) => b.type === "arrow")).toBe(true);
    expect(live(after).filter((e) => e.type === "rectangle")).toHaveLength(2);
  });

  it("resolves references by label and by remapped ids", () => {
    const c = ctx();
    const { els } = run([{ name: "add_shape", input: { id: "x", kind: "rectangle", label: "Cache" } }], c);
    // Same requested id again -> gets a new id, alias maps to the new one.
    const { els: els2 } = run([{ name: "add_shape", input: { id: "x", kind: "rectangle", label: "Queue" } }], c, els);
    expect(labelOf(els2, byId(els2, "x-2"))).toBe("Queue");
    const { els: els3 } = run([{ name: "add_arrow", input: { from: "Cache", to: "x" } }], c, els2);
    const arrow = live(els3).find((e) => e.type === "arrow")!;
    expect(arrow.type === "arrow" && arrow.endBinding?.elementId).toBe("x-2");
  });

  it("deletes shapes together with their labels and connected arrows", () => {
    const { els, c } = run([
      { name: "add_shape", input: { id: "a", kind: "rectangle", label: "A" } },
      { name: "add_shape", input: { id: "b", kind: "rectangle", label: "B" } },
      { name: "add_arrow", input: { from: "a", to: "b" } },
    ]);
    const { els: after } = run([{ name: "delete_elements", input: { targets: ["b"] } }], c, els);
    expect(live(after).map((e) => e.id)).toEqual(["a"]);
    expect(byId(after, "a").boundElements?.some((b) => b.type === "arrow")).toBe(false);
  });

  it("throws a friendly ActionError for unknown references", () => {
    expect(() => run([{ name: "move_element", input: { target: "ghost", direction: "left" } }])).toThrow(ActionError);
  });

  it("summarizes the scene for the model", () => {
    const { els, c } = run([
      { name: "add_shape", input: { id: "n", kind: "sticky", label: "Ship Friday" } },
      { name: "add_text", input: { id: "t", text: "Roadmap", style: "title" } },
    ]);
    const s = summarize(els, ["n"], c.recentIds, c.viewport);
    expect(s.elements.map((e) => [e.id, e.type, e.label])).toEqual([
      ["n", "sticky", "Ship Friday"],
      ["t", "text", "Roadmap"],
    ]);
    expect(s.selectedIds).toEqual(["n"]);
    expect(s.recentIds).toEqual(["t", "n"]);
  });
});
