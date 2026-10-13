import type { BoardAction } from "./actions";

/** Compact description of the board sent with each command, so the model can resolve references. */
export interface SceneElementSummary {
  id: string;
  type: "rectangle" | "ellipse" | "diamond" | "sticky" | "text" | "arrow" | "image" | "graph" | "chart" | "other";
  label?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  color?: string;
  /** For arrows: connected element ids. */
  from?: string;
  to?: string;
}

export interface SceneSummary {
  elements: SceneElementSummary[];
  selectedIds: string[];
  /** Most recently created/changed element ids, newest first ("it", "that"). */
  recentIds: string[];
  viewport: { x: number; y: number; width: number; height: number };
}

/** How add_object names its picture: "enum" = curated list in the tool, "text" = free text mapped on the server. */
export type ObjectMode = "enum" | "text";
export type ReasoningEffort = "off" | "low" | "medium" | "high";
/** The two API styles the server speaks; every OpenAI-compatible service (Cerebras, xAI, Groq...) is "openai". */
export type ApiStyle = "anthropic" | "openai";

/**
 * Model settings from the browser (Settings panel, saved in localStorage per base URL). Every field
 * overrides the server's .env; a missing one falls back to it. Without `provider` the .env endpoint is used.
 * The server's own API key is only ever sent to the endpoint .env configures it for.
 */
export interface ModelConfig {
  provider?: ApiStyle;
  /** Empty = the provider's official API. */
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  effort?: ReasoningEffort;
  objectMode?: ObjectMode;
}

export interface CommandRequest {
  text: string;
  scene: SceneSummary;
  config?: ModelConfig;
}

/**
 * Speech-to-text backend. "moonshine" = the local sidecar (stt/server.py, WebSocket /stt); the cloud ones go
 * through the API server's /api/stt WebSocket, which speaks the same protocol (see server/src/stt.ts);
 * "browser" = the browser's own Web Speech API (web/src/voice/browserSpeech.ts), no server involved.
 */
export type SttProvider = "moonshine" | "deepgram" | "assemblyai" | "browser";
export const STT_PROVIDERS: SttProvider[] = ["moonshine", "deepgram", "assemblyai", "browser"];
export const CLOUD_STT: SttProvider[] = ["deepgram", "assemblyai"];

/** GET /api/health: the server's .env defaults (never its keys). */
export interface HealthInfo {
  ok: boolean;
  provider: ApiStyle;
  model: string;
  /** The .env endpoint; empty = the provider's official API. */
  baseUrl: string;
  hasKey: boolean;
  /** Endpoints the server has a key for ("anthropic" or "openai" + base URL, see endpointKey). */
  keyedEndpoints: string[];
  effort: ReasoningEffort;
  objectMode: ObjectMode;
  fastPath: boolean;
  /** STT_PROVIDER, and the cloud speech providers the server has a .env key for. */
  stt: { provider: SttProvider; keyed: SttProvider[] };
}

/** Official API base URLs, used when a config leaves baseUrl empty. */
export const DEFAULT_BASE_URLS: Record<ApiStyle, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
};

/** A canonical "style base-url" string, so "https://api.x.ai/v1/" and "https://api.x.ai/v1" are one endpoint. */
export function endpointKey(provider: ApiStyle, baseUrl?: string): string {
  const url = (baseUrl?.trim() || DEFAULT_BASE_URLS[provider]).replace(/\/+$/, "").toLowerCase();
  return `${provider} ${url}`;
}

/**
 * Who decided a command: the local fast-path model (Laya sidecar) or the cloud LLM.
 * `detail` says why, e.g. the local model's reason for passing a command on.
 */
export type CommandSource = "local" | "cloud";

/** Server -> client events, sent as SSE `data:` lines. */
export type CommandEvent =
  | { type: "route"; source: CommandSource; model: string; detail: string; ms: number; objects?: ObjectMode }
  | { type: "action"; action: BoardAction; ms: number }
  | { type: "say"; text: string }
  | { type: "invalid"; name: string; error: string }
  | { type: "error"; message: string }
  | { type: "done"; ms: number; model: string; actions: number };
