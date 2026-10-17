import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Excalidraw, MainMenu, THEME } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { BoardAction, HealthInfo } from "@board/shared";
import { Settings2 } from "lucide-react";
import { checkHealth } from "./api";
import { loadObjectFiles } from "./board/objects";
import { loadPlotFiles } from "./board/plots";
import { useCommandRunner } from "./board/useCommandRunner";
import { ActivityPanel } from "./components/ActivityPanel";
import { ChartEditor } from "./components/ChartEditor";
import { CommandDock } from "./components/CommandDock";
import { PlotHover } from "./components/PlotHover";
import { SettingsPanel } from "./components/SettingsPanel";
import { StatusPill, type ServerStatus } from "./components/StatusPill";
import { useCorrections } from "./voice/corrections";
import { boardKeyterms, useVoice } from "./voice/useVoice";
import {
  activeChoice,
  activeProfile,
  effectiveModel,
  loadSettings,
  requestConfig,
  saveSettings,
  speechConfig,
  serverHasKey,
  type Settings,
} from "./settings";

const STORAGE_KEY = "voice-board:scene:v1";

function loadScene(): ExcalidrawElement[] | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function prefersDark() {
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches;
}

export default function App() {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">(prefersDark() ? "dark" : "light");
  const [boardEmpty, setBoardEmpty] = useState(true);
  // undefined = still checking, null = server offline.
  const [health, setHealth] = useState<HealthInfo | null | undefined>(undefined);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => saveSettings(settings), [settings]);
  const updateSettings = useCallback((fn: (s: Settings) => Settings) => setSettings(fn), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  // Each command carries the Settings panel's config (read at send time, so the runner needn't re-render).
  const latest = useRef({ settings, health });
  latest.current = { settings, health };
  const getConfig = useCallback(() => requestConfig(latest.current.settings, latest.current.health ?? null), []);
  const getAutoCenter = useCallback(() => latest.current.settings.autoCenter, []);
  const runner = useCommandRunner(api, getConfig, getAutoCenter);

  // Learned fixes for misheard lines (voice only): every command that changed nothing is kept so it can be fixed in the activity panel.
  const corrections = useCorrections();
  const { capture } = corrections;
  const capturedIds = useRef(new Set<number>());
  useEffect(() => {
    for (const e of runner.log) {
      if (e.status !== "ignored" || capturedIds.current.has(e.id)) continue;
      capturedIds.current.add(e.id);
      capture(e.text);
    }
  }, [runner.log, capture]);

  // Spoken commands run in order: a new line waits for the command in flight instead of cancelling it (typing still barges in).
  const runRef = useRef(runner.run);
  runRef.current = runner.run;
  const spoken = useRef<Promise<unknown>>(Promise.resolve());
  const { apply: correct, keyterms: learnedKeyterms } = corrections;
  const onSpoken = useCallback(
    (text: string) => {
      const line = correct(text, latest.current.settings.speech.defaultDraw ?? true);
      spoken.current = spoken.current.then(() => runRef.current(line)).catch(() => undefined);
    },
    [correct],
  );
  const getKeyterms = useCallback(() => (api ? boardKeyterms(api.getSceneElements(), learnedKeyterms()) : []), [api, learnedKeyterms]);
  const getSpeech = useCallback(() => speechConfig(latest.current.settings, latest.current.health ?? null), []);
  const voice = useVoice(onSpoken, getKeyterms, getSpeech);

  const status: ServerStatus = useMemo(() => {
    if (health === undefined) return { state: "checking" };
    if (health === null) return { state: "offline" };
    const choice = activeChoice(settings);
    const model = effectiveModel(settings, health) ?? "no model";
    const keyed = Boolean(activeProfile(settings).apiKey) || serverHasKey(choice, health);
    const where = choice ? choice.label : undefined;
    return keyed
      ? { state: "ready", model, where, fastPath: health.fastPath }
      : { state: "no-key", model, where, fastPath: health.fastPath };
  }, [health, settings]);
  const initialData = useMemo(() => {
    const elements = loadScene();
    return { elements: elements ?? [], appState: { theme: prefersDark() ? THEME.DARK : THEME.LIGHT } };
  }, []);

  // Follow OS light/dark changes live (the menu's theme toggle still overrides via onChange).
  useEffect(() => {
    if (typeof matchMedia === "undefined") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setTheme(mq.matches ? "dark" : "light");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      const h = await checkHealth();
      if (alive) setHealth(h);
    };
    poll();
    const t = setInterval(poll, 15000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // Save the board locally (debounced) so a reload doesn't lose work.
  const saveTimer = useRef<number | undefined>(undefined);
  // Last theme Excalidraw reported; a change here means the user used the menu's theme toggle.
  const reportedTheme = useRef<string | null>(null);
  const onChange = useCallback((elements: readonly ExcalidrawElement[], appState: AppState) => {
    if (appState.theme !== reportedTheme.current) {
      if (reportedTheme.current !== null) setTheme(appState.theme);
      reportedTheme.current = appState.theme;
    }
    const empty = !elements.some((e) => !e.isDeleted);
    setBoardEmpty((prev) => (prev === empty ? prev : empty));
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(elements.filter((e) => !e.isDeleted)));
      } catch {
        /* storage unavailable: ignore */
      }
    }, 400);
  }, []);

  // Saved boards keep only element JSON; fetch the clip-art their object images point at and redraw graphs/charts.
  useEffect(() => {
    if (!api) return;
    void loadObjectFiles(api);
    void loadPlotFiles(api);
  }, [api]);

  // Dev-only hook for driving the board without the model (used by tests and demos).
  useEffect(() => {
    if (!import.meta.env.DEV || !api) return;
    (window as unknown as { __board: unknown }).__board = {
      api,
      apply: (text: string, actions: BoardAction[]) => runner.applyActions(text, actions, "dev"),
    };
  }, [api, runner.applyActions]);

  return (
    <div className="app" data-theme={theme}>
      <Excalidraw
        excalidrawAPI={setApi}
        initialData={initialData}
        onChange={onChange}
        theme={theme}
        renderTopRightUI={() => (
          <div className="top-right">
            <StatusPill status={status} />
            <button
              className={`settings-toggle${settingsOpen ? " is-open" : ""}`}
              onClick={() => setSettingsOpen((o) => !o)}
              aria-label="Model settings"
              aria-expanded={settingsOpen}
              title="Model settings"
            >
              <Settings2 size={16} />
            </button>
          </div>
        )}
        UIOptions={{ canvasActions: { loadScene: true, saveToActiveFile: false, export: { saveFileToDisk: true } } }}
      >
        <MainMenu>
          <MainMenu.DefaultItems.LoadScene />
          <MainMenu.DefaultItems.Export />
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.ClearCanvas />
          <MainMenu.Separator />
          <MainMenu.DefaultItems.ToggleTheme />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
          <MainMenu.DefaultItems.Help />
        </MainMenu>
      </Excalidraw>

      <PlotHover api={api} />

      <ChartEditor api={api} onApply={runner.applyActions} />

      {boardEmpty && runner.log.length === 0 && (
        <div className="empty-state" aria-hidden>
          <div className="empty-mark">✦</div>
          <h1>Describe it. Watch it appear.</h1>
          <p>
            Type or say a command below — boxes, arrows, notes, whole diagrams. Press <kbd>/</kbd> anytime to focus.
          </p>
        </div>
      )}

      {settingsOpen && <SettingsPanel settings={settings} health={health ?? null} update={updateSettings} onClose={closeSettings} />}

      <ActivityPanel log={runner.log} running={runner.running} onUndo={runner.undo} corrections={corrections} />

      <CommandDock
        showSuggestions={boardEmpty && runner.log.length === 0}
        running={runner.running}
        disabled={status.state === "offline"}
        onSubmit={(t) => void runner.run(t)}
        onCancel={runner.cancel}
        voice={voice}
      />
    </div>
  );
}
