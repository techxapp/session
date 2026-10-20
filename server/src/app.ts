import Fastify from "fastify";
import { z } from "zod";
import type { CommandEvent, CommandRequest, HealthInfo, ModelConfig } from "@board/shared";
import { DEFAULT_EFFORT, type ReasoningEffort } from "./effort";
import type { Provider } from "./provider";
import { clipRoutes, type ClipStore } from "./clips";
import { attachStt, sttKeyed, type Connect, type SttSettings } from "./stt";

/** Model settings from the browser; see ModelConfig. Empty strings mean "not set". */
const Config = z
  .object({
    provider: z.enum(["anthropic", "openai"]).optional(),
    baseUrl: z.union([z.literal(""), z.url({ protocol: /^https?$/ }).max(300)]).optional(),
    apiKey: z.string().trim().max(500).optional(),
    model: z.string().trim().max(200).optional(),
    effort: z.enum(["off", "low", "medium", "high"]).optional(),
    objectMode: z.enum(["enum", "text"]).optional(),
    tools: z.enum(["auto", "all"]).optional(),
  })
  .optional();

const CommandBody = z.object({
  text: z.string().trim().min(1).max(2000),
  scene: z.object({
    elements: z.array(z.any()).max(500),
    selectedIds: z.array(z.string()).max(100),
    recentIds: z.array(z.string()).max(50),
    viewport: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
  }),
  config: Config,
});

export interface AppOptions {
  logger?: boolean;
  /** The provider for a request that carries a config from the UI. Without it, configs are ignored. */
  forConfig?: (config: ModelConfig) => Provider;
  /** Model ids an endpoint offers, for the Settings model picker (POST /api/models). */
  listModels?: (config: ModelConfig) => Promise<string[]>;
  /** .env facts for /api/health that the default provider doesn't carry. */
  info?: { baseUrl: string; keyedEndpoints: string[]; effort: ReasoningEffort };
  /** Cloud speech-to-text on the WebSocket /api/stt; without it only the Moonshine sidecar is offered. */
  stt?: SttSettings;
  /** Opens the upstream speech socket (tests pass a fake). */
  sttConnect?: Connect;
  /** The voice-clip folder: cloud speech lines are recorded into it, and /api/clips lists, labels and deletes clips. */
  clips?: ClipStore;
}

export function buildApp(provider: Provider, opts: AppOptions = {}) {
  const app = Fastify({ logger: opts.logger === false ? false : { level: process.env.LOG_LEVEL || "info" } });
  if (opts.stt) {
    const wss = attachStt(app.server, opts.stt, app.log, opts.sttConnect, opts.clips);
    app.addHook("onClose", async () => wss.clients.forEach((c) => c.terminate()));
  }
  if (opts.clips) clipRoutes(app, opts.clips);

  app.get("/api/health", async (): Promise<HealthInfo> => ({
    ok: true,
    model: provider.model,
    provider: provider.name,
    baseUrl: opts.info?.baseUrl ?? "",
    hasKey: provider.hasKey,
    keyedEndpoints: opts.info?.keyedEndpoints ?? [],
    effort: opts.info?.effort ?? DEFAULT_EFFORT,
    objectMode: provider.objects,
    toolRouter: provider.tools,
    fastPath: Boolean(provider.fastPath),
    stt: { provider: opts.stt?.provider ?? "moonshine", keyed: opts.stt ? sttKeyed(opts.stt) : [] },
  }));

  app.post("/api/models", async (request, reply) => {
    const body = z.object({ config: Config }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: z.prettifyError(body.error) });
    if (!opts.listModels) return reply.code(404).send({ error: "Model listing is not available." });
    try {
      return { models: await opts.listModels(body.data.config ?? {}) };
    } catch (err) {
      request.log.warn({ err: err instanceof Error ? err.message : err }, "listing models failed");
      return reply.code(502).send({ error: err instanceof Error ? err.message : "Couldn't list models." });
    }
  });

  app.post("/api/command", async (request, reply) => {
    const body = CommandBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: z.prettifyError(body.error) });

    let runner = provider;
    if (body.data.config && opts.forConfig) {
      try {
        runner = opts.forConfig(body.data.config);
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : "Invalid model settings." });
      }
    }

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
      // With a fast path, the wrapper says which side decided; otherwise it is always the cloud model.
      if (!runner.fastPath)
        emit({ type: "route", source: "cloud", model: runner.model, detail: "Cloud model", ms: 0, objects: runner.objects });
      const { config: _config, ...req } = body.data;
      await runner.run(req as CommandRequest, emit, abort.signal);
    } catch (err) {
      if (!abort.signal.aborted) {
        request.log.error(err);
        emit({ type: "error", message: runner.describeError(err) ?? "Something went wrong running the command." });
      }
    } finally {
      res.end();
    }
  });

  return app;
}
