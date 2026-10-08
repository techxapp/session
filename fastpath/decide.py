"""
Decision logic for the Laya fast path, shared by the app sidecar (fastpath/server.py) and the eval harness.

A decision model answers closed-set questions about a command (`build_questions`); code picks the target when the
command names it (`resolve_target`), routes the command (`route`: ignore / fast / llm) and builds the board actions
(`compose`). Element ids, colors and action names mirror shared/src/actions.ts.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

# Mirrors shared/src/actions.ts.
COLORS = ["black", "gray", "red", "orange", "yellow", "green", "teal", "blue", "purple", "pink"]
ACTION_DESCRIPTIONS = {
    "add_shape": "Draw a new shape (box, circle, diamond, sticky note), optionally with a label inside.",
    "add_text": "Write new free-standing text on the board (titles, captions, notes).",
    "add_arrow": "Connect two elements with an arrow.",
    "move_element": "Move an existing element in a direction or next to something.",
    "update_element": "Change an existing element's text, color or size.",
    "delete_elements": "Remove existing elements from the board.",
    "undo_last_command": "Undo what the previous command did.",
    "clear_board": "Erase the entire board.",
    "none": "Not a whiteboard command: chatter, noise, or talking to someone else.",
}
# Actions code can build from closed-set answers alone; everything else goes to the LLM.
FAST_ACTIONS = {"undo_last_command", "clear_board", "delete_elements", "update_element", "move_element", "add_shape"}
FIELDS = ["action", "target", "color", "kind", "size", "direction", "multi_step", "needs_text"]


def describe_element(el: dict, scene: dict) -> str:
    kind = {"rectangle": "box", "ellipse": "circle", "sticky": "sticky note", "text": "text"}.get(el["type"], el["type"])
    parts = [kind]
    if el.get("label"):
        parts.append(f'"{el["label"]}"')
    if el["type"] == "arrow":
        parts.append(f'from {el.get("from")} to {el.get("to")}')
    if el.get("color"):
        parts.append(el["color"])
    if el["id"] in scene["selectedIds"]:
        parts.append("(selected)")
    elif scene["recentIds"] and el["id"] == scene["recentIds"][0]:
        parts.append("(most recent)")
    return " ".join(parts)


def format_scene(scene: dict) -> str:
    if not scene["elements"]:
        return "The board is empty."
    lines = [f"{el['id']}: {describe_element(el, scene)}" for el in scene["elements"]]
    return "; ".join(lines)


def build_questions(scene: dict) -> dict:
    q: dict = {
        "on_board": {
            "type": "noul",
            "instructions": "Is the speaker giving a command to change the whiteboard?",
            "criteria": {
                "false": "Chatter, noise, a question to people, or talking to someone else.",
                "true": "An instruction to draw, change, move, delete, undo or clear something on the board.",
            },
        },
        "action": {
            "type": "choice",
            "instructions": "What is the main thing the command asks the whiteboard to do?",
            "criteria": dict(ACTION_DESCRIPTIONS),
        },
        "color": {
            "type": "choice",
            "instructions": "Which color does the command ask for? If the speaker corrects themselves, use the correction.",
            "criteria": {**{c: f"the color {c}" for c in COLORS}, "none": "no color is mentioned"},
        },
        "kind": {
            "type": "choice",
            "instructions": "Which kind of new shape does the command ask to draw?",
            "criteria": {
                "rectangle": "a box, rectangle or square",
                "ellipse": "a circle, oval or ellipse",
                "diamond": "a diamond",
                "sticky": "a sticky note",
                "none": "no new shape is drawn",
            },
        },
        "size": {
            "type": "choice",
            "instructions": "Which size does the command ask for?",
            "criteria": {"small": "small", "medium": "medium", "large": "large or big", "none": "no size is mentioned"},
        },
        "direction": {
            "type": "choice",
            "instructions": "In which direction should an element be moved?",
            "criteria": {
                "left": "to the left",
                "right": "to the right",
                "up": "up",
                "down": "down",
                "none": "nothing is moved in a direction",
            },
        },
        "multi_step": {
            "type": "noul",
            # v2 wording: v1 ("Does the command ask for more than one change, or to change several elements at
            # once?") made Qwen3.5-4B answer true for most single commands when the question came first.
            "instructions": (
                "Count the separate changes the command asks for. Each element that is added, changed, moved or "
                "deleted is one change; undo and clear are one change each."
            ),
            "criteria": {
                "false": "Exactly one change.",
                "true": "Two or more changes.",
            },
        },
        "needs_text": {
            "type": "noul",
            "instructions": "Does the command contain new words to write on the board, such as a label, a title or a new name?",
            "criteria": {
                "false": "No new text to write.",
                "true": "New text to write, label, rename or caption.",
            },
        },
    }
    targets = {el["id"]: describe_element(el, scene) for el in scene["elements"] if el["type"] != "arrow"}
    if targets:
        q["target"] = {
            "type": "choice",
            "instructions": "Which existing element does the command refer to? 'it', 'that' and 'this' mean the selected element, otherwise the most recent one.",
            "criteria": {**targets, "none": "no existing element is referred to"},
        }
    return q


# Words that name an element's type, for "the diamond" / "the title" when only one element has that type.
KIND_WORDS = {
    "box": "rectangle", "rectangle": "rectangle", "square": "rectangle",
    "circle": "ellipse", "oval": "ellipse", "ellipse": "ellipse",
    "diamond": "diamond",
    "sticky": "sticky", "note": "sticky",
    "title": "text", "heading": "text", "text": "text",
}  # fmt: skip
PLURAL_KIND_WORDS = {
    "boxes": "rectangle", "rectangles": "rectangle", "squares": "rectangle",
    "circles": "ellipse", "ovals": "ellipse", "ellipses": "ellipse",
    "diamonds": "diamond",
    "stickies": "sticky", "notes": "sticky",
    "titles": "text", "headings": "text",
}  # fmt: skip
LABEL_STOPWORDS = {"the", "and", "for", "box", "note", "board"}
PRONOUNS = {"it", "this", "that"}

# Set commands ("make all the notes green") are resolved to a list of element ids.
QUANTIFIERS = {"all", "every", "each", "both", "everything"}
EVERYTHING_WORDS = {"everything", "elements", "things", "shapes"}
# Words that add a condition or a second change code can't follow; such set commands go to the LLM.
SET_BLOCKERS = {
    "and", "then", "also", "plus", "except", "but", "besides", "other", "others",
    "on", "in", "at", "near", "about", "with", "without", "that", "which", "inside", "under", "above", "below",
    "from", "labelled", "labeled", "called", "saying", "named",
}  # fmt: skip
# Target value meaning "several elements, but code can't tell which"; only undo/clear can still go fast.
SEVERAL = "several"
SET_ACTIONS = {"delete_elements", "update_element", "move_element"}


def words(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", text.lower())


# Clip-art the LLM can draw with add_object (shared/objects.json): every name and alias -> object name.
_CATALOG = json.loads((Path(__file__).resolve().parent.parent / "shared" / "objects.json").read_text(encoding="utf-8"))
# Longest first, so "pine tree" wins over "tree".
OBJECT_WORDS = dict(sorted(((w, n) for n, o in _CATALOG.items() for w in (n, *o["aliases"])), key=lambda p: -len(p[0])))
EDIT_ACTIONS = SET_ACTIONS | {"undo_last_command", "clear_board"}


def draws_object(text: str, decision: str, actions: list[dict] | None) -> str | None:
    """The object a command may want drawn ("let's grab a tree"), unless it was routed fast as an edit.

    The decision model has no add_object answer, so it reads such commands as add_shape, add_text or chatter;
    they go to the LLM instead. Fast edits of an existing object ("make the tree bigger") stay fast.
    """
    if decision == "fast" and actions and all(a["name"] in EDIT_ACTIONS for a in actions):
        return None
    padded = f" {' '.join(words(text))} "
    return next((name for w, name in OBJECT_WORDS.items() if f" {w} " in padded or f" {w}s " in padded), None)


def resolve_set(said: list[str], elements: list[dict]) -> list[str] | str | None:
    """Ids for a command about a group of elements, SEVERAL if it is one code can't resolve, None if it isn't one."""
    if not (QUANTIFIERS & set(said) or any(w in PLURAL_KIND_WORDS or w in EVERYTHING_WORDS for w in said)):
        return None
    said = " ".join(said).replace("on the board", "").replace("from the board", "").split()
    kind_at = [i for i, w in enumerate(said) if w in KIND_WORDS or w in PLURAL_KIND_WORDS or w in EVERYTHING_WORDS]
    kinds = {KIND_WORDS.get(w) or PLURAL_KIND_WORDS.get(w) for w in said} - {None}
    # A color before the type word filters ("the yellow notes"); one after it is the new color.
    filters = [w for w in said[: kind_at[0]] if w in COLORS] if kind_at else []
    if SET_BLOCKERS & set(said) or len(kinds) > 1 or len(filters) > 1 or not kind_at:
        return SEVERAL
    if kinds:
        hits = [el for el in elements if el["type"] in kinds]
    elif "shapes" in said:
        hits = [el for el in elements if el["type"] != "text"]
    else:
        hits = elements
    hits = [el for el in hits if not filters or el.get("color") == filters[0]]
    if not hits or "both" in said and len(hits) != 2:
        return SEVERAL
    return sorted(el["id"] for el in hits)


def resolve_target(text: str, scene: dict) -> tuple[str | list[str], str] | None:
    """Pick the target in code when the command names it unambiguously, else None (the model decides).

    Commands about a group ("all the notes", "every box", "the yellow stickies", "everything") resolve to a
    sorted list of ids, or to SEVERAL when they add a condition or second change code can't follow.
    Otherwise, first match wins: whole label in the command, then one distinctive label word, then the
    element type when only one element has it, then it/this/that -> the selected element, else the most
    recent one. Anything that may name more than one element returns None: several matches for a rule, or a
    type word the label match doesn't explain ("delete the error box and the diamond").
    """
    said = words(text)
    elements = [el for el in scene["elements"] if el["type"] != "arrow"]
    group = resolve_set(said, elements)
    if group is not None:
        return group, "set"
    padded = f" {' '.join(said)} "
    kinds = {KIND_WORDS[w] for w in said if w in KIND_WORDS}
    rules = [
        ("label", lambda el: el.get("label") and f" {' '.join(words(el['label']))} " in padded),
        ("label word", lambda el: any(w in said for w in words(el.get("label", "")) if len(w) >= 3 and w not in LABEL_STOPWORDS)),
        ("kind", lambda el: el["type"] in kinds),
    ]
    for rule, matches in rules:
        hits = [el for el in elements if matches(el)]
        if len(hits) > 1 or hits and rule != "kind" and kinds - {hits[0]["type"]}:
            return None
        if hits:
            return hits[0]["id"], rule
    if PRONOUNS & set(said):
        if len(scene["selectedIds"]) == 1:
            return scene["selectedIds"][0], "pronoun"
        if not scene["selectedIds"] and scene["recentIds"]:
            return scene["recentIds"][0], "pronoun"
    return None


def parse_answers(raw: dict) -> dict:
    """Laya answers -> {field: (value, confidence)}.

    Uses `answer_confidence`, which Laya calibrates the same way for every question type
    (plain `confidence` is max(p) for noul but normalized entropy for choice).
    """
    out: dict = {}
    for name, ans in raw["answers"].items():
        conf = float(ans["answer_confidence"])
        if ans["type"] == "noul":
            out[name] = (float(ans["noul"]) >= 0.5, conf)
        else:
            out[name] = (ans["choice"], conf)
    out.setdefault("target", ("none", 1.0))
    return out


def compose(a: dict) -> list[dict] | None:
    """Assemble the command's board actions from closed-set answers, or None if code can't build them alone.

    A set target (list of ids) becomes one delete_elements, or one update/move per element.
    """
    action = a["action"]
    if action == "undo_last_command":
        return [{"name": action, "input": {}}]
    if action == "clear_board":
        return [{"name": action, "input": {"confirm": True}}]
    targets = a["target"] if isinstance(a["target"], list) else [a["target"]]
    if action in SET_ACTIONS and targets[0] in ("none", SEVERAL):
        return None
    if action == "delete_elements":
        return [{"name": action, "input": {"targets": targets}}]
    if action == "update_element":
        inp = {k: a[k] for k in ("color", "size") if a[k] != "none"}
        return [{"name": action, "input": {"target": t, **inp}} for t in targets] if inp else None
    if action == "move_element" and a["direction"] != "none":
        return [{"name": action, "input": {"target": t, "direction": a["direction"]}} for t in targets]
    if action == "add_shape" and a["kind"] != "none":
        inp = {"kind": a["kind"]}
        if a["color"] != "none":
            inp["color"] = a["color"]
        return [{"name": action, "input": inp}]
    return None


# Fields each composed action reads; only these gate the fast path on confidence.
USED_FIELDS = {
    "undo_last_command": [],
    "clear_board": [],
    "delete_elements": ["target"],
    "update_element": ["target", "color", "size"],
    "move_element": ["target", "direction"],
    "add_shape": ["kind", "color"],
}


def route(ans: dict, threshold: float) -> tuple[str, list[dict] | None]:
    decision, actions, _why = route_why(ans, threshold)
    return decision, actions


def route_why(ans: dict, threshold: float) -> tuple[str, list[dict] | None, str]:
    """`route` plus a short reason for the decision, shown in the app's activity feed."""
    on_board, on_conf = ans["on_board"]
    action, action_conf = ans["action"]
    if not on_board or action == "none":
        # Only drop input when both signals agree and are confident; otherwise let the LLM look.
        if not on_board and action == "none" and on_conf >= threshold and action_conf >= threshold:
            return "ignore", None, "not a board command"
        return "llm", None, "unsure whether it's a board command"
    if action not in FAST_ACTIONS:
        return "llm", None, f"{action} needs the LLM"
    if action_conf < threshold:
        return "llm", None, f"unsure of the action ({action} {action_conf:.2f})"
    target = ans["target"][0]
    is_set = isinstance(target, list)
    if (is_set or target == SEVERAL) and action not in {"undo_last_command", "clear_board", *(SET_ACTIONS if is_set else ())}:
        return "llm", None, "several elements"
    # A resolved set is several changes by design; resolve_set already sent second clauses to SEVERAL.
    for flag in ("needs_text",) if is_set else ("multi_step", "needs_text"):
        value, conf = ans[flag]
        if value:
            return "llm", None, {"multi_step": "several changes", "needs_text": "needs new text"}[flag]
        if conf < threshold:
            return "llm", None, f"unsure about {flag} ({conf:.2f})"
    for f in USED_FIELDS[action]:
        if ans[f][1] < threshold:
            return "llm", None, f"unsure of the {f} ({ans[f][1]:.2f})"
    composed = compose({k: v for k, (v, _) in ans.items()})
    if not composed:
        return "llm", None, "answers don't make a complete action"
    return "fast", composed, action
