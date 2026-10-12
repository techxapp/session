import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { CommandRequest } from "@board/shared";
import { DEFAULT_ANTHROPIC_MODEL, runSystem1, type Emit } from "./system1";
import { DEFAULT_EFFORT, effortFromEnv, type ReasoningEffort } from "./effort";
import { DEFAULT_OPENAI_MODEL, runSystem1OpenAI } from "./system1-openai";

export type ProviderName = "anthropic" | "openai";

/** A model backend for System 1. The HTTP layer only talks to this. */
export interface Provider {
  name: ProviderName;
  model: string;
  hasKey: boolean;
  /** True when a local fast-path model answers simple commands first (see fastpath.ts). */
  fastPath?: boolean;
  run(req: CommandRequest, emit: Emit, signal?: AbortSignal): Promise<void>;
  /** User-facing message for a failed call, or undefined if the error isn't one this provider recognises. */
  describeError(err: unknown): string | undefined;
}

export function anthropicProvider(
  client: Anthropic,
  model = DEFAULT_ANTHROPIC_MODEL,
  hasKey = true,
  effort: ReasoningEffort = DEFAULT_EFFORT,
): Provider {
  return {
    name: "anthropic",
    model,
    hasKey,
    run: (req, emit, signal) => runSystem1(client, req, emit, signal, model, effort),
    describeError(err) {
      if (err instanceof Anthropic.AuthenticationError) return "Server has no valid ANTHROPIC_API_KEY.";
      if (err instanceof Anthropic.RateLimitError) return "Rate limited by the model API. Try again in a moment.";
      if (err instanceof Anthropic.APIError) return `Model API error (${err.status ?? "network"}).`;
      if (err instanceof Error && /api key|authentication/i.test(err.message)) return "Server has no ANTHROPIC_API_KEY configured.";
    },
  };
}

export function openaiProvider(
  client: OpenAI,
  model = DEFAULT_OPENAI_MODEL,
  hasKey = true,
  effort: ReasoningEffort = DEFAULT_EFFORT,
): Provider {
  return {
    name: "openai",
    model,
    hasKey,
    run: (req, emit, signal) => runSystem1OpenAI(client, req, emit, signal, model, effort),
    describeError(err) {
      if (err instanceof OpenAI.AuthenticationError) return "Server has no valid OPENAI_API_KEY.";
      if (err instanceof OpenAI.RateLimitError) return "Rate limited by the model API. Try again in a moment.";
      if (err instanceof OpenAI.APIError) return `Model API error (${err.status ?? "network"}).`;
      if (err instanceof Error && /api key|authentication/i.test(err.message)) return "Server has no OPENAI_API_KEY configured.";
    },
  };
}

/**
 * OPENAI_BASE_URL points the client at any OpenAI-compatible API (e.g. Cerebras: https://api.cerebras.ai/v1);
 * SYSTEM1_MODEL must then name one of that service's models. The SDK throws at construction without a key,
 * so use a placeholder; calls then fail with a 401.
 */
export function openaiClientFromEnv(env: NodeJS.ProcessEnv): OpenAI {
  return new OpenAI({ apiKey: env.OPENAI_API_KEY || "missing", baseURL: env.OPENAI_BASE_URL || undefined });
}

/**
 * Pick the backend from the environment. LLM_PROVIDER wins; otherwise whichever key is set
 * (Anthropic first if both are). With neither key, fall back to Anthropic so the app still
 * starts and the status pill reports the missing key.
 */
export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): Provider {
  const explicit = env.LLM_PROVIDER?.trim().toLowerCase();
  if (explicit && explicit !== "anthropic" && explicit !== "openai") {
    throw new Error(`LLM_PROVIDER must be "anthropic" or "openai" (got "${env.LLM_PROVIDER}")`);
  }
  const name: ProviderName = explicit ? (explicit as ProviderName) : !env.ANTHROPIC_API_KEY && env.OPENAI_API_KEY ? "openai" : "anthropic";
  const model = env.SYSTEM1_MODEL || undefined;
  const effort = effortFromEnv(env);

  if (name === "openai") {
    const hasKey = Boolean(env.OPENAI_API_KEY);
    return openaiProvider(openaiClientFromEnv(env), model, hasKey, effort);
  }
  return anthropicProvider(new Anthropic(), model, Boolean(env.ANTHROPIC_API_KEY), effort);
}
