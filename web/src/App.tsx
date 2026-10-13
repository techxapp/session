import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Excalidraw, MainMenu, THEME } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { BoardAction, CommandEvent, HealthInfo } from "@board/shared";
import { Settings2 } from "lucide-react";
import { checkHealth } from "./api";
import { loadObjectFiles } from "./board/objects";
import { useCommandRunner } from "./board/useCommandRunner";
import { ActivityPanel } from "./components/ActivityPanel";
import { CommandDock } from "./components/CommandDock";
import { SettingsPanel } from "./components/SettingsPanel";
import { StatusPill, type ServerStatus } from "./components/StatusPill";
import { boardKeyterms, useVoice } from "./voice/useVoice";
import {
  activeChoice,
  activeProfile,
  effectiveModel,
  loadSettings,
  requestConfig,
  saveSettings,
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
  const runner = useCommandRunner(api, getConfig);

  // Spoken commands run in order: a new line waits for the command in flight instead of cancelling it (typing still barges in).
  const runRef = useRef(runner.run);
  runRef.current = runner.run;
  const spoken = useRef<Promise<unknown>>(Promise.resolve());
  const onSpoken = useCallback((text: string) => {
    spoken.current = spoken.current.then(() => runRef.current(text)).catch(() => undefined);
  }, []);
  const getKeyterms = useCallback(() => (api ? boardKeyterms(api.getSceneElements()) : []), [api]);
  const voice = useVoice(onSpoken, getKeyterms);

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

  // Saved boards keep only element JSON; fetch the clip-art their object images point at.
  useEffect(() => {
    if (api) void loadObjectFiles(api);
  }, [api]);

  // Dev-only hook for driving the board without the model (used by tests and demos).
  useEffect(() => {
    if (!import.meta.env.DEV || !api) return;
    (window as unknown as { __board: unknown }).__board = {
      api,
      apply: (text: string, actions: BoardAction[]) => {
        async function* events(): AsyncGenerator<CommandEvent> {
          for (const action of actions) yield { type: "action", action, ms: 0 };
          yield { type: "done", ms: 0, model: "dev", actions: actions.length };
        }
        return runner.consume(text, events(), new AbortController());
      },
    };
  }, [api, runner.consume]);

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

      <ActivityPanel log={runner.log} running={runner.running} onUndo={runner.undo} />

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
