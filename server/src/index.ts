import Anthropic from "@anthropic-ai/sdk";
import { buildApp } from "./app";

const PORT = Number(process.env.PORT || 8787);

// Resolves ANTHROPIC_API_KEY (or another configured credential) from the environment.
const app = buildApp(new Anthropic());

app.listen({ port: PORT, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
