import { buildApp } from "./app";
import { fastPathFromEnv, withFastPath } from "./fastpath";
import { buildProvider, listModels, providerFromEnv, settingsFromEnv, type Provider } from "./provider";
import { sttSettingsFromEnv } from "./stt";

const PORT = Number(process.env.PORT || 8787);

// The .env settings; a request may carry its own (the browser's Settings panel), layered on top.
const settings = settingsFromEnv();
// Picks Anthropic or OpenAI from LLM_PROVIDER, or from whichever API key is set.
const provider = providerFromEnv();
// FASTPATH_URL puts the local Laya sidecar (fastpath/server.py) in front of it.
const fast = fastPathFromEnv();
const local = (p: Provider) =>
  fast ? withFastPath(p, fast, (err) => app.log.warn({ err }, "fast path failed; using the cloud model")) : p;
const app = buildApp(local(provider), {
  forConfig: (config) => local(buildProvider(settings, config)),
  listModels: (config) => listModels(settings, config),
  info: { baseUrl: settings.baseUrl, keyedEndpoints: [...settings.keys.keys()], effort: settings.effort },
  // STT_PROVIDER + DEEPGRAM_API_KEY / ASSEMBLYAI_API_KEY: cloud speech-to-text on the /api/stt WebSocket.
  stt: sttSettingsFromEnv(),
});

app.listen({ port: PORT, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
