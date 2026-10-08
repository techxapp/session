import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Excalidraw, MainMenu, THEME } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { BoardAction, CommandEvent } from "@board/shared";
import { checkHealth } from "./api";
import { useCommandRunner } from "./board/useCommandRunner";
import { CommandDock } from "./components/CommandDock";
import { StatusPill, type ServerStatus } from "./components/StatusPill";

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
  const [status, setStatus] = useState<ServerStatus>({ state: "checking" });
  const runner = useCommandRunner(api);
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
      if (!alive) return;
      setStatus(
        !h
          ? { state: "offline" }
          : h.hasKey
            ? { state: "ready", model: h.model, fastPath: Boolean(h.fastPath) }
            : { state: "no-key", model: h.model, fastPath: Boolean(h.fastPath) },
      );
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
        renderTopRightUI={() => <StatusPill status={status} />}
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
            Type a command below — boxes, arrows, notes, whole diagrams. Press <kbd>/</kbd> anytime to focus.
          </p>
        </div>
      )}

      <CommandDock
        log={runner.log}
        running={runner.running}
        disabled={status.state === "offline"}
        boardEmpty={boardEmpty}
        onSubmit={(t) => void runner.run(t)}
        onCancel={runner.cancel}
        onUndo={runner.undo}
      />
    </div>
  );
}
