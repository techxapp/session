import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_CAPTURED,
  MAX_RULES,
  addCaptured,
  addRule,
  applyCorrections,
  correctLine,
  deriveRule,
  loadCorrections,
  removeEntry,
  ruleKeyterms,
  withDefaultVerb,
  type Correction,
  type CorrectionStore,
} from "./corrections";

const rule = (find: string, replace: string, id = find): Correction => ({ id, find, replace });
const empty: CorrectionStore = { rules: [], captured: [] };

describe("deriveRule", () => {
  it("keeps one word of left context around the change", () => {
    expect(deriveRule("set june 250%", "set zoom 250%")).toEqual({ find: "set june", replace: "set zoom" });
  });

  it("uses no right context for a change at the start", () => {
    expect(deriveRule("june 250%", "zoom 250%")).toEqual({ find: "june", replace: "zoom" });
  });

  it("handles a change at the end and a multi-word change", () => {
    expect(deriveRule("add a blue print", "add a blueprint")).toEqual({ find: "a blue print", replace: "a blueprint" });
    expect(deriveRule("connect post grass to api", "connect Postgres to api")).toEqual({
      find: "connect post grass",
      replace: "connect Postgres",
    });
  });

  it("anchors an insertion or deletion at the start on the next word", () => {
    expect(deriveRule("apple and mango", "draw apple and mango")).toEqual({ find: "apple", replace: "draw apple" });
    expect(deriveRule("uh draw a box", "draw a box")).toEqual({ find: "uh draw", replace: "draw" });
  });

  it("ignores case and punctuation, and returns nothing for the same text", () => {
    expect(deriveRule("Draw a box.", "draw a box")).toBeUndefined();
    expect(deriveRule("", "")).toBeUndefined();
  });
});

describe("applyCorrections", () => {
  const rules = [rule("set june", "set zoom")];

  it("replaces only the segment and keeps the rest as spoken", () => {
    expect(applyCorrections("set june 250%", rules)).toBe("set zoom 250%");
    expect(applyCorrections("Set June 80%", rules)).toBe("set zoom 80%");
    expect(applyCorrections("please set june to 50%.", rules)).toBe("please set zoom to 50%.");
  });

  it("matches whole words only", () => {
    expect(applyCorrections("set junebug", rules)).toBe("set junebug");
    expect(applyCorrections("reset june", rules)).toBe("reset june");
  });

  it("keeps the trailing punctuation of the replaced words", () => {
    expect(applyCorrections("set june, then zoom", rules)).toBe("set zoom, then zoom");
  });

  it("applies the longest rule first and each rule once (no loops)", () => {
    const r = [rule("blue", "green"), rule("blue print", "blueprint"), rule("green", "blue")];
    expect(applyCorrections("draw a blue print", r)).toBe("draw a blueprint");
    expect(applyCorrections("make it blue", [rule("blue", "blue blue")])).toBe("make it blue blue");
  });

  it("leaves text that already has an insertion rule's words", () => {
    const r = [rule("apple", "draw apple")];
    expect(applyCorrections("apple and mango", r)).toBe("draw apple and mango");
    expect(applyCorrections("draw apple and mango", r)).toBe("draw apple and mango");
  });
});

describe("withDefaultVerb", () => {
  it.each([
    ["apple and mango", "draw apple and mango"],
    ["a red box", "draw a red box"],
    ["three trees", "draw three trees"],
    ["a mind map", "draw a mind map"],
  ])("%s -> %s", (input, out) => expect(withDefaultVerb(input)).toBe(out));

  it.each(["move the box left", "zoom in", "what is this", "thanks", "okay", "is it done", "a box?", "250%", ""])(
    "leaves %j alone",
    (input) => expect(withDefaultVerb(input)).toBe(input),
  );

  it("leaves long lines alone", () => {
    const long = "one two three four five six seven eight nine";
    expect(withDefaultVerb(long)).toBe(long);
  });
});

describe("correctLine", () => {
  it("runs the rules, then the default verb (when on)", () => {
    const r = [rule("aple", "apple")];
    expect(correctLine("aple and mango", r, true)).toBe("draw apple and mango");
    expect(correctLine("aple and mango", r, false)).toBe("apple and mango");
  });
});

describe("store", () => {
  it("dedupes rules by find (newest wins) and removes the captured entry it fixes", () => {
    let s = addCaptured(empty, "set june 250%");
    const capturedId = s.captured[0].id;
    s = addRule(s, { find: "Set June", replace: "set zoom" });
    s = addRule(s, { find: "set june", replace: "set zoom level" }, capturedId);
    expect(s.rules.map((r) => [r.find, r.replace])).toEqual([["set june", "set zoom level"]]);
    expect(s.captured).toEqual([]);
  });

  it("replaces the rule it was edited from, even with a new find", () => {
    const s = addRule(empty, { find: "set june", replace: "set zoom" });
    const edited = addRule(s, { find: "june", replace: "zoom" }, s.rules[0].id);
    expect(edited.rules.map((r) => r.find)).toEqual(["june"]);
  });

  it("skips empty and no-op rules and duplicate captures", () => {
    expect(addRule(empty, { find: " ", replace: "x" })).toBe(empty);
    expect(addRule(empty, { find: "Box", replace: "box" })).toBe(empty);
    const s = addCaptured(addCaptured(empty, "hello there"), "Hello, there.");
    expect(s.captured).toHaveLength(1);
  });

  it("caps rules and captured entries, keeping the newest", () => {
    let s = empty;
    for (let i = 0; i < MAX_RULES + 5; i++) s = addRule(s, { find: `w${i}`, replace: `x${i}` });
    for (let i = 0; i < MAX_CAPTURED + 5; i++) s = addCaptured(s, `line ${i}`);
    expect(s.rules).toHaveLength(MAX_RULES);
    expect(s.rules.at(-1)?.find).toBe(`w${MAX_RULES + 4}`);
    expect(s.captured).toHaveLength(MAX_CAPTURED);
  });

  it("removes a rule or a captured entry by id", () => {
    const s = addCaptured(addRule(empty, { find: "a", replace: "b" }), "c");
    const r = removeEntry(removeEntry(s, s.rules[0].id), s.captured[0].id);
    expect(r).toEqual(empty);
  });

  afterEach(() => vi.restoreAllMocks());

  it("loads an empty store when storage throws or holds junk", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(loadCorrections()).toEqual(empty);
    vi.restoreAllMocks();
    vi.spyOn(Storage.prototype, "getItem").mockReturnValue("{not json");
    expect(loadCorrections()).toEqual(empty);
  });
});

describe("ruleKeyterms", () => {
  it("lists the new words rules teach, not the ones they keep", () => {
    expect(ruleKeyterms([rule("set june", "set zoom"), rule("post grass", "Postgres")])).toEqual(["zoom", "Postgres"]);
  });
});
