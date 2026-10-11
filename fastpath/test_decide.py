"""Tests for the code-only parts of fastpath/decide.py (no Laya needed): python -m unittest fastpath.test_decide"""

import unittest

from fastpath.decide import draws_object, object_command, route_object

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
            "um, add a pine tree on the board": ("pine tree", None, False),
            "sketch me a dog": ("dog", None, False),
            "let's grab a tree": ("tree", None, True),
            "I want a sunflower": ("sunflower", None, True),
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
        self.assertEqual(object_command("add a pine tree")["object"], "pine tree")
        self.assertEqual(route_object(object_command("add a pine tree"), None, 0.8)[1][0]["input"]["id"], "pine-tree")
        grab = object_command("let's grab a coffee")
        self.assertEqual(route_object(grab, YES, 0.8)[0], "fast")
        self.assertEqual(route_object(grab, UNSURE, 0.8)[0], "llm")
        self.assertEqual(route_object(grab, NO, 0.8)[0], "llm")

    def test_draws_object_guard(self):
        self.assertEqual(draws_object("add a tree next to the house", "llm", None), "house")
        self.assertIsNone(draws_object("make the tree bigger", "fast", [{"name": "update_element", "input": {}}]))
        self.assertIsNone(draws_object("add a box called API", "fast", [{"name": "add_shape", "input": {}}]))


if __name__ == "__main__":
    unittest.main()
