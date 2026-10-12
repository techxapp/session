import type OpenAI from "openai";
import { parseAction, type CommandRequest } from "@board/shared";
import { DEFAULT_EFFORT, DEFAULT_MAX_TURNS, openaiEffortParam, type ReasoningEffort } from "./effort";
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

/** Does the command read like several steps ("X and Y", "X, then Y")? Only those get follow-up turns. */
export function looksMultiStep(text: string): boolean {
  return /,|\b(and|then|also|after|before|plus|next)\b/i.test(text);
}

/**
 * System 1 on OpenAI: a streaming chat completion that answers with tool calls only.
 * Tool-call deltas are stitched together per index; a call is complete once the next one
 * starts (or the stream ends), and is validated and forwarded immediately.
 *
 * Some models (gpt-oss on Cerebras) ignore parallel_tool_calls and make ONE call per turn, so a
 * multi-step command would stop after its first step. When a turn makes exactly one call and the
 * command looks multi-step, the call is answered with a tool result and the model gets another turn.
 * Models that do batch their calls (2+ in one turn) and single-step commands stay at one request.
 * Each follow-up is another request, which counts against rate limits (Cerebras free tier is requests/minute);
 * `maxTurns` caps them (1 = off). If a follow-up fails, the steps already emitted stay and an `error` event says why.
 */
export async function runSystem1OpenAI(
  client: OpenAI,
  req: CommandRequest,
  emit: Emit,
  signal?: AbortSignal,
  model = DEFAULT_OPENAI_MODEL,
  effort: ReasoningEffort = DEFAULT_EFFORT,
  maxTurns = DEFAULT_MAX_TURNS,
  describeError: (err: unknown) => string | undefined = () => undefined,
) {
  const startedAt = Date.now();
  const multiStep = looksMultiStep(req.text);
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildUserMessage(req.text, req.scene) },
  ];
  let count = 0;
  let text = "";
  let finish: string | null = null;
  let actualModel = model;

  for (let turn = 0; turn < maxTurns; turn++) {
    let stream;
    try {
      stream = await client.chat.completions.create(
        {
          model,
          max_completion_tokens: 4096,
          ...(openaiEffortParam(model, effort) ? { reasoning_effort: openaiEffortParam(model, effort) } : {}),
          stream: true,
          tools: OPENAI_TOOLS,
          tool_choice: "auto",
          parallel_tool_calls: true,
          messages,
        },
        { signal },
      );
    } catch (err) {
      if (turn === 0 || signal?.aborted) throw err;
      emit({ type: "error", message: `${describeError(err) ?? "Model request failed."} Only the first ${turn} step(s) were applied.` });
      text = "";
      finish = null;
      break;
    }

    const calls = new Map<number, PendingCall & { id: string; result?: string }>();
    const order: number[] = [];
    let current = -1;
    text = "";
    finish = null;

    const flush = (index: number) => {
      const call = calls.get(index);
      if (!call || call.result !== undefined) return;
      const event = toolCallToEvent(call, startedAt);
      if (event.type === "action") count++;
      call.result = event.type === "invalid" ? `error: ${event.error}` : "ok. Continue with the remaining steps of the command, if any.";
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
        let call = calls.get(tc.index);
        if (!call) {
          call = { id: "", name: "", args: "" };
          calls.set(tc.index, call);
          order.push(tc.index);
        }
        if (tc.id) call.id = tc.id;
        if (tc.function?.name) call.name += tc.function.name;
        if (tc.function?.arguments) call.args += tc.function.arguments;
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
    if (current >= 0) flush(current);

    // A single call on a multi-step command: answer it and let the model continue.
    if (!(multiStep && finish === "tool_calls" && order.length === 1 && turn < maxTurns - 1)) break;
    const done = order.map((i) => calls.get(i)!);
    done.forEach((c, i) => (c.id ||= `call_${turn}_${i}`));
    messages.push({
      role: "assistant",
      content: text.trim() || null,
      tool_calls: done.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.args } })),
    });
    for (const c of done) messages.push({ role: "tool", tool_call_id: c.id, content: c.result ?? "ok" });
  }

  if (text.trim()) emit({ type: "say", text: text.trim() });
  if (finish === "content_filter") {
    emit({ type: "error", message: "The model declined this command." });
  } else if (finish === "length") {
    emit({ type: "error", message: "Command was too long to finish; try splitting it up." });
  }
  emit({ type: "done", ms: Date.now() - startedAt, model: actualModel, actions: count });
}
