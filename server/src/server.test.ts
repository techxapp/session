import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import type { CommandEvent, CommandRequest } from "@board/shared";
import { buildApp } from "./app";
import { buildUserMessage } from "./prompt";
import { TOOLS, blockToEvents } from "./system1";

const scene: CommandRequest["scene"] = {
  elements: [{ id: "api", type: "rectangle", label: "API", x: 10, y: 20, w: 180, h: 84 }],
  selectedIds: ["api"],
  recentIds: ["api"],
  viewport: { x: 0, y: 0, width: 1200, height: 800 },
};

const toolUse = (name: string, input: unknown) => ({ type: "tool_use", id: `t_${name}`, name, input }) as Anthropic.ContentBlock;

/** Minimal stand-in for the SDK's MessageStream: replays blocks, then resolves the final message. */
function fakeClient(blocks: Anthropic.ContentBlock[], stop_reason = "tool_use") {
  const calls: unknown[] = [];
  const client = {
    messages: {
      stream(params: unknown) {
        calls.push(params);
        let onBlock: (b: Anthropic.ContentBlock) => void = () => {};
        return {
          on(event: string, cb: (b: Anthropic.ContentBlock) => void) {
            if (event === "contentBlock") onBlock = cb;
            return this;
          },
          async finalMessage() {
            blocks.forEach((b) => onBlock(b));
            return { stop_reason, model: "fake-model", content: blocks };
          },
        };
      },
    },
  };
  return { client: client as unknown as Anthropic, calls };
}

function parseSse(body: string): CommandEvent[] {
  return body
    .split("\n\n")
    .filter((f) => f.startsWith("data: "))
    .map((f) => JSON.parse(f.slice(6)));
}

describe("tool definitions", () => {
  it("are generated for every action, as object schemas, with the prefix cached", () => {
    expect(TOOLS.map((t) => t.name)).toEqual([
      "add_shape",
      "add_text",
      "add_arrow",
      "move_element",
      "update_element",
      "delete_elements",
      "undo_last_command",
      "clear_board",
    ]);
    for (const t of TOOLS) {
      expect(t.input_schema.type).toBe("object");
      expect(t.input_schema).not.toHaveProperty("$schema");
    }
    expect(TOOLS.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
    expect((TOOLS[0].input_schema.properties as Record<string, unknown>).kind).toMatchObject({
      enum: ["rectangle", "ellipse", "diamond", "sticky"],
    });
  });
});

describe("blockToEvents", () => {
  it("validates tool calls into actions", () => {
    const [ev] = blockToEvents(toolUse("add_shape", { id: "db", kind: "rectangle", label: "DB" }), Date.now());
    expect(ev).toMatchObject({ type: "action", action: { name: "add_shape", input: { id: "db", kind: "rectangle", label: "DB" } } });
  });
  it("rejects malformed or unknown calls instead of forwarding them", () => {
    expect(blockToEvents(toolUse("add_shape", { kind: "hexagon" }), 0)[0].type).toBe("invalid");
    expect(blockToEvents(toolUse("rm_rf", {}), 0)[0].type).toBe("invalid");
  });
  it("passes short text through as a 'say' event", () => {
    expect(blockToEvents({ type: "text", text: " Done. ", citations: null } as Anthropic.ContentBlock, 0)).toEqual([
      { type: "say", text: "Done." },
    ]);
  });
});

describe("prompt", () => {
  it("includes the scene and command", () => {
    const msg = buildUserMessage("make it blue", scene);
    expect(msg).toContain('- api: rectangle "API" at (10, 20) size 180x84');
    expect(msg).toContain("Selected: api");
    expect(msg).toContain("<command>make it blue</command>");
  });
});

describe("POST /api/command", () => {
  it("streams validated actions then done", async () => {
    const { client, calls } = fakeClient([
      toolUse("add_shape", { id: "db", kind: "rectangle", label: "DB" }),
      toolUse("add_arrow", { from: "api", to: "db" }),
      toolUse("add_shape", { kind: "nope" }),
    ]);
    const app = buildApp(client, { logger: false });
    const res = await app.inject({ method: "POST", url: "/api/command", payload: { text: "add a db next to the api", scene } });
    expect(res.headers["content-type"]).toBe("text/event-stream");
    const events = parseSse(res.body);
    expect(events.map((e) => e.type)).toEqual(["action", "action", "invalid", "done"]);
    expect(events.at(-1)).toMatchObject({ type: "done", actions: 2, model: "fake-model" });
    expect(calls[0]).toMatchObject({ model: "claude-haiku-4-5", tool_choice: { type: "auto" } });
  });

  it("reports refusals", async () => {
    const { client } = fakeClient([], "refusal");
    const res = await buildApp(client, { logger: false }).inject({ method: "POST", url: "/api/command", payload: { text: "x", scene } });
    expect(parseSse(res.body).map((e) => e.type)).toEqual(["error", "done"]);
  });

  it("rejects bad requests with 400", async () => {
    const { client } = fakeClient([]);
    const res = await buildApp(client, { logger: false }).inject({ method: "POST", url: "/api/command", payload: { text: "" } });
    expect(res.statusCode).toBe(400);
  });
});
