export type ServerStatus =
  { state: "checking" } | { state: "offline" } | { state: "no-key"; model: string } | { state: "ready"; model: string };

const MODEL_NAMES: Record<string, string> = { "claude-haiku-4-5": "Haiku 4.5", "claude-sonnet-5-5": "Sonnet 5.5" };

export function StatusPill({ status }: { status: ServerStatus }) {
  const [tone, label, title] =
    status.state === "ready"
      ? ["ok", `System 1 · ${MODEL_NAMES[status.model] ?? status.model}`, "Fast model connected"]
      : status.state === "no-key"
        ? ["warn", "API key missing", "Set ANTHROPIC_API_KEY in .env and restart the server"]
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
