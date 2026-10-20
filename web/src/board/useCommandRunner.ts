import { useCallback, useRef, useState } from "react";
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { BoardAction, CommandEvent, CommandSource, ModelConfig, ObjectMode, TokenUsage } from "@board/shared";
import { streamCommand } from "../api";
import type { SpokenLine } from "../voice/clips";
import { playAnimation } from "./animate";
import { ActionError, applyAction } from "./executor";
import { loadObjectFiles } from "./objects";
import { loadPlotFiles } from "./plots";
import { summarize, visibleArea } from "./summary";
import { AUTO_CENTER_ANCHOR_Y, boundsOf, frame, isInSafeArea, planScroll, planZoom, playScroll } from "./view";

export type EntryStatus = "running" | "done" | "error" | "ignored" | "cancelled";

export interface LogEntry {
  id: number;
  text: string;
  status: EntryStatus;
  actions: number;
  /** Latency to the first action reaching the board. */
  firstMs?: number;
  totalMs?: number;
  /** Tokens the cloud model reported for this command (absent for local answers). */
  tokens?: TokenUsage;
  notes: { kind: "say" | "warn" | "error"; text: string }[];
  /** Which model decided the command (local fast path or cloud LLM) and why; set as soon as the server knows. */
  source?: { kind: CommandSource; model: string; detail: string; ms: number; objects?: ObjectMode; tools?: string[] };
  /** Spoken commands with saved voice clips: what was heard (before voice corrections) and the clip ids. */
  spoken?: SpokenLine;
}

type Snapshot = readonly ExcalidrawElement[];

/**
 * `getConfig` returns the Settings panel's model config for each command (undefined = the server's .env).
 * `getAutoCenter` says whether to glide the view to the last created/changed element after a command (code only, no model).
 */
export function useCommandRunner(
  api: ExcalidrawImperativeAPI | null,
  getConfig: () => ModelConfig | undefined = () => undefined,
  getAutoCenter: () => boolean = () => false,
) {
  const [log, setLog] = useState<LogEntry[]>([]);
  const [running, setRunning] = useState(false);
  const recentIds = useRef<string[]>([]);
  const history = useRef<Snapshot[]>([]);
  const inflight = useRef<AbortController | null>(null);
  const nextId = useRef(1);

  const update = (id: number, fn: (e: LogEntry) => LogEntry) => setLog((l) => l.map((e) => (e.id === id ? fn(e) : e)));

  const restore = useCallback(
    (snapshot: Snapshot) => {
      if (!api) return;
      const before = new Map(snapshot.map((e) => [e.id, e]));
      const restored = api.getSceneElementsIncludingDeleted().map((cur) => {
        const old = before.get(cur.id);
        const base = old ?? { ...cur, isDeleted: true };
        return {
          ...base,
          version: Math.max(cur.version, base.version) + 1,
          versionNonce: (Math.random() * 2 ** 31) | 0,
          updated: Date.now(),
        };
      });
      api.updateScene({ elements: restored, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
      void loadPlotFiles(api); // an undone graph edit may point back at a file this session never drew
    },
    [api],
  );

  const undo = useCallback(() => {
    const snap = history.current.pop();
    if (!snap) return false;
    restore(snap);
    return true;
  }, [restore]);

  /** Apply a stream of command events to the board. Shared by the server path and the dev hook. */
  const consume = useCallback(
    async (text: string, events: AsyncIterable<CommandEvent>, controller: AbortController, spoken?: SpokenLine) => {
      if (!api) return;
      const id = nextId.current++;
      setLog((l) => [...l.slice(-19), { id, text, status: "running", actions: 0, notes: [], spoken }]);
      setRunning(true);

      const snapshot = api.getSceneElementsIncludingDeleted();
      const ctx = { viewport: visibleArea(api.getAppState()), recentIds: recentIds.current, idMap: new Map<string, string>() };
      const touched: string[] = [];
      let lastTouched: string[] = []; // what the last board-changing action created or changed
      let applied = 0;
      let changed = 0; // applied actions that changed the board (scrolling/zooming don't)
      let scrolled = false;
      let undid = false;
      let failed = false;

      try {
        for await (const ev of events) {
          if (controller.signal.aborted) break;
          if (ev.type === "action") {
            if (ev.action.name === "undo_last_command") {
              undid = undo() || undid;
              if (!undid) update(id, (e) => ({ ...e, notes: [...e.notes, { kind: "warn", text: "Nothing to undo." }] }));
              applied++;
              update(id, (e) => ({ ...e, actions: applied, firstMs: e.firstMs ?? ev.ms }));
              continue;
            }
            try {
              if (ev.action.name === "scroll_view" || ev.action.name === "zoom_view") {
                const [els, st] = [api.getSceneElements(), api.getAppState()];
                const target =
                  ev.action.name === "scroll_view" ? planScroll(els, st, ev.action.input, ctx) : planZoom(els, st, ev.action.input, ctx);
                await playScroll(api, target, controller.signal);
                ctx.viewport = visibleArea(api.getAppState()); // later actions place into the new view
                scrolled = true;
                applied++;
                update(id, (e) => ({ ...e, actions: applied, firstMs: e.firstMs ?? ev.ms }));
                continue;
              }
              const before = api.getSceneElementsIncludingDeleted();
              const res = applyAction(before, ev.action, ctx);
              // Play motion before the next action, so "walk to X, then to Y" runs in order.
              if (res.animation) await playAnimation(api, before, res.elements, res.animation, controller.signal);
              else api.updateScene({ elements: res.elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
              if (ev.action.name === "add_object") void loadObjectFiles(api);
              else void loadPlotFiles(api); // new or changed graphs/charts (cheap scan otherwise)
              touched.push(...res.touched);
              if (res.touched.length) lastTouched = res.touched;
              applied++;
              changed++;
              const warns = (res.warnings ?? []).map((text) => ({ kind: "warn" as const, text }));
              update(id, (e) => ({ ...e, actions: applied, firstMs: e.firstMs ?? ev.ms, notes: [...e.notes, ...warns] }));
            } catch (err) {
              const msg = err instanceof ActionError ? err.message : `Couldn't apply ${ev.action.name}.`;
              if (!(err instanceof ActionError)) console.error(err);
              update(id, (e) => ({ ...e, notes: [...e.notes, { kind: "warn", text: msg }] }));
            }
          } else if (ev.type === "route") {
            update(id, (e) => ({ ...e, source: { kind: ev.source, model: ev.model, detail: ev.detail, ms: ev.ms, objects: ev.objects } }));
          } else if (ev.type === "say") {
            update(id, (e) => ({ ...e, notes: [...e.notes, { kind: "say", text: ev.text }] }));
          } else if (ev.type === "invalid") {
            update(id, (e) => ({ ...e, notes: [...e.notes, { kind: "warn", text: `Skipped a malformed ${ev.name} call.` }] }));
          } else if (ev.type === "error") {
            failed = true;
            update(id, (e) => ({ ...e, notes: [...e.notes, { kind: "error", text: ev.message }] }));
          } else if (ev.type === "done") {
            update(id, (e) => ({
              ...e,
              totalMs: ev.ms,
              tokens: ev.tokens,
              source: e.source && ev.tools ? { ...e.source, tools: ev.tools } : e.source,
            }));
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          failed = true;
          const msg = err instanceof Error ? err.message : "Request failed";
          update(id, (e) => ({
            ...e,
            notes: [...e.notes, { kind: "error", text: msg === "Failed to fetch" ? "Can't reach the server." : msg }],
          }));
        }
      }

      // A view-only command (scrolling, zooming) leaves no undo step: "undo" then undoes the last board change.
      const changedBoard = changed > 0 && !undid;
      if (changedBoard) history.current = [...history.current.slice(-49), snapshot];
      const status: EntryStatus = controller.signal.aborted
        ? "cancelled"
        : failed && applied === 0
          ? "error"
          : applied === 0
            ? "ignored"
            : "done";
      update(id, (e) => ({ ...e, status }));
      if (inflight.current === controller) inflight.current = null;
      if (!inflight.current) setRunning(false);
      if (touched.length && !scrolled) {
        // After a scroll, the user chose the view.
        if (getAutoCenter() && !controller.signal.aborted) await centerOn(api, lastTouched, controller.signal);
        else revealIfHidden(api, touched);
      }
    },
    [api, undo, getAutoCenter],
  );

  const run = useCallback(
    (text: string, spoken?: SpokenLine) => {
      if (!api || !text.trim()) return;
      inflight.current?.abort(); // barge-in: a new command cancels the one in flight
      const controller = new AbortController();
      inflight.current = controller;
      const scene = summarize(
        api.getSceneElements(),
        Object.keys(api.getAppState().selectedElementIds),
        recentIds.current,
        visibleArea(api.getAppState()),
      );
      return consume(text, streamCommand({ text, scene, config: getConfig() }, controller.signal), controller, spoken);
    },
    [api, consume, getConfig],
  );

  /** Apply ready-made actions as one command (one undo step, one log entry): manual edits and the dev hook. */
  const applyActions = useCallback(
    (text: string, actions: BoardAction[], model = "manual") => {
      async function* events(): AsyncGenerator<CommandEvent> {
        for (const action of actions) yield { type: "action", action, ms: 0 };
        yield { type: "done", ms: 0, model, actions: actions.length };
      }
      return consume(text, events(), new AbortController());
    },
    [consume],
  );

  const cancel = useCallback(() => {
    inflight.current?.abort();
    inflight.current = null;
    setRunning(false);
  }, []);

  return { log, running, run, cancel, consume, applyActions, undo };
}

/** Glide the view so `ids` sit at bottom centre of the free screen area; keeps the zoom unless they can't fit. */
async function centerOn(api: ExcalidrawImperativeAPI, ids: string[], signal: AbortSignal) {
  const box = boundsOf(api.getSceneElements().filter((e) => ids.includes(e.id)));
  if (box) await playScroll(api, frame(api.getAppState(), box, AUTO_CENTER_ANCHOR_Y), signal);
}

/**
 * Bring new content into view if it landed off-screen or under the toolbar / command dock.
 * Keeps the current zoom unless the content can't fit, then zooms out just enough.
 */
function revealIfHidden(api: ExcalidrawImperativeAPI, ids: string[]) {
  const box = boundsOf(api.getSceneElements().filter((e) => ids.includes(e.id)));
  const st = api.getAppState();
  if (!box || isInSafeArea(st, box)) return;
  const next = frame(st, box);
  api.updateScene({ appState: { scrollX: next.scrollX, scrollY: next.scrollY, zoom: { value: next.zoom as typeof st.zoom.value } } });
}
