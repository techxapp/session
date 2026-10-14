import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { DEFAULT_BASE_URLS, endpointKey, type ApiStyle, type CommandRequest, type ModelConfig, type ToolRouterMode } from "@board/shared";
import { DEFAULT_ANTHROPIC_MODEL, runSystem1, type Emit } from "./system1";
import { DEFAULT_EFFORT, DEFAULT_MAX_TURNS, effortFromEnv, maxTurnsFromEnv, type ReasoningEffort } from "./effort";
import { DEFAULT_OBJECT_MODE, objectModeFromEnv, type ObjectMode } from "./objects";
import { DEFAULT_OPENAI_MODEL, runSystem1OpenAI } from "./system1-openai";
import { DEFAULT_TOOL_ROUTER, toolRouterFromEnv, type ToolHint } from "./toolRouter";

export type ProviderName = ApiStyle;

/** A model backend for System 1. The HTTP layer only talks to this. */
export interface RunOptions {
  toolHint?: ToolHint;
}

export interface Provider {
  name: ProviderName;
  model: string;
  hasKey: boolean;
  /** How add_object names its picture; reported on the route event so the activity log can show it. */
  objects: ObjectMode;
  /** Which tools a request carries: the routed subset ("auto") or every tool. */
  tools: ToolRouterMode;
  /** True when a local fast-path model answers simple commands first (see fastpath.ts). */
  fastPath?: boolean;
  /** `opts.toolHint`: the local decision model's tool groups (withFastPath), merged into the tool router's pick. */
  run(req: CommandRequest, emit: Emit, signal?: AbortSignal, opts?: RunOptions): Promise<void>;
  /** User-facing message for a failed call, or undefined if the error isn't one this provider recognises. */
  describeError(err: unknown): string | undefined;
}

const KEY_HELP = "Check the API key in Settings (or .env).";

export function anthropicProvider(
  client: Anthropic,
  model = DEFAULT_ANTHROPIC_MODEL,
  hasKey = true,
  effort: ReasoningEffort = DEFAULT_EFFORT,
  objects: ObjectMode = DEFAULT_OBJECT_MODE,
  tools: ToolRouterMode = DEFAULT_TOOL_ROUTER,
): Provider {
  return {
    name: "anthropic",
    model,
    hasKey,
    objects,
    tools,
    run: (req, emit, signal, opts) => runSystem1(client, req, emit, signal, model, effort, objects, tools, opts?.toolHint),
    describeError(err) {
      if (err instanceof Anthropic.AuthenticationError) return `The Anthropic API rejected the key. ${KEY_HELP}`;
      if (err instanceof Anthropic.RateLimitError) return "Rate limited by the model API. Try again in a moment.";
      if (err instanceof Anthropic.NotFoundError) return `Model "${model}" was not found.`;
      if (err instanceof Anthropic.APIError) return `Model API error (${err.status ?? "network"}).`;
      if (err instanceof Error && /api key|authentication/i.test(err.message)) return `No Anthropic API key. ${KEY_HELP}`;
    },
  };
}

export function openaiProvider(
  client: OpenAI,
  model = DEFAULT_OPENAI_MODEL,
  hasKey = true,
  effort: ReasoningEffort = DEFAULT_EFFORT,
  maxTurns = DEFAULT_MAX_TURNS,
  objects: ObjectMode = DEFAULT_OBJECT_MODE,
  tools: ToolRouterMode = DEFAULT_TOOL_ROUTER,
): Provider {
  const provider: Provider = {
    name: "openai",
    model,
    hasKey,
    objects,
    tools,
    run: (req, emit, signal, opts) =>
      runSystem1OpenAI(
        client,
        req,
        emit,
        signal,
        model,
        effort,
        maxTurns,
        (e) => provider.describeError(e),
        objects,
        tools,
        opts?.toolHint,
      ),
    describeError(err) {
      if (err instanceof OpenAI.AuthenticationError) return `The API rejected the key. ${KEY_HELP}`;
      if (err instanceof OpenAI.RateLimitError) return "Rate limited by the model API. Try again in a moment.";
      if (err instanceof OpenAI.NotFoundError) return `Model "${model}" was not found at this endpoint.`;
      if (err instanceof OpenAI.APIError && err.status === 413) {
        return `Request too large for this model (413). A free-tier tokens-per-minute/request limit (e.g. Groq) can be smaller than one command's prompt and tools; keep Settings > Tools on Auto. ${err.message.slice(0, 200)}`;
      }
      if (err instanceof OpenAI.APIError) return `Model API error (${err.status ?? "network"}).`;
      if (err instanceof Error && /api key|authentication/i.test(err.message)) return `No API key. ${KEY_HELP}`;
    },
  };
  return provider;
}

/**
 * OPENAI_BASE_URL points the client at any OpenAI-compatible API (e.g. Cerebras: https://api.cerebras.ai/v1);
 * SYSTEM1_MODEL must then name one of that service's models. The SDK throws at construction without a key,
 * so use a placeholder; calls then fail with a 401.
 */
export function openaiClientFromEnv(env: NodeJS.ProcessEnv): OpenAI {
  return new OpenAI({ apiKey: env.OPENAI_API_KEY || "missing", baseURL: env.OPENAI_BASE_URL || undefined });
}

/** The .env configuration, parsed once at startup. Request configs from the UI are layered on top of it. */
export interface ServerSettings {
  provider: ProviderName;
  /** Empty = the provider's official API. */
  baseUrl: string;
  model?: string;
  effort: ReasoningEffort;
  objects: ObjectMode;
  tools: ToolRouterMode;
  maxTurns: number;
  /** endpointKey -> API key. Each .env key belongs to exactly one endpoint and is never sent anywhere else. */
  keys: Map<string, string>;
}

/**
 * LLM_PROVIDER wins; otherwise whichever key is set (Anthropic first if both are). With neither key,
 * fall back to Anthropic so the app still starts and the status pill reports the missing key.
 */
export function settingsFromEnv(env: NodeJS.ProcessEnv = process.env): ServerSettings {
  const explicit = env.LLM_PROVIDER?.trim().toLowerCase();
  if (explicit && explicit !== "anthropic" && explicit !== "openai") {
    throw new Error(`LLM_PROVIDER must be "anthropic" or "openai" (got "${env.LLM_PROVIDER}")`);
  }
  const provider: ProviderName = explicit
    ? (explicit as ProviderName)
    : !env.ANTHROPIC_API_KEY && env.OPENAI_API_KEY
      ? "openai"
      : "anthropic";
  const keys = new Map<string, string>();
  if (env.ANTHROPIC_API_KEY) keys.set(endpointKey("anthropic"), env.ANTHROPIC_API_KEY);
  if (env.OPENAI_API_KEY) keys.set(endpointKey("openai", env.OPENAI_BASE_URL), env.OPENAI_API_KEY);
  return {
    provider,
    baseUrl: provider === "openai" ? env.OPENAI_BASE_URL?.trim() || "" : "",
    model: env.SYSTEM1_MODEL || undefined,
    effort: effortFromEnv(env),
    objects: objectModeFromEnv(env),
    tools: toolRouterFromEnv(env),
    maxTurns: maxTurnsFromEnv(env),
    keys,
  };
}

/** Build SDK clients; tests pass fakes. */
export interface ClientFactory {
  anthropic(opts: { apiKey: string; baseURL?: string }): Anthropic;
  openai(opts: { apiKey: string; baseURL?: string }): OpenAI;
}

const MAX_CLIENTS = 16;
const clients = new Map<string, Anthropic | OpenAI>();

/** Real SDK clients, reused per endpoint + key so connections stay warm across requests. */
export const sdkClients: ClientFactory = {
  anthropic: (opts) => cached(`anthropic ${opts.baseURL} ${opts.apiKey}`, () => new Anthropic(opts)) as Anthropic,
  openai: (opts) => cached(`openai ${opts.baseURL} ${opts.apiKey}`, () => new OpenAI(opts)) as OpenAI,
};

function cached(key: string, make: () => Anthropic | OpenAI) {
  let client = clients.get(key);
  if (!client) {
    client = make();
    if (clients.size >= MAX_CLIENTS) clients.delete(clients.keys().next().value!);
    clients.set(key, client);
  }
  return client;
}

/** Where a request goes and with which key, after layering the request's config over .env. */
export function resolveEndpoint(settings: ServerSettings, config: ModelConfig = {}) {
  const provider = config.provider ?? settings.provider;
  const baseUrl = (config.provider ? config.baseUrl : settings.baseUrl)?.trim().replace(/\/+$/, "") || "";
  const key = endpointKey(provider, baseUrl);
  const isEnvEndpoint = key === endpointKey(settings.provider, settings.baseUrl);
  const apiKey = config.apiKey?.trim() || settings.keys.get(key) || "";
  return { provider, baseUrl, apiKey, isEnvEndpoint };
}

/**
 * The provider for one request: the request's config (from the browser's Settings) over the .env settings.
 * The model falls back to SYSTEM1_MODEL only on the .env endpoint, then to the official API's default;
 * any other endpoint must name its model.
 */
export function buildProvider(settings: ServerSettings, config: ModelConfig = {}, factory: ClientFactory = sdkClients): Provider {
  const { provider, baseUrl, apiKey, isEnvEndpoint } = resolveEndpoint(settings, config);
  const official = !baseUrl || baseUrl.toLowerCase() === DEFAULT_BASE_URLS[provider];
  const model =
    config.model?.trim() ||
    (isEnvEndpoint ? settings.model : undefined) ||
    (official ? (provider === "anthropic" ? DEFAULT_ANTHROPIC_MODEL : DEFAULT_OPENAI_MODEL) : undefined);
  if (!model) throw new Error(`Choose a model for ${baseUrl} in Settings.`);
  const effort = config.effort ?? settings.effort;
  const objects = config.objectMode ?? settings.objects;
  const tools = config.tools ?? settings.tools;
  const opts = { apiKey: apiKey || "missing", baseURL: baseUrl || undefined };
  if (provider === "openai") {
    return openaiProvider(factory.openai(opts), model, Boolean(apiKey), effort, settings.maxTurns, objects, tools);
  }
  return anthropicProvider(factory.anthropic(opts), model, Boolean(apiKey), effort, objects, tools);
}

/** Model ids the endpoint offers (GET /models), for the Settings model picker. */
export async function listModels(
  settings: ServerSettings,
  config: ModelConfig = {},
  factory: ClientFactory = sdkClients,
): Promise<string[]> {
  const { provider, baseUrl, apiKey } = resolveEndpoint(settings, config);
  if (!apiKey) throw new Error("No API key for this endpoint.");
  const opts = { apiKey, baseURL: baseUrl || undefined };
  const request = { timeout: 10_000, maxRetries: 0 };
  const ids: string[] = [];
  const pages =
    provider === "openai" ? factory.openai(opts).models.list(request) : factory.anthropic(opts).models.list({ limit: 100 }, request);
  for await (const m of pages) {
    ids.push(m.id);
    if (ids.length >= 1000) break;
  }
  return ids.sort();
}

export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): Provider {
  const settings = settingsFromEnv(env);
  // The .env provider keeps the old construction (the Anthropic SDK reads ANTHROPIC_BASE_URL etc. itself).
  if (settings.provider === "openai") {
    const hasKey = Boolean(env.OPENAI_API_KEY);
    const client = openaiClientFromEnv(env);
    return openaiProvider(client, settings.model, hasKey, settings.effort, settings.maxTurns, settings.objects, settings.tools);
  }
  const { model, effort, objects, tools } = settings;
  return anthropicProvider(new Anthropic(), model, Boolean(env.ANTHROPIC_API_KEY), effort, objects, tools);
}
