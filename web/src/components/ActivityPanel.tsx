import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowRight,
  BookmarkPlus,
  Check,
  ChevronDown,
  ChevronRight,
  CircleSlash,
  Cloud,
  Cpu,
  History,
  Loader2,
  MessageSquare,
  PanelRightClose,
  Pencil,
  Undo2,
  Wand2,
  X,
} from "lucide-react";
import type { TokenUsage } from "@board/shared";
import type { LogEntry } from "../board/useCommandRunner";
import { sendClipLabels, type SpokenLine } from "../voice/clips";
import { deriveRule, normLine, type Corrections } from "../voice/corrections";
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
  corrections: Corrections;
}

/** What the fix editor is open on: a log row, a captured line or a saved rule. */
interface Editing {
  key: string;
  heard: string;
  meant?: string;
  /** Captured line or rule the saved rule replaces. */
  fromId?: string;
  /** The line's saved voice clips: the fixed text labels them. */
  spoken?: SpokenLine;
}

/** Collapsible activity log on the right edge; newest command first. Below it, the voice corrections (voice/corrections.ts). */
export function ActivityPanel({ log, running, onUndo, corrections }: Props) {
  const [open, setOpen] = useState(loadOpen);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [fixesOpen, setFixesOpen] = useState(true);

  useEffect(() => {
    try {
      localStorage.setItem(OPEN_KEY, open ? "1" : "0");
    } catch {
      /* storage unavailable: ignore */
    }
  }, [open]);

  const { rules, captured, saveRule, remove } = corrections;
  if (log.length === 0 && rules.length === 0 && captured.length === 0) return null;
  const entries = [...log].reverse();
  const save = (find: string, replace: string, meant?: string) => {
    saveRule(find, replace, editing?.fromId);
    if (editing?.spoken && meant?.trim()) void sendClipLabels({ ...editing.spoken, text: meant.trim() });
    setEditing(null);
  };
  const editor = (e: Editing) => (
    <FixEditor key={e.key} heard={e.heard} meant={e.meant} labels={Boolean(e.spoken)} onSave={save} onCancel={() => setEditing(null)} />
  );
  const editRow = (entry: LogEntry) => {
    const from = captured.find((c) => normLine(c.text) === normLine(entry.text));
    setEditing({ key: `log-${entry.id}`, heard: entry.text, fromId: from?.id, spoken: entry.spoken ?? from?.spoken });
  };

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
          <ActivityRow
            key={entry.id}
            entry={entry}
            latest={i === 0}
            onUndo={onUndo}
            onFix={() => editRow(entry)}
            editor={editing?.key === `log-${entry.id}` ? editor(editing) : null}
          />
        ))}
      </ol>
      {(rules.length > 0 || captured.length > 0) && (
        <section className="fixes" aria-label="Voice corrections">
          <button className="fixes-head" onClick={() => setFixesOpen((o) => !o)} aria-expanded={fixesOpen}>
            {fixesOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <Wand2 size={13} aria-hidden />
            <span>Voice corrections</span>
            <span className="fixes-count">
              {[rules.length && String(rules.length), captured.length && `${captured.length} to fix`].filter(Boolean).join(" · ")}
            </span>
          </button>
          {fixesOpen && (
            <ul className="fixes-list">
              {[...captured].reverse().map((c) => (
                <li key={c.id} className="fix needs-fix">
                  <div className="fix-line">
                    <span className="fix-text" title="Changed nothing: fix it to learn a correction">
                      {c.text}
                    </span>
                    <button
                      className="row-undo"
                      onClick={() => setEditing({ key: `cap-${c.id}`, heard: c.text, fromId: c.id, spoken: c.spoken })}
                      title="Fix this line"
                    >
                      <Pencil size={12} /> Fix
                    </button>
                    <button className="fix-remove" onClick={() => remove(c.id)} aria-label="Dismiss" title="Dismiss">
                      <X size={13} />
                    </button>
                  </div>
                  {editing?.key === `cap-${c.id}` && editor(editing)}
                </li>
              ))}
              {[...rules].reverse().map((r) => (
                <li key={r.id} className="fix">
                  <div className="fix-line">
                    <span className="fix-text">
                      <span className="fix-find">{r.find}</span>
                      <ArrowRight size={12} aria-hidden />
                      <span className="fix-replace">{r.replace}</span>
                    </span>
                    <button
                      className="fix-remove"
                      onClick={() => setEditing({ key: `rule-${r.id}`, heard: r.find, meant: r.replace, fromId: r.id })}
                      aria-label="Edit correction"
                      title="Edit"
                    >
                      <Pencil size={12} />
                    </button>
                    <button className="fix-remove" onClick={() => remove(r.id)} aria-label="Delete correction" title="Delete">
                      <X size={13} />
                    </button>
                  </div>
                  {editing?.key === `rule-${r.id}` && editor(editing)}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </aside>
  );
}

/**
 * Fix a misheard line: type what it should have been; the rule is the words that differ ("set june" -> "set zoom"),
 * shown in two fields that can be widened or narrowed before saving. Enter saves, Escape cancels.
 * `labels`: the line has saved voice clips, and what is typed is also sent as their true text (`onSave`'s `meant`).
 */
function FixEditor({
  heard,
  meant: initialMeant,
  labels,
  onSave,
  onCancel,
}: {
  heard: string;
  meant?: string;
  labels?: boolean;
  onSave: (find: string, replace: string, meant?: string) => void;
  onCancel: () => void;
}) {
  const [meant, setMeant] = useState(initialMeant ?? heard);
  // Once the user edits find/replace by hand, typing in "meant" no longer overwrites them.
  const [manual, setManual] = useState<{ find: string; replace: string } | null>(
    initialMeant !== undefined ? { find: heard, replace: initialMeant } : null,
  );
  const derived = deriveRule(heard, meant);
  const rule = manual ?? derived ?? { find: "", replace: "" };
  const canSave = Boolean(rule.find.trim()) && normLine(rule.find) !== normLine(rule.replace);
  const meantArg = initialMeant === undefined ? meant : undefined;
  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation(); // keep Excalidraw shortcuts off the board while typing
    if (e.key === "Escape") onCancel();
    else if (e.key === "Enter" && canSave) onSave(rule.find, rule.replace, meantArg);
  };

  return (
    <div className="fix-editor" onKeyDown={onKey}>
      {initialMeant === undefined && (
        <label className="fix-field">
          <span>Heard “{heard}”. Should have been:</span>
          <input autoFocus value={meant} onChange={(e) => setMeant(e.target.value)} spellCheck={false} />
        </label>
      )}
      <div className="fix-rule">
        <label className="fix-field">
          <span>Replace</span>
          <input
            value={rule.find}
            onChange={(e) => setManual({ ...rule, find: e.target.value })}
            autoFocus={initialMeant !== undefined}
            spellCheck={false}
          />
        </label>
        <ArrowRight size={13} aria-hidden className="fix-arrow" />
        <label className="fix-field">
          <span>With</span>
          <input value={rule.replace} onChange={(e) => setManual({ ...rule, replace: e.target.value })} spellCheck={false} />
        </label>
      </div>
      <div className="fix-actions">
        <span className="fix-hint">
          Only these words are replaced in later spoken lines.
          {labels && initialMeant === undefined && " Type what you said: it also labels the saved recording."}
        </span>
        <button className="row-undo" onClick={onCancel}>
          Cancel
        </button>
        <button className="row-undo is-primary" onClick={() => onSave(rule.find, rule.replace, meantArg)} disabled={!canSave}>
          Save
        </button>
      </div>
    </div>
  );
}

function ActivityRow({
  entry,
  latest,
  onUndo,
  onFix,
  editor,
}: {
  entry: LogEntry;
  latest: boolean;
  onUndo: () => void;
  onFix: () => void;
  editor: ReactNode;
}) {
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
          {entry.status !== "running" && (
            <button
              className="row-undo"
              onClick={onFix}
              title={
                entry.status === "ignored" ? "Fix a misheard line: learn a voice correction" : "Store a voice correction for this line"
              }
            >
              {entry.status === "ignored" ? <Pencil size={12} /> : <BookmarkPlus size={13} />}
              {entry.status === "ignored" ? "Fix" : "Save"}
            </button>
          )}
        </div>
        {entry.source && (
          <div className={`note note-route note-${entry.source.kind}`}>
            {modelName(entry.source.model)} · {entry.source.detail}
            {entry.source.kind === "local" && entry.source.ms > 0 ? ` · ${fmt(entry.source.ms)}` : ""}
            {entry.source.objects ? ` · objects: ${entry.source.objects}` : ""}
            {entry.source.tools ? ` · tools: ${entry.source.tools.join("+")}` : ""}
            {entry.tokens && (
              <span title={tokenTitle(entry.tokens)}>
                {` · tokens: ${fmtTokens(entry.tokens.in)} in, ${fmtTokens(entry.tokens.out)} out`}
              </span>
            )}
          </div>
        )}
        {entry.notes.map((n, i) => (
          <div key={i} className={`note note-${n.kind}`}>
            {n.kind === "say" ? <MessageSquare size={12} /> : <AlertTriangle size={12} />}
            {n.text}
          </div>
        ))}
        {editor}
      </div>
    </li>
  );
}

/** Rounded token counts: 840 -> "840", 8234 -> "8.2k", 12345 -> "12k". */
export const fmtTokens = (n: number) =>
  n < 1000 ? String(n) : n < 10_000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : `${Math.round(n / 1000)}k`;
const tokenTitle = (t: TokenUsage) =>
  `${t.in.toLocaleString()} tokens sent${t.cached ? ` (${t.cached.toLocaleString()} from the prompt cache)` : ""}, ${t.out.toLocaleString()} received`;

const fmt = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
