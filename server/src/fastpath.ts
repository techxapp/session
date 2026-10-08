import { parseAction, type BoardAction, type CommandRequest } from "@board/shared";
import type { Emit } from "./system1";
import type { Provider } from "./provider";

/** The local decision model's answer for one command (fastpath/server.py `POST /decide`). */
export interface FastDecision {
  route: "fast" | "ignore" | "llm";
  actions: { name: string; input: unknown }[] | null;
  /** Why it decided that, e.g. "unsure of the color (0.62)". */
  reason?: string;
  model?: string;
  ms?: number;
}

export type FastPath = (req: CommandRequest, signal?: AbortSignal) => Promise<FastDecision>;

const LOCAL_MODEL = "laya";

/** Ask the sidecar at `url`; rejects on a network error, a non-200 reply or after `timeoutMs`. */
export function httpFastPath(url: string, timeoutMs = 1000): FastPath {
  const endpoint = `${url.replace(/\/$/, "")}/decide`;
  return async (req, signal) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: req.text, scene: req.scene }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!res.ok) throw new Error(`fast path replied ${res.status}: ${await res.text()}`);
    return (await res.json()) as FastDecision;
  };
}

/**
 * Put the local fast path in front of a provider. Every command first goes to the local model:
 * "fast" streams its actions straight to the board, "ignore" drops chatter, and "llm" or any
 * failure (sidecar down, timeout, an action that fails validation) runs the provider as usual.
 * A `route` event tells the client which side decided and why.
 */
export function withFastPath(provider: Provider, fast: FastPath, onError?: (err: unknown) => void): Provider {
  return {
    ...provider,
    fastPath: true,
    async run(req, emit: Emit, signal) {
      const startedAt = Date.now();
      let decision: FastDecision | undefined;
      try {
        decision = await fast(req, signal);
      } catch (err) {
        if (signal?.aborted) return;
        onError?.(err);
      }
      const ms = Date.now() - startedAt;
      const local = decision?.model ?? LOCAL_MODEL;

      if (decision?.route === "ignore") {
        emit({ type: "route", source: "local", model: local, detail: "Not a board command, ignored", ms });
        emit({ type: "done", ms, model: local, actions: 0 });
        return;
      }
      const actions = decision?.route === "fast" ? validActions(decision) : undefined;
      if (actions) {
        emit({ type: "route", source: "local", model: local, detail: `Handled locally (${decision?.reason ?? "fast path"})`, ms });
        for (const action of actions) emit({ type: "action", action, ms: Date.now() - startedAt });
        emit({ type: "done", ms: Date.now() - startedAt, model: local, actions: actions.length });
        return;
      }

      const why = !decision
        ? "local model unavailable"
        : decision.route === "fast"
          ? "local actions failed validation"
          : `local model passed: ${decision.reason ?? "not a simple command"}`;
      emit({ type: "route", source: "cloud", model: provider.model, detail: `Sent to the cloud (${why})`, ms });
      return provider.run(req, emit, signal);
    },
  };
}

/** All of the decision's actions, validated with the shared schemas, or undefined if any is invalid. */
function validActions(decision: FastDecision): BoardAction[] | undefined {
  if (!decision.actions?.length) return undefined;
  const parsed = decision.actions.map((a) => parseAction(a.name, a.input));
  return parsed.every((p) => p.ok) ? parsed.map((p) => (p as { ok: true; action: BoardAction }).action) : undefined;
}

/** The fast path configured by FASTPATH_URL (and FASTPATH_TIMEOUT_MS), or undefined if it is off. */
export function fastPathFromEnv(env: NodeJS.ProcessEnv = process.env): FastPath | undefined {
  const url = env.FASTPATH_URL?.trim();
  if (!url) return undefined;
  const timeout = Number(env.FASTPATH_TIMEOUT_MS || 1000);
  if (!Number.isFinite(timeout) || timeout <= 0)
    throw new Error(`FASTPATH_TIMEOUT_MS must be a positive number (got "${env.FASTPATH_TIMEOUT_MS}")`);
  return httpFastPath(url, timeout);
}
