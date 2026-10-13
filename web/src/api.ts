import type { CommandEvent, CommandRequest, HealthInfo, ModelConfig } from "@board/shared";

export async function checkHealth(): Promise<HealthInfo | null> {
  try {
    const res = await fetch("/api/health");
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** The endpoint's model ids (through the server, which holds or forwards the key). Throws with the server's message. */
export async function fetchModels(config: ModelConfig, signal?: AbortSignal): Promise<string[]> {
  const res = await fetch("/api/models", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ config }),
    signal,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Server error (${res.status})`);
  return body.models ?? [];
}

/** POST a command and yield server-sent events as they arrive. */
export async function* streamCommand(req: CommandRequest, signal: AbortSignal): AsyncGenerator<CommandEvent> {
  const res = await fetch("/api/command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
    signal,
  });
  if (!res.ok || !res.body) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error ?? `Server error (${res.status})`);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const data = frame
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (data) yield JSON.parse(data) as CommandEvent;
    }
  }
}
