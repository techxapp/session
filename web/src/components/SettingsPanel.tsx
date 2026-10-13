import { useEffect, useRef, useState, type ReactNode } from "react";
import { Eye, EyeOff, Plus, RefreshCw, Settings2, X } from "lucide-react";
import { CLOUD_STT, type HealthInfo, type ObjectMode, type ReasoningEffort, type SttProvider } from "@board/shared";
import { fetchModels } from "../api";
import {
  SERVER,
  activeChoice,
  choices,
  effectiveModel,
  profileKey,
  requestConfig,
  serverHasKey,
  speechConfig,
  type Profile,
  type Settings,
  type SpeechSettings,
} from "../settings";
import { modelName } from "./StatusPill";

interface Props {
  settings: Settings;
  health: HealthInfo | null;
  update: (fn: (s: Settings) => Settings) => void;
  onClose: () => void;
}

const EFFORTS: ReasoningEffort[] = ["off", "low", "medium", "high"];
const OBJECT_MODES: { value: ObjectMode; label: string; title: string }[] = [
  { value: "enum", label: "Enum", title: "The model picks from the curated list of ~190 pictures (bigger prompt)" },
  { value: "text", label: "Text", title: "The model names any thing; the server maps it to ~1,600 pictures or draws a labelled box" },
];
const SPEECH: { value: SttProvider; label: string; title: string }[] = [
  { value: "moonshine", label: "Moonshine", title: "On this computer (the stt/server.py sidecar): free, CPU only" },
  { value: "deepgram", label: "Deepgram", title: "Deepgram streaming (Nova-3), relayed by the API server" },
  { value: "assemblyai", label: "AssemblyAI", title: "AssemblyAI Universal Streaming, relayed by the API server" },
  {
    value: "browser",
    label: "Browser",
    title:
      "The browser's built-in Web Speech API: no key or server; Chrome sends audio to Google, Edge to Microsoft; no board key terms; not in Firefox",
  },
];
const speechName = (p: SttProvider) => SPEECH.find((o) => o.value === p)!.label;
const OTHER = "\u0000other";

/** Model and speech settings, saved in this browser (models per base URL); they override the server's .env. */
export function SettingsPanel({ settings, health, update, onClose }: Props) {
  const choice = activeChoice(settings);
  const key = profileKey(choice);
  const profile = settings.profiles[key] ?? {};
  const keyFromServer = serverHasKey(choice, health);
  const hasKey = Boolean(profile.apiKey) || keyFromServer;
  const model = effectiveModel(settings, health);
  const speech = speechConfig(settings, health);

  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const [typingModel, setTypingModel] = useState(false);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string>();
  const panel = useRef<HTMLDivElement>(null);

  const setProfile = (patch: Partial<Profile>, forKey = key) =>
    update((s) => ({ ...s, profiles: { ...s.profiles, [forKey]: { ...s.profiles[forKey], ...patch } } }));
  const setSpeech = (patch: Partial<SpeechSettings>) => update((s) => ({ ...s, speech: { ...s.speech, ...patch } }));
  const select = (active: string) => {
    update((s) => ({ ...s, active }));
    setTypingModel(false);
    setListError(undefined);
  };

  const loadModels = async () => {
    const forKey = key;
    setLoading(true);
    setListError(undefined);
    try {
      const models = await fetchModels(requestConfig(settings, health) ?? {});
      setProfile({ models }, forKey);
    } catch (err) {
      setListError(err instanceof Error ? err.message : "Couldn't load models.");
    } finally {
      setLoading(false);
    }
  };

  // Load the endpoint's model list the first time it is picked with a key (and after a key is entered, on blur).
  const autoLoad = () => {
    if (hasKey && !profile.models && health && !loading) void loadModels();
  };
  useEffect(autoLoad, [key, Boolean(health)]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element;
      if (!panel.current?.contains(t) && !t.closest?.(".settings-toggle")) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [onClose]);

  const addUrl = () => {
    const u = url.trim().replace(/\/+$/, "");
    if (!/^https?:\/\/[^\s/]+/.test(u)) return setListError("Enter a URL like https://host/v1");
    update((s) => ({ ...s, customUrls: s.customUrls.includes(u) ? s.customUrls : [...s.customUrls, u], active: u }));
    setAdding(false);
    setUrl("");
    setListError(undefined);
  };
  const removeUrl = (u: string) =>
    update((s) => {
      const profiles = { ...s.profiles };
      delete profiles[profileKey(choices(s).find((c) => c.id === u))];
      return { ...s, customUrls: s.customUrls.filter((x) => x !== u), profiles, active: s.active === u ? SERVER : s.active };
    });

  const models = [...new Set([...(profile.models ?? choice?.models ?? []), ...(model ? [model] : [])])];

  return (
    <div className="settings" ref={panel} role="dialog" aria-label="Settings">
      <header className="settings-head">
        <Settings2 size={15} aria-hidden />
        <span>Settings</span>
        <button className="icon-btn" onClick={onClose} aria-label="Close settings">
          <X size={16} />
        </button>
      </header>

      <div className="settings-body">
        <fieldset className="field">
          <legend>Provider</legend>
          <div className="choices" role="radiogroup">
            <Choice checked={!choice} onSelect={() => select(SERVER)} title="Use the server's .env settings">
              Server .env
            </Choice>
            {choices(settings).map((c) => (
              <Choice key={c.id} checked={choice?.id === c.id} onSelect={() => select(c.id)} title={c.baseUrl || `Official ${c.label} API`}>
                {c.label}
                {c.custom && (
                  <span
                    className="choice-remove"
                    role="button"
                    aria-label={`Remove ${c.label}`}
                    onClick={(e) => {
                      e.preventDefault();
                      removeUrl(c.id);
                    }}
                  >
                    <X size={11} />
                  </span>
                )}
              </Choice>
            ))}
            {!adding && (
              <button className="choice choice-add" onClick={() => setAdding(true)} title="Any OpenAI-compatible API">
                <Plus size={12} /> Custom URL
              </button>
            )}
          </div>
          {adding && (
            <form
              className="inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                addUrl();
              }}
            >
              <input autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://host/v1 (OpenAI-compatible)" />
              <button type="submit" className="small-btn">
                Add
              </button>
            </form>
          )}
        </fieldset>

        {choice && (
          <label className="field">
            <span className="field-label">API key</span>
            <KeyInput
              value={profile.apiKey}
              onChange={(apiKey) => setProfile({ apiKey, models: undefined })}
              onBlur={autoLoad}
              fromServer={keyFromServer}
            />
          </label>
        )}

        <label className="field">
          <span className="field-label">Model</span>
          <div className="input-row">
            {typingModel ? (
              <input
                autoFocus
                value={profile.model ?? ""}
                onChange={(e) => setProfile({ model: e.target.value.trim() || undefined })}
                onBlur={() => setTypingModel(false)}
                placeholder="model id"
                spellCheck={false}
              />
            ) : (
              <select
                value={model ?? ""}
                onChange={(e) => (e.target.value === OTHER ? setTypingModel(true) : setProfile({ model: e.target.value || undefined }))}
              >
                {!model && <option value="">Choose a model…</option>}
                {models.map((m) => (
                  <option key={m} value={m}>
                    {modelName(m) === m ? m : `${modelName(m)} (${m})`}
                  </option>
                ))}
                <option value={OTHER}>Other…</option>
              </select>
            )}
            <button
              type="button"
              className="icon-btn"
              onClick={() => void loadModels()}
              disabled={!hasKey || loading}
              aria-label="Load models from the provider"
              title={hasKey ? "Load models from the provider" : "Needs an API key"}
            >
              <RefreshCw size={15} className={loading ? "spin" : ""} />
            </button>
          </div>
          {listError && <span className="field-error">{listError}</span>}
        </label>

        <div className="field">
          <span className="field-label">Reasoning effort</span>
          <Segmented
            value={profile.effort}
            onChange={(effort) => setProfile({ effort })}
            options={EFFORTS.map((e) => ({ value: e, label: e[0].toUpperCase() + e.slice(1) }))}
            defaultLabel={`Default (${health?.effort ?? "low"})`}
          />
        </div>

        <div className="field">
          <span className="field-label">Objects</span>
          <Segmented
            value={profile.objectMode}
            onChange={(objectMode) => setProfile({ objectMode })}
            options={OBJECT_MODES}
            defaultLabel={`Default (${health?.objectMode ?? "enum"})`}
          />
        </div>

        <div className="field">
          <span className="field-label">Speech to text</span>
          <Segmented
            value={settings.speech.provider}
            onChange={(provider) => setSpeech({ provider })}
            options={SPEECH}
            defaultLabel={`Default (${speechName(health?.stt.provider ?? "moonshine")})`}
          />
        </div>

        {CLOUD_STT.includes(speech.provider) && (
          <label className="field">
            <span className="field-label">{speechName(speech.provider)} API key</span>
            <KeyInput
              value={settings.speech.keys[speech.provider]}
              onChange={(key) => setSpeech({ keys: { ...settings.speech.keys, [speech.provider]: key } })}
              fromServer={Boolean(health?.stt.keyed.includes(speech.provider))}
            />
          </label>
        )}
      </div>

      <footer className="settings-foot">
        {choice && !hasKey ? "Add an API key to use this provider. " : ""}
        Saved in this browser (models per base URL) and used instead of the server's .env. Speech changes apply when the mic next starts.
      </footer>
    </div>
  );
}

function KeyInput({
  value,
  onChange,
  onBlur,
  fromServer,
}: {
  value: string | undefined;
  onChange: (key: string | undefined) => void;
  onBlur?: () => void;
  fromServer: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="input-row">
      <input
        type={show ? "text" : "password"}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value.trim() || undefined)}
        onBlur={onBlur}
        placeholder={fromServer ? "Using the server's key from .env" : "Paste your API key"}
        autoComplete="off"
        spellCheck={false}
      />
      <button type="button" className="icon-btn" onClick={() => setShow((v) => !v)} aria-label={show ? "Hide key" : "Show key"}>
        {show ? <EyeOff size={15} /> : <Eye size={15} />}
      </button>
    </div>
  );
}

function Choice({ checked, onSelect, title, children }: { checked: boolean; onSelect: () => void; title: string; children: ReactNode }) {
  return (
    <label className={`choice${checked ? " is-checked" : ""}`} title={title}>
      <input type="radio" name="provider" checked={checked} onChange={onSelect} />
      {children}
    </label>
  );
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
  defaultLabel,
}: {
  value: T | undefined;
  onChange: (v: T | undefined) => void;
  options: { value: T; label: string; title?: string }[];
  defaultLabel: string;
}) {
  return (
    <div className="segmented" role="radiogroup">
      {[{ value: undefined, label: defaultLabel, title: "Use the server's .env setting" }, ...options].map((o) => (
        <button
          key={o.label}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          className={value === o.value ? "is-checked" : ""}
          onClick={() => onChange(o.value)}
          title={o.title}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
