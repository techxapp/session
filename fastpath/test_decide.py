"""Tests for the code-only parts of fastpath/decide.py (no Laya needed): python -m unittest fastpath.test_decide"""

import unittest

from fastpath.decide import (
    code_answers,
    draws_object,
    guard,
    has_measurement,
    measure_command,
    object_command,
    resolve_target,
    route_object,
    route_why,
    tool_hint,
    view_amount,
    zoom_level,
)

YES = {"on_board": (True, 0.95)}
UNSURE = {"on_board": (True, 0.5)}
NO = {"on_board": (False, 0.9)}


class ObjectCommand(unittest.TestCase):
    def test_simple_commands_parse(self):
        cases = {
            "draw a tree": ("tree", None, False),
            "Draw a tree.": ("tree", None, False),
            "add a big tree please": ("tree", "large", False),
            "can you put a small kid here": ("child", "small", False),
            "um, add a pine tree on the board": ("tree", None, False),
            "sketch me a dog": ("dog", None, False),
            "let's grab a tree": ("tree", None, True),
            "I want a sunflower": ("flower", None, True),
        }
        for text, (obj, size, casual) in cases.items():
            with self.subTest(text):
                self.assertEqual(object_command(text), {"object": obj, "size": size, "casual": casual})

    def test_anything_more_goes_to_the_llm(self):
        for text in [
            "draw a man and a child",
            "draw two trees",
            "add a tree next to the house",
            "draw a tree labelled oak",
            "add a box",
            "draw a circle",
            "make the tree bigger",
            "make a tree",
            "I love trees",
            "draw a giraffe-shaped cake",
            "the tree",
        ]:
            with self.subTest(text):
                self.assertIsNone(object_command(text))

    def test_routing(self):
        draw = object_command("draw a big tree")
        self.assertEqual(
            route_object(draw, None, 0.8), ("fast", [{"name": "add_object", "input": {"id": "tree", "object": "tree", "size": "large"}}], "add_object tree")
        )
        self.assertEqual(object_command("add a police car")["object"], "police car")
        self.assertEqual(route_object(object_command("add a police car"), None, 0.8)[1][0]["input"]["id"], "police-car")
        grab = object_command("let's grab a coffee")
        self.assertEqual(route_object(grab, YES, 0.8)[0], "fast")
        self.assertEqual(route_object(grab, UNSURE, 0.8)[0], "llm")
        self.assertEqual(route_object(grab, NO, 0.8)[0], "llm")

    def test_draws_object_guard(self):
        self.assertEqual(draws_object("add a tree next to the house", "llm", None), "house")
        self.assertIsNone(draws_object("make the tree bigger", "fast", [{"name": "update_element", "input": {}}]))
        self.assertIsNone(draws_object("add a box called API", "fast", [{"name": "add_shape", "input": {}}]))


def el(id, type, label=None):
    return {"id": id, "type": type, "label": label, "x": 0, "y": 0, "w": 100, "h": 100}


SCENE = {
    "elements": [el("t1", "image", "tree"), el("m1", "image", "man"), el("h1", "image", "house"), el("b1", "rectangle", "API")],
    "selectedIds": [],
    "recentIds": ["b1", "h1", "m1", "t1"],
}


def dim(label, **inp):
    return {"name": "add_dimension", "input": {**inp, "label": label}}


class MeasureCommand(unittest.TestCase):
    def test_has_measurement(self):
        for text in ["draw a tree of height 10 ft", "distance between them is 20 ft", "make it 5 meters wide", "the pole is 6'"]:
            self.assertTrue(has_measurement(text), text)
        for text in ["draw a tree", "add 3 boxes", "move it 10 pixels left", "make it blue", "a tree 10 in height"]:
            self.assertFalse(has_measurement(text), text)

    def test_new_thing_with_a_measurement(self):
        tree = {"name": "add_object", "input": {"id": "tree", "object": "tree"}}
        cases = {
            "draw a tree of height 10 ft": [tree, dim("10 ft", target="tree")],
            "Draw a 10 ft tall tree.": [tree, dim("10 ft", target="tree")],
            "can you add a tree that is 10 feet high please": [tree, dim("10 feet", target="tree")],
            "draw a big tree 3 m tall": [{"name": "add_object", "input": {"id": "tree", "object": "tree", "size": "large"}}, dim("3 m", target="tree")],
            "add a box 5 m wide": [{"name": "add_shape", "input": {"id": "box", "kind": "rectangle"}}, dim("5 m", target="box", axis="width")],
        }
        for text, actions in cases.items():
            with self.subTest(text):
                self.assertEqual(measure_command(text, SCENE)[0], actions)

    def test_existing_element(self):
        cases = {
            "the tree is 10 ft tall": dim("10 ft", target="t1"),
            "height of the house is 30 ft": dim("30 ft", target="h1"),
            "the API box is 2 m wide": dim("2 m", target="b1", axis="width"),
            "it is 4 m high": dim("4 m", target="b1"),
        }
        for text, action in cases.items():
            with self.subTest(text):
                self.assertEqual(measure_command(text, SCENE)[0], [action])

    def test_distance(self):
        cases = {
            "the distance between the man and the tree is 20 ft": ("m1", "t1"),
            "distance between 2 objects is 20 ft": ("b1", "h1"),
            "the man and the house are 20 ft apart": ("m1", "h1"),
            "the tree is 20 ft away from the house": ("t1", "h1"),
            "draw a line between the man and the tree of 20 ft": ("m1", "t1"),
        }
        for text, (a, b) in cases.items():
            with self.subTest(text):
                self.assertEqual(measure_command(text, SCENE)[0], [dim("20 ft", **{"from": a, "to": b})])
        selected = {**SCENE, "selectedIds": ["t1", "m1"]}
        self.assertEqual(measure_command("they are 20 ft apart", selected)[0], [dim("20 ft", **{"from": "t1", "to": "m1"})])

    def test_left_to_the_llm(self):
        for text in [
            "I walked 20 ft today",
            "make the box 5 m wide",
            "move it 10 ft left",
            "the tree is 10 ft",  # no height/width word
            "the car is 10 ft tall",  # nothing called car
            "the tree is 10 ft tall and make it red",
            "draw a tree 20 ft from the house",
            "the man and the tree are 20 ft apart, 10 ft tall",
            "distance between the man and the dog is 20 ft",
            "let's grab a tree 10 ft tall",
            "draw a tree next to the house 10 ft tall",
        ]:
            with self.subTest(text):
                self.assertIsNone(measure_command(text, SCENE))
        one_selected = {**SCENE, "selectedIds": ["t1"]}
        self.assertIsNone(measure_command("the distance between them is 20 ft", one_selected))



def answers(**over):
    """Confident answers for a fast single command, with overrides as values (confidence 0.95)."""
    base = {"on_board": True, "route": "simple", "action": "view", "target": "none", "color": "none", "kind": "none",
            "size": "none", "direction": "none", "view": "none", "multi_step": False, "needs_text": False}  # fmt: skip
    text = over.pop("text", "")
    return {**{k: (v, 0.95) for k, v in {**base, **over}.items()}, **code_answers(text)}


class ViewAnswers(unittest.TestCase):
    def test_zoom_level(self):
        cases = {"zoom to 150%": 150, "150 percent zoom": 150, "make it 2x": 200, "1.5x please": 150, "zoom 3 times": 300,
                 "put the zoom back to normal": 100, "reset it": 100, "zoom to 2": None, "zoom to 5000%": None,
                 "zoom between 50 and 80": None, "zoom in": None}  # fmt: skip
        for text, level in cases.items():
            with self.subTest(text):
                self.assertEqual(zoom_level(text), level)

    def test_view_amount(self):
        cases = {"zoom out a bit": "little", "scroll down a lot": "far", "zoom way out": "far", "scroll the page down": None,
                 "a little bit more, a lot": None, "zoom in": None}  # fmt: skip
        for text, amount in cases.items():
            with self.subTest(text):
                self.assertEqual(view_amount(text), amount)

    def test_compose(self):
        cases = [
            (dict(view="in", text="get closer"), {"name": "zoom_view", "input": {"step": "in"}}),
            (dict(view="out", text="pull back a bit"), {"name": "zoom_view", "input": {"step": "out", "amount": "little"}}),
            (dict(view="in", target="db"), {"name": "zoom_view", "input": {"step": "in", "on": "db"}}),
            (dict(view="level", text="make the zoom 200%"), {"name": "zoom_view", "input": {"level": 200}}),
            (dict(view="fit"), {"name": "scroll_view", "input": {"fit": "all"}}),
            (dict(view="element", target="db"), {"name": "scroll_view", "input": {"to": "db"}}),
            (dict(view="edge", direction="up"), {"name": "scroll_view", "input": {"edge": "top"}}),
            (dict(view="direction", direction="left", text="pan left a lot"), {"name": "scroll_view", "input": {"direction": "left", "distance": "far"}}),
        ]  # fmt: skip
        for over, action in cases:
            with self.subTest(over):
                self.assertEqual(route_why(answers(**over), 0.8)[:2], ("fast", [action]))

    def test_incomplete_views_go_to_the_llm(self):
        for over in [
            dict(view="level", text="zoom to a nice level"),  # no number
            dict(view="element"),  # no target
            dict(view="edge"),  # no direction
            dict(view="in", target=["a", "b"]),
            dict(view="none"),
        ]:
            with self.subTest(over):
                self.assertEqual(route_why(answers(**over), 0.8)[0], "llm")


class Router(unittest.TestCase):
    def test_route_gates_the_fast_path(self):
        delete = dict(action="delete_elements", target="db")
        self.assertEqual(route_why(answers(**delete), 0.8)[0], "fast")
        self.assertEqual(route_why(answers(**delete, route="assistant"), 0.8)[:3:2], ("llm", "router: needs the assistant"))
        unsure = answers(**delete)
        unsure["route"] = ("simple", 0.5)
        self.assertEqual(route_why(unsure, 0.8)[0], "llm")
        self.assertEqual(route_why(answers(action="other"), 0.8)[:3:2], ("llm", "needs the assistant"))

    def test_ignore_needs_all_three_signals(self):
        chatter = dict(on_board=False, action="none", route="none")
        self.assertEqual(route_why(answers(**chatter), 0.8)[0], "ignore")
        self.assertEqual(route_why(answers(**{**chatter, "route": "assistant"}), 0.8)[0], "llm")
        self.assertEqual(route_why(answers(**{**chatter, "action": "other"}), 0.8)[0], "llm")

    def test_tool_hint_needs_confidence(self):
        self.assertEqual(tool_hint({"core": ("edit", 0.98)}, 0.97), {"core": ["edit"]})
        self.assertEqual(tool_hint({"core": ("mixed", 0.99)}, 0.97), {"core": ["draw", "edit", "arrow"]})
        self.assertEqual(tool_hint({"core": ("none", 0.94)}, 0.97), {"core": None})
        self.assertEqual(tool_hint({}, 0.97), {"core": None})

    def test_view_actions_are_edits_for_the_object_guard(self):
        self.assertIsNone(draws_object("zoom in on the tree", "fast", [{"name": "zoom_view", "input": {"step": "in", "on": "t1"}}]))


NOTES = {
    "elements": [{"id": "s1", "type": "sticky", "label": "Buy milk", "color": "yellow"},
                 {"id": "s2", "type": "sticky", "label": "Ship v2", "color": "yellow"},
                 {"id": "s3", "type": "sticky", "label": "Fix login bug", "color": "pink"}],
    "selectedIds": [], "recentIds": ["s3"],
}  # fmt: skip


class Guards(unittest.TestCase):
    def decide(self, text, **over):
        rule = resolve_target(text, NOTES)
        ans = answers(**over)
        if rule:
            ans["target"] = (rule[0], 1.0)
        return route_why(guard(ans, text, rule), 0.8)

    def test_filter_colour_is_not_the_new_colour(self):
        recolor = dict(action="update_element", view="none")
        self.assertEqual(self.decide("turn all the yellow notes pink", **recolor, color="yellow")[0], "llm")
        self.assertEqual(self.decide("turn all the yellow notes pink", **recolor, color="pink")[:2], (
            "fast", [{"name": "update_element", "input": {"target": t, "color": "pink"}} for t in ("s1", "s2")]))
        self.assertEqual(self.decide("make all the notes yellow", **recolor, color="yellow")[0], "fast")

    def test_never_ignore_a_named_element(self):
        chatter = dict(on_board=False, action="none", route="none", view="none")
        self.assertEqual(self.decide("where's the milk note, I can't find it", **chatter)[0], "llm")
        self.assertEqual(self.decide("how was your weekend", **chatter)[0], "ignore")


if __name__ == "__main__":
    unittest.main()
