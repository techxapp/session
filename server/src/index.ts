import { buildApp } from "./app";
import { providerFromEnv } from "./provider";

const PORT = Number(process.env.PORT || 8787);

// Picks Anthropic or OpenAI from LLM_PROVIDER, or from whichever API key is set.
const app = buildApp(providerFromEnv());

app.listen({ port: PORT, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
