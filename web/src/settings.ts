import {
  cleanAssemblyTurn,
  endpointKey,
  type AssemblyTurn,
  type ApiStyle,
  type HealthInfo,
  type ModelConfig,
  type ObjectMode,
  type ReasoningEffort,
  type SttProvider,
  type ToolRouterMode,
  CLOUD_STT,
} from "@board/shared";

/**
 * Model settings chosen in the Settings panel, kept in this browser's localStorage. They override the
 * server's .env per request (sent as CommandRequest.config); anything left unset falls back to .env.
 * Each endpoint (API style + base URL) has its own saved profile: key, model, effort, object mode.
 */

/** One of the radio choices. "server" = whatever .env configures. */
export interface ProviderChoice {
  id: string;
  label: string;
  provider: ApiStyle;
  /** Empty = the official API. */
  baseUrl: string;
  /** Suggested models until the endpoint's own list is loaded; the first is the default. */
  models: string[];
  custom?: boolean;
}

export const PRESETS: ProviderChoice[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    provider: "anthropic",
    baseUrl: "",
    models: ["claude-haiku-4-5", "claude-sonnet-5-5", "claude-opus-5-5"],
  },
  { id: "openai", label: "OpenAI", provider: "openai", baseUrl: "", models: ["gpt-4.1-mini", "gpt-4.1-nano", "gpt-4.1"] },
  {
    id: "cerebras",
    label: "Cerebras",
    provider: "openai",
    baseUrl: "https://api.cerebras.ai/v1",
    models: ["gpt-oss-120b", "qwen-3.8-27b"],
  },
  { id: "xai", label: "xAI", provider: "openai", baseUrl: "https://api.x.ai/v1", models: [] },
  { id: "groq", label: "Groq", provider: "openai", baseUrl: "https://api.groq.com/openai/v1", models: [] },
  { id: "openrouter", label: "OpenRouter", provider: "openai", baseUrl: "https://openrouter.ai/api/v1", models: [] },
];

export const SERVER = "server";

export interface Profile {
  apiKey?: string;
  model?: string;
  effort?: ReasoningEffort;
  objectMode?: ObjectMode;
  /** Tools per request: only what the command needs (auto) or every tool (all). */
  tools?: ToolRouterMode;
  /** The endpoint's model list, last loaded from it. */
  models?: string[];
}

export interface Settings {
  /** SERVER, a preset id, or a custom base URL. */
  active: string;
  /** Custom OpenAI-compatible base URLs the user added. */
  customUrls: string[];
  /** Keyed by SERVER or endpointKey(provider, baseUrl). */
  profiles: Record<string, Profile>;
  speech: SpeechSettings;
  /** Glide the view to centre whatever a command just created or changed (default on). Off: only bring it in if it landed out of sight. */
  autoCenter: boolean;
}

/** Speech-to-text choice; the provider defaults to the server's STT_PROVIDER, each cloud key to its .env key. */
export interface SpeechSettings {
  provider?: SttProvider;
  keys: Partial<Record<SttProvider, string>>;
  /** Pause recognition after this long with nothing heard (0 = never); default IDLE_SECONDS. */
  idleSeconds?: number;
  /** How loud the mic must get to resume a paused session; default "normal". */
  wake?: WakeSensitivity;
  /** AssemblyAI turn detection; a field left out uses AssemblyAI's default. */
  assemblyTurn?: AssemblyTurn;
}

export type WakeSensitivity = "high" | "normal" | "low";
export const IDLE_SECONDS = 10;
/** RMS level (dBFS) of a ~100 ms mic frame that counts as someone speaking, after the browser's noise suppression. */
export const WAKE_DBFS: Record<WakeSensitivity, number> = { high: -50, normal: -42, low: -34 };

/** What the voice hook needs to start listening. */
export interface SpeechConfig {
  provider: SttProvider;
  apiKey?: string;
  /** 0 = never pause. */
  idleMs: number;
  /** Linear RMS threshold that resumes a paused session. */
  wakeRms: number;
  /** AssemblyAI turn detection to send with `start` (only for assemblyai). */
  turn?: AssemblyTurn;
}

const STORAGE_KEY = "voice-board:settings:v1";
export const DEFAULT_SETTINGS: Settings = { active: SERVER, customUrls: [], profiles: {}, speech: { keys: {} }, autoCenter: true };

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const saved = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...saved, speech: { keys: {}, ...saved.speech } };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable: settings last for this page only */
  }
}

export const customChoice = (url: string): ProviderChoice => ({
  id: url,
  label: url.replace(/^https?:\/\//, "").replace(/\/+$/, ""),
  provider: "openai",
  baseUrl: url,
  models: [],
  custom: true,
});

/** The provider radio list: presets, then the user's custom URLs. */
export const choices = (s: Settings) => [...PRESETS, ...s.customUrls.map(customChoice)];

/** The active choice, or undefined for SERVER. */
export function activeChoice(s: Settings): ProviderChoice | undefined {
  return s.active === SERVER ? undefined : choices(s).find((c) => c.id === s.active);
}

export const profileKey = (c: ProviderChoice | undefined) => (c ? endpointKey(c.provider, c.baseUrl) : SERVER);
export const activeProfile = (s: Settings): Profile => s.profiles[profileKey(activeChoice(s))] ?? {};

/** Does the server hold a .env key for this endpoint (so the browser needs none)? */
export const serverHasKey = (c: ProviderChoice | undefined, health: HealthInfo | null) =>
  !c ? Boolean(health?.hasKey) : Boolean(health?.keyedEndpoints.includes(endpointKey(c.provider, c.baseUrl)));

/** The model a request will use, as far as the browser can tell. */
export function effectiveModel(s: Settings, health: HealthInfo | null): string | undefined {
  const c = activeChoice(s);
  const p = activeProfile(s);
  if (p.model) return p.model;
  if (!c) return health?.model;
  const onEnvEndpoint = health && endpointKey(c.provider, c.baseUrl) === endpointKey(health.provider, health.baseUrl);
  return onEnvEndpoint ? health.model : c.models[0];
}

/** The speech provider the mic will use, the browser's key for it (else the server's .env key) and the idle pause. */
export function speechConfig(s: Settings, health: HealthInfo | null): SpeechConfig {
  const provider = s.speech.provider ?? health?.stt.provider ?? "moonshine";
  return {
    provider,
    apiKey: CLOUD_STT.includes(provider) ? s.speech.keys[provider] || undefined : undefined,
    idleMs: Math.max(0, s.speech.idleSeconds ?? IDLE_SECONDS) * 1000,
    wakeRms: 10 ** (WAKE_DBFS[s.speech.wake ?? "normal"] / 20),
    turn: provider === "assemblyai" ? cleanAssemblyTurn(s.speech.assemblyTurn) : undefined,
  };
}

/** What to send with each command, or undefined to use .env as is. */
export function requestConfig(s: Settings, health: HealthInfo | null): ModelConfig | undefined {
  const c = activeChoice(s);
  const p = activeProfile(s);
  const overrides = { model: p.model || undefined, effort: p.effort, objectMode: p.objectMode, tools: p.tools };
  if (!c) return Object.values(overrides).some(Boolean) ? overrides : undefined;
  return { provider: c.provider, baseUrl: c.baseUrl, apiKey: p.apiKey || undefined, ...overrides, model: effectiveModel(s, health) };
}
