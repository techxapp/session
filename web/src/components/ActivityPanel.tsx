import { useEffect, useState } from "react";
import { AlertTriangle, Check, CircleSlash, Cloud, Cpu, History, Loader2, MessageSquare, PanelRightClose, Undo2 } from "lucide-react";
import type { LogEntry } from "../board/useCommandRunner";
import { modelName } from "./StatusPill";

const OPEN_KEY = "voice-board:activity-open";

function loadOpen() {
  try {
    return localStorage.getItem(OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}

interface Props {
  log: LogEntry[];
  running: boolean;
  onUndo: () => void;
}

/** Collapsible activity log on the right edge; newest command first. */
export function ActivityPanel({ log, running, onUndo }: Props) {
  const [open, setOpen] = useState(loadOpen);

  useEffect(() => {
    try {
      localStorage.setItem(OPEN_KEY, open ? "1" : "0");
    } catch {
      /* storage unavailable: ignore */
    }
  }, [open]);

  if (log.length === 0) return null;
  const entries = [...log].reverse();

  if (!open) {
    return (
      <button className="activity-tab" onClick={() => setOpen(true)} aria-label="Show activity" title="Show activity">
        {running ? <Loader2 size={16} className="spin" /> : <History size={16} />}
        <span className="activity-count">{log.length}</span>
      </button>
    );
  }

  return (
    <aside className="activity-panel" aria-label="Activity">
      <header className="activity-head">
        <History size={15} aria-hidden />
        <span>Activity</span>
        <button className="activity-close" onClick={() => setOpen(false)} aria-label="Hide activity" title="Hide activity">
          <PanelRightClose size={16} />
        </button>
      </header>
      <ol className="activity" aria-live="polite">
        {entries.map((entry, i) => (
          <ActivityRow key={entry.id} entry={entry} latest={i === 0} onUndo={onUndo} />
        ))}
      </ol>
    </aside>
  );
}

function ActivityRow({ entry, latest, onUndo }: { entry: LogEntry; latest: boolean; onUndo: () => void }) {
  const icon = {
    running: <Loader2 size={14} className="spin" />,
    done: <Check size={14} />,
    error: <AlertTriangle size={14} />,
    ignored: <CircleSlash size={14} />,
    cancelled: <CircleSlash size={14} />,
  }[entry.status];
  const meta =
    entry.status === "running"
      ? entry.actions
        ? `${entry.actions} action${entry.actions > 1 ? "s" : ""}…`
        : "Thinking…"
      : entry.status === "done"
        ? `${entry.actions} action${entry.actions > 1 ? "s" : ""}${entry.firstMs != null ? ` · first in ${fmt(entry.firstMs)}` : ""}`
        : entry.status === "ignored"
          ? "No board change"
          : entry.status === "cancelled"
            ? "Stopped"
            : "Failed";

  return (
    <li className={`row status-${entry.status}${latest ? " latest" : ""}`}>
      <span className="row-icon">{icon}</span>
      <div className="row-body">
        <div className="row-line">
          <span className="row-text" title={entry.text}>
            {entry.text}
          </span>
          {entry.source && (
            <span className={`source source-${entry.source.kind}`} title={`${entry.source.detail} · ${entry.source.model}`}>
              {entry.source.kind === "local" ? <Cpu size={11} /> : <Cloud size={11} />}
              {entry.source.kind === "local" ? "Local" : "Cloud"}
            </span>
          )}
          <span className="row-meta">{meta}</span>
          {latest && entry.status === "done" && (
            <button className="row-undo" onClick={onUndo} title="Undo this command">
              <Undo2 size={13} /> Undo
            </button>
          )}
        </div>
        {entry.source && (
          <div className={`note note-route note-${entry.source.kind}`}>
            {modelName(entry.source.model)} · {entry.source.detail}
            {entry.source.kind === "local" && entry.source.ms > 0 ? ` · ${fmt(entry.source.ms)}` : ""}
          </div>
        )}
        {entry.notes.map((n, i) => (
          <div key={i} className={`note note-${n.kind}`}>
            {n.kind === "say" ? <MessageSquare size={12} /> : <AlertTriangle size={12} />}
            {n.text}
          </div>
        ))}
      </div>
    </li>
  );
}

const fmt = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
