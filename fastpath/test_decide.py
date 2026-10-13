"""Tests for the code-only parts of fastpath/decide.py (no Laya needed): python -m unittest fastpath.test_decide"""

import unittest

from fastpath.decide import draws_object, has_measurement, measure_command, object_command, route_object

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



if __name__ == "__main__":
    unittest.main()
