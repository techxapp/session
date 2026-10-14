"""
Rule tier of the fast path: commands that follow a small closed grammar, answered in code with no model.

Strict grammar: after dropping fillers ("um"), stutters ("the, the"), politeness ("can you", "please") and
self-corrections ("red, no wait, blue"), every word must be explained by one template: its verb, an element
reference, a value, or a filler that template allows. A leftover word, a second clause, or a reference that
doesn't resolve to exactly one element (or a clean group) returns None, and the command goes to Laya, then to
the LLM. Rules never drop a command as chatter; only Laya does that.

`rule_command` is called by the sidecar (fastpath/server.py) before Laya and by eval/rules_eval.py.
"""

from __future__ import annotations

import re

from fastpath.decide import (
    COLORS,
    EVERYTHING_WORDS,
    KIND_WORDS,
    PLURAL_KIND_WORDS,
    QUANTIFIERS,
    SECOND_CLAUSE,
    SEVERAL,
    has_measurement,
    measure_command,
    object_command,
    resolve_target,
    route_object,
    words,
)

FILLERS = {"uh", "uhh", "um", "umm", "er", "erm", "hmm"}
# Leading/trailing politeness, longest first.
PREFIXES = sorted(
    ["ok", "okay", "so", "now", "alright", "hey", "please", "just", "quickly", "oops", "can you", "could you", "would you",
     "will you", "can we", "could we", "let s", "lets", "let us", "go ahead and"],
    key=lambda p: -len(p),
)  # fmt: skip
SUFFIXES = sorted(["please", "thanks", "thank you", "for me"], key=lambda p: -len(p))
CORRECTION_WORDS = {"no", "wait", "sorry", "i", "mean", "meant", "actually", "rather", "or"}
CORRECTION_MARKERS = CORRECTION_WORDS - {"i", "or"}

COLOR_WORDS = {**{c: c for c in COLORS}, "grey": "gray"}
SIZE_WORDS = {"small": "small", "tiny": "small", "medium": "medium", "large": "large", "big": "large", "huge": "large"}
DIRECTION_WORDS = {"left": "left", "right": "right", "up": "up", "down": "down", "upward": "up", "upwards": "up",
                   "downward": "down", "downwards": "down"}  # fmt: skip
SHAPE_KINDS = {"sticky note": "sticky", **{w: k for w, k in KIND_WORDS.items() if k != "text"}}
TEXT_STYLES = {"title": "title", "heading": "heading", "header": "heading", "subtitle": "heading", "caption": "caption",
               "text": "body"}  # fmt: skip
REGIONS = {"top left": "top-left", "top right": "top-right", "bottom left": "bottom-left", "bottom right": "bottom-right",
           "top": "top", "bottom": "bottom", "left": "left", "right": "right", "middle": "center", "center": "center",
           "centre": "center"}  # fmt: skip
# "in the top right corner", "on the left", "at the bottom".
REGION_PHRASES = sorted(
    ((f"{prep} the {p}{tail}", r) for p, r in REGIONS.items() for prep in ("in", "on", "at") for tail in ("", " corner", " side")),
    key=lambda pr: -len(pr[0]),
)

UNDO_PHRASES = {"go back", "take that back", "take it back", "revert", "revert that", "revert it", "scratch that"}
UNDO_TAILS = {"", "that", "it", "this", "last", "the last thing", "the last change", "the last step", "the last command",
              "last change", "that last change", "all of that", "the last one"}  # fmt: skip
CLEAR_VERBS = {"clear", "wipe", "erase", "reset"}
CLEAR_TAILS = {"the board", "board", "everything", "the whole board", "the entire board", "the canvas", "the whole canvas",
               "the entire canvas", "it all", "the whole thing", "everything on the board"}  # fmt: skip
DELETE_VERBS = ["get rid of", "delete", "remove", "erase", "drop", "scrap"]
ADD_VERBS = {"add", "draw", "put", "place", "create", "insert", "make"}
TEXT_VERBS = {"add", "write", "put", "insert", "create"}
ARTICLES = {"a", "an", "another", "one"}
BOARD_SUFFIX = {"", "here", "there", "on the board", "to the board"}
# "called payments", "that says call mom".
LABEL_MARKERS = sorted(["called", "named", "saying", "that says", "which says", "labelled", "labeled", "labelled as",
                        "labeled as", "with the text", "with the label", "reading"], key=lambda p: -len(p))  # fmt: skip
RECOLOR_VERBS = {"make", "turn", "color", "colour", "paint", "change", "set"}
RESIZE_VERBS = {"make", "set", "resize"}
MOVE_VERBS = {"move", "nudge", "shift", "push", "drag", "slide", "bump"}
MOVE_TAIL = {"to", "the", "over", "towards", "a", "little", "bit", "slightly", "tad", "touch", "lot", "far", "way", "side"}
DISTANCE_LITTLE = {"little", "bit", "slightly", "tad", "touch"}
DISTANCE_FAR = {"lot", "far", "way"}
CONNECT_VERBS = {"connect", "link", "join"}
ARROW_STYLES = {"dashed": "dashed", "dotted": "dotted", "solid": "solid"}
RENAME_FIELDS = {"label", "text", "name", "wording"}
# Text that looks like a second change, a placement or a self-correction; such commands go to the model.
TEXT_BLOCKERS = SECOND_CLAUSE | {"next", "beside", "below", "above", "connect", "arrow", "wait", "sorry", "actually", "mean"}
MAX_TEXT_WORDS = 8
REF_FILLER = {"the", "this", "that", "it", "one"}
SET_WORDS = QUANTIFIERS | set(PLURAL_KIND_WORDS) | set(KIND_WORDS) | EVERYTHING_WORDS | set(COLORS) | {"the", "of", "these", "those"}


class Command:
    """The command's words after normalising, with their spans in the original text (for labels)."""

    def __init__(self, text: str):
        self.text = text
        toks = [(m[0].lower(), m.start(), m.end()) for m in re.finditer(r"[a-z0-9]+", text, re.I)]
        toks = [t for t in toks if t[0] not in FILLERS]
        toks = [t for i, t in enumerate(toks) if i == 0 or t[0] != toks[i - 1][0]]  # "the, the" -> "the"
        toks = strip_corrections(toks)
        stripped = True
        while stripped:
            stripped = False
            for p in PREFIXES:
                n = len(p.split())
                if " ".join(t[0] for t in toks[:n]) == p and len(toks) > n:
                    toks, stripped = toks[n:], True
                    break
            for s in SUFFIXES:
                n = len(s.split())
                if " ".join(t[0] for t in toks[-n:]) == s and len(toks) > n:
                    toks, stripped = toks[:-n], True
                    break
        self.toks = toks
        self.w = [t[0] for t in toks]

    def phrase(self, i: int, j: int | None = None) -> str:
        return " ".join(self.w[i:j])

    def original(self, i: int) -> str:
        """The user's own text from word i to the end, as typed (casing, punctuation inside)."""
        return self.text[self.toks[i][1] : self.toks[-1][2]].strip(" \"'“”‘’")


def strip_corrections(toks: list) -> list:
    """'red, no wait, blue' -> 'blue': a value, correction words, then a value of the same kind."""
    for table in (COLOR_WORDS, SIZE_WORDS, DIRECTION_WORDS):
        i = 0
        while i < len(toks):
            j = i + 1
            while j < len(toks) and toks[j][0] in CORRECTION_WORDS:
                j += 1
            marked = {t[0] for t in toks[i + 1 : j]} & CORRECTION_MARKERS  # "red or blue" is not a correction
            if toks[i][0] in table and marked and j < len(toks) and toks[j][0] in table:
                toks = toks[:i] + toks[j:]
            else:
                i += 1
    return toks


def starts(w: list[str], options) -> int:
    """Length of the first (longest-first) phrase in `options` that `w` starts with, else 0."""
    for p in options:
        n = len(p.split())
        if " ".join(w[:n]) == p:
            return n
    return 0


def ref(phrase: list[str], scene: dict, group: bool = False) -> str | list[str] | None:
    """The element (or, with `group`, the sorted ids) a phrase like "the user box" names, if every word is explained."""
    if not phrase:
        return None
    hit = resolve_target(" ".join(phrase), scene)
    if not hit:
        return None
    target, rule = hit
    if rule == "set":
        return target if group and target != SEVERAL and set(phrase) <= SET_WORDS else None
    el = next(e for e in scene["elements"] if e["id"] == target)
    explained = REF_FILLER | {w for w, k in KIND_WORDS.items() if k == el["type"]} | set(words(el.get("label", "")))
    if el.get("color"):
        explained.add(el["color"])
    return target if set(phrase) <= explained else None


def element(scene: dict, target: str) -> dict:
    return next(e for e in scene["elements"] if e["id"] == target)


def label_text(cmd: Command, i: int) -> str | None:
    """New text from word i to the end, if it is short and doesn't look like a placement or a second change."""
    said = cmd.w[i:]
    if not 1 <= len(said) <= MAX_TEXT_WORDS or TEXT_BLOCKERS & set(said):
        return None
    if any(" ".join(said).endswith(p) for p, _ in REGION_PHRASES):  # "saying call mom on the right"
        return None
    return cmd.original(i) or None


def slug(text: str) -> str | None:
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:40].strip("-")
    return s or None


def each(name: str, targets: str | list[str], **inp) -> list[dict]:
    return [{"name": name, "input": {"target": t, **inp}} for t in (targets if isinstance(targets, list) else [targets])]


def undo(cmd: Command, scene: dict):
    if cmd.phrase(0) in UNDO_PHRASES or cmd.w[:1] == ["undo"] and cmd.phrase(1) in UNDO_TAILS:
        return [{"name": "undo_last_command", "input": {}}], "undo"


def clear(cmd: Command, scene: dict):
    if cmd.w[0] in CLEAR_VERBS and cmd.phrase(1) in CLEAR_TAILS:
        return [{"name": "clear_board", "input": {"confirm": True}}], "clear"


def delete(cmd: Command, scene: dict):
    n = starts(cmd.w, DELETE_VERBS)
    w = cmd.w[n:]
    for tail in ("from the board", "off the board"):
        if " ".join(w).endswith(tail):
            w = w[: -len(tail.split())]
    targets = ref(w, scene, group=True) if n else None
    if targets:
        return [{"name": "delete_elements", "input": {"targets": targets if isinstance(targets, list) else [targets]}}], "delete"


def modifiers(w: list[str], i: int, tables: dict[str, dict]) -> tuple[dict, int]:
    """Read at most one value from each table (e.g. color, size) in any order, starting at w[i]."""
    found: dict = {}
    while i < len(w):
        key = next((k for k, t in tables.items() if w[i] in t and k not in found), None)
        if not key:
            break
        found[key] = tables[key][w[i]]
        i += 1
    return found, i


def placement_and_label(cmd: Command, i: int) -> tuple[dict, str | None] | None:
    """Optional region and optional label clause after a new element, e.g. "in the top right corner called X"."""
    w, extra = cmd.w, {}
    n = starts(w[i:], [p for p, _ in REGION_PHRASES])
    if n:
        extra["placement"] = {"region": dict(REGION_PHRASES)[" ".join(w[i : i + n])]}
        i += n
    n = starts(w[i:], LABEL_MARKERS)
    if n:
        text = label_text(cmd, i + n) if i + n < len(w) else None
        return (extra, text) if text else None
    if " ".join(w[i:]) in BOARD_SUFFIX:
        return extra, None
    return None


def add_shape(cmd: Command, scene: dict):
    w = cmd.w
    if w[0] not in ADD_VERBS:
        return None
    i = 2 if len(w) > 1 and w[1] in ARTICLES else 1
    mods, i = modifiers(w, i, {"color": COLOR_WORDS, "size": SIZE_WORDS})
    n = starts(w[i:], sorted(SHAPE_KINDS, key=lambda k: -len(k.split())))
    if not n:
        return None
    kind = SHAPE_KINDS[" ".join(w[i : i + n])]
    rest = placement_and_label(cmd, i + n)
    if not rest:
        return None
    extra, label = rest
    inp = {"kind": kind, **mods, **extra}
    if label:
        inp = {**({"id": slug(label)} if slug(label) else {}), **inp, "label": label}
    return [{"name": "add_shape", "input": inp}], "labelled add_shape" if label else "add_shape"


def add_text(cmd: Command, scene: dict):
    w = cmd.w
    if w[0] not in TEXT_VERBS:
        return None
    i = 2 if len(w) > 1 and w[1] in ARTICLES else 1
    mods, i = modifiers(w, i, {"color": COLOR_WORDS})
    if i >= len(w) or w[i] not in TEXT_STYLES:
        return None
    style = TEXT_STYLES[w[i]]
    rest = placement_and_label(cmd, i + 1)
    if not rest or not rest[1]:
        return None
    extra, text = rest
    inp = {**({"id": slug(text)} if slug(text) else {}), "text": text, "style": style, **mods, **extra}
    return [{"name": "add_text", "input": inp}], f"add_text {style}"


def is_value(text: str) -> bool:
    """New text that is really a color, size or shape ("change the title to red"): not a rename."""
    said = words(text)
    return len(said) <= 2 and bool(set(said) & (set(COLOR_WORDS) | set(SIZE_WORDS) | set(SHAPE_KINDS) | set(TEXT_STYLES)))


def rename(cmd: Command, scene: dict):
    w = cmd.w
    if w[0] in ("rename", "relabel"):
        start, text_only = 1, False
    elif w[0] in ("change", "set") and len(w) > 3 and w[1] == "the" and w[2] in RENAME_FIELDS and w[3] == "of":
        start, text_only = 4, False  # "change the label of X to Y"
    elif w[0] == "change":
        start, text_only = 1, True  # "change the title to Y": only for a text element
    else:
        return None
    for at in range(start + 1, len(w) - 1):
        if w[at] not in ("to", "as") or w[at] == "as" and text_only:
            continue
        target = ref(w[start:at], scene)
        if not target or text_only and element(scene, target)["type"] != "text" or element(scene, target)["type"] == "image":
            continue
        text = label_text(cmd, at + 1)
        if not text or is_value(text) or text_only and w[at + 1] in ARTICLES:
            return None
        return each("update_element", target, label=text), "rename"
    return None


def recolor(cmd: Command, scene: dict):
    w = cmd.w
    if w[0] not in RECOLOR_VERBS:
        return None
    end = len(w) - 1 if w[-1] in ("color", "colour") else len(w)
    if end < 3 or w[end - 1] not in COLOR_WORDS:
        return None
    color = COLOR_WORDS[w[end - 1]]
    stop = end - 2 if w[end - 2] in ("to", "into", "in") else end - 1
    start = 4 if w[1:4] in (["the", "color", "of"], ["the", "colour", "of"]) else 1
    targets = ref(w[start:stop], scene, group=True)
    if not targets or any(element(scene, t)["type"] == "image" for t in (targets if isinstance(targets, list) else [targets])):
        return None
    return each("update_element", targets, color=color), "recolor"


def resize(cmd: Command, scene: dict):
    w = cmd.w
    if w[0] not in RESIZE_VERBS:
        return None
    end = len(w) - 1 if w[-1] in ("sized", "size") else len(w)
    if end < 3 or w[end - 1] not in SIZE_WORDS:
        return None
    stop = end - 2 if w[end - 2] == "to" else end - 1
    targets = ref(w[1:stop], scene, group=True)
    return (each("update_element", targets, size=SIZE_WORDS[w[end - 1]]), "resize") if targets else None


def move(cmd: Command, scene: dict):
    w = cmd.w
    if w[0] not in MOVE_VERBS:
        return None
    cut = next((i for i in range(1, len(w)) if w[i] in DIRECTION_WORDS or w[i] in MOVE_TAIL - {"the"}), len(w))
    tail = w[cut:]
    dirs = [d for d in tail if d in DIRECTION_WORDS]
    if len(dirs) != 1 or set(tail) - set(DIRECTION_WORDS) - MOVE_TAIL:
        return None
    little, far = DISTANCE_LITTLE & set(tail), DISTANCE_FAR & set(tail)
    if little and far:
        return None
    targets = ref(w[1:cut], scene, group=True)
    if not targets:
        return None
    dist = {"distance": "little"} if little else {"distance": "far"} if far else {}
    return each("move_element", targets, direction=DIRECTION_WORDS[dirs[0]], **dist), "move"


def arrow(cmd: Command, scene: dict):
    w, extra = cmd.w, {}
    if w[0] in CONNECT_VERBS:
        body = w[1:]
        for suffix in ("with an arrow", "using an arrow", "with a line"):
            if " ".join(body).endswith(suffix):
                body = body[: -len(suffix.split())]
        seps = ("to", "with", "and")
    elif w[0] in ADD_VERBS:
        i = 2 if len(w) > 1 and w[1] in ARTICLES else 1
        mods, i = modifiers(w, i, {"color": COLOR_WORDS, "style": ARROW_STYLES})
        if w[i : i + 2] == ["arrow", "from"]:
            body, seps = w[i + 2 :], ("to",)
        elif w[i : i + 2] == ["arrow", "between"]:
            body, seps = w[i + 2 :], ("and",)
        else:
            return None
        extra = mods
    else:
        return None
    pairs = []
    for at, sep in enumerate(body):
        if sep in seps:
            a, b = ref(body[:at], scene), ref(body[at + 1 :], scene)
            if a and b and a != b:
                pairs.append((a, b))
    if len(pairs) != 1:
        return None
    return [{"name": "add_arrow", "input": {"from": pairs[0][0], "to": pairs[0][1], **extra}}], "add_arrow"


def verb_forms(*bases: str) -> set[str]:
    """walk -> walk, walks, walking; drive -> drives, driving; go/dash -> goes/dashes."""
    out = set()
    for b in bases:
        out |= {b, b + ("es" if b.endswith(("sh", "o")) else "s"), (b[:-1] if b.endswith("e") else b) + "ing"}
    return out


MOTION_SPEED = {
    **{f: "normal" for f in verb_forms("walk", "go", "head", "travel", "march", "follow") | {"moves", "moving"}},
    **{f: "fast" for f in verb_forms("rush", "race", "dash", "drive", "zoom", "chase") | {"run", "runs", "running", "fly", "flies", "flying"}},
    **{f: "slow" for f in verb_forms("stroll", "creep", "crawl", "wander", "tiptoe")},
}
TOWARD_PREPS = sorted(["towards", "toward", "to", "up to", "over to", "straight to", "right up to"], key=lambda p: -len(p))


def animate(cmd: Command, scene: dict):
    """'the boy walks towards the girl', 'the dog is running away from the cat', 'move the boy towards the girl'."""
    w = cmd.w
    if w[0] in ("move", "bring"):  # imperative: only "towards"; "move X to Y" stays a move or placement
        speed, preps = "normal", ["towards", "toward"]
        at = next((i for i in range(2, len(w) - 1) if w[i] in preps), None)
        mover_span = (1, at)
    else:
        verb = next((i for i, x in enumerate(w) if x in MOTION_SPEED), 0)
        if not verb:
            return None
        speed, preps, at = MOTION_SPEED[w[verb]], TOWARD_PREPS + ["away from"], verb + 1  # "walks slowly to" -> LLM
        mover_span = (0, verb - 1 if verb > 1 and w[verb - 1] in ("is", "are") else verb)
    if at is None or at >= len(w):
        return None
    n = starts(w[at:], preps)
    if not n:
        return None
    mover, other = ref(w[slice(*mover_span)], scene), ref(w[at + n :], scene)
    if not mover or not other or mover == other:
        return None
    inp = {"target": mover, "away_from" if w[at] == "away" else "toward": other}
    if speed != "normal":
        inp["speed"] = speed
    return [{"name": "animate_element", "input": inp}], "animate"


def has_motion(cmd: Command) -> bool:
    """A motion command the templates didn't take. Laya has no animate_element and would read it as a teleport."""
    if not ({"towards", "toward", "away", "across"} & set(cmd.w) or "to" in cmd.w):
        return False
    return any(x in MOTION_SPEED for x in cmd.w) or cmd.w[0] in ("move", "bring") and {"towards", "toward"} & set(cmd.w)


SCROLL_VERBS = {"scroll", "pan"}
SCROLL_WORDS = verb_forms("scroll", "pan") | {"scrolled", "panned", "panning", "camera", "viewport", "canvas"}
# Nouns for the view itself: "scroll the page down". Move verbs only take the camera-like ones ("move the view
# left"); "move the canvas down" could mean dragging it the other way, so it goes to the LLM.
VIEW_NOUNS = {"view", "screen", "page", "canvas", "board", "camera"}
MOVABLE_VIEW_NOUNS = {"view", "screen", "camera"}
SCROLL_TAIL = {"to", "the", "over", "a", "little", "bit", "slightly", "tad", "touch", "lot", "far", "further", "more", "way", "side"}
SCREENFUL = {"page", "screen", "screenful"}  # "scroll down a page" = a whole screen
EDGES = {"top": "top", "bottom": "bottom", "left": "left", "right": "right", "start": "top", "beginning": "top", "end": "bottom"}
EDGE_TAILS = {"", "of the board", "of the page", "of the canvas", "of it", "of everything"}
GOTO_PHRASES = sorted(
    [f"{v}{back}{over} to" for v in ("scroll", "pan", "go", "jump", "head", "navigate", "take me", "bring me")
     for back in ("", " back") for over in ("", " over", " all the way", " up", " down")]
    + ["back to", "show me", "focus on", "center on", "centre on"],
    key=lambda p: -len(p),
)  # fmt: skip
FIT_PHRASES = {
    f"{v} {what}{tail}".strip()
    for v in ("show", "show me", "fit", "see", "let me see", "zoom out to show", "zoom out to see")
    for what in ("everything", "it all", "all of it", "the whole board", "the entire board", "the whole canvas",
                 "the whole page", "the whole thing", "everything on the board")
    for tail in ("", " on screen", " on the screen", " at once", " on one screen")
} | {"zoom to fit", "zoom out to fit", "fit to screen", "fit to the screen", "fit the board on screen", "fit all"}  # fmt: skip


def view_noun(w: list[str], i: int, nouns: set[str]) -> int:
    """Length of "the page" / "page" at w[i], else 0."""
    j = i + 1 if w[i : i + 1] == ["the"] else i
    return j + 1 - i if j < len(w) and w[j] in nouns else 0


def scroll(cmd: Command, scene: dict):
    """'scroll down a bit', 'pan the view left', 'go to postgres', 'back to the top', 'show everything'."""
    w = cmd.w
    if cmd.phrase(0) in FIT_PHRASES:
        return [{"name": "scroll_view", "input": {"fit": "all"}}], "scroll"
    n = starts(w, GOTO_PHRASES)
    if n:
        rest = w[n:]
        if rest[:1] == ["the"]:
            rest = rest[1:]
        if rest and rest[0] in EDGES and " ".join(rest[1:]) in EDGE_TAILS and not {"show", "focus", "center", "centre"} & set(w[:n]):
            if rest[0] in ("left", "right") and "way" not in w[:n]:  # "go to the left" scrolls left; "all the way to the left" is the edge
                return [{"name": "scroll_view", "input": {"direction": rest[0]}}], "scroll"
            return [{"name": "scroll_view", "input": {"edge": EDGES[rest[0]]}}], "scroll"
        target = ref(w[n:], scene)
        return ([{"name": "scroll_view", "input": {"to": target}}], "scroll") if target else None
    if w[0] in SCROLL_VERBS:
        i = 1 + (view_noun(w, 1, VIEW_NOUNS) if len(w) > 1 else 0)
    elif w[0] in MOVE_VERBS and len(w) > 1 and view_noun(w, 1, MOVABLE_VIEW_NOUNS) and not ref(w[1:3], scene):
        i = 1 + view_noun(w, 1, MOVABLE_VIEW_NOUNS)
    else:
        return None
    tail = w[i:]
    dirs = [d for d in tail if d in DIRECTION_WORDS]
    if len(dirs) != 1 or set(tail) - set(DIRECTION_WORDS) - SCROLL_TAIL - SCREENFUL - {"all", "one"}:
        return None
    direction = DIRECTION_WORDS[dirs[0]]
    if "all the way" in " ".join(tail):  # "scroll all the way down" = to the bottom edge
        return [{"name": "scroll_view", "input": {"edge": {"up": "top", "down": "bottom"}.get(direction, direction)}}], "scroll"
    if "all" in tail:
        return None
    little, far = DISTANCE_LITTLE & set(tail), (DISTANCE_FAR | SCREENFUL) & set(tail)
    if little and far:
        return None
    dist = {"distance": "little"} if little else {"distance": "far"} if far else {}
    return [{"name": "scroll_view", "input": {"direction": direction, **dist}}], "scroll"


def has_scroll(cmd: Command) -> bool:
    """A scroll command the templates didn't take. Laya has no scroll_view and would read it as a move."""
    return bool(SCROLL_WORDS & set(cmd.w))


DIAGRAM_WORDS = {"diagram", "diagrams", "flowchart", "flowcharts", "architecture", "workflow", "pipeline", "hierarchy", "mindmap"}
DIAGRAM_PHRASES = {"flow chart", "org chart", "mind map"}


def has_diagram(cmd: Command) -> bool:
    """A whole-diagram command. Laya has no generate_diagram and would draw one box."""
    text = " ".join(cmd.w)
    return bool(DIAGRAM_WORDS & set(cmd.w)) or any(p in text for p in DIAGRAM_PHRASES)


PLOT_WORDS = {
    "graph", "graphs", "plot", "plots", "plotted", "plotting", "equation", "equations", "parabola", "chart", "charts",
    "histogram", "sine", "cosine",
}
EQUATION = re.compile(r"\b(y|f\s*\(\s*x\s*\))\s*=|=\s*y\b|\bx\s*(\^|\*\*)", re.I)


def has_plot(cmd: Command) -> bool:
    """An equation graph or data chart. Laya has no plot_graph/add_chart and would draw a box or text."""
    return bool(PLOT_WORDS & set(cmd.w)) or bool(EQUATION.search(cmd.text))


CHART_NAME = re.compile(r'"((?:[^"\\]|\\.)*)"')


def edits_chart(cmd: Command, scene: dict) -> bool:
    """Names a category or series of a chart on the board ("set Q2 to 20", "remove food"): add_chart replace."""
    for el in scene["elements"]:
        if el["type"] != "chart" or not el.get("data"):
            continue
        names = CHART_NAME.findall(el["data"].split("; unit ")[0])  # labels and series names, not the unit
        for name in names:
            words = re.findall(r"[a-z0-9]+", name.lower())
            n = len(words)
            if n and any(cmd.w[i : i + n] == words for i in range(len(cmd.w) - n + 1)):
                return True
    return False


TEMPLATES = [undo, clear, arrow, add_text, add_shape, delete, rename, recolor, resize, scroll, move, animate]


def rule_command(text: str, scene: dict) -> tuple[str, list[dict] | None, str] | None:
    """(route, actions, why) when code alone settles the command, else None (ask the decision model).

    route is "fast" with actions, or "llm" when code knows the command needs the LLM (a measurement it can't
    build). Casual-verb objects ("let's grab a tree") return None: whether they are meant for the board is
    Laya's call.
    """
    if has_measurement(text):  # Laya has no add_dimension: built here or left to the LLM
        measured = measure_command(text, scene)
        return ("fast", *measured) if measured else ("llm", None, "measurement needs the LLM")
    obj = object_command(text)
    if obj and has_plot(Command(text)):  # "add a bar chart": a real chart now, not the clip-art icon
        return "llm", None, "graph needs the LLM"
    if obj:
        return route_object(obj, None, 1.0) if not obj["casual"] else None
    cmd = Command(text)
    if not cmd.w:
        return None
    for template in TEMPLATES:
        hit = template(cmd, scene)
        if hit:
            return "fast", hit[0], f"rule: {hit[1]}"
    if has_motion(cmd):  # Laya has no animate_element: built here or left to the LLM
        return "llm", None, "motion needs the LLM"
    if has_scroll(cmd):  # Laya has no scroll_view either
        return "llm", None, "scroll needs the LLM"
    if has_diagram(cmd):  # nor generate_diagram ("org chart" lands here, not below)
        return "llm", None, "diagram needs the LLM"
    if has_plot(cmd) or edits_chart(cmd, scene):  # nor plot_graph / add_chart
        return "llm", None, "graph needs the LLM"
    return None
