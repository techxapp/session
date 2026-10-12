/** `off` sends no effort parameter at all. */
export type ReasoningEffort = "off" | "low" | "medium" | "high";

export const DEFAULT_EFFORT: ReasoningEffort = "low";

/** Parse REASONING_EFFORT (default `low`). Anything else throws at startup, like LLM_PROVIDER. */
export function effortFromEnv(env: NodeJS.ProcessEnv): ReasoningEffort {
  const v = env.REASONING_EFFORT?.trim().toLowerCase();
  if (!v) return DEFAULT_EFFORT;
  if (v === "off" || v === "low" || v === "medium" || v === "high") return v;
  throw new Error(`REASONING_EFFORT must be "off", "low", "medium" or "high" (got "${env.REASONING_EFFORT}")`);
}

/**
 * Models that accept an effort parameter. Sending it to one that doesn't (gpt-4.1-mini, Claude Haiku 4.5) is a 400,
 * so the parameter is only added for these; for all others the setting is silently a no-op.
 */
export const anthropicSupportsEffort = (model: string) => /^claude-(opus-4-[5-9]|sonnet-4-6|(sonnet|opus|fable|mythos)-5)/.test(model);
/** OpenAI reasoning models and gpt-oss (also served by Cerebras). */
export const openaiSupportsEffort = (model: string) => /^(o\d|gpt-5|gpt-oss)/.test(model);
