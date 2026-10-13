import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  ACTION_DESCRIPTIONS,
  ACTION_NAMES,
  ACTION_SCHEMAS,
  AddObject,
  AddObjectText,
  type CommandEvent,
  type CommandRequest,
} from "@board/shared";
import { DEFAULT_EFFORT, anthropicSupportsEffort, type ReasoningEffort } from "./effort";
import { DEFAULT_OBJECT_MODE, parseToolCall, type ObjectMode } from "./objects";
import { SYSTEM_PROMPT, buildUserMessage } from "./prompt";

export const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5";

/**
 * Tool definitions generated from the shared zod schemas (single source of truth). add_object is per ObjectMode:
 * the curated enum or free text (ACTION_SCHEMAS.add_object, which validates, accepts the whole library).
 */
const buildTools = (objects: ObjectMode): Anthropic.Tool[] =>
  ACTION_NAMES.map((name, i) => {
    const source = name === "add_object" ? (objects === "text" ? AddObjectText : AddObject) : ACTION_SCHEMAS[name];
    const { $schema: _ignored, ...schema } = z.toJSONSchema(source, { io: "input" }) as Record<string, unknown>;
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

export const TOOLS_BY_MODE: Record<ObjectMode, Anthropic.Tool[]> = { enum: buildTools("enum"), text: buildTools("text") };
export const TOOLS = TOOLS_BY_MODE.enum;

export type Emit = (event: CommandEvent) => void;

/** Turn one completed content block into client events. Exported for tests. */
export function blockToEvents(block: Anthropic.ContentBlock, startedAt: number, objects: ObjectMode = DEFAULT_OBJECT_MODE): CommandEvent[] {
  if (block.type === "tool_use") {
    const parsed = parseToolCall(block.name, block.input, objects);
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
export async function runSystem1(
  client: Anthropic,
  req: CommandRequest,
  emit: Emit,
  signal?: AbortSignal,
  model = DEFAULT_ANTHROPIC_MODEL,
  effort: ReasoningEffort = DEFAULT_EFFORT,
  objects: ObjectMode = DEFAULT_OBJECT_MODE,
) {
  const startedAt = Date.now();
  let count = 0;

  const stream = client.messages.stream(
    {
      model,
      max_tokens: 4096,
      ...(effort !== "off" && anthropicSupportsEffort(model) ? { output_config: { effort } } : {}),
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: TOOLS_BY_MODE[objects],
      tool_choice: { type: "auto" },
      messages: [{ role: "user", content: buildUserMessage(req.text, req.scene) }],
    },
    { signal },
  );

  stream.on("contentBlock", (block) => {
    for (const event of blockToEvents(block, startedAt, objects)) {
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
