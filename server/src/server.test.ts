import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import { describe, expect, it } from "vitest";
import type { CommandEvent, CommandRequest } from "@board/shared";
import { buildApp } from "./app";
import { fastPathFromEnv, httpFastPath, withFastPath, type FastDecision } from "./fastpath";
import { anthropicProvider, openaiProvider, providerFromEnv } from "./provider";
import { buildUserMessage } from "./prompt";
import { TOOLS, blockToEvents } from "./system1";
import { OPENAI_TOOLS, toolCallToEvent } from "./system1-openai";

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
      "add_object",
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
  it("accepts catalog objects and rejects ones not in it", () => {
    expect(blockToEvents(toolUse("add_object", { id: "tree", object: "tree", size: "large" }), 0)[0].type).toBe("action");
    expect(blockToEvents(toolUse("add_object", { object: "spaceship-shaped-cake" }), 0)[0].type).toBe("invalid");
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
    const app = buildApp(anthropicProvider(client), { logger: false });
    const res = await app.inject({ method: "POST", url: "/api/command", payload: { text: "add a db next to the api", scene } });
    expect(res.headers["content-type"]).toBe("text/event-stream");
    const events = parseSse(res.body);
    expect(events.map((e) => e.type)).toEqual(["route", "action", "action", "invalid", "done"]);
    expect(events[0]).toMatchObject({ type: "route", source: "cloud", model: "claude-haiku-4-5" });
    expect(events.at(-1)).toMatchObject({ type: "done", actions: 2, model: "fake-model" });
    expect(calls[0]).toMatchObject({ model: "claude-haiku-4-5", tool_choice: { type: "auto" } });
  });

  it("reports refusals", async () => {
    const { client } = fakeClient([], "refusal");
    const res = await buildApp(anthropicProvider(client), { logger: false }).inject({
      method: "POST",
      url: "/api/command",
      payload: { text: "x", scene },
    });
    expect(parseSse(res.body).map((e) => e.type)).toEqual(["route", "error", "done"]);
  });

  it("rejects bad requests with 400", async () => {
    const { client } = fakeClient([]);
    const res = await buildApp(anthropicProvider(client), { logger: false }).inject({
      method: "POST",
      url: "/api/command",
      payload: { text: "" },
    });
    expect(res.statusCode).toBe(400);
  });
});

/** Minimal stand-in for an OpenAI chat-completions stream. Each entry is one chunk's delta. */
type Delta = OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta;
function fakeOpenAI(deltas: Delta[], finish_reason: string = "tool_calls") {
  const calls: unknown[] = [];
  const client = {
    chat: {
      completions: {
        async create(params: unknown) {
          calls.push(params);
          return (async function* () {
            for (const delta of deltas) yield { model: "fake-gpt", choices: [{ index: 0, delta, finish_reason: null }] };
            yield { model: "fake-gpt", choices: [{ index: 0, delta: {}, finish_reason }] };
          })();
        },
      },
    },
  };
  return { client: client as unknown as OpenAI, calls };
}

const fn = (index: number, name?: string, args?: string): Delta => ({
  tool_calls: [{ index, ...(name ? { id: `c${index}`, type: "function" as const } : {}), function: { name, arguments: args } }],
});

describe("OpenAI tool definitions", () => {
  it("mirror the Anthropic tools", () => {
    expect(OPENAI_TOOLS.map((t) => t.function.name)).toEqual(TOOLS.map((t) => t.name));
    expect(OPENAI_TOOLS[0]).toMatchObject({ type: "function", function: { parameters: { type: "object" } } });
  });
});

describe("toolCallToEvent", () => {
  it("validates, and rejects bad JSON or schema violations", () => {
    expect(toolCallToEvent({ name: "add_shape", args: '{"id":"db","kind":"rectangle","label":"DB"}' }, 0).type).toBe("action");
    expect(toolCallToEvent({ name: "add_shape", args: "{oops" }, 0).type).toBe("invalid");
    expect(toolCallToEvent({ name: "add_shape", args: '{"kind":"hexagon"}' }, 0).type).toBe("invalid");
    expect(toolCallToEvent({ name: "undo_last_command", args: "" }, 0).type).toBe("action");
  });
});

describe("POST /api/command (OpenAI)", () => {
  it("stitches streamed tool-call deltas into validated actions", async () => {
    const { client, calls } = fakeOpenAI([
      fn(0, "add_shape", '{"id":"db","kin'),
      fn(0, undefined, 'd":"rectangle","label":"DB"}'),
      fn(1, "add_arrow", '{"from":"api","to":"db"}'),
      fn(2, "add_shape", '{"kind":"nope"}'),
      { content: " Done. " },
    ]);
    const res = await buildApp(openaiProvider(client), { logger: false }).inject({
      method: "POST",
      url: "/api/command",
      payload: { text: "add a db next to the api", scene },
    });
    const events = parseSse(res.body);
    expect(events.map((e) => e.type)).toEqual(["route", "action", "action", "invalid", "say", "done"]);
    expect(events.at(-1)).toMatchObject({ type: "done", actions: 2, model: "fake-gpt" });
    expect(calls[0]).toMatchObject({ model: "gpt-4.1-mini", stream: true, tool_choice: "auto" });
  });

  it("reports truncated output", async () => {
    const { client } = fakeOpenAI([], "length");
    const res = await buildApp(openaiProvider(client), { logger: false }).inject({
      method: "POST",
      url: "/api/command",
      payload: { text: "x", scene },
    });
    expect(parseSse(res.body).map((e) => e.type)).toEqual(["route", "error", "done"]);
  });
});

describe("providerFromEnv", () => {
  it("prefers LLM_PROVIDER, then whichever key is set", () => {
    expect(providerFromEnv({ ANTHROPIC_API_KEY: "a" }).name).toBe("anthropic");
    expect(providerFromEnv({ OPENAI_API_KEY: "o" })).toMatchObject({ name: "openai", hasKey: true, model: "gpt-4.1-mini" });
    expect(providerFromEnv({ ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" }).name).toBe("anthropic");
    expect(providerFromEnv({ ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o", LLM_PROVIDER: "openai" }).name).toBe("openai");
    expect(providerFromEnv({ OPENAI_API_KEY: "o", SYSTEM1_MODEL: "gpt-x" }).model).toBe("gpt-x");
  });
  it("starts without a key and reports it", () => {
    expect(providerFromEnv({})).toMatchObject({ name: "anthropic", hasKey: false });
    expect(providerFromEnv({ LLM_PROVIDER: "openai" })).toMatchObject({ name: "openai", hasKey: false });
  });
  it("rejects an unknown provider", () => {
    expect(() => providerFromEnv({ LLM_PROVIDER: "gemini" })).toThrow(/LLM_PROVIDER/);
  });
});

describe("fast path", () => {
  const command = (provider: ReturnType<typeof anthropicProvider>) =>
    buildApp(provider, { logger: false })
      .inject({ method: "POST", url: "/api/command", payload: { text: "make the api red", scene } })
      .then((res) => parseSse(res.body));
  const decide = (d: FastDecision) => async () => d;

  it("streams confident local actions without calling the cloud model", async () => {
    const { client, calls } = fakeClient([toolUse("undo_last_command", {})]);
    const fast = decide({
      route: "fast",
      actions: [{ name: "update_element", input: { target: "api", color: "red" } }],
      reason: "update_element",
      model: "laya:top6",
    });
    const events = await command(withFastPath(anthropicProvider(client), fast));
    expect(events.map((e) => e.type)).toEqual(["route", "action", "done"]);
    expect(events[0]).toMatchObject({ source: "local", model: "laya:top6" });
    expect(events[1]).toMatchObject({ action: { name: "update_element", input: { target: "api", color: "red" } } });
    expect(events[2]).toMatchObject({ model: "laya:top6", actions: 1 });
    expect(calls).toHaveLength(0);
  });

  it("drops chatter the local model is sure about", async () => {
    const { client, calls } = fakeClient([]);
    const events = await command(withFastPath(anthropicProvider(client), decide({ route: "ignore", actions: null })));
    expect(events.map((e) => e.type)).toEqual(["route", "done"]);
    expect(events[1]).toMatchObject({ actions: 0 });
    expect(calls).toHaveLength(0);
  });

  it("falls through to the cloud model, saying why", async () => {
    const { client, calls } = fakeClient([toolUse("update_element", { target: "api", color: "red" })]);
    const events = await command(
      withFastPath(anthropicProvider(client), decide({ route: "llm", actions: null, reason: "needs new text" })),
    );
    expect(events.map((e) => e.type)).toEqual(["route", "action", "done"]);
    expect(events[0]).toMatchObject({ source: "cloud", model: "claude-haiku-4-5", detail: expect.stringContaining("needs new text") });
    expect(calls).toHaveLength(1);
  });

  it("uses the cloud model when the sidecar fails or sends an invalid action", async () => {
    const errors: unknown[] = [];
    const down = async (): Promise<FastDecision> => {
      throw new Error("ECONNREFUSED");
    };
    const a = fakeClient([]);
    const events = await command(withFastPath(anthropicProvider(a.client), down, (err) => errors.push(err)));
    expect(events[0]).toMatchObject({ source: "cloud", detail: expect.stringContaining("unavailable") });
    expect(a.calls).toHaveLength(1);
    expect(errors).toHaveLength(1);

    const b = fakeClient([]);
    const bad = decide({ route: "fast", actions: [{ name: "update_element", input: { target: "api", color: "chartreuse" } }] });
    expect((await command(withFastPath(anthropicProvider(b.client), bad)))[0]).toMatchObject({ source: "cloud" });
    expect(b.calls).toHaveLength(1);
  });

  it("reports itself in /api/health", async () => {
    const { client } = fakeClient([]);
    const app = buildApp(withFastPath(anthropicProvider(client), decide({ route: "llm", actions: null })), { logger: false });
    expect((await app.inject({ method: "GET", url: "/api/health" })).json()).toMatchObject({ fastPath: true, model: "claude-haiku-4-5" });
  });

  it("posts the command to the sidecar over HTTP", async () => {
    const sidecar = buildApp(anthropicProvider(fakeClient([]).client), { logger: false });
    let body: unknown;
    sidecar.post("/decide", async (req) => {
      body = req.body;
      return { route: "ignore", actions: null };
    });
    const url = await sidecar.listen({ port: 0, host: "127.0.0.1" });
    try {
      expect(await httpFastPath(url)({ text: "hello", scene })).toEqual({ route: "ignore", actions: null });
      expect(body).toEqual({ text: "hello", scene });
      await expect(httpFastPath(`${url}/missing`)({ text: "hello", scene })).rejects.toThrow(/404/);
    } finally {
      await sidecar.close();
    }
  });

  it("is configured by FASTPATH_URL", () => {
    expect(fastPathFromEnv({})).toBeUndefined();
    expect(fastPathFromEnv({ FASTPATH_URL: "http://127.0.0.1:8788" })).toBeTypeOf("function");
    expect(() => fastPathFromEnv({ FASTPATH_URL: "http://x", FASTPATH_TIMEOUT_MS: "soon" })).toThrow(/FASTPATH_TIMEOUT_MS/);
  });
});
