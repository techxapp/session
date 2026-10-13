import type { ReasoningEffort } from "@board/shared";

/** `off` sends no effort parameter, except `none` to Cerebras Qwen 3.8 (see openaiEffortParam). */
export type { ReasoningEffort };

export const DEFAULT_EFFORT: ReasoningEffort = "low";

/** Parse REASONING_EFFORT (default `low`). Anything else throws at startup, like LLM_PROVIDER. */
export function effortFromEnv(env: NodeJS.ProcessEnv): ReasoningEffort {
  const v = env.REASONING_EFFORT?.trim().toLowerCase();
  if (!v) return DEFAULT_EFFORT;
  if (v === "off" || v === "low" || v === "medium" || v === "high") return v;
  throw new Error(`REASONING_EFFORT must be "off", "low", "medium" or "high" (got "${env.REASONING_EFFORT}")`);
}

export const DEFAULT_MAX_TURNS = 6;

/** Parse SYSTEM1_MAX_TURNS (default 6): model round trips per command on the OpenAI path. 1 = never follow up. */
export function maxTurnsFromEnv(env: NodeJS.ProcessEnv): number {
  const v = env.SYSTEM1_MAX_TURNS?.trim();
  if (!v) return DEFAULT_MAX_TURNS;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 10)
    throw new Error(`SYSTEM1_MAX_TURNS must be an integer from 1 to 10 (got "${env.SYSTEM1_MAX_TURNS}")`);
  return n;
}

/**
 * Models that accept an effort parameter. Sending it to one that doesn't (gpt-4.1-mini, Claude Haiku 4.5) is a 400,
 * so the parameter is only added for these; for all others the setting is silently a no-op.
 */
export const anthropicSupportsEffort = (model: string) => /^claude-(opus-4-[5-9]|sonnet-4-6|(sonnet|opus|fable|mythos)-5)/.test(model);
/**
 * OpenAI reasoning models, gpt-oss and Cerebras's Qwen 3.8 (low/medium/high; its default is high, so not sending it is slower).
 */
export const openaiSupportsEffort = (model: string) => /^(o\d|gpt-5|gpt-oss|qwen-3\.8)/.test(model);

/** The `reasoning_effort` value to send, or undefined to send nothing. Qwen 3.8 takes "none", so `off` really turns its reasoning off. */
export function openaiEffortParam(model: string, effort: ReasoningEffort): "none" | "low" | "medium" | "high" | undefined {
  if (!openaiSupportsEffort(model)) return undefined;
  if (effort !== "off") return effort;
  return /^qwen-3\.8/.test(model) ? "none" : undefined;
}
