import Anthropic from "@anthropic-ai/sdk";
import Fastify from "fastify";
import { z } from "zod";
import type { CommandEvent, CommandRequest } from "@board/shared";
import { SYSTEM1_MODEL, runSystem1 } from "./system1";

const CommandBody = z.object({
  text: z.string().trim().min(1).max(2000),
  scene: z.object({
    elements: z.array(z.any()).max(500),
    selectedIds: z.array(z.string()).max(100),
    recentIds: z.array(z.string()).max(50),
    viewport: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
  }),
});

export function buildApp(anthropic: Anthropic, opts: { logger?: boolean } = {}) {
  const app = Fastify({ logger: opts.logger === false ? false : { level: process.env.LOG_LEVEL || "info" } });

  app.get("/api/health", async () => ({ ok: true, model: SYSTEM1_MODEL, hasKey: Boolean(process.env.ANTHROPIC_API_KEY) }));

  app.post("/api/command", async (request, reply) => {
    const body = CommandBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: z.prettifyError(body.error) });

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    const emit = (event: CommandEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`);

    // Abort the model call if the client goes away (e.g. the user barges in with a new command).
    const abort = new AbortController();
    res.on("close", () => abort.abort());

    try {
      await runSystem1(anthropic, body.data as CommandRequest, emit, abort.signal);
    } catch (err) {
      if (!abort.signal.aborted) {
        request.log.error(err);
        emit({ type: "error", message: describeError(err) });
      }
    } finally {
      res.end();
    }
  });

  return app;
}

function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "Server has no valid ANTHROPIC_API_KEY.";
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by the model API. Try again in a moment.";
  if (err instanceof Anthropic.APIError) return `Model API error (${err.status ?? "network"}).`;
  if (err instanceof Error && /api key|authentication/i.test(err.message)) return "Server has no ANTHROPIC_API_KEY configured.";
  return "Something went wrong running the command.";
}
