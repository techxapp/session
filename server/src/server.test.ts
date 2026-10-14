import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import { describe, expect, it } from "vitest";
import type { CommandEvent, CommandRequest } from "@board/shared";
import { buildApp } from "./app";
import { fastPathFromEnv, httpFastPath, withFastPath, type FastDecision } from "./fastpath";
import { anthropicSupportsEffort, effortFromEnv, maxTurnsFromEnv, openaiEffortParam, openaiSupportsEffort } from "./effort";
import {
  anthropicProvider,
  buildProvider,
  listModels,
  openaiClientFromEnv,
  openaiProvider,
  providerFromEnv,
  settingsFromEnv,
  type ClientFactory,
} from "./provider";
import { SYSTEM_PROMPT, buildUserMessage } from "./prompt";
import { TOOLS, TOOLS_BY_MODE, blockToEvents, toolsFor, usageOf } from "./system1";
import { OPENAI_TOOLS, OPENAI_TOOLS_BY_MODE, addUsage, looksMultiStep, openaiToolsFor, toolCallToEvent } from "./system1-openai";

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
      "generate_diagram",
      "add_dimension",
      "plot_graph",
      "add_chart",
      "move_element",
      "animate_element",
      "update_element",
      "delete_elements",
      "scroll_view",
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

  it("list the catalog in add_object only in enum mode", () => {
    const objectProp = (tools: Anthropic.Tool[]) =>
      (tools.find((t) => t.name === "add_object")!.input_schema.properties as Record<string, { enum?: string[]; type?: string }>).object;
    expect(objectProp(TOOLS_BY_MODE.enum).enum).toContain("tree");
    expect(objectProp(TOOLS_BY_MODE.text)).toMatchObject({ type: "string" });
    expect(objectProp(TOOLS_BY_MODE.text).enum).toBeUndefined();
    expect(JSON.stringify(TOOLS_BY_MODE.text).length).toBeLessThan(JSON.stringify(TOOLS_BY_MODE.enum).length - 1500);
    expect(TOOLS_BY_MODE.text.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    expect(OPENAI_TOOLS_BY_MODE.text.map((t) => t.function.name)).toEqual(TOOLS.map((t) => t.name));
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
  it("accepts scroll_view with exactly one of direction / to / edge / fit", () => {
    expect(blockToEvents(toolUse("scroll_view", { direction: "down", distance: "little" }), 0)[0].type).toBe("action");
    expect(blockToEvents(toolUse("scroll_view", { to: "db" }), 0)[0].type).toBe("action");
    expect(blockToEvents(toolUse("scroll_view", { fit: "all" }), 0)[0].type).toBe("action");
    expect(blockToEvents(toolUse("scroll_view", { direction: "down", edge: "top" }), 0)[0].type).toBe("invalid");
    expect(blockToEvents(toolUse("scroll_view", {}), 0)[0].type).toBe("invalid");
    expect(blockToEvents(toolUse("plot_graph", { equations: ["y = x^2", "sin(2x)"], x_min: -5, x_max: 5 }), 0)[0].type).toBe("action");
    expect(blockToEvents(toolUse("plot_graph", { equations: ["x^2 + y^2 = 1"] }), 0)[0].type).toBe("invalid");
    expect(blockToEvents(toolUse("plot_graph", { equations: ["y = foo(x)"] }), 0)[0].type).toBe("invalid");
    expect(blockToEvents(toolUse("plot_graph", { equations: ["x"], x_min: 3, x_max: 1 }), 0)[0].type).toBe("invalid");
    const pie = { kind: "pie", labels: ["Rent", "Food"], series: [{ values: [40, 60] }] };
    expect(blockToEvents(toolUse("add_chart", pie), 0)[0].type).toBe("action");
    expect(blockToEvents(toolUse("add_chart", { ...pie, series: [{ values: [40] }] }), 0)[0].type).toBe("invalid");
    expect(blockToEvents(toolUse("add_chart", { ...pie, series: [{ values: [40, -1] }] }), 0)[0].type).toBe("invalid");
    expect(blockToEvents(toolUse("add_chart", { ...pie, series: [{ values: [1, 2] }, { values: [3, 4] }] }), 0)[0].type).toBe("invalid");
    expect(
      blockToEvents(toolUse("add_chart", { ...pie, kind: "column", series: [{ values: [1, 2] }, { values: [3, -4] }] }), 0)[0].type,
    ).toBe("action");
  });
  it("accepts generate_diagram with unique node ids only", () => {
    const nodes = [
      { id: "start", label: "Start", kind: "ellipse" },
      { id: "check", label: "Logged in?", kind: "diamond" },
    ];
    const edges = [{ from: "start", to: "check" }];
    expect(blockToEvents(toolUse("generate_diagram", { nodes, edges, direction: "right" }), 0)[0].type).toBe("action");
    expect(blockToEvents(toolUse("generate_diagram", { nodes: [nodes[0], nodes[0]] }), 0)[0].type).toBe("invalid");
    expect(blockToEvents(toolUse("generate_diagram", { nodes: [nodes[0]] }), 0)[0].type).toBe("invalid");
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

  it("lists a chart's data under it, so the model can redraw it with a change", () => {
    const data = 'pie; labels ["Rent","Food"]; series [60,40]; colors blue, red';
    const msg = buildUserMessage("set food to 50", {
      ...scene,
      elements: [{ id: "c", type: "chart", label: "Spend", x: 0, y: 0, w: 480, h: 360, data }],
    });
    expect(msg).toContain(`- c: chart "Spend" at (0, 0) size 480x360\n  data: ${data}`);
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

  it("in OBJECT_MODE=text sends free-text tools and maps objects to the catalog or a box", async () => {
    const { client, calls } = fakeClient([
      toolUse("add_object", { id: "pup", object: "puppies" }),
      toolUse("add_object", { id: "tower", object: "skyscraper" }),
    ]);
    const res = await buildApp(anthropicProvider(client, undefined, true, "low", "text"), { logger: false }).inject({
      method: "POST",
      url: "/api/command",
      payload: { text: "draw a puppy and a skyscraper", scene },
    });
    const events = parseSse(res.body);
    expect(events[1]).toMatchObject({ action: { name: "add_object", input: { id: "pup", object: "dog" } } });
    expect(events[2]).toMatchObject({ action: { name: "add_shape", input: { id: "tower", kind: "rectangle", label: "skyscraper" } } });
    expect((calls[0] as { tools: unknown }).tools).toBe(toolsFor(["object"], "text"));
  });

  it("routes tools: core only for a plain command, plus the groups a command needs, or all of them", async () => {
    const run = async (text: string, tools?: "auto" | "all", chart = false) => {
      const { client, calls } = fakeClient([]);
      const s = chart
        ? {
            ...scene,
            elements: [
              ...scene.elements,
              { id: "sales", type: "chart" as const, x: 0, y: 0, w: 1, h: 1, data: 'column; labels ["Q1","Q2"]' },
            ],
          }
        : scene;
      const res = await buildApp(anthropicProvider(client, undefined, true, "low", "enum", tools), { logger: false }).inject({
        method: "POST",
        url: "/api/command",
        payload: { text, scene: s },
      });
      const params = calls[0] as { tools: Anthropic.Tool[]; system: { text: string }[]; messages: { content: string }[] };
      return {
        names: params.tools.map((t) => t.name),
        system: params.system[0].text,
        user: params.messages[0].content,
        events: parseSse(res.body),
      };
    };
    const plain = await run("add a red box next to the api");
    expect(plain.names).toEqual([
      "add_shape",
      "add_text",
      "add_arrow",
      "move_element",
      "update_element",
      "delete_elements",
      "undo_last_command",
      "clear_board",
    ]);
    expect(plain.system).not.toContain("plot_graph");
    expect(plain.events.at(-1)).toMatchObject({ type: "done", tools: ["core"] });
    const chart = await run("set Q2 to 20", "auto", true);
    expect(chart.names).toContain("add_chart");
    expect(chart.user).toContain("data: column");
    expect((await run("make it bigger", "auto", true)).user).not.toContain("data:");
    const all = await run("add a red box", "all");
    expect(all.names).toEqual(TOOLS.map((t) => t.name));
    expect(all.system).toBe(SYSTEM_PROMPT);
    expect(all.events.at(-1)).toMatchObject({ tools: ["all"] });
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

describe("token usage", () => {
  it("counts Anthropic cache reads and writes as sent tokens", () => {
    const usage = { input_tokens: 40, output_tokens: 90, cache_read_input_tokens: 8000, cache_creation_input_tokens: 0 };
    expect(usageOf({ usage } as Anthropic.Message)).toEqual({ in: 8040, out: 90, cached: 8000 });
    expect(usageOf({ usage: { ...usage, cache_read_input_tokens: null } } as unknown as Anthropic.Message)).toEqual({ in: 40, out: 90 });
  });

  it("sums OpenAI usage over follow-up turns", () => {
    const one = addUsage(undefined, { prompt_tokens: 3000, completion_tokens: 50, total_tokens: 3050 });
    expect(one).toEqual({ in: 3000, out: 50 });
    const two = addUsage(one, {
      prompt_tokens: 3100,
      completion_tokens: 40,
      total_tokens: 3140,
      prompt_tokens_details: { cached_tokens: 2900 },
    });
    expect(two).toEqual({ in: 6100, out: 90, cached: 2900 });
  });
});

describe("POST /api/command (OpenAI)", () => {
  it("sends the routed tool subset on every turn", async () => {
    const { client, calls } = fakeOpenAI([fn(0, "add_shape", '{"kind":"rectangle"}')]);
    await buildApp(openaiProvider(client), { logger: false }).inject({
      method: "POST",
      url: "/api/command",
      payload: { text: "scroll down and add a box", scene },
    });
    const tools = (calls[0] as { tools: OpenAI.Chat.Completions.ChatCompletionFunctionTool[] }).tools;
    expect(tools).toBe(openaiToolsFor(["scroll"]));
    expect(calls[0]).toMatchObject({ stream_options: { include_usage: true } });
    expect(tools.map((t) => t.function.name)).toContain("scroll_view");
    expect(tools.map((t) => t.function.name)).not.toContain("add_chart");
  });

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
    expect(() => providerFromEnv({ OBJECT_MODE: "fuzzy" })).toThrow(/OBJECT_MODE/);
  });
});

describe("request config (UI settings over .env)", () => {
  /** Records the options each client was built with; the clients are fakes that replay `blocks`. */
  function factory(blocks: Anthropic.ContentBlock[] = []) {
    const built: { style: string; apiKey: string; baseURL?: string }[] = [];
    const f: ClientFactory = {
      anthropic: (o) => (built.push({ style: "anthropic", ...o }), fakeClient(blocks).client),
      openai: (o) => {
        built.push({ style: "openai", ...o });
        const client = fakeOpenAI([]).client as unknown as { models: unknown };
        client.models = {
          list: async function* () {
            yield { id: "m-b" };
            yield { id: "m-a" };
          },
        };
        return client as unknown as OpenAI;
      },
    };
    return { f, built };
  }
  const env = {
    ANTHROPIC_API_KEY: "env-anthropic",
    OPENAI_API_KEY: "env-cerebras",
    OPENAI_BASE_URL: "https://api.cerebras.ai/v1",
    SYSTEM1_MODEL: "env-model",
  };

  it("sends the .env key only to the endpoint .env sets it for", () => {
    const s = settingsFromEnv(env);
    const { f, built } = factory();
    expect(buildProvider(s, {}, f)).toMatchObject({ name: "anthropic", hasKey: true, model: "env-model" });
    buildProvider(s, { provider: "openai", baseUrl: "https://api.cerebras.ai/v1/", model: "gpt-oss-120b" }, f);
    const other = buildProvider(s, { provider: "openai", baseUrl: "https://evil.example/v1", model: "x" }, f);
    expect(built.map((b) => b.apiKey)).toEqual(["env-anthropic", "env-cerebras", "missing"]);
    expect(other.hasKey).toBe(false);
  });

  it("uses the browser's key, model, effort and object mode over .env", () => {
    const { f, built } = factory();
    const p = buildProvider(
      settingsFromEnv(env),
      { provider: "openai", baseUrl: "https://api.x.ai/v1", apiKey: "mine", model: "grok-x", objectMode: "text" },
      f,
    );
    expect(p).toMatchObject({ name: "openai", model: "grok-x", hasKey: true, objects: "text" });
    expect(built[0]).toEqual({ style: "openai", apiKey: "mine", baseURL: "https://api.x.ai/v1" });
  });

  it("falls back to SYSTEM1_MODEL only on the .env endpoint, and needs a model elsewhere", () => {
    const s = settingsFromEnv(env);
    const { f } = factory();
    expect(buildProvider(s, { provider: "anthropic" }, f).model).toBe("env-model");
    expect(buildProvider(s, { provider: "openai" }, f).model).toBe("gpt-4.1-mini");
    expect(buildProvider(s, {}, f).tools).toBe("auto");
    expect(buildProvider(s, { tools: "all" }, f).tools).toBe("all");
    expect(settingsFromEnv({ ...env, TOOL_ROUTER: "all" }).tools).toBe("all");
    expect(() => settingsFromEnv({ ...env, TOOL_ROUTER: "some" })).toThrow(/TOOL_ROUTER/);
    expect(() => buildProvider(s, { provider: "openai", baseUrl: "https://api.groq.com/openai/v1" }, f)).toThrow(/Choose a model/);
  });

  it("runs a command with the request's config and reports the object mode on the route event", async () => {
    const s = settingsFromEnv(env);
    const { f, built } = factory([toolUse("add_object", { object: "kangaroo" })]);
    const app = buildApp(anthropicProvider(fakeClient([]).client), { logger: false, forConfig: (c) => buildProvider(s, c, f) });
    const res = await app.inject({
      method: "POST",
      url: "/api/command",
      payload: { text: "draw a kangaroo", scene, config: { provider: "anthropic", apiKey: "k", objectMode: "text" } },
    });
    const events = parseSse(res.body);
    expect(events[0]).toMatchObject({ type: "route", source: "cloud", model: "env-model", objects: "text" });
    expect(events.at(-1)).toMatchObject({ type: "done", tools: ["core", "object"] });
    expect(events[1]).toMatchObject({ action: { name: "add_object", input: { object: "kangaroo" } } });
    expect(built[0].apiKey).toBe("k");
  });

  it("rejects a bad config with 400 before streaming", async () => {
    const s = settingsFromEnv(env);
    const app = buildApp(anthropicProvider(fakeClient([]).client), { logger: false, forConfig: (c) => buildProvider(s, c, factory().f) });
    const post = (config: unknown) => app.inject({ method: "POST", url: "/api/command", payload: { text: "x", scene, config } });
    expect((await post({ provider: "openai", baseUrl: "ftp://x" })).statusCode).toBe(400);
    const noModel = await post({ provider: "openai", baseUrl: "https://api.groq.com/openai/v1" });
    expect(noModel.statusCode).toBe(400);
    expect(noModel.json().error).toMatch(/Choose a model/);
  });

  it("lists an endpoint's models, and refuses without a key", async () => {
    const s = settingsFromEnv(env);
    const { f } = factory();
    expect(await listModels(s, { provider: "openai", baseUrl: "https://api.cerebras.ai/v1" }, f)).toEqual(["m-a", "m-b"]);
    await expect(listModels(s, { provider: "openai", baseUrl: "https://api.x.ai/v1" }, f)).rejects.toThrow(/No API key/);
    const app = buildApp(anthropicProvider(fakeClient([]).client), { logger: false, listModels: (c) => listModels(s, c, f) });
    const res = await app.inject({
      method: "POST",
      url: "/api/models",
      payload: { config: { provider: "openai", baseUrl: "https://api.x.ai/v1" } },
    });
    expect(res.statusCode).toBe(502);
  });

  it("reports the .env defaults on /api/health without any key", async () => {
    const s = settingsFromEnv({ ...env, LLM_PROVIDER: "openai", OBJECT_MODE: "text" });
    const app = buildApp(providerFromEnv({ ...env, LLM_PROVIDER: "openai", OBJECT_MODE: "text" }), {
      logger: false,
      info: { baseUrl: s.baseUrl, keyedEndpoints: [...s.keys.keys()], effort: s.effort },
    });
    const health = (await app.inject({ method: "GET", url: "/api/health" })).json();
    expect(health).toMatchObject({ provider: "openai", baseUrl: "https://api.cerebras.ai/v1", objectMode: "text", effort: "low" });
    expect(health.keyedEndpoints).toEqual(["anthropic https://api.anthropic.com", "openai https://api.cerebras.ai/v1"]);
    expect(JSON.stringify(health)).not.toMatch(/env-anthropic|env-cerebras/);
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

  it("streams a rule-built scroll_view", async () => {
    const { client, calls } = fakeClient([]);
    const fast = decide({
      route: "fast",
      actions: [{ name: "scroll_view", input: { direction: "down" } }],
      reason: "rule: scroll",
      model: "rules",
    });
    const events = await command(withFastPath(anthropicProvider(client), fast));
    expect(events.map((e) => e.type)).toEqual(["route", "action", "done"]);
    expect(events[1]).toMatchObject({ action: { name: "scroll_view", input: { direction: "down" } } });
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
