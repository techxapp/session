export type ServerStatus =
  | { state: "checking" }
  | { state: "offline" }
  | { state: "no-key"; model: string; fastPath?: boolean }
  | { state: "ready"; model: string; fastPath?: boolean };

const MODEL_NAMES: Record<string, string> = { "claude-haiku-4-5": "Haiku 4.5", "claude-sonnet-5-5": "Sonnet 5.5" };

/** Friendly model name: known Anthropic ids, "laya:<checkpoint>" from the local fast path, else the raw id. */
export function modelName(model: string): string {
  if (model === "laya" || model.startsWith("laya:")) return "Laya";
  return MODEL_NAMES[model] ?? model;
}

export function StatusPill({ status }: { status: ServerStatus }) {
  const [tone, label, title] =
    status.state === "ready"
      ? [
          "ok",
          `System 1 · ${modelName(status.model)}${status.fastPath ? " + Laya" : ""}`,
          status.fastPath ? "Simple commands run on the local Laya model; the rest go to the cloud model" : "Fast model connected",
        ]
      : status.state === "no-key"
        ? [
            "warn",
            status.fastPath ? "API key missing · Laya only" : "API key missing",
            "Set ANTHROPIC_API_KEY or OPENAI_API_KEY in .env and restart the server",
          ]
        : status.state === "offline"
          ? ["bad", "Server offline", "Start the server: npm run dev"]
          : ["idle", "Connecting…", ""];
  return (
    <div className={`pill pill-${tone}`} title={title || label} aria-label={label} role="status">
      <span className="pill-dot" />
      <span className="pill-label">{label}</span>
    </div>
  );
}
