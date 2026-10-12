import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import { describe, expect, it } from "vitest";
import type { CommandEvent, CommandRequest } from "@board/shared";
import { buildApp } from "./app";
import { fastPathFromEnv, httpFastPath, withFastPath, type FastDecision } from "./fastpath";
import { anthropicSupportsEffort, effortFromEnv, maxTurnsFromEnv, openaiEffortParam, openaiSupportsEffort } from "./effort";
import { anthropicProvider, openaiClientFromEnv, openaiProvider, providerFromEnv } from "./provider";
import { buildUserMessage } from "./prompt";
import { TOOLS, blockToEvents } from "./system1";
import { OPENAI_TOOLS, looksMultiStep, toolCallToEvent } from "./system1-openai";

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
      "add_dimension",
      "move_element",
      "animate_element",
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

/** Like fakeOpenAI, but request N replays turns[N] (a turn that is an Error is thrown instead of streamed). */
function fakeOpenAITurns(turns: (Delta[] | Error)[]) {
  const calls: { messages: { role: string }[] }[] = [];
  const client = {
    chat: {
      completions: {
        async create(params: { messages: { role: string }[] }) {
          const turn = turns[calls.length] ?? [];
          calls.push({ messages: [...params.messages] });
          if (turn instanceof Error) throw turn;
          return (async function* () {
            for (const delta of turn) yield { model: "fake-gpt", choices: [{ index: 0, delta, finish_reason: null }] };
            yield {
              model: "fake-gpt",
              choices: [{ index: 0, delta: {}, finish_reason: turn.some((d) => d.tool_calls) ? "tool_calls" : "stop" }],
            };
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

describe("OpenAI follow-up turns (models that make one tool call per turn)", () => {
  const run = (client: OpenAI, text: string, maxTurns?: number) =>
    buildApp(openaiProvider(client, "m", true, "off", maxTurns), { logger: false })
      .inject({ method: "POST", url: "/api/command", payload: { text, scene } })
      .then((res) => parseSse(res.body));

  it("answers a lone call with a tool result and asks again until the model stops", async () => {
    const { client, calls } = fakeOpenAITurns([
      [fn(0, "add_object", '{"id":"tree","object":"tree"}')],
      [fn(0, "add_object", '{"id":"flower","object":"flower"}')],
      [{ content: "Done." }],
    ]);
    const events = await run(client, "draw a tree and flower");
    expect(events.map((e) => e.type)).toEqual(["route", "action", "action", "say", "done"]);
    expect(events.at(-1)).toMatchObject({ type: "done", actions: 2 });
    expect(calls).toHaveLength(3);
    expect(calls[1]!.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(calls[2]!.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "assistant", "tool"]);
  });

  it("does not follow up single-step commands, batched calls or when maxTurns is 1", async () => {
    const one = [fn(0, "add_object", '{"id":"tree","object":"tree"}')];
    expect(await run(fakeOpenAITurns([one]).client, "draw a tree")).toHaveLength(3);
    const batched = fakeOpenAITurns([[...one, fn(1, "add_object", '{"id":"flower","object":"flower"}')]]);
    await run(batched.client, "draw a tree and flower");
    expect(batched.calls).toHaveLength(1);
    const capped = fakeOpenAITurns([one]);
    await run(capped.client, "draw a tree and flower", 1);
    expect(capped.calls).toHaveLength(1);
  });

  it("keeps the applied steps and reports the problem when a follow-up request fails", async () => {
    const { client } = fakeOpenAITurns([[fn(0, "add_object", '{"id":"tree","object":"tree"}')], new Error("boom")]);
    const events = await run(client, "draw a tree and flower");
    expect(events.map((e) => e.type)).toEqual(["route", "action", "error", "done"]);
    expect(events[2]).toMatchObject({ message: expect.stringContaining("first 1 step") });
    expect(events.at(-1)).toMatchObject({ actions: 1 });
  });

  it("detects multi-step wording and parses SYSTEM1_MAX_TURNS", () => {
    expect(looksMultiStep("enlarge boy and draw flower")).toBe(true);
    expect(looksMultiStep("draw a house, a car")).toBe(true);
    expect(looksMultiStep("draw a tree")).toBe(false);
    expect(maxTurnsFromEnv({})).toBe(6);
    expect(maxTurnsFromEnv({ SYSTEM1_MAX_TURNS: "1" })).toBe(1);
    expect(() => maxTurnsFromEnv({ SYSTEM1_MAX_TURNS: "0" })).toThrow(/SYSTEM1_MAX_TURNS/);
  });
});

describe("reasoning effort", () => {
  it("defaults to low and validates REASONING_EFFORT", () => {
    expect(effortFromEnv({})).toBe("low");
    expect(effortFromEnv({ REASONING_EFFORT: " High " })).toBe("high");
    expect(effortFromEnv({ REASONING_EFFORT: "off" })).toBe("off");
    expect(() => effortFromEnv({ REASONING_EFFORT: "max" })).toThrow(/REASONING_EFFORT/);
  });
  it("only knows which models accept it", () => {
    expect(openaiSupportsEffort("gpt-oss-120b")).toBe(true);
    expect(openaiSupportsEffort("gpt-5-mini")).toBe(true);
    expect(openaiSupportsEffort("qwen-3.8-27b")).toBe(true);
    expect(openaiEffortParam("qwen-3.8-27b", "off")).toBe("none");
    expect(openaiEffortParam("qwen-3.8-27b", "low")).toBe("low");
    expect(openaiEffortParam("gpt-oss-120b", "off")).toBeUndefined();
    expect(openaiEffortParam("gpt-4.1-mini", "high")).toBeUndefined();
    expect(openaiSupportsEffort("gpt-4.1-mini")).toBe(false);
    expect(anthropicSupportsEffort("claude-sonnet-5-5")).toBe(true);
    expect(anthropicSupportsEffort("claude-haiku-4-5")).toBe(false);
  });
  it("sends effort to Anthropic models that support it, and not to Haiku", async () => {
    const run = async (model: string, effort?: "off" | "high") => {
      const { client, calls } = fakeClient([]);
      await anthropicProvider(client, model, true, effort).run({ text: "x", scene }, () => {});
      return calls[0];
    };
    expect(await run("claude-sonnet-5-5")).toMatchObject({ output_config: { effort: "low" } });
    expect(await run("claude-sonnet-5-5", "high")).toMatchObject({ output_config: { effort: "high" } });
    expect(await run("claude-sonnet-5-5", "off")).not.toHaveProperty("output_config");
    expect(await run("claude-haiku-4-5")).not.toHaveProperty("output_config");
  });
  it("sends reasoning_effort to OpenAI-compatible models that support it", async () => {
    const run = async (model: string, effort?: "off") => {
      const { client, calls } = fakeOpenAI([]);
      await openaiProvider(client, model, true, effort).run({ text: "x", scene }, () => {});
      return calls[0];
    };
    expect(await run("gpt-oss-120b")).toMatchObject({ reasoning_effort: "low" });
    expect(await run("gpt-oss-120b", "off")).not.toHaveProperty("reasoning_effort");
    expect(await run("gpt-4.1-mini")).not.toHaveProperty("reasoning_effort");
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
  it("points the OpenAI client at OPENAI_BASE_URL when set", () => {
    expect(openaiClientFromEnv({ OPENAI_API_KEY: "o" }).baseURL).toBe("https://api.openai.com/v1");
    expect(openaiClientFromEnv({ OPENAI_API_KEY: "o", OPENAI_BASE_URL: "https://api.cerebras.ai/v1" }).baseURL).toBe(
      "https://api.cerebras.ai/v1",
    );
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

  it("streams a locally built add_object", async () => {
    const { client, calls } = fakeClient([]);
    const fast = decide({
      route: "fast",
      actions: [{ name: "add_object", input: { id: "tree", object: "tree", size: "large" } }],
      reason: "add_object tree",
      model: "laya:top6",
    });
    const events = await command(withFastPath(anthropicProvider(client), fast));
    expect(events.map((e) => e.type)).toEqual(["route", "action", "done"]);
    expect(events[1]).toMatchObject({ action: { name: "add_object", input: { object: "tree", size: "large" } } });
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
