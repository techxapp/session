import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowUp, Check, CircleSlash, Cloud, Cpu, Loader2, MessageSquare, Sparkles, Square, Undo2 } from "lucide-react";
import type { LogEntry } from "../board/useCommandRunner";
import { modelName } from "./StatusPill";

const SUGGESTIONS = [
  "Draw a login flow: user, web app, auth service, database",
  "Add a sticky note that says ship by Friday",
  "Title: Q3 architecture review",
  "Make the database green and move it down",
];

interface Props {
  log: LogEntry[];
  running: boolean;
  disabled?: boolean;
  boardEmpty: boolean;
  onSubmit: (text: string) => void;
  onCancel: () => void;
  onUndo: () => void;
}

export function CommandDock({ log, running, disabled, boardEmpty, onSubmit, onCancel, onUndo }: Props) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const recent = log.slice(-3);

  // "/" focuses the command bar from anywhere (unless the user is typing in the canvas).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.isContentEditable || ["INPUT", "TEXTAREA"].includes(t.tagName));
      if (e.key === "/" && !typing) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const submit = (value = text) => {
    const v = value.trim();
    if (!v || disabled) return;
    onSubmit(v);
    setText("");
  };

  return (
    <div className="dock" role="region" aria-label="AI command bar">
      {recent.length > 0 && (
        <ol className="activity" aria-live="polite">
          {recent.map((entry, i) => (
            <ActivityRow key={entry.id} entry={entry} latest={i === recent.length - 1} onUndo={onUndo} />
          ))}
        </ol>
      )}

      {boardEmpty && log.length === 0 && (
        <div className="suggestions">
          {SUGGESTIONS.map((s) => (
            <button key={s} className="chip" onClick={() => submit(s)} disabled={disabled}>
              {s}
            </button>
          ))}
        </div>
      )}

      <form
        className={`bar${running ? " is-running" : ""}`}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Sparkles className="bar-icon" size={18} aria-hidden />
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              if (running) onCancel();
              else inputRef.current?.blur();
            }
          }}
          placeholder={disabled ? "Connect the server to start drawing…" : "Tell the board what to draw…"}
          aria-label="Command"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
        />
        {!text && !running && <kbd className="hint">/</kbd>}
        {running ? (
          <button type="button" className="send stop" onClick={onCancel} aria-label="Stop">
            <Square size={14} fill="currentColor" />
          </button>
        ) : (
          <button type="submit" className="send" disabled={!text.trim() || disabled} aria-label="Run command">
            <ArrowUp size={18} strokeWidth={2.4} />
          </button>
        )}
      </form>
    </div>
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
