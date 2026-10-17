import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Learned fixes for misheard voice lines. A rule replaces one segment of a line ("set june" -> "set zoom") and
 * keeps the rest as spoken ("set june 250%" -> "set zoom 250%"). Voice lines only; typed commands are never rewritten.
 */
export interface Correction {
  id: string;
  /** Words to look for (whole words, any case). */
  find: string;
  /** What they become. */
  replace: string;
}

/** A command that changed nothing (or one the user stored), waiting for a fix. */
export interface Captured {
  id: string;
  text: string;
}

export interface CorrectionStore {
  rules: Correction[];
  captured: Captured[];
}

const STORAGE_KEY = "voice-board:corrections:v1";
export const MAX_RULES = 100;
export const MAX_CAPTURED = 50;

/** Verbs that make a line a command already; a short line with none of these is taken as things to draw. */
export const COMMAND_VERBS = new Set(
  `add draw put place create insert make sketch write label rename relabel
   delete remove erase drop scrap clear wipe reset undo revert redo
   move nudge shift push drag slide bump bring send
   connect link join
   color colour paint turn change set resize enlarge shrink grow expand increase decrease reduce raise lower
   scroll pan zoom go jump take focus show fit center centre
   plot animate walk run fly drive chase
   grab get have want need replace swap`
    .split(/\s+/)
    .filter(Boolean),
);
/** Words that mark chatter or a question rather than a list of things: "what is this", "thanks", "I think so". */
const NOT_THINGS = new Set(
  `what how why when where who which can could would should will shall is are was were do does did am
   i i'm im me my we us our you your he she they it them these those
   yes yeah yep no nope ok okay thanks thank hello hi hey bye sorry please wait stop hmm um uh oh`
    .split(/\s+/)
    .filter(Boolean),
);
const MAX_DRAW_WORDS = 8;

/** Lowercase word without surrounding punctuation ("June," -> "june"); "%" and digits stay ("250%"). */
export const cleanWord = (w: string) => w.toLowerCase().replace(/^[^\p{L}\p{N}%]+|[^\p{L}\p{N}%']+$/gu, "");
const words = (text: string) => text.trim().split(/\s+/).filter(Boolean);
const cleanWords = (text: string) => words(text).map(cleanWord).filter(Boolean);

/**
 * The rule that turns `heard` into `meant`: the words that differ, widened by one neighbouring word as context
 * (left; right only for an insertion or deletion at the start). "set june 250%" / "set zoom 250%" -> "set june" -> "set zoom". Undefined if they don't differ.
 */
export function deriveRule(heard: string, meant: string): Omit<Correction, "id"> | undefined {
  const h = cleanWords(heard);
  const mRaw = words(meant).filter((w) => cleanWord(w));
  const m = mRaw.map(cleanWord);
  let pre = 0;
  while (pre < h.length && pre < m.length && h[pre] === m[pre]) pre++;
  let suf = 0;
  while (suf < h.length - pre && suf < m.length - pre && h[h.length - 1 - suf] === m[m.length - 1 - suf]) suf++;
  if (pre === h.length && pre === m.length) return undefined;
  let from = pre;
  let hEnd = h.length - suf;
  let mEnd = m.length - suf;
  // Left context always; right context only when one side is empty (an insertion or deletion needs an anchor).
  if (pre > 0) from--;
  else if (suf > 0 && (hEnd === from || mEnd === from)) {
    hEnd++;
    mEnd++;
  }
  const find = h.slice(from, hEnd).join(" ");
  const replace = mRaw
    .slice(from, mEnd)
    .map((w) => w.replace(/^[^\p{L}\p{N}%]+|[^\p{L}\p{N}%']+$/gu, ""))
    .join(" ");
  return find ? { find, replace } : undefined;
}

/**
 * Apply each rule once, longest `find` first, to every whole-word match (any case); the line's other words are kept.
 * A match already inside its own replacement is skipped, so "apple" -> "draw apple" leaves "draw apple" alone.
 */
export function applyCorrections(text: string, rules: readonly Correction[]): string {
  let toks = words(text);
  const sorted = [...rules].sort((a, b) => cleanWords(b.find).length - cleanWords(a.find).length);
  for (const rule of sorted) {
    const find = cleanWords(rule.find);
    const repl = words(rule.replace);
    const replClean = repl.map(cleanWord);
    if (!find.length || find.join(" ") === replClean.join(" ")) continue;
    // Where `find` sits inside `replace`, if it does: lets an insertion rule spot text that already has it.
    const at = indexOf(replClean, find);
    const out: string[] = [];
    let i = 0;
    while (i < toks.length) {
      const clean = toks.slice(i, i + find.length).map(cleanWord);
      const hit = clean.length === find.length && clean.every((w, k) => w === find[k]);
      const done = hit && at >= 0 && equalAt(toks.map(cleanWord), i - at, replClean);
      if (hit && !done) {
        const tail = trailingPunct(toks[i + find.length - 1]);
        out.push(...repl.slice(0, -1), (repl.at(-1) ?? "") + tail);
        i += find.length;
      } else out.push(toks[i++]);
    }
    toks = out.filter(Boolean);
  }
  return toks.join(" ");
}

const trailingPunct = (w: string) => /[.,!?;:]+$/.exec(w)?.[0] ?? "";
function indexOf(hay: string[], needle: string[]) {
  for (let i = 0; i + needle.length <= hay.length; i++) if (needle.every((w, k) => hay[i + k] === w)) return i;
  return -1;
}
const equalAt = (toks: string[], start: number, seq: string[]) =>
  start >= 0 && start + seq.length <= toks.length && seq.every((w, k) => toks[start + k] === w);

/** "apple and mango" -> "draw apple and mango": a short line with no command verb and no chatter words names things to draw. */
export function withDefaultVerb(text: string): string {
  const t = text.trim();
  if (!t || t.endsWith("?")) return text;
  const ws = cleanWords(t);
  if (!ws.length || ws.length > MAX_DRAW_WORDS) return text;
  if (ws.some((w) => COMMAND_VERBS.has(w) || NOT_THINGS.has(w))) return text;
  if (!ws.some((w) => /\p{L}/u.test(w))) return text;
  return `draw ${t}`;
}

/** What a spoken line runs as: the stored rules, then (if on) the default "draw". */
export function correctLine(text: string, rules: readonly Correction[], defaultDraw: boolean): string {
  const fixed = applyCorrections(text, rules);
  return defaultDraw ? withDefaultVerb(fixed) : fixed;
}

/** New words a rule teaches, for the recogniser's key terms: replace words that aren't in find. */
export function ruleKeyterms(rules: readonly Correction[], max = 10): string[] {
  const out = new Map<string, string>();
  for (const r of rules) {
    const found = new Set(cleanWords(r.find));
    for (const w of words(r.replace)) {
      const c = cleanWord(w);
      if (c && !found.has(c) && !out.has(c)) out.set(c, w.replace(/[^\p{L}\p{N}%' -]/gu, ""));
    }
  }
  return [...out.values()].slice(-max);
}

/** Comparison key for a line or a rule's find: clean words joined by spaces. */
export const normLine = (text: string) => cleanWords(text).join(" ");
const norm = normLine;

/** Add a rule (replacing one with the same find). `fromId` = the captured line it fixes or the rule it was edited from. */
export function addRule(store: CorrectionStore, rule: Omit<Correction, "id">, fromId?: string): CorrectionStore {
  const find = norm(rule.find);
  const replace = rule.replace.trim().replace(/\s+/g, " ");
  if (!find || find === norm(replace)) return store;
  const base = fromId ? removeEntry(store, fromId) : store;
  const rules = [...base.rules.filter((r) => norm(r.find) !== find), { id: newId(), find, replace }].slice(-MAX_RULES);
  return { rules, captured: base.captured };
}

export function addCaptured(store: CorrectionStore, text: string): CorrectionStore {
  const key = norm(text);
  if (!key || store.captured.some((c) => norm(c.text) === key)) return store;
  return { ...store, captured: [...store.captured, { id: newId(), text: text.trim() }].slice(-MAX_CAPTURED) };
}

export const removeEntry = (store: CorrectionStore, id: string): CorrectionStore => ({
  rules: store.rules.filter((r) => r.id !== id),
  captured: store.captured.filter((c) => c.id !== id),
});

const newId = () => Math.random().toString(36).slice(2, 10);

export function loadCorrections(): CorrectionStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const saved = raw ? JSON.parse(raw) : null;
    return {
      rules: Array.isArray(saved?.rules) ? saved.rules : [],
      captured: Array.isArray(saved?.captured) ? saved.captured : [],
    };
  } catch {
    return { rules: [], captured: [] };
  }
}

function saveCorrections(store: CorrectionStore) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* storage unavailable: corrections last for this page only */
  }
}

/** The correction store plus a stable `apply` for the voice path (reads a ref, so callers needn't re-create). */
export function useCorrections() {
  const [store, setStore] = useState<CorrectionStore>(loadCorrections);
  const ref = useRef(store);
  ref.current = store;
  useEffect(() => saveCorrections(store), [store]);

  const capture = useCallback((text: string) => setStore((s) => addCaptured(s, text)), []);
  const saveRule = useCallback(
    (find: string, replace: string, fromId?: string) => setStore((s) => addRule(s, { find, replace }, fromId)),
    [],
  );
  const remove = useCallback((id: string) => setStore((s) => removeEntry(s, id)), []);
  const apply = useCallback((text: string, defaultDraw: boolean) => correctLine(text, ref.current.rules, defaultDraw), []);
  const keyterms = useCallback(() => ruleKeyterms(ref.current.rules), []);

  return useMemo(
    () => ({ rules: store.rules, captured: store.captured, capture, saveRule, remove, apply, keyterms }),
    [store, capture, saveRule, remove, apply, keyterms],
  );
}

export type Corrections = ReturnType<typeof useCorrections>;
