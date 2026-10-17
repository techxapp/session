import { useEffect, useRef, useState, type ReactNode } from "react";
import { Eye, EyeOff, Plus, RefreshCw, Settings2, X } from "lucide-react";
import {
  ASSEMBLY_TURN_DEFAULTS,
  ASSEMBLY_TURN_LIMITS,
  CLOUD_STT,
  type AssemblyTurn,
  type HealthInfo,
  type ObjectMode,
  type ReasoningEffort,
  type SttProvider,
  type ToolRouterMode,
} from "@board/shared";
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
  type WakeSensitivity,
  HOLD_LIMITS,
  HOLD_MS,
  HOLD_SPEAKING_MS,
  IDLE_SECONDS,
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
const TOOL_MODES: { value: ToolRouterMode; label: string; title: string }[] = [
  {
    value: "auto",
    label: "Auto",
    title: "Send the core tools plus only those the command needs (keyword filter): smaller, cheaper requests",
  },
  { value: "all", label: "All", title: "Send every tool and the full prompt with each command (biggest request)" },
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
const IDLE: { value: string; label: string }[] = [
  { value: "5", label: "5 s" },
  { value: "15", label: "15 s" },
  { value: "30", label: "30 s" },
  { value: "0", label: "Never" },
];
const WAKE: { value: WakeSensitivity; label: string; title: string }[] = [
  { value: "high", label: "High", title: "Wakes on quieter speech (and more often on background noise)" },
  { value: "normal", label: "Normal", title: "Default" },
  { value: "low", label: "Low", title: "Needs clearer, louder speech to wake" },
  { value: "lowest", label: "Lowest", title: "Only loud, close speech wakes it" },
];
const WAKE_ORDER = WAKE.map((o) => o.value);
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
          <span className="field-label">Tools</span>
          <Segmented
            value={profile.tools}
            onChange={(tools) => setProfile({ tools })}
            options={TOOL_MODES}
            defaultLabel={`Default (${health?.toolRouter ?? "auto"})`}
          />
        </div>

        <div className="field">
          <span className="field-label">Auto-centre view on new items</span>
          <div className="segmented" role="radiogroup">
            {[
              { on: true, label: "On", title: "Slide the canvas so the last created or changed item is centred" },
              { on: false, label: "Off", title: "Only move the view when new items land out of sight" },
            ].map((o) => (
              <button
                key={o.label}
                type="button"
                role="radio"
                aria-checked={settings.autoCenter === o.on}
                className={settings.autoCenter === o.on ? "is-checked" : ""}
                onClick={() => update((s) => ({ ...s, autoCenter: o.on }))}
                title={o.title}
              >
                {o.label}
              </button>
            ))}
          </div>
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

        <div className="field">
          <span className="field-label">Pause listening after silence</span>
          <Segmented
            value={settings.speech.idleSeconds?.toString()}
            onChange={(v) => setSpeech({ idleSeconds: v === undefined ? undefined : Number(v) })}
            options={IDLE}
            defaultLabel={`Default (${IDLE_SECONDS} s)`}
            defaultTitle="The mic stays open; speaking resumes recognition"
          />
        </div>

        {speech.idleMs > 0 && (
          <div className="field">
            <span className="field-label">Wake sensitivity</span>
            <input
              type="range"
              className="wake-slider"
              min={0}
              max={WAKE.length - 1}
              step={1}
              value={WAKE_ORDER.indexOf(settings.speech.wake ?? "normal")}
              onChange={(e) => setSpeech({ wake: WAKE_ORDER[Number(e.target.value)] })}
              aria-label="Wake sensitivity"
              title="How loud the mic must get to resume a paused session"
            />
            <div className="wake-labels">
              {WAKE.map((o) => (
                <span key={o.value} title={o.title}>
                  {o.label}
                </span>
              ))}
            </div>
          </div>
        )}

        <JoinFields speech={settings.speech} setSpeech={setSpeech} />

        <div className="field">
          <span className="field-label">Spoken names without a verb</span>
          <div className="segmented" role="radiogroup">
            {[
              { on: true, label: "Draw them", title: '"apple and mango" runs as "draw apple and mango"' },
              { on: false, label: "As heard", title: "Run the line exactly as heard" },
            ].map((o) => (
              <button
                key={o.label}
                type="button"
                role="radio"
                aria-checked={(settings.speech.defaultDraw ?? true) === o.on}
                className={(settings.speech.defaultDraw ?? true) === o.on ? "is-checked" : ""}
                onClick={() => setSpeech({ defaultDraw: o.on })}
                title={o.title}
              >
                {o.label}
              </button>
            ))}
          </div>
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

        {speech.provider === "assemblyai" && (
          <AssemblyTurnFields value={settings.speech.assemblyTurn ?? {}} onChange={(assemblyTurn) => setSpeech({ assemblyTurn })} />
        )}
      </div>

      <footer className="settings-foot">
        {choice && !hasKey ? "Add an API key to use this provider. " : ""}
        Saved in this browser (models per base URL) and used instead of the server's .env. Speech changes apply when the mic next starts.
      </footer>
    </div>
  );
}

const TURN_FIELDS: { key: keyof AssemblyTurn; label: string; unit: string; step: number; title: string }[] = [
  {
    key: "confidence",
    label: "End-of-turn confidence",
    unit: "0-1",
    step: 0.05,
    title: "How sure the model must be that you finished (end_of_turn_confidence_threshold). Higher = waits for clearer endings",
  },
  {
    key: "minSilenceMs",
    label: "Min silence when confident",
    unit: "ms",
    step: 50,
    title: "Silence needed before a confident end of turn (min_end_of_turn_silence_when_confident). Raise it if commands get cut at pauses",
  },
  {
    key: "maxSilenceMs",
    label: "Max silence",
    unit: "ms",
    step: 100,
    title: "The line ends after this much silence whatever the model thinks (max_turn_silence)",
  },
];

/** AssemblyAI turn detection: empty = AssemblyAI's default (shown as the placeholder). */
function AssemblyTurnFields({ value, onChange }: { value: AssemblyTurn; onChange: (t: AssemblyTurn | undefined) => void }) {
  const set = (key: keyof AssemblyTurn, n: number | undefined) => {
    const kept = Object.fromEntries(Object.entries({ ...value, [key]: n }).filter(([, v]) => v !== undefined)) as AssemblyTurn;
    onChange(Object.keys(kept).length ? kept : undefined);
  };
  return (
    <fieldset className="field">
      <legend>AssemblyAI turn detection</legend>
      <div className="number-grid">
        {TURN_FIELDS.map((f) => (
          <NumberField
            key={f.key}
            label={f.label}
            unit={f.unit}
            step={f.step}
            title={f.title}
            limits={ASSEMBLY_TURN_LIMITS[f.key]}
            value={value[f.key]}
            fallback={ASSEMBLY_TURN_DEFAULTS[f.key]}
            onChange={(n) => set(f.key, n)}
          />
        ))}
      </div>
      <span className="field-note">
        Empty = AssemblyAI's default (shown greyed). Longer silences stop commands being cut at pauses but make every command arrive later.
      </span>
    </fieldset>
  );
}

/** Line joining waits (useVoice.ts#LineJoiner): empty = the default shown greyed. */
function JoinFields({ speech, setSpeech }: { speech: SpeechSettings; setSpeech: (patch: Partial<SpeechSettings>) => void }) {
  return (
    <fieldset className="field">
      <legend>Join a command split by a pause</legend>
      <div className="number-grid two">
        <NumberField
          label="Wait for the rest"
          unit="ms"
          step={250}
          title='After a line that ends on "and", "with", "to", "the"... wait this long for more speech before running it as it is. 0 = never join'
          limits={HOLD_LIMITS.holdMs}
          value={speech.holdMs}
          fallback={HOLD_MS}
          onChange={(holdMs) => setSpeech({ holdMs })}
        />
        <NumberField
          label="Wait while still speaking"
          unit="ms"
          step={500}
          title="Once you carry on speaking, wait up to this long for that part to finish"
          limits={HOLD_LIMITS.holdSpeakingMs}
          value={speech.holdSpeakingMs}
          fallback={HOLD_SPEAKING_MS}
          onChange={(holdSpeakingMs) => setSpeech({ holdSpeakingMs })}
        />
      </div>
      <span className="field-note">
        A line ending in "and", "with", "to", "the"... waits for the rest and both run as one command. 0 = never join.
      </span>
    </fieldset>
  );
}

/** A number setting: empty = undefined (the default, shown as the placeholder). Clamped where it's used, not while typing. */
function NumberField({
  label,
  unit,
  step,
  title,
  limits: [min, max],
  value,
  fallback,
  onChange,
}: {
  label: string;
  unit: string;
  step: number;
  title: string;
  limits: readonly [number, number];
  value: number | undefined;
  fallback: number;
  onChange: (n: number | undefined) => void;
}) {
  return (
    <label className="number-field" title={title}>
      <span>
        {label} <small>({unit})</small>
      </span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value ?? ""}
        onChange={(e) => {
          const n = e.target.value.trim() === "" ? undefined : Number(e.target.value);
          onChange(n !== undefined && Number.isFinite(n) ? n : undefined);
        }}
        placeholder={String(fallback)}
      />
    </label>
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
  defaultTitle = "Use the server's .env setting",
}: {
  value: T | undefined;
  onChange: (v: T | undefined) => void;
  options: { value: T; label: string; title?: string }[];
  defaultLabel: string;
  defaultTitle?: string;
}) {
  return (
    <div className="segmented" role="radiogroup">
      {[{ value: undefined, label: defaultLabel, title: defaultTitle }, ...options].map((o) => (
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
