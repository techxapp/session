import { describe, expect, it } from "vitest";
import { ALL_OBJECT_NAMES } from "@board/shared";
import { matchObject, objectModeFromEnv, parseToolCall } from "./objects";

/**
 * Words a model might write in OBJECT_MODE=text, with the picture they should get.
 * null = no picture fits well, so a labelled box is drawn. A wrong picture is worse than a box.
 */
const CASES: Record<string, string | null> = {
  // catalog names and aliases
  dog: "dog",
  puppy: "dog",
  "old woman": "old woman",
  kid: "child",
  laptop: "laptop",
  "light bulb": "light bulb",
  // the rest of the library: a variety with its own picture beats the curated alias of its category
  rose: "rose",
  "palm tree": "palm tree",
  sailboat: "sailboat",
  rooster: "rooster",
  kangaroo: "kangaroo",
  "t-rex": "t rex",
  "1st place medal": "1st place medal",
  tulip: "tulip",
  // a curated alias where the library has no picture of its own
  "pine tree": "tree",
  // case, articles, punctuation
  Dog: "dog",
  "a dog": "dog",
  "the house!": "house",
  "teddy-bear": "teddy bear",
  "an apple": "apple",
  // plurals
  dogs: "dog",
  trees: "tree",
  puppies: "dog",
  bushes: null,
  // head noun of a longer phrase
  "red sports car": "car",
  "big brown dog": "dog",
  "rain cloud": "cloud",
  "apple pie": "pie",
  "american flag": "flag",
  "dog house": "house",
  "wooden chair": "chair",
  "little girl": "girl",
  "computer mouse": "computer mouse",
  mouse: "mouse",
  // misspellings (one letter, unique)
  giraffee: "giraffe",
  dolphine: "dolphin",
  elefant: null, // two edits
  hourse: null, // horse or house: ambiguous
  // not in the catalog: a box beats a wrong picture
  // Known miss: a compound's head can be another sense ("cricket bat" -> the animal bat).
  skyscraper: null,
  server: null,
  database: null,
  queue: null,
  "load balancer": null,
  user: null,
  "pizza slice": null,
  "": null,
  "!!!": null,
};

describe("matchObject", () => {
  for (const [word, expected] of Object.entries(CASES)) {
    it(`${JSON.stringify(word)} -> ${expected ?? "box"}`, () => {
      expect(matchObject(word) ?? null).toBe(expected);
    });
  }

  it("matches every curated and library name to itself", () => {
    for (const name of ALL_OBJECT_NAMES) expect(matchObject(name)).toBe(name);
  });
});

describe("parseToolCall", () => {
  it("maps a free-text object to the catalog in text mode", () => {
    const parsed = parseToolCall("add_object", { id: "pup", object: "a puppy", size: "small" }, "text");
    expect(parsed).toEqual({ ok: true, action: { name: "add_object", input: { id: "pup", object: "dog", size: "small" } } });
  });

  it("reaches library pictures the enum mode can't name", () => {
    expect(parseToolCall("add_object", { object: "kangaroo" }, "text")).toEqual({
      ok: true,
      action: { name: "add_object", input: { object: "kangaroo" } },
    });
  });

  it("draws a labelled box when nothing fits, keeping id, size and placement", () => {
    const input = { id: "tower", object: "skyscraper", size: "large", placement: { region: "top" } };
    expect(parseToolCall("add_object", input, "text")).toEqual({
      ok: true,
      action: {
        name: "add_shape",
        input: { id: "tower", kind: "rectangle", label: "skyscraper", size: "large", placement: { region: "top" } },
      },
    });
  });

  it("leaves enum mode and other actions to parseAction", () => {
    expect(parseToolCall("add_object", { object: "puppy" }, "enum").ok).toBe(false);
    expect(parseToolCall("add_object", { object: "dog" }, "enum").ok).toBe(true);
    expect(parseToolCall("add_shape", { kind: "rectangle" }, "text").ok).toBe(true);
    expect(parseToolCall("add_object", { object: "" }, "text").ok).toBe(false);
  });
});

describe("objectModeFromEnv", () => {
  it("defaults to enum and rejects unknown values", () => {
    expect(objectModeFromEnv({})).toBe("enum");
    expect(objectModeFromEnv({ OBJECT_MODE: " Text " })).toBe("text");
    expect(() => objectModeFromEnv({ OBJECT_MODE: "fuzzy" })).toThrow(/OBJECT_MODE/);
  });
});
