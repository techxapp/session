import { describe, expect, it } from "vitest";
import type { HealthInfo } from "@board/shared";
import { DEFAULT_SETTINGS, effectiveModel, requestConfig, serverHasKey, activeChoice, speechConfig, type Settings } from "./settings";

const health: HealthInfo = {
  ok: true,
  provider: "openai",
  model: "env-model",
  baseUrl: "https://api.cerebras.ai/v1",
  hasKey: true,
  keyedEndpoints: ["openai https://api.cerebras.ai/v1"],
  effort: "low",
  objectMode: "enum",
  toolRouter: "auto",
  fastPath: false,
  stt: { provider: "deepgram", keyed: ["deepgram"] },
};
const with_ = (s: Partial<Settings>): Settings => ({ ...DEFAULT_SETTINGS, ...s });

describe("settings -> request config", () => {
  it("sends nothing on the server's .env until something is overridden", () => {
    expect(requestConfig(DEFAULT_SETTINGS, health)).toBeUndefined();
    expect(requestConfig(with_({ profiles: { server: { objectMode: "text" } } }), health)).toEqual({ objectMode: "text" });
    expect(requestConfig(with_({ profiles: { server: { tools: "all" } } }), health)).toEqual({ tools: "all" });
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
      tools: undefined,
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

describe("settings -> speech config", () => {
  it("follows the server's STT_PROVIDER until one is picked, with the browser's key for cloud providers", () => {
    expect(speechConfig(DEFAULT_SETTINGS, health)).toMatchObject({ provider: "deepgram", apiKey: undefined });
    expect(speechConfig(DEFAULT_SETTINGS, null)).toMatchObject({ provider: "moonshine", apiKey: undefined });
    const speech = { provider: "assemblyai" as const, keys: { assemblyai: "aai", moonshine: "ignored" } };
    expect(speechConfig(with_({ speech }), health)).toMatchObject({ provider: "assemblyai", apiKey: "aai" });
    expect(speechConfig(with_({ speech: { ...speech, provider: "moonshine" } }), health)).toMatchObject({
      provider: "moonshine",
      apiKey: undefined,
    });
    expect(speechConfig(with_({ speech: { ...speech, provider: "browser" } }), health)).toMatchObject({
      provider: "browser",
      apiKey: undefined,
    });
  });

  it("pauses after 10 s of silence unless set otherwise, and wakes at the chosen level", () => {
    expect(speechConfig(DEFAULT_SETTINGS, health)).toMatchObject({ idleMs: 10_000 });
    expect(speechConfig(DEFAULT_SETTINGS, health).wakeRms).toBeCloseTo(10 ** (-42 / 20));
    const s = with_({ speech: { keys: {}, idleSeconds: 0, wake: "high" } });
    expect(speechConfig(s, health)).toMatchObject({ idleMs: 0, wakeRms: 10 ** (-50 / 20) });
    expect(speechConfig(with_({ speech: { keys: {}, idleSeconds: 90 } }), health).idleMs).toBe(90_000);
  });

  it("sends AssemblyAI turn detection only for AssemblyAI, clamped", () => {
    const speech = { keys: {}, assemblyTurn: { confidence: 2, minSilenceMs: 750 } };
    expect(speechConfig(with_({ speech: { ...speech, provider: "assemblyai" } }), health).turn).toEqual({
      confidence: 1,
      minSilenceMs: 750,
    });
    expect(speechConfig(with_({ speech: { ...speech, provider: "deepgram" } }), health).turn).toBeUndefined();
    expect(speechConfig(with_({ speech: { keys: {}, provider: "assemblyai" } }), health).turn).toEqual({});
  });

  it("line joining waits: defaults, 0 = off, clamped", () => {
    expect(speechConfig(DEFAULT_SETTINGS, health)).toMatchObject({ holdMs: 1500, holdSpeakingMs: 8000 });
    expect(speechConfig(with_({ speech: { keys: {}, holdMs: 0, holdSpeakingMs: 3000 } }), health)).toMatchObject({
      holdMs: 0,
      holdSpeakingMs: 3000,
    });
    expect(speechConfig(with_({ speech: { keys: {}, holdMs: 99_999, holdSpeakingMs: 10 } }), health)).toMatchObject({
      holdMs: 10_000,
      holdSpeakingMs: 1000,
    });
  });
});
