import { describe, expect, it } from "vitest";
import type { HealthInfo } from "@board/shared";
import { DEFAULT_SETTINGS, effectiveModel, requestConfig, serverHasKey, activeChoice, type Settings } from "./settings";

const health: HealthInfo = {
  ok: true,
  provider: "openai",
  model: "env-model",
  baseUrl: "https://api.cerebras.ai/v1",
  hasKey: true,
  keyedEndpoints: ["openai https://api.cerebras.ai/v1"],
  effort: "low",
  objectMode: "enum",
  fastPath: false,
};
const with_ = (s: Partial<Settings>): Settings => ({ ...DEFAULT_SETTINGS, ...s });

describe("settings -> request config", () => {
  it("sends nothing on the server's .env until something is overridden", () => {
    expect(requestConfig(DEFAULT_SETTINGS, health)).toBeUndefined();
    expect(requestConfig(with_({ profiles: { server: { objectMode: "text" } } }), health)).toEqual({ objectMode: "text" });
  });

  it("sends the chosen provider's endpoint, key and model", () => {
    const s = with_({ active: "xai", profiles: { "openai https://api.x.ai/v1": { apiKey: "k", model: "grok-x", effort: "off" } } });
    expect(requestConfig(s, health)).toEqual({
      provider: "openai",
      baseUrl: "https://api.x.ai/v1",
      apiKey: "k",
      model: "grok-x",
      effort: "off",
      objectMode: undefined,
    });
  });

  it("keeps a profile per base URL and knows which endpoints the server holds a key for", () => {
    const s = with_({ active: "cerebras" });
    expect(serverHasKey(activeChoice(s), health)).toBe(true);
    expect(serverHasKey(activeChoice(with_({ active: "groq" })), health)).toBe(false);
    // The .env endpoint keeps the .env model; other presets start on their first suggestion.
    expect(effectiveModel(s, health)).toBe("env-model");
    expect(effectiveModel(with_({ active: "anthropic" }), health)).toBe("claude-haiku-4-5");
    expect(effectiveModel(with_({ active: "https://my.host/v1", customUrls: ["https://my.host/v1"] }), health)).toBeUndefined();
  });
});
