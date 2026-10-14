"""
Generate synthetic training rows for fine-tuning Laya on the voice-board questions.

Boards are random, built from labels that appear in no eval scene, and commands come from templates for every
sample category (plus fillers, stutters and self-corrections). Any command whose text matches an eval sample is
dropped. Rows are `{state, questions, expected}`, the format `laya-train` reads; questions come from
`build_questions`, so training sees exactly what inference asks. Questions a command doesn't answer cleanly
(the target of a group, multi-step or arrow command) are left unlabelled.

Usage:
  python make_train.py [--n 4000] [--seed 0] [--out F:/temp/laya-train/train.jsonl]
"""

from __future__ import annotations

import argparse
import json
import random
from pathlib import Path

from laya_eval import COLORS, HERE, build_questions, words

# Labels that appear in no eval scene.
POOL = {
    "rectangle": ["Auth Service", "Billing", "Frontend", "Load Balancer", "Queue Worker", "Search", "Mobile App", "CDN",
                  "Inventory", "Scheduler", "Logger", "Admin Panel", "Email Sender", "Web Server", "Checkout", "Notifier",
                  "Ship package", "Charge card", "Send receipt", "Load profile"],
    "ellipse": ["Redis", "MySQL", "Mongo", "Kafka", "S3 Bucket", "Customer", "Begin", "End", "Elastic", "Browser"],
    "diamond": ["Paid?", "In stock?", "Logged in?", "Retry?", "Approved?", "Is admin?"],
    "sticky": ["Write tests", "Call vendor", "Update docs", "Plan demo", "Review PR", "Book flights", "Order lunch",
               "Refactor auth", "Hire designer", "Pay invoice", "Clean backlog", "Email Sam"],
    "text": ["Roadmap", "Q3 Goals", "Retro", "Data Pipeline", "Team Board", "Checkout Flow", "Release Plan"],
}  # fmt: skip
KIND_NOUNS = {
    "rectangle": ["box", "rectangle", "box", "square"],
    "ellipse": ["circle", "oval", "circle"],
    "diamond": ["diamond"],
    "sticky": ["note", "sticky", "sticky note", "note"],
    "text": ["title", "heading", "text"],
}
PLURAL_NOUNS = {
    "rectangle": ["boxes", "rectangles"],
    "ellipse": ["circles", "ovals"],
    "diamond": ["diamonds"],
    "sticky": ["notes", "stickies", "sticky notes"],
    "text": ["titles", "headings"],
}
NEW_SHAPE_NOUNS = {
    "rectangle": ["box", "rectangle", "square"],
    "ellipse": ["circle", "oval", "ellipse"],
    "diamond": ["diamond"],
    "sticky": ["sticky note", "sticky", "note", "post-it"],
}
NEW_TEXTS = ["payments v2", "todo", "draft", "user flow", "done", "phase one", "backend", "notes from monday", "ideas",
             "launch", "api layer", "storage", "risks", "next steps", "q4 plan", "sign up", "orders", "review"]  # fmt: skip
SIZE_WORDS = {"small": ["small", "smaller", "tiny", "a bit smaller"], "medium": ["medium", "medium sized", "normal sized", "regular size"],
              "large": ["large", "big", "bigger", "huge", "larger"]}  # fmt: skip
DIRECTION_WORDS = {
    "left": ["left", "to the left", "a bit to the left", "left a little", "over to the left"],
    "right": ["right", "to the right", "a bit to the right", "right a little", "over to the right"],
    "up": ["up", "up a bit", "higher", "upward", "up a little"],
    "down": ["down", "down a bit", "lower", "downward", "down a little"],
}
CHATTER = [
    "can everyone see my screen", "let's take a five minute break", "who's presenting next", "I'll be right back",
    "that's a really good point", "hmm I'm not sure about that", "can you repeat the question", "is the meeting recorded",
    "let me grab some water", "sorry, my internet dropped", "what time is the demo", "I agree with Priya",
    "we should ask the team first", "how long will this take", "the billing service has been slow lately",
    "I like the blue one better", "does that make sense to everyone", "yeah, go ahead", "no worries",
    "can you hear me now", "my mic was muted", "wait, someone's at the door", "let's discuss this offline",
    "good morning everyone", "thanks for joining", "I think we're almost out of time", "anyone have questions",
    "this diagram is getting complicated", "the redis cluster went down yesterday", "hold that thought",
    "I'm going to share my screen", "where did we leave off last week", "should we invite the design team",
    "okay, moving on", "that was the last item on the agenda", "great job on the release", "brb",
    "what does everyone think", "I need to check with my manager", "it's raining here today", "testing, one two three",
    "mute yourself please", "the roadmap looks ambitious", "let's vote on it", "can someone take notes",
    "oh nice", "right, exactly", "I'll send the link in chat", "how was your weekend", "sorry, that was my dog",
    # View-like and drawing-like chatter: the view and other answers must not fire on talk about screens, calls, slides.
    "can you share your screen", "your screen is frozen", "scroll up in the chat", "I'll send the zoom link",
    "let's hop on a zoom call", "my screen went black", "move your camera a bit, I can only see half your face",
    "the page won't load", "I keep scrolling through slack", "next slide please", "go back to the previous slide",
    "can you zoom in on your camera", "let's go back to the top of the agenda", "I'm zooming out of here, bye",
    "look it up later", "show me your dog", "we drew straws for it", "I'm drawing a blank", "let's chart a new course",
    "the graph in the report looks off", "plot twist", "she walked over to my desk", "the car broke down",
    "my cat is on the keyboard again", "I'll draw up the contract tomorrow", "where's my coffee", "can everyone scroll down in the doc",
]  # fmt: skip
UNDO = ["undo", "undo that", "undo the last change", "go back", "take that back", "revert that", "undo please",
        "oops, undo", "reverse that", "put it back the way it was", "undo what you just did", "go back one step",
        "revert the last change", "never mind, undo it", "ctrl z", "undo the last command", "back that out"]  # fmt: skip
CLEAR = ["clear the board", "clear everything", "clear all", "wipe the board", "start over with a blank board", "clean the board",
         "erase the whole board", "wipe everything off", "remove everything from the board", "clear it all",
         "reset the board", "start from scratch", "delete everything on the board", "empty the board", "clear the canvas"]  # fmt: skip
FILLERS = ["lets", "let's", "uh", "um", "okay", "ok so", "so", "please", "can you", "could you", "hey,", "alright,", "now", "and now", "uh, um,"]
SUFFIXES = ["please", "thanks", "now", "for me", "real quick", "if you can"]
CORRECTIONS = [", no wait, {}", ", sorry, I mean {}", "... actually {}", ", no, {}", ", I mean {}"]


# Scroll and zoom phrasings per view answer ({r} = an element reference, {d} = a direction word).
VIEW_IN = ["zoom in", "zoom in a bit", "get closer", "closer please", "can we get a closer look", "magnify", "magnify the view",
           "make everything look bigger", "enlarge the view", "zoom closer", "push in a little", "let me see it up close",
           "go in closer", "increase the zoom", "bump up the zoom", "more zoom", "zoom in more", "zoom in a lot", "zoom way in",
           "I can't read it, zoom in", "make the view bigger", "move the camera closer"]  # fmt: skip
VIEW_IN_ON = ["zoom in on {r}", "get closer to {r}", "magnify {r}", "zoom into {r}", "give me a close-up of {r}", "close in on {r}",
              "let me see {r} up close", "zoom in a bit on {r}", "take a closer look at {r}"]  # fmt: skip
VIEW_OUT = ["zoom out", "zoom out a bit", "pull back", "back up a little", "pull the camera back", "make everything look smaller",
            "decrease the zoom", "less zoom", "zoom out more", "zoom way out", "step back a bit", "too close, zoom out",
            "I'm too zoomed in", "reduce the zoom", "widen the view", "zoom out a lot", "back the camera up", "go out a bit"]  # fmt: skip
VIEW_LEVEL = ["zoom to {n}%", "set the zoom to {n} percent", "make the zoom {n}%", "change the zoom level to {n}%",
              "{n} percent zoom please", "go to {n}% zoom", "put the zoom at {n}%", "zoom to {k}x", "I want {n}% zoom",
              "reset the zoom", "put the view back to normal size", "normal zoom please", "put the zoom back to normal",
              "go back to actual size", "default zoom", "zoom back to 100%", "set the zoom back to the default", "{k}x zoom"]  # fmt: skip
VIEW_FIT = ["show everything", "fit everything on screen", "let me see the whole board", "zoom to fit", "show me the whole thing",
            "fit it all in", "I want to see everything at once", "zoom out to see it all", "show the entire board",
            "get everything on one screen", "show me all of it", "fit the board to the screen", "bring everything into view",
            "can I see the full board"]  # fmt: skip
VIEW_ELEMENT = ["go to {r}", "take me to {r}", "show me {r}", "where is {r}", "where's {r}", "find {r}", "jump to {r}",
                "focus on {r}", "center on {r}", "centre the view on {r}", "scroll to {r}", "pan over to {r}", "bring {r} into view",
                "let's look at {r}", "head over to {r}", "can you find {r} for me", "put {r} in the middle of the screen",
                "navigate to {r}", "I can't see {r}, where did it go", "move the camera to {r}"]  # fmt: skip
VIEW_EDGE = {
    "up": ["go to the top", "back to the top", "scroll all the way up", "jump to the start", "take me to the beginning",
           "head to the top of the page", "back to the start of the board", "all the way up please"],
    "down": ["scroll all the way down", "jump to the bottom", "go to the very end", "scroll to the bottom of the board",
             "go right to the end", "take me to the bottom"],
    "left": ["all the way to the left", "scroll all the way left", "go to the far left", "jump to the left edge"],
    "right": ["all the way to the right", "go to the far right", "scroll all the way right", "jump to the right edge"],
}  # fmt: skip
VIEW_DIRECTION = ["scroll {d}", "scroll {d} a bit", "pan {d}", "pan the view {d}", "move the view {d}", "move the screen {d}",
                  "shift the camera {d}", "scroll {d} a page", "show me what's {w}", "let me see what's {w}", "scroll {d} a lot",
                  "scroll the page {d}", "drag the view {d}", "slide the view {d}", "pan a little {d}", "look a bit further {d}"]  # fmt: skip
VIEW_BEYOND = {"up": "above", "down": "below", "left": "to the left", "right": "to the right"}
# Commands only the assistant can do: pictures, diagrams, charts/graphs, motion, measurements.
OBJECTS = sorted(json.loads((HERE.parent / "shared" / "objects.json").read_text(encoding="utf-8")))
TOPICS = ["the signup process", "our deploy pipeline", "how payments work", "the login flow", "a request from browser to database",
          "the hiring process", "order fulfillment", "the release process", "how a pull request gets merged", "customer support tickets"]  # fmt: skip
DATA = ["sales by quarter", "q1 10 q2 20 q3 15", "our budget split", "monthly signups", "revenue per region", "bugs per team",
        "jan 5, feb 8, mar 12", "votes: yes 12 no 4"]  # fmt: skip
FUNCS = ["y = x^2", "y = 2x + 1", "sin(x)", "x squared", "sine of x", "x cubed", "the parabola y equals x squared", "cos x",
         "e to the x", "y = 1/x"]  # fmt: skip
OTHER_OBJECT = ["draw a {o}", "add a {o}", "put a {o} next to {r}", "sketch a {o}", "can you draw me a {o}", "add two {o}s",
                "a {o} please", "I need a picture of a {o}", "show a {o} here", "draw a big {o} on the right", "add a {o} under {r}",
                "put a little {o} in the corner"]  # fmt: skip
OTHER_DIAGRAM = ["draw a flowchart of {t}", "sketch the architecture of {t}", "map out {t}", "lay out the steps of {t}",
                 "diagram {t}", "show how {t} works step by step", "make an org chart for the design team",
                 "draw a mind map about {t}", "break {t} down into boxes and arrows", "draw the pipeline for {t}",
                 "visualize {t} as a flow", "sketch a sequence diagram of {t}", "build a decision tree for {t}"]  # fmt: skip
OTHER_GRAPH = ["plot {f}", "graph {f}", "draw the curve of {f}", "plot {f} from -5 to 5", "sketch {f} on axes"]
OTHER_CHART = ["draw a bar chart of {x}", "make a pie chart of {x}", "show {x} as a line chart", "chart {x}", "visualize {x}",
               "add a histogram of {x}", "show {x} as bars", "draw a graph of {x}"]  # fmt: skip
OTHER_MOTION = ["make {r} walk to {s}", "{r} runs toward {s}", "animate {r} moving away from {s}", "have {r} drive over to {s}",
                "{r} slowly creeps up to {s}", "let {r} fly across to {s}", "{r} chases {s}", "make {r} zoom over to {s}",
                "{r} strolls over to {s}", "move {r} slowly towards {s}"]  # fmt: skip
OTHER_MEASURE = ["{r} is {n} ft tall", "mark {r} as {n} meters wide", "the distance between {r} and {s} is {n} feet",
                 "add a dimension line of {n} m to {r}", "label the height of {r} {n} cm", "{r} and {s} are {n} m apart"]  # fmt: skip


def make_scene(rng: random.Random) -> dict:
    n = rng.choice([0, 2, 3, 3, 4, 4, 5, 5, 6, 7])
    types = ["rectangle", "rectangle", "ellipse", "diamond", "sticky", "sticky", "text"]
    elements, used = [], set()
    for i in range(n):
        t = rng.choice(types)
        if t == "text" and any(e["type"] == "text" for e in elements):
            t = "rectangle"
        label = rng.choice(POOL[t])
        if label in used:
            continue
        used.add(label)
        el = {"id": slug(label, elements, rng, t, i), "type": t, "label": label}
        if t != "text":
            el["color"] = rng.choice(COLORS)
        elements.append(el)
    ids = [e["id"] for e in elements]
    recent = rng.sample(ids, k=min(len(ids), rng.randint(1, 3))) if ids and rng.random() < 0.85 else []
    selected = []
    if ids and rng.random() < 0.3:
        selected = rng.sample(ids, k=2 if len(ids) > 1 and rng.random() < 0.15 else 1)
    return {"elements": elements, "selectedIds": selected, "recentIds": recent}


def slug(label: str, elements: list[dict], rng: random.Random, t: str, i: int) -> str:
    base = words(label)[0] if rng.random() < 0.7 else {"sticky": "n", "text": "t"}.get(t, "e") + str(i + 1)
    taken = {e["id"] for e in elements}
    sid, k = base, 2
    while sid in taken:
        sid, k = f"{base}{k}", k + 1
    return sid


def references(el: dict, scene: dict, rng: random.Random) -> list[str]:
    """Ways a speaker could name `el` unambiguously on this board."""
    els = scene["elements"]
    label = " ".join(words(el["label"]))
    noun = rng.choice(KIND_NOUNS[el["type"]])
    refs = [f"the {label}", f"the {label} {noun}", label]
    others = [w for e in els if e is not el for w in words(e["label"])]
    distinct = [w for w in words(el["label"]) if len(w) >= 3 and w not in others]
    if distinct and len(words(el["label"])) > 1:
        w = rng.choice(distinct)
        refs += [f"the {w} {noun}", f"the {w} one"]
    if sum(e["type"] == el["type"] for e in els) == 1:
        refs += [f"the {noun}"] * 2
    sel, recent = scene["selectedIds"], scene["recentIds"]
    if (len(sel) == 1 and sel[0] == el["id"]) or (not sel and recent and recent[0] == el["id"]):
        refs += ["it", "this", "that", "it", "this one", "that one"]
    return refs


def blank(action: str) -> dict:
    return {"action": action, "target": "none", "color": "none", "kind": "none", "size": "none", "direction": "none",
            "view": "none", "multi_step": False, "needs_text": False}  # fmt: skip


def pick_target(scene: dict, rng: random.Random) -> tuple[dict, str] | None:
    els = scene["elements"]
    if not els:
        return None
    el = rng.choice(els)
    return el, rng.choice(references(el, scene, rng))


def other_color(c: str, rng: random.Random) -> str:
    return rng.choice([x for x in COLORS if x != c])


def gen(cat: str, scene: dict, rng: random.Random) -> tuple[str, dict] | None:
    els = scene["elements"]
    if cat == "chatter":
        return rng.choice(CHATTER), {**blank("none")}
    if cat == "undo":
        return rng.choice(UNDO), blank("undo_last_command")
    if cat == "clear":
        return rng.choice(CLEAR), blank("clear_board")
    if cat == "delete":
        if not (p := pick_target(scene, rng)):
            return None
        el, ref = p
        verb = rng.choice(["delete", "remove", "get rid of", "erase", "drop", "take away", "trash", "delete", "remove"])
        return f"{verb} {ref}", {**blank("delete_elements"), "target": el["id"]}
    if cat == "recolor":
        if not (p := pick_target(scene, rng)):
            return None
        el, ref = p
        c = rng.choice(COLORS)
        exp = {**blank("update_element"), "target": el["id"], "color": c}
        if rng.random() < 0.15:
            wrong = other_color(c, rng)
            return f"make {ref} {wrong}{rng.choice(CORRECTIONS).format(c)}", exp
        tpl = rng.choice(["make {r} {c}", "color {r} {c}", "turn {r} {c}", "change {r} to {c}", "paint {r} {c}", "set {r} to {c}",
                          "change the color of {r} to {c}", "{r} should be {c}", "make {r} {c}", "recolor {r} {c}", "fill {r} with {c}"])  # fmt: skip
        return tpl.format(r=ref, c=c), exp
    if cat == "resize":
        if not (p := pick_target(scene, rng)):
            return None
        el, ref = p
        size = rng.choice(["small", "medium", "large", "large", "small"])
        w = rng.choice(SIZE_WORDS[size])
        exp = {**blank("update_element"), "target": el["id"], "size": size}
        verbs = {"small": ["shrink {r}"], "large": ["enlarge {r}", "blow up {r}"], "medium": []}[size]
        tpl = rng.choice(["make {r} {w}", "make {r} {w}", "resize {r} to {w}", "set {r} to {w}", "change {r} to {w}", *verbs])
        return tpl.format(r=ref, w=w), exp
    if cat == "move":
        if not (p := pick_target(scene, rng)):
            return None
        el, ref = p
        d = rng.choice(list(DIRECTION_WORDS))
        exp = {**blank("move_element"), "target": el["id"], "direction": d}
        verb = rng.choice(["move", "shift", "nudge", "push", "slide", "drag", "move", "bump"])
        if rng.random() < 0.08:
            wrong = rng.choice([x for x in DIRECTION_WORDS if x != d])
            return f"{verb} {ref} {wrong}{rng.choice(CORRECTIONS).format(d)}", exp
        return f"{verb} {ref} {rng.choice(DIRECTION_WORDS[d])}", exp
    if cat == "move_rel":
        if len(els) < 2:
            return None
        el, other = rng.sample(els, 2)
        ref = rng.choice(references(el, scene, rng))
        oref = rng.choice([r for r in references(other, scene, rng) if r not in PRONOUN_REFS] or [f"the {other['label'].lower()}"])
        rel = rng.choice(["next to", "below", "above", "to the left of", "under", "beside", "on top of"])
        return f"move {ref} {rel} {oref}", {**blank("move_element"), "target": el["id"]}
    if cat == "add_shape":
        kind = rng.choice(list(NEW_SHAPE_NOUNS))
        noun = rng.choice(NEW_SHAPE_NOUNS[kind])
        exp = {**blank("add_shape"), "kind": kind}
        adj = []
        if rng.random() < 0.45:
            exp["color"] = rng.choice(COLORS)
            adj.append(exp["color"])
        if rng.random() < 0.15:
            exp["size"] = rng.choice(["small", "large"])
            adj.insert(0, rng.choice(["tiny", "small"] if exp["size"] == "small" else ["big", "large"]))
        art = "an" if (adj or [noun])[0][0] in "aeiou" else "a"
        verb = rng.choice(["add", "draw", "put", "create", "place", "make", "drop", "add", "draw"])
        where = rng.choice(["", "", "", " on the board", " here", " in the middle", " somewhere"])
        return f"{verb} {art} {' '.join([*adj, noun])}{where}", exp
    if cat == "labelled_shape":
        kind = rng.choice(list(NEW_SHAPE_NOUNS))
        noun = rng.choice(NEW_SHAPE_NOUNS[kind])
        exp = {**blank("add_shape"), "kind": kind, "needs_text": True}
        verb = rng.choice(["add", "draw", "create", "put", "make"])
        how = rng.choice(["called", "labelled", "labeled", "named", "saying", "that says", "with the text", "for"])
        return f"{verb} a {noun} {how} {rng.choice(NEW_TEXTS)}", exp
    if cat == "text":
        noun = rng.choice(["title", "heading", "caption", "label", "some text", "a note at the top"])
        verb = rng.choice(["write", "add", "put", "add", "type"])
        art = "" if noun.startswith(("some", "a ")) else "a "
        how = rng.choice(["saying", "that says", "called", "reading", ":"])
        return f"{verb} {art}{noun} {how} {rng.choice(NEW_TEXTS)}".replace(" :", ":"), {**blank("add_text"), "needs_text": True}
    if cat == "arrow":
        if len(els) < 2:
            return None
        a, b = rng.sample(els, 2)
        ra, rb = (f"the {words(e['label'])[0]}" if rng.random() < 0.5 else " ".join(words(e["label"])) for e in (a, b))
        tpl = rng.choice(["connect {a} to {b}", "draw an arrow from {a} to {b}", "link {a} and {b}", "{a} should point to {b}",
                          "add an arrow from {a} to {b}", "connect {a} with {b}", "point {a} at {b}"])  # fmt: skip
        return tpl.format(a=ra, b=rb), {"action": "add_arrow", "multi_step": False, "needs_text": False, "kind": "none",
                                         "size": "none", "direction": "none", "color": "none"}  # fmt: skip
    if cat == "rename":
        if not (p := pick_target(scene, rng)):
            return None
        el, ref = p
        tpl = rng.choice(["rename {r} to {t}", "change {r} to say {t}", "relabel {r} as {t}", "call {r} {t}",
                          "change the text of {r} to {t}", "{r} should say {t}", "retitle {r} {t}"])  # fmt: skip
        return tpl.format(r=ref, t=rng.choice(NEW_TEXTS)), {**blank("update_element"), "target": el["id"], "needs_text": True}
    if cat == "multi":
        two = [e for e in els]
        opts = ["shapes", "add_connect", "add_two", "three"]
        if len(two) >= 2:
            opts += ["delete_two", "recolor_move", "recolor_two", "move_delete", "view_edit", "view_delete", "mixed", "mixed", "mixed"]
        kind = rng.choice(opts)
        if kind == "mixed":  # new things, edits and arrows together: every core group
            a, b = (" ".join(words(e["label"])) for e in rng.sample(els, 2))
            noun, new = rng.choice(["box", "circle", "note", "diamond"]), rng.choice(NEW_TEXTS)
            text = rng.choice([
                f"add a {noun} called {new} and make the {a} {rng.choice(COLORS)}",
                f"connect the {a} to the {b} and make it {rng.choice(COLORS)}",
                f"delete the {a} and add a {noun} saying {new}",
                f"make the {a} bigger and draw an arrow to the {b}",
                f"add a {noun} next to the {a} and connect them",
                f"move the {a} {rng.choice(['left', 'right', 'up', 'down'])} and link it to the {b}",
                f"rename the {a} to {new} and add a {noun} below it",
            ])  # fmt: skip
            return text, {"action": "add_shape" if text.startswith("add") else "update_element", "multi_step": True, "core": "mixed"}
        if kind in ("view_edit", "view_delete"):  # a view change plus an edit: two changes, so it goes to the assistant
            ra = " ".join(words(rng.choice(els)["label"]))
            verb = rng.choice(["zoom in on", "go to", "focus on"] if kind == "view_edit" else ["scroll to", "go to", "find"])
            edit = f"make it {rng.choice(COLORS)}" if kind == "view_edit" else "delete it"
            view = "in" if verb == "zoom in on" else "element"
            return f"{verb} the {ra} and {edit}", {"action": "view", "view": view, "multi_step": True, "needs_text": False, "core": "edit"}
        if kind in ("shapes", "add_two"):
            k1, k2 = rng.sample(list(NEW_SHAPE_NOUNS), 2)
            text = f"{rng.choice(['add', 'draw'])} a {NEW_SHAPE_NOUNS[k1][0]} and a {NEW_SHAPE_NOUNS[k2][0]}"
            return text, {"action": "add_shape", "multi_step": True, "needs_text": False}
        if kind == "three":
            n = rng.choice(["two", "three", "four"])
            names = rng.sample(NEW_TEXTS, 3)
            text = f"add {n} boxes" + (f" called {names[0]}, {names[1]} and {names[2]}" if rng.random() < 0.5 else "")
            return text, {"action": "add_shape", "multi_step": True, "needs_text": "called" in text}
        if kind == "add_connect":
            if not els:
                return None
            other = " ".join(words(rng.choice(els)["label"]))
            text = f"add a box called {rng.choice(NEW_TEXTS)} and connect it to {other}"
            return text, {"action": "add_shape", "multi_step": True, "needs_text": True, "core": "mixed"}
        a, b = rng.sample(els, 2)
        ra, rb = (" the " + " ".join(words(e["label"])) for e in (a, b))
        if kind == "delete_two":
            return f"delete{ra} and{rb}", {"action": "delete_elements", "multi_step": True, "needs_text": False}
        if kind == "recolor_two":
            return f"make{ra} and{rb} {rng.choice(COLORS)}", {"action": "update_element", "multi_step": True, "needs_text": False}
        if kind == "recolor_move":
            text = f"make{ra} {rng.choice(COLORS)} and move it {rng.choice(['left', 'right', 'up', 'down'])}"
            return text, {"action": "update_element", "multi_step": True, "needs_text": False}
        return f"move{ra} {rng.choice(['left', 'down'])} and delete{rb}", {"action": "move_element", "multi_step": True, "needs_text": False}
    if cat == "group":
        types = sorted({e["type"] for e in els if e["type"] != "text"})
        if not types:
            return None
        t = rng.choice(types)
        noun = rng.choice(PLURAL_NOUNS[t])
        q = rng.choice(["all the", "all", "every", "each", "the", "all of the"])
        if q in ("every", "each"):
            noun = rng.choice(KIND_NOUNS[t])
        grp = f"{q} {noun}"
        verb_kind = rng.choice(["delete", "recolor", "move", "resize"])
        if verb_kind == "delete":
            return f"{rng.choice(['delete', 'remove', 'get rid of'])} {grp}", {"action": "delete_elements", "multi_step": True, "needs_text": False}
        if verb_kind == "recolor":
            c = rng.choice(COLORS)
            return f"{rng.choice(['make', 'turn', 'color'])} {grp} {c}", {"action": "update_element", "color": c, "multi_step": True,
                                                                         "needs_text": False, "direction": "none", "kind": "none"}  # fmt: skip
        if verb_kind == "resize":
            s = rng.choice(["small", "large"])
            return f"make {grp} {rng.choice(SIZE_WORDS[s][:2])}", {"action": "update_element", "size": s, "multi_step": True,
                                                                   "needs_text": False, "color": "none", "kind": "none"}  # fmt: skip
        d = rng.choice(list(DIRECTION_WORDS))
        return f"move {grp} {rng.choice(DIRECTION_WORDS[d][:2])}", {"action": "move_element", "direction": d, "multi_step": True,
                                                                    "needs_text": False, "kind": "none"}  # fmt: skip
    if cat == "view":
        kind = rng.choices(["in", "in_on", "out", "level", "fit", "element", "edge", "direction"], [4, 3, 4, 3, 3, 5, 3, 5])[0]
        exp = {**blank("view"), "view": kind}
        if kind in ("in_on", "element"):
            if not (p := pick_target(scene, rng)):
                return None
            el, ref = p
            exp["target"] = el["id"]
            if kind == "in_on":
                return rng.choice(VIEW_IN_ON).format(r=ref), {**exp, "view": "in"}
            return rng.choice(VIEW_ELEMENT).format(r=ref), exp
        if kind == "level":
            tpl = rng.choice(VIEW_LEVEL)
            return tpl.format(n=rng.choice([25, 50, 75, 80, 120, 125, 150, 200, 250, 300, 400]), k=rng.choice([2, 3, 4])), exp
        if kind == "edge":
            d = rng.choice(list(VIEW_EDGE))
            return rng.choice(VIEW_EDGE[d]), {**exp, "direction": d}
        if kind == "direction":
            d = rng.choice(list(VIEW_BEYOND))
            return rng.choice(VIEW_DIRECTION).format(d=d, w=VIEW_BEYOND[d]), {**exp, "direction": d}
        return rng.choice({"in": VIEW_IN, "out": VIEW_OUT, "fit": VIEW_FIT}[kind]), exp
    if cat == "other":
        refs = [rng.choice(references(el, scene, rng)) for el in rng.sample(els, min(2, len(els)))]
        extra = rng.choice(["object", "object", "diagram", "graph", "chart", "motion", "dimension"])
        tpls = {"object": OTHER_OBJECT, "diagram": OTHER_DIAGRAM, "graph": OTHER_GRAPH, "chart": OTHER_CHART,
                "motion": OTHER_MOTION, "dimension": OTHER_MEASURE}[extra]  # fmt: skip
        tpls = [t for t in tpls if ("{r}" not in t or refs) and ("{s}" not in t or len(refs) == 2)]
        if not tpls:
            return None
        text = rng.choice(tpls).format(o=rng.choice(OBJECTS), t=rng.choice(TOPICS), x=rng.choice(DATA), f=rng.choice(FUNCS),
                                       r=(refs or [""])[0], s=refs[-1] if refs else "", n=rng.choice([2, 3, 5, 10, 12, 20, 30]))  # fmt: skip
        # Only what such a command clearly answers; colour, kind, target... stay unlabelled. Motion moves an existing
        # element (edit); the rest draw something new.
        return text, {"action": "other", "view": "none", "core": "edit" if extra == "motion" else "new"}
    raise ValueError(cat)


PRONOUN_REFS = {"it", "this", "that", "this one", "that one"}
# Category weights; labelled noise is applied on top of the single-element categories.
WEIGHTS = {"chatter": 11, "undo": 6, "clear": 4, "delete": 11, "recolor": 14, "resize": 9, "move": 11, "move_rel": 2,
           "add_shape": 10, "labelled_shape": 5, "text": 4, "arrow": 4, "rename": 4, "multi": 10, "group": 6,
           "view": 14, "other": 12}  # fmt: skip
NOISY = {"delete", "recolor", "resize", "move", "add_shape", "undo", "chatter", "view", "other"}
# The `route` answer per category: what code alone can build vs what needs the assistant.
SIMPLE = {"undo", "clear", "delete", "recolor", "resize", "move", "add_shape", "group", "view"}
# The `core` answer per category (the cloud's core tool groups); multi and other rows set their own.
CORE_OF = {"delete": "edit", "recolor": "edit", "resize": "edit", "move": "edit", "move_rel": "edit", "rename": "edit",
           "group": "edit", "add_shape": "new", "labelled_shape": "new", "text": "new", "arrow": "connect"}  # fmt: skip


def add_noise(text: str, rng: random.Random) -> str:
    if rng.random() < 0.25:
        text = f"{rng.choice(FILLERS)} {text}"
    if rng.random() < 0.08:
        first, _, rest = text.partition(" ")
        text = f"{first} {first} {rest}" if rng.random() < 0.5 else text.replace(" the ", " the, the ", 1)
    if rng.random() < 0.12:
        text = f"{text} {rng.choice(SUFFIXES)}"
    return text


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=4000)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--out", default="F:/temp/laya-train/train.jsonl")
    args = ap.parse_args()
    rng = random.Random(args.seed)

    eval_texts = set()
    for f in HERE.glob("samples*.jsonl"):
        eval_texts |= {" ".join(words(json.loads(line)["text"])) for line in f.read_text().splitlines() if line.strip()}

    cats, weights = zip(*WEIGHTS.items())
    rows, counts, dropped = [], {}, 0
    while len(rows) < args.n:
        scene = make_scene(rng)
        cat = rng.choices(cats, weights)[0]
        made = gen(cat, scene, rng)
        if not made:
            continue
        text, exp = made
        if cat in NOISY:
            text = add_noise(text, rng)
        if " ".join(words(text)) in eval_texts:
            dropped += 1
            continue
        multi_core = "edit" if exp["action"] in ("delete_elements", "update_element", "move_element") else "new"
        exp = {"view": "none", "core": CORE_OF.get(cat, multi_core if cat == "multi" else "none"), **exp}
        exp["on_board"] = exp["action"] != "none"
        exp["route"] = "none" if cat == "chatter" else "simple" if cat in SIMPLE else "assistant"
        questions = build_questions(scene)
        if "target" not in questions:
            exp.pop("target", None)
        rows.append({"state": {"command": text}, "questions": questions, "expected": exp, "cat": cat})
        counts[cat] = counts.get(cat, 0) + 1

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("".join(json.dumps(r) + "\n" for r in rows))
    print(f"{len(rows)} rows -> {out} (dropped {dropped} that matched eval commands)")
    print(dict(sorted(counts.items())))
    for r in rng.sample(rows, 25):
        print(f"  [{r['cat']}] {r['state']['command']!r} -> {r['expected']}")


if __name__ == "__main__":
    main()
