import { useCallback, useRef, useState } from "react";
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { CommandEvent } from "@board/shared";
import { streamCommand } from "../api";
import { ActionError, applyAction, isTopLevel } from "./executor";
import { summarize, visibleArea } from "./summary";

export type EntryStatus = "running" | "done" | "error" | "ignored" | "cancelled";

export interface LogEntry {
  id: number;
  text: string;
  status: EntryStatus;
  actions: number;
  /** Latency to the first action reaching the board. */
  firstMs?: number;
  totalMs?: number;
  notes: { kind: "say" | "warn" | "error"; text: string }[];
}

type Snapshot = readonly ExcalidrawElement[];

export function useCommandRunner(api: ExcalidrawImperativeAPI | null) {
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
    async (text: string, events: AsyncIterable<CommandEvent>, controller: AbortController) => {
      if (!api) return;
      const id = nextId.current++;
      setLog((l) => [...l.slice(-19), { id, text, status: "running", actions: 0, notes: [] }]);
      setRunning(true);

      const snapshot = api.getSceneElementsIncludingDeleted();
      const ctx = { viewport: visibleArea(api.getAppState()), recentIds: recentIds.current, idMap: new Map<string, string>() };
      const touched: string[] = [];
      let applied = 0;
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
              const res = applyAction(api.getSceneElementsIncludingDeleted(), ev.action, ctx);
              api.updateScene({ elements: res.elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
              touched.push(...res.touched);
              applied++;
              update(id, (e) => ({ ...e, actions: applied, firstMs: e.firstMs ?? ev.ms }));
            } catch (err) {
              const msg = err instanceof ActionError ? err.message : `Couldn't apply ${ev.action.name}.`;
              if (!(err instanceof ActionError)) console.error(err);
              update(id, (e) => ({ ...e, notes: [...e.notes, { kind: "warn", text: msg }] }));
            }
          } else if (ev.type === "say") {
            update(id, (e) => ({ ...e, notes: [...e.notes, { kind: "say", text: ev.text }] }));
          } else if (ev.type === "invalid") {
            update(id, (e) => ({ ...e, notes: [...e.notes, { kind: "warn", text: `Skipped a malformed ${ev.name} call.` }] }));
          } else if (ev.type === "error") {
            failed = true;
            update(id, (e) => ({ ...e, notes: [...e.notes, { kind: "error", text: ev.message }] }));
          } else if (ev.type === "done") {
            update(id, (e) => ({ ...e, totalMs: ev.ms }));
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

      const changedBoard = applied > 0 && !undid;
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
      if (touched.length) revealIfHidden(api, touched);
    },
    [api, undo],
  );

  const run = useCallback(
    (text: string) => {
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
      return consume(text, streamCommand({ text, scene }, controller.signal), controller);
    },
    [api, consume],
  );

  const cancel = useCallback(() => {
    inflight.current?.abort();
    inflight.current = null;
    setRunning(false);
  }, []);

  return { log, running, run, cancel, consume, undo };
}

/**
 * Bring new content into view if it landed off-screen or under the toolbar / command dock.
 * Keeps the current zoom unless the content can't fit, then zooms out just enough.
 */
function revealIfHidden(api: ExcalidrawImperativeAPI, ids: string[]) {
  const els = api.getSceneElements().filter((e) => ids.includes(e.id) && isTopLevel(e));
  if (!els.length) return;
  const st = api.getAppState();
  const zoom = st.zoom.value;
  // Unobstructed screen area: below the toolbar, above the dock + activity feed.
  const safe = { left: 24, top: 96, right: st.width - 24, bottom: st.height - 300 };
  const box = {
    x1: Math.min(...els.map((e) => e.x)),
    y1: Math.min(...els.map((e) => e.y)),
    x2: Math.max(...els.map((e) => e.x + e.width)),
    y2: Math.max(...els.map((e) => e.y + e.height)),
  };
  const toScreen = (x: number, y: number) => ({ x: (x + st.scrollX) * zoom, y: (y + st.scrollY) * zoom });
  const a = toScreen(box.x1, box.y1);
  const b = toScreen(box.x2, box.y2);
  if (a.x >= safe.left && a.y >= safe.top && b.x <= safe.right && b.y <= safe.bottom) return;

  const safeW = Math.max(200, safe.right - safe.left);
  const safeH = Math.max(160, safe.bottom - safe.top);
  const nextZoom = Math.min(zoom, (safeW / (box.x2 - box.x1)) * 0.9, (safeH / (box.y2 - box.y1)) * 0.9);
  const cx = (box.x1 + box.x2) / 2;
  const cy = (box.y1 + box.y2) / 2;
  api.updateScene({
    appState: {
      zoom: { value: Math.max(0.1, nextZoom) as typeof st.zoom.value },
      scrollX: (safe.left + safeW / 2) / nextZoom - cx,
      scrollY: (safe.top + safeH / 2) / nextZoom - cy,
    },
  });
}
