import {
  ALL_OBJECT_NAMES,
  AddObjectText,
  OBJECT_CATALOG,
  OBJECT_NAMES,
  parseAction,
  type BoardAction,
  type ObjectMode,
} from "@board/shared";

/**
 * How add_object names its picture (OBJECT_MODE; type in shared/protocol.ts so the UI settings can set it):
 * - "enum": the tool lists every curated catalog name (~3k characters of the tool prefix); the model picks one.
 * - "text": the model writes a plain noun and matchObject maps it to the curated catalog or the rest of the
 *   icon library (~1.6k pictures) here, or the call becomes a labelled box. The prompt doesn't grow with the catalog.
 */
export type { ObjectMode };
export const DEFAULT_OBJECT_MODE: ObjectMode = "enum";

export function objectModeFromEnv(env: NodeJS.ProcessEnv = process.env): ObjectMode {
  const v = env.OBJECT_MODE?.trim().toLowerCase();
  if (!v) return DEFAULT_OBJECT_MODE;
  if (v !== "enum" && v !== "text") throw new Error(`OBJECT_MODE must be "enum" or "text" (got "${env.OBJECT_MODE}")`);
  return v;
}

/**
 * Every object name -> itself, then every curated alias -> its object. A name beats an alias, so with the
 * whole library "rose" is the rose picture, not the curated "flower" it is an alias of in enum mode.
 */
const WORDS = new Map<string, string>();
for (const name of ALL_OBJECT_NAMES) WORDS.set(name, name);
for (const name of OBJECT_NAMES) {
  for (const w of OBJECT_CATALOG[name].aliases) if (!WORDS.has(w)) WORDS.set(w, name);
}
/** Single-word entries long enough to match a misspelling against. */
const FUZZY = [...WORDS.keys()].filter((w) => !w.includes(" ") && w.length >= 5);

const clean = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function exactOrSingular(phrase: string): string | undefined {
  const forms = [phrase, phrase.replace(/ies$/, "y"), phrase.replace(/es$/, ""), phrase.replace(/s$/, "")];
  for (const f of forms) {
    const hit = WORDS.get(f);
    if (hit) return hit;
  }
}

function editDistanceAtMost1(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/**
 * Map a free-text object word to an object name (curated or library), or undefined when nothing fits well.
 * Tries the whole phrase, then shorter tails ("red sports car" -> "sports car" -> "car", the head noun
 * of an English noun phrase), each also singularised; then a unique one-letter misspelling of a single word.
 * A weak match is worse than a labelled box, so ambiguous misspellings give undefined.
 */
export function matchObject(text: string): string | undefined {
  const phrase = clean(text);
  const exact = WORDS.get(phrase); // before dropping articles: "a button blood type" is a name
  if (exact) return exact;
  const words = phrase
    .replace(/^(a|an|the|some|one) /, "")
    .split(" ")
    .filter(Boolean);
  for (let start = 0; start < words.length; start++) {
    const hit = exactOrSingular(words.slice(start).join(" "));
    if (hit) return hit;
  }
  if (words.length !== 1 || words[0].length < 5) return undefined;
  const close = new Set(FUZZY.filter((w) => editDistanceAtMost1(words[0], w)).map((w) => WORDS.get(w)!));
  return close.size === 1 ? [...close][0] : undefined;
}

/** Catalog words that are usually board vocabulary in a command, not a picture ("a box labelled X", "scroll down"). */
const NOT_OBJECTS = new Set([
  "label",
  "labels",
  "link",
  "links",
  "chart",
  "charts",
  "map",
  "maps",
  "question",
  "questions",
  "scroll",
  "scrolls",
  "camera",
  "symbol",
  "sign",
]);
/** Words after "draw a ..." that are board shapes or text, not pictures. */
const BOARD_NOUNS =
  /^(box|boxe|square|rectangle|rect|circle|ellipse|oval|diamond|shape|sticky|note|card|text|title|heading|caption|label|arrow|line|connector|node|diagram|flowchart|chart|graph|plot|table|list|bullet|measurement|dimension|step|stage|item|row|column)s?$/;
const ADD_A =
  /\b(draw|add|put|place|sketch|insert|create)\b( me)? (a|an|another|one|some|two|three|four|five|\d+) (((small|big|large|medium|tiny|huge|little|new|[a-z]+ish)|black|gray|grey|red|orange|yellow|green|teal|blue|purple|pink) )*([a-z]+)/;

/**
 * Does a command seem to ask for a picture? For the tool router: any 1-3 word phrase (singular or plural) that
 * names a catalog object or alias, "picture/icon/emoji of", or "draw a <noun>" where the noun isn't a board shape.
 * Errs towards yes; a wrong yes only adds the add_object tool to the request.
 */
export function mentionsObject(text: string): boolean {
  // A label's words aren't a picture request: "a box labelled payments", "rename it to tree house".
  const t = clean(text)
    .replace(/\b(labell?ed|called|named|saying|says|titled|with the text)\b.*$/, "")
    .replace(/^(rename|relabel|retitle)\b(.*?)\bto\b.*$/, "$1$2");
  if (/\b(picture|pictures|icon|icons|emoji|emojis|image|images|clip ?art|drawing of)\b/.test(t)) return true;
  const w = t.split(" ").filter(Boolean);
  for (let n = 3; n >= 1; n--) {
    for (let i = 0; i + n <= w.length; i++) {
      const phrase = w.slice(i, i + n).join(" ");
      if (n === 1 && (phrase.length < 3 || NOT_OBJECTS.has(phrase))) continue;
      if (exactOrSingular(phrase)) return true;
    }
  }
  const noun = ADD_A.exec(t)?.[7];
  return Boolean(noun && !BOARD_NOUNS.test(noun));
}

/**
 * Validate a tool call. In "text" mode a free-text add_object is mapped to the catalog, or turned into
 * an add_shape box labelled with the word, so the user still gets something on the board.
 */
export function parseToolCall(name: string, input: unknown, mode: ObjectMode) {
  if (mode !== "text" || name !== "add_object") return parseAction(name, input);
  const raw = AddObjectText.safeParse(input);
  if (!raw.success) return parseAction(name, input);
  const { object, ...rest } = raw.data;
  const match = matchObject(object);
  if (match) return parseAction(name, { ...rest, object: match });
  const box: Extract<BoardAction, { name: "add_shape" }>["input"] = { ...rest, kind: "rectangle", label: object.trim() };
  return parseAction("add_shape", box);
}
