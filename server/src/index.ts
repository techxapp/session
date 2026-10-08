import { buildApp } from "./app";
import { fastPathFromEnv, withFastPath } from "./fastpath";
import { providerFromEnv } from "./provider";

const PORT = Number(process.env.PORT || 8787);

// Picks Anthropic or OpenAI from LLM_PROVIDER, or from whichever API key is set.
const provider = providerFromEnv();
// FASTPATH_URL puts the local Laya sidecar (fastpath/server.py) in front of it.
const fast = fastPathFromEnv();
const app = buildApp(
  fast ? withFastPath(provider, fast, (err) => app.log.warn({ err }, "fast path failed; using the cloud model")) : provider,
);

app.listen({ port: PORT, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
