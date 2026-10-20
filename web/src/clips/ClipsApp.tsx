import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, RefreshCw, RotateCcw, Search, Trash2 } from "lucide-react";
import { CLIP_SOURCES, type ClipItem } from "@board/shared";
import {
  DEFAULT_FILTERS,
  SOURCE_NAMES,
  STATUSES,
  STATUS_NAMES,
  facetCounts,
  filterItems,
  initialText,
  minutes,
  type ClipFilters,
} from "./clipFilter";

/**
 * The clips dashboard (/clips.html): every saved voice clip (Settings "Keep voice clips"), to listen to, correct the
 * transcript (a label, as the activity panel's Fix/Save writes), or delete. Served by the API server's /api/clips.
 */

const PAGE = 100;
const PREFS_KEY = "voice-board:clips-dashboard:v1";

interface Prefs {
  filters: ClipFilters;
  autoplay: boolean;
}

function loadPrefs(): Prefs {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
    return { filters: { ...DEFAULT_FILTERS, ...saved.filters, query: "" }, autoplay: saved.autoplay ?? true };
  } catch {
    return { filters: DEFAULT_FILTERS, autoplay: true };
  }
}

function savePrefs(p: Prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable: the filters reset on reload */
  }
}

async function call<T>(url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(
      url,
      body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    );
  } catch {
    throw new Error("Can't reach the API server (npm run dev).");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data as T;
}

const when = (at: string) => {
  const d = new Date(at);
  return Number.isNaN(d.getTime())
    ? at
    : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

export default function ClipsApp() {
  const prefs = useMemo(loadPrefs, []);
  const [items, setItems] = useState<ClipItem[] | null>(null);
  const [dir, setDir] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filters, setFilters] = useState(prefs.filters);
  const [autoplay, setAutoplay] = useState(prefs.autoplay);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState(PAGE);
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const inputs = useRef(new Map<string, HTMLInputElement>());

  const load = useCallback(async () => {
    try {
      const body = await call<{ dir: string; items: ClipItem[] }>("/api/clips");
      setItems(body.items);
      setDir(body.dir);
      setError(null);
      const keys = new Set(body.items.map((i) => i.key));
      setSelected((s) => new Set([...s].filter((k) => keys.has(k))));
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => void load(), [load]);
  useEffect(() => savePrefs({ filters, autoplay }), [filters, autoplay]);
  useEffect(() => setLimit(PAGE), [filters]);

  const shown = useMemo(() => (items ? filterItems(items, filters) : []), [items, filters]);
  const visible = shown.slice(0, limit);
  const counts = useMemo(() => facetCounts(items ?? [], filters), [items, filters]);
  const setFilter = (f: Partial<ClipFilters>) => setFilters((cur) => ({ ...cur, ...f }));

  const stop = useCallback(() => {
    audio.current?.pause();
    audio.current = null;
    setPlaying(null);
  }, []);

  /** Plays the item's clips one after another (a command joined from several lines); again = stop. */
  const play = useCallback(
    (item: ClipItem, toggle = true) => {
      if (toggle && playing === item.key) return stop();
      audio.current?.pause();
      const a = new Audio();
      audio.current = a;
      const urls = item.clips.map((c) => `/api/clips/audio/${encodeURIComponent(c.id)}`);
      let i = 0;
      const done = () => {
        if (audio.current !== a) return;
        audio.current = null;
        setPlaying(null);
      };
      const next = () => {
        if (audio.current !== a) return;
        if (i >= urls.length) return done();
        a.src = urls[i++];
        a.play().catch(done);
      };
      a.onended = next;
      a.onerror = done;
      setPlaying(item.key);
      next();
    },
    [playing, stop],
  );

  const draftOf = (item: ClipItem) => drafts[item.key] ?? initialText(item);
  const revert = (key: string) =>
    setDrafts(({ [key]: _, ...rest }) => {
      void _;
      return rest;
    });

  const focusAfter = (key: string) => {
    const at = visible.findIndex((i) => i.key === key);
    const next = visible[at + 1];
    if (next) inputs.current.get(next.key)?.focus();
  };

  const saveLabel = async (item: ClipItem, advance = false) => {
    const text = draftOf(item).replace(/\s+/g, " ").trim();
    if (!text) return setError("Type what was said, or delete the clip.");
    setBusy(true);
    try {
      await call("/api/clips/labels", { labels: [{ clips: item.clips.map((c) => c.id), heard: item.heard, text }], from: "dashboard" });
      revert(item.key);
      if (advance) focusAfter(item.key);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (keys: string[]) => {
    const doomed = (items ?? []).filter((i) => keys.includes(i.key));
    if (!doomed.length) return;
    const what = doomed.length === 1 ? `"${doomed[0].text ?? doomed[0].heard}"` : `${doomed.length} clips`;
    if (!window.confirm(`Delete ${what}? The audio and its transcript are removed for good.`)) return;
    if (playing && keys.includes(playing)) stop();
    setBusy(true);
    try {
      await call("/api/clips/delete", { clips: doomed.flatMap((i) => i.clips.map((c) => c.id)) });
      setSelected((s) => new Set([...s].filter((k) => !keys.includes(k))));
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (key: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  const allShownSelected = shown.length > 0 && shown.every((i) => selected.has(i.key));

  return (
    <div className="clips">
      <header className="clips-head">
        <div>
          <h1>Voice clips</h1>
          <p className="muted">
            {items ? `${items.length} clips · ${minutes(items).toFixed(1)} min` : "Loading…"}
            {dir && <span className="dir"> · {dir}</span>}
          </p>
        </div>
        <button type="button" className="ghost" onClick={() => void load()} disabled={busy} title="Reload the list">
          <RefreshCw size={16} /> Refresh
        </button>
      </header>

      <section className="clips-filters" aria-label="Filters">
        <div className="filter-row">
          <span className="filter-label">Transcript from</span>
          <div className="chips" role="radiogroup" aria-label="Transcript source">
            {(["all", ...CLIP_SOURCES] as const).map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={filters.source === s}
                className={`chip${filters.source === s ? " on" : ""}${s !== "all" ? ` src-${s}` : ""}`}
                onClick={() => setFilter({ source: s })}
                disabled={s !== "all" && counts.sources[s] === 0 && filters.source !== s}
              >
                {s === "all" ? "All" : SOURCE_NAMES[s]} <span className="count">{counts.sources[s]}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="filter-row">
          <span className="filter-label">Review</span>
          <div className="chips" role="radiogroup" aria-label="Review state">
            {(["all", ...STATUSES] as const).map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={filters.status === s}
                className={`chip${filters.status === s ? " on" : ""}`}
                onClick={() => setFilter({ status: s })}
              >
                {s === "all" ? "All" : STATUS_NAMES[s]} <span className="count">{counts.statuses[s]}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="filter-row">
          <label className="search">
            <Search size={15} aria-hidden />
            <input
              type="search"
              placeholder="Search heard or corrected text"
              value={filters.query}
              onChange={(e) => setFilter({ query: e.target.value })}
            />
          </label>
          <label className="check">
            <input type="checkbox" checked={autoplay} onChange={(e) => setAutoplay(e.target.checked)} />
            Play a clip when its text box is focused
          </label>
        </div>
      </section>

      {error && (
        <div className="banner" role="alert">
          {error}
          <button type="button" className="ghost small" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {items && items.length === 0 && (
        <div className="empty">
          <p>No clips yet.</p>
          <p className="muted">
            Turn on Settings › Speech › Keep voice clips (Moonshine, Deepgram or AssemblyAI) and talk to the board. Each spoken line is
            saved here with its transcript.
          </p>
        </div>
      )}

      {items && items.length > 0 && (
        <>
          <div className="list-head">
            <label className="check">
              <input
                type="checkbox"
                checked={allShownSelected}
                onChange={() => setSelected(allShownSelected ? new Set() : new Set(shown.map((i) => i.key)))}
                disabled={!shown.length}
              />
              {shown.length} shown · {minutes(shown).toFixed(1)} min
            </label>
            {selected.size > 0 && (
              <div className="bulk">
                <span>{selected.size} selected</span>
                <button type="button" className="danger" disabled={busy} onClick={() => void remove([...selected])}>
                  <Trash2 size={15} /> Delete selected
                </button>
                <button type="button" className="ghost small" onClick={() => setSelected(new Set())}>
                  Clear
                </button>
              </div>
            )}
          </div>

          {shown.length === 0 && <div className="empty muted">Nothing matches these filters.</div>}

          <ul className="rows">
            {visible.map((item) => {
              const draft = draftOf(item);
              const dirty = draft.trim() !== initialText(item).trim();
              const primary = dirty ? "Save fix" : item.status === "unreviewed" ? "Heard right" : "Saved";
              return (
                <li
                  key={item.key}
                  className={`row${selected.has(item.key) ? " is-selected" : ""}${playing === item.key ? " is-playing" : ""}`}
                >
                  <input
                    type="checkbox"
                    className="pick"
                    checked={selected.has(item.key)}
                    onChange={() => toggle(item.key)}
                    aria-label="Select"
                  />
                  <button
                    type="button"
                    className="play"
                    onClick={() => play(item)}
                    aria-label={playing === item.key ? "Stop" : "Play"}
                    title={playing === item.key ? "Stop" : "Play (Ctrl+Space in the text box)"}
                  >
                    {playing === item.key ? <Pause size={16} /> : <Play size={16} />}
                  </button>
                  <div className="body">
                    <div className="meta">
                      <span className={`badge src-${item.source}`} title={item.clips[0].model}>
                        {SOURCE_NAMES[item.source]}
                      </span>
                      <span className={`status st-${item.status}`}>{STATUS_NAMES[item.status]}</span>
                      <span className="muted">{when(item.at)}</span>
                      <span className="muted">{item.seconds.toFixed(1)} s</span>
                      {item.clips.length > 1 && <span className="muted">{item.clips.length} lines joined</span>}
                    </div>
                    <div className="heard">
                      <span className="muted">Heard</span> {item.heard || <em className="muted">(nothing)</em>}
                    </div>
                    <div className="edit">
                      <input
                        ref={(el) => {
                          if (el) inputs.current.set(item.key, el);
                          else inputs.current.delete(item.key);
                        }}
                        value={draft}
                        aria-label="What was said"
                        className={dirty ? "dirty" : ""}
                        onChange={(e) => setDrafts((d) => ({ ...d, [item.key]: e.target.value }))}
                        onFocus={() => autoplay && playing !== item.key && play(item, false)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            if (dirty || item.status === "unreviewed") void saveLabel(item, true);
                            else focusAfter(item.key);
                          } else if (e.key === "Escape") revert(item.key);
                          else if (e.key === " " && e.ctrlKey) {
                            e.preventDefault();
                            play(item);
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="primary"
                        disabled={busy || primary === "Saved"}
                        onClick={() => void saveLabel(item)}
                        title={dirty ? "Save this as what was said" : "The transcript is right: label it as is"}
                      >
                        {primary}
                      </button>
                      {dirty && (
                        <button
                          type="button"
                          className="ghost icon"
                          onClick={() => revert(item.key)}
                          title="Undo the edit (Esc)"
                          aria-label="Undo the edit"
                        >
                          <RotateCcw size={15} />
                        </button>
                      )}
                      <button
                        type="button"
                        className="ghost icon danger-text"
                        disabled={busy}
                        onClick={() => void remove([item.key])}
                        title="Delete the clip"
                        aria-label="Delete the clip"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>

          {shown.length > visible.length && (
            <button type="button" className="ghost more" onClick={() => setLimit((n) => n + PAGE)}>
              Show {Math.min(PAGE, shown.length - visible.length)} more
            </button>
          )}
        </>
      )}

      <footer className="clips-foot muted">
        <p>Enter saves and moves to the next clip, Esc undoes an edit, Ctrl+Space plays.</p>
        <details className="guide" open>
          <summary>Building the training set</summary>
          <p>
            <code>stt/build_manifest.py</code> turns these clips into <code>train.jsonl</code> and <code>eval.jsonl</code> for Moonshine's
            LoRA fine-tuning. <b>Corrected</b> clips (fixed or marked heard right) use your text. <b>Unreviewed</b> clips use the text the
            recogniser heard, so any mistakes in them are learned too.
          </p>
          <table>
            <tbody>
              <tr>
                <td>
                  <code>python stt/build_manifest.py</code>
                </td>
                <td>Corrected clips only.</td>
              </tr>
              <tr>
                <td>
                  <code>--heard</code>
                </td>
                <td>Corrected clips plus every unreviewed clip, with its heard text.</td>
              </tr>
              <tr>
                <td>
                  <code>--heard-source deepgram,assemblyai</code>
                </td>
                <td>
                  Corrected clips from every source, plus unreviewed clips only from these sources. Recommended: the cloud transcripts are
                  usually right, and Moonshine's own unchecked guesses are left out.
                </td>
              </tr>
              <tr>
                <td>
                  <code>--source moonshine,…</code>
                </td>
                <td>Only clips from these sources, corrected or not.</td>
              </tr>
              <tr>
                <td>
                  <code>--eval-frac 0.2</code>
                </td>
                <td>
                  Share of corrected clips held out in <code>eval.jsonl</code> to measure the result (default 0.2). Unreviewed clips never
                  go there. <code>0</code> trains on all of them but leaves nothing to measure with.
                </td>
              </tr>
            </tbody>
          </table>
          <p>
            Then train with{" "}
            <code>python -m moonshine_voice.lora --train-manifest stt/clips/train.jsonl --eval-manifest stt/clips/eval.jsonl</code> (needs{" "}
            <code>moonshine-voice[finetune]</code>; the full command is in the script's docstring).
          </p>
        </details>
      </footer>
    </div>
  );
}
