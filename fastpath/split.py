"""
Conjunction splitting for the fast path: "draw an apple and a mango" -> "draw an apple", "draw a mango".

`split_command` cuts a command at "and", "then", "also", "after that", commas and semicolons into at most
`MAX_PARTS` clauses that can each be decided on their own (fastpath/server.py runs every clause through the rules,
then Laya, and only answers "fast" when all of them are fast). A clause without a verb takes the previous clause's
("make the box red and the circle blue" -> "make the circle blue").

It errs towards not splitting (None): an "and" that belongs to the command ("connect A and B", "between X and Y",
"a note saying salt and pepper", "draw a bow and arrow"), a self-correction ("red, no wait, blue"), quotes, a
measurement, or a later clause that points back with a pronoun ("draw a box and make it red": every clause is
decided against the board as it was, so "it" can't mean the new box). A wrong split costs nothing more than the
cloud call the command would have made anyway, as long as no clause is wrongly fast on its own.
"""

from __future__ import annotations

import re

from fastpath.decide import CASUAL_VERBS, COLORS, OBJECT_PREFIX, OBJECT_VERBS, OBJECT_WORDS, has_measurement, words
from fastpath.rules import (
    ADD_VERBS,
    CLEAR_VERBS,
    CONNECT_VERBS,
    CORRECTION_MARKERS,
    DIRECTION_WORDS,
    FILLERS,
    LABEL_MARKERS,
    MOVE_VERBS,
    RECOLOR_VERBS,
    RESIZE_VERBS,
    SCROLL_VERBS,
    SIZE_WORDS,
    TEXT_VERBS,
)

MAX_PARTS = 3
PUNCTUATION = {",", ";"}
SEPARATORS = PUNCTUATION | {"and", "then", "also"}
# Words a clause may start with. Loose edit verbs are for Laya ("increase zoom", "reduce the square").
VERBS = (
    ADD_VERBS | TEXT_VERBS | RECOLOR_VERBS | RESIZE_VERBS | MOVE_VERBS | CONNECT_VERBS | SCROLL_VERBS | CLEAR_VERBS
    | OBJECT_VERBS | CASUAL_VERBS
    | {"delete", "remove", "drop", "scrap", "undo", "revert", "rename", "relabel", "label", "zoom", "go", "jump", "take",
       "focus", "show", "increase", "decrease", "reduce", "enlarge", "shrink", "grow", "expand", "change", "write", "fit"}
)  # fmt: skip
# After these, "and" (or a comma) is part of the clause: two ends, a label's text, or new text.
JOINING_WORDS = CONNECT_VERBS | {"between", "from", "rename", "relabel", "write"} | {w for m in LABEL_MARKERS for w in m.split()[-1:]}
ARTICLES = {"the", "a", "an", "to", "of"}
PRONOUNS = {"it", "its", "this", "that", "them", "they", "these", "those"}
# Words that only fill a clause: "ok, draw a tree" and "draw a tree, please" are one clause each.
FILLER_WORDS = OBJECT_PREFIX | FILLERS | {"okay", "please", "thanks", "thank", "for", "me", "now", "then", "next", "oh"}
# Words that say nothing about which element an inherited verb applies to ("make the box big and red" -> "make red").
VALUE_WORDS = (
    set(COLORS) | {"grey"} | set(SIZE_WORDS) | set(DIRECTION_WORDS) | FILLER_WORDS
    | {"the", "a", "an", "one", "another", "bigger", "smaller", "larger", "more", "less", "little", "bit", "lot", "too"}
)  # fmt: skip
# Catalog names with "and" in them ("fork and knife"): never cut there.
AND_NAMES = [n.split() for n in OBJECT_WORDS if " and " in n]
TOKEN = re.compile(r"[a-z0-9']+|[,;\"“”]", re.I)


def split_command(text: str, scene: dict | None = None) -> list[str] | None:
    """The command's clauses (2..MAX_PARTS, verbs filled in), or None when it isn't a plain list of commands.

    Labels on the board with "and" in them ("salt and pepper") are never cut, like catalog names.
    """
    if has_measurement(text) or re.search(r"[\"“”]", text):
        return None
    labels = [words(el.get("label") or "") for el in (scene or {}).get("elements", [])]
    names = AND_NAMES + [label for label in labels if "and" in label]
    toks = [(m[0].lower().replace("'", ""), m.start(), m.end()) for m in TOKEN.finditer(text)]
    w = [t[0] for t in toks]
    if CORRECTION_MARKERS & set(w):  # "make it blue, sorry, I mean purple": the rules strip it, or the model reads it
        return None

    # Runs of separator tokens (", and then") are one cut; "after that" counts as one too.
    cuts: list[tuple[int, int]] = []  # (first separator index, index after the run)
    i = 0
    while i < len(w):
        j = i
        while j < len(w) and (w[j] in SEPARATORS or w[j : j + 2] == ["after", "that"]):
            j += 2 if w[j] == "after" else 1
        if j > i:
            cuts.append((i, j))
            i = j
        else:
            i += 1

    pieces: list[tuple[int, int]] = []  # word spans of the clauses
    start = 0
    for a, b in cuts:
        before, after = [x for x in w[start:a] if x not in PUNCTUATION], [x for x in w[b:] if x not in PUNCTUATION]
        if keep_together(w, a, b, before, after, names):
            continue
        pieces.append((start, a))
        start = b
    pieces.append((start, len(w)))
    pieces = [(s, e) for s, e in pieces if s < e]
    if not 2 <= len(pieces) <= MAX_PARTS:
        return None

    out: list[str] = []
    verb: str | None = None
    for n, (s, e) in enumerate(pieces):
        idx = [x for x in range(s, e) if w[x] not in PUNCTUATION]  # a kept comma ("ok, draw") is not a word
        said = [w[x] for x in idx]
        if n and PRONOUNS & set(said):
            return None
        k = 0
        while k < len(said) and said[k] in FILLER_WORDS and said[k] not in VERBS:
            k += 1
        if k < len(said) and said[k] in VERBS:
            verb = "get rid of" if said[k : k + 3] == ["get", "rid", "of"] else said[k]
            out.append(text[toks[s][1] : toks[e - 1][2]].strip(" ,;"))
        elif verb and k < len(said) and set(said) - VALUE_WORDS:  # "and a mango" -> "draw a mango"; not "and red"
            out.append(f"{verb} {text[toks[idx[k]][1] : toks[e - 1][2]].strip(' ,;')}")
        else:
            return None
    return out


def keep_together(w: list[str], a: int, b: int, before: list[str], after: list[str], names: list[list[str]]) -> bool:
    """True when the separators w[a:b] belong to the clause instead of ending it."""
    if not before or not after:  # leading/trailing comma
        return True
    if all(x in FILLER_WORDS for x in before) or all(x in FILLER_WORDS for x in after):  # "ok, draw ..." / "..., please"
        return True
    if before[-1] in ARTICLES or after[0] == before[-1]:  # "delete the, the cache": a stutter, not a new clause
        return True
    if "and" in w[a:b] or "," in w[a:b]:
        if JOINING_WORDS & set(before):  # "connect A and B", "a note saying salt and pepper"
            return True
        for name in names:  # "draw a fork and knife", "make the salt and pepper box red"
            at = a - name.index("and")
            if at >= 0 and w[at : at + len(name)] == name:
                return True
    return False
