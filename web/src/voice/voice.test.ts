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
    expect(boardKeyterms(els)).toEqual(["Postgres", "Auth v2"]);
  });
});

describe("isCommand", () => {
  it("drops lines with no words", () => {
    expect(isCommand("Undo that.")).toBe(true);
    expect(isCommand("...")).toBe(false);
    expect(isCommand(" ")).toBe(false);
  });
});
