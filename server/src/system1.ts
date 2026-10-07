import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { ACTION_DESCRIPTIONS, ACTION_NAMES, ACTION_SCHEMAS, parseAction, type CommandEvent, type CommandRequest } from "@board/shared";
import { SYSTEM_PROMPT, buildUserMessage } from "./prompt";

export const SYSTEM1_MODEL = process.env.SYSTEM1_MODEL || "claude-haiku-4-5";

/** Tool definitions generated from the shared zod schemas (single source of truth). */
export const TOOLS: Anthropic.Tool[] = ACTION_NAMES.map((name, i) => {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(ACTION_SCHEMAS[name], { io: "input" }) as Record<string, unknown>;
  return {
    name,
    description: ACTION_DESCRIPTIONS[name],
    input_schema: schema as Anthropic.Tool.InputSchema,
    // Stream each tool input as it's generated so the first action reaches the board sooner.
    // Inputs are validated with the zod schema before they're forwarded.
    eager_input_streaming: true,
    // Cache the stable tools + system prefix.
    ...(i === ACTION_NAMES.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
  };
});

type Emit = (event: CommandEvent) => void;

/** Turn one completed content block into client events. Exported for tests. */
export function blockToEvents(block: Anthropic.ContentBlock, startedAt: number): CommandEvent[] {
  if (block.type === "tool_use") {
    const parsed = parseAction(block.name, block.input);
    if (!parsed.ok) return [{ type: "invalid", name: block.name, error: parsed.error }];
    return [{ type: "action", action: parsed.action, ms: Date.now() - startedAt }];
  }
  if (block.type === "text" && block.text.trim()) return [{ type: "say", text: block.text.trim() }];
  return [];
}

/**
 * System 1: one fast, streaming call. The model answers with tool calls only;
 * each completed tool call is validated and forwarded to the client immediately.
 * There is no tool-result round trip - the client applies the actions.
 */
export async function runSystem1(client: Anthropic, req: CommandRequest, emit: Emit, signal?: AbortSignal) {
  const startedAt = Date.now();
  let count = 0;

  const stream = client.messages.stream(
    {
      model: SYSTEM1_MODEL,
      max_tokens: 4096,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: TOOLS,
      tool_choice: { type: "auto" },
      messages: [{ role: "user", content: buildUserMessage(req.text, req.scene) }],
    },
    { signal },
  );

  stream.on("contentBlock", (block) => {
    for (const event of blockToEvents(block, startedAt)) {
      if (event.type === "action") count++;
      emit(event);
    }
  });

  const message = await stream.finalMessage();
  if (message.stop_reason === "refusal") {
    emit({ type: "error", message: "The model declined this command." });
  } else if (message.stop_reason === "max_tokens") {
    emit({ type: "error", message: "Command was too long to finish; try splitting it up." });
  }
  emit({ type: "done", ms: Date.now() - startedAt, model: message.model, actions: count });
}
