import { beforeAll, describe, expect, it } from "vitest";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { BoardAction } from "@board/shared";
import { applyAction, type ExecContext } from "../board/executor";
import { boardKeyterms, isCommand } from "./useVoice";

beforeAll(async () => {
  const { setCustomTextMetricsProvider } = await import("@excalidraw/excalidraw");
  setCustomTextMetricsProvider({ getLineWidth: (text: string, font: string) => text.length * (parseFloat(font) || 20) * 0.55 });
});

function board(actions: BoardAction[]) {
  const ctx: ExecContext = { viewport: { x: 0, y: 0, w: 1600, h: 900 }, recentIds: [], idMap: new Map() };
  let els: readonly ExcalidrawElement[] = [];
  for (const a of actions) els = applyAction(els, a, ctx).elements;
  return els;
}

describe("boardKeyterms", () => {
  it("lists shape and text labels once, without commas or clip-art names", () => {
    const els = board([
      { name: "add_shape", input: { id: "db", kind: "rectangle", label: "Postgres" } },
      { name: "add_shape", input: { id: "db2", kind: "ellipse", label: "postgres" } },
      { name: "add_text", input: { text: "Auth, v2", style: "title" } },
      { name: "add_object", input: { object: "tree" } },
      { name: "add_arrow", input: { from: "db", to: "db2" } },
    ]);
    expect(boardKeyterms(els)).toEqual(["draw", "flower", "Postgres", "Auth v2"]);
  });

  it("always keeps the command words, and caps the total at 50", () => {
    const els = board([
      { name: "add_shape", input: { kind: "rectangle", label: "Flower" } },
      ...Array.from({ length: 60 }, (_, i) => ({ name: "add_shape" as const, input: { kind: "rectangle" as const, label: `Box ${i}` } })),
    ]);
    const terms = boardKeyterms(els);
    expect(terms).toHaveLength(50);
    expect(terms.slice(0, 2)).toEqual(["draw", "flower"]);
    expect(terms).not.toContain("Flower");
    expect(terms.at(-1)).toBe("Box 59");
  });
});

describe("isCommand", () => {
  it("drops lines with no words", () => {
    expect(isCommand("Undo that.")).toBe(true);
    expect(isCommand("...")).toBe(false);
    expect(isCommand(" ")).toBe(false);
  });
});
