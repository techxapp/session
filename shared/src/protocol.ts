import type { BoardAction } from "./actions";

/** Compact description of the board sent with each command, so the model can resolve references. */
export interface SceneElementSummary {
  id: string;
  type: "rectangle" | "ellipse" | "diamond" | "sticky" | "text" | "arrow" | "image" | "other";
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

export interface CommandRequest {
  text: string;
  scene: SceneSummary;
}

/**
 * Who decided a command: the local fast-path model (Laya sidecar) or the cloud LLM.
 * `detail` says why, e.g. the local model's reason for passing a command on.
 */
export type CommandSource = "local" | "cloud";

/** Server -> client events, sent as SSE `data:` lines. */
export type CommandEvent =
  | { type: "route"; source: CommandSource; model: string; detail: string; ms: number }
  | { type: "action"; action: BoardAction; ms: number }
  | { type: "say"; text: string }
  | { type: "invalid"; name: string; error: string }
  | { type: "error"; message: string }
  | { type: "done"; ms: number; model: string; actions: number };
