import type OpenAI from "openai";
import { parseAction, type CommandRequest } from "@board/shared";
import { SYSTEM_PROMPT, buildUserMessage } from "./prompt";
import { TOOLS, type Emit } from "./system1";

export const DEFAULT_OPENAI_MODEL = "gpt-4.1-mini";

/** The same tool definitions as the Anthropic path, in OpenAI's function-calling shape. */
export const OPENAI_TOOLS: OpenAI.Chat.Completions.ChatCompletionFunctionTool[] = TOOLS.map((t) => ({
  type: "function",
  function: { name: t.name, description: t.description, parameters: t.input_schema as Record<string, unknown> },
}));

interface PendingCall {
  name: string;
  args: string;
}

/** Validate one finished tool call into a client event. Exported for tests. */
export function toolCallToEvent(call: PendingCall, startedAt: number) {
  let input: unknown;
  try {
    input = call.args.trim() ? JSON.parse(call.args) : {};
  } catch {
    return { type: "invalid" as const, name: call.name, error: "tool arguments were not valid JSON" };
  }
  const parsed = parseAction(call.name, input);
  if (!parsed.ok) return { type: "invalid" as const, name: call.name, error: parsed.error };
  return { type: "action" as const, action: parsed.action, ms: Date.now() - startedAt };
}

/**
 * System 1 on OpenAI: one streaming chat completion that answers with tool calls only.
 * Tool-call deltas are stitched together per index; a call is complete once the next one
 * starts (or the stream ends), and is validated and forwarded immediately.
 */
export async function runSystem1OpenAI(
  client: OpenAI,
  req: CommandRequest,
  emit: Emit,
  signal?: AbortSignal,
  model = DEFAULT_OPENAI_MODEL,
) {
  const startedAt = Date.now();
  let count = 0;

  const stream = await client.chat.completions.create(
    {
      model,
      max_completion_tokens: 4096,
      stream: true,
      tools: OPENAI_TOOLS,
      tool_choice: "auto",
      parallel_tool_calls: true,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserMessage(req.text, req.scene) },
      ],
    },
    { signal },
  );

  const calls = new Map<number, PendingCall>();
  let current = -1;
  let text = "";
  let finish: string | null = null;
  let actualModel = model;

  const flush = (index: number) => {
    const call = calls.get(index);
    if (!call) return;
    calls.delete(index);
    const event = toolCallToEvent(call, startedAt);
    if (event.type === "action") count++;
    emit(event);
  };

  for await (const chunk of stream) {
    actualModel = chunk.model || actualModel;
    const choice = chunk.choices[0];
    if (!choice) continue;
    if (choice.delta.content) text += choice.delta.content;
    for (const tc of choice.delta.tool_calls ?? []) {
      if (tc.index !== current) {
        if (current >= 0) flush(current);
        current = tc.index;
      }
      const call = calls.get(tc.index) ?? { name: "", args: "" };
      if (tc.function?.name) call.name += tc.function.name;
      if (tc.function?.arguments) call.args += tc.function.arguments;
      calls.set(tc.index, call);
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  }
  if (current >= 0) flush(current);

  if (text.trim()) emit({ type: "say", text: text.trim() });
  if (finish === "content_filter") {
    emit({ type: "error", message: "The model declined this command." });
  } else if (finish === "length") {
    emit({ type: "error", message: "Command was too long to finish; try splitting it up." });
  }
  emit({ type: "done", ms: Date.now() - startedAt, model: actualModel, actions: count });
}
