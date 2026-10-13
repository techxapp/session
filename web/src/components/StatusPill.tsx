export type ServerStatus =
  | { state: "checking" }
  | { state: "offline" }
  /** `where`: the Settings provider in use (undefined = the server's .env). */
  | { state: "no-key"; model: string; where?: string; fastPath?: boolean }
  | { state: "ready"; model: string; where?: string; fastPath?: boolean };

const MODEL_NAMES: Record<string, string> = {
  "claude-haiku-4-5": "Haiku 4.5",
  "claude-sonnet-5-5": "Sonnet 5.5",
  "claude-opus-5-5": "Opus 5.5",
};

/** Friendly model name: known Anthropic ids, "laya:<checkpoint>" and "rules" from the local fast path, else the raw id. */
export function modelName(model: string): string {
  if (model === "laya" || model.startsWith("laya:")) return "Laya";
  if (model === "rules") return "Rules";
  return MODEL_NAMES[model] ?? model;
}

export function StatusPill({ status }: { status: ServerStatus }) {
  const [tone, label, title] =
    status.state === "ready"
      ? [
          "ok",
          `System 1 · ${modelName(status.model)}${status.fastPath ? " + local" : ""}`,
          `${status.where ?? "Server .env"} · ${status.model}. ` +
            (status.fastPath
              ? "Simple commands run locally (code rules, then the Laya model if loaded); the rest go to the cloud model"
              : "Fast model connected"),
        ]
      : status.state === "no-key"
        ? [
            "warn",
            status.fastPath ? "API key missing · local only" : "API key missing",
            status.where
              ? `Add a ${status.where} API key in Settings`
              : "Add an API key in Settings, or set ANTHROPIC_API_KEY / OPENAI_API_KEY in .env and restart the server",
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
