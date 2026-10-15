"""Tests for conjunction splitting (fastpath/split.py) and split decisions, no model: python -m unittest fastpath.test_split"""

import unittest

from fastpath.server import RulesOnly
from fastpath.split import split_command
from fastpath.test_rules import SCENE


def obj(name: str) -> dict:
    return {"name": "add_object", "input": {"id": name, "object": name}}


class Split(unittest.TestCase):
    def test_splits(self):
        for text, want in [
            ("draw apple and mango", ["draw apple", "draw mango"]),
            ("increase zoom and reduce square size", ["increase zoom", "reduce square size"]),
            ("make the box red and the circle blue", ["make the box red", "make the circle blue"]),
            ("delete the box, then undo", ["delete the box", "undo"]),
            ("zoom in and then draw a star", ["zoom in", "draw a star"]),
            ("draw a tree, a house and a car", ["draw a tree", "draw a house", "draw a car"]),
            ("ok, draw a tree and a house, please", ["ok, draw a tree", "draw a house, please"]),
            ("get rid of the box and the circle", ["get rid of the box", "get rid of the circle"]),
            ("draw a tree; zoom in", ["draw a tree", "zoom in"]),
            ("draw a fork and knife and a tree", ["draw a fork and knife", "draw a tree"]),
        ]:
            with self.subTest(text):
                self.assertEqual(split_command(text), want)

    def test_keeps_together(self):
        for text in [
            "connect A and B",
            "link the api and the cache",
            "add a note saying salt and pepper",
            "rename X to Tom and Jerry",
            "make it red, no wait, blue",
            "make the cache blue, sorry, I mean purple",
            "uh delete the, the error box",
            "draw a box and make it red",  # "it" is the new box: the clauses can't be decided apart
            "the tree and the man are 10 ft apart",
            "draw a fork and knife",
            "make the box big and red",  # "make red" says nothing about what
            'add a note "this and that"',
            "draw a cat, then a dog, then a tree, then a car",  # more than MAX_PARTS
            "draw a tree",
        ]:
            with self.subTest(text):
                self.assertIsNone(split_command(text))

    def test_board_label_with_and(self):
        scene = {"elements": [{"id": "sp", "type": "rectangle", "label": "Salt and Pepper"}]}
        self.assertIsNone(split_command("make the salt and pepper box red", scene))
        self.assertEqual(split_command("make the salt and pepper box red", {"elements": []}), ["make the salt", "make pepper box red"])


class Decide(unittest.TestCase):
    rules = RulesOnly()

    def decide(self, text: str) -> dict:
        return self.rules.decide(text, SCENE)

    def test_all_clauses_fast(self):
        got = self.decide("draw apple and mango")
        self.assertEqual((got["route"], got["actions"], got["model"]), ("fast", [obj("apple"), obj("mango")], "rules"))
        self.assertTrue(got["reason"].startswith("split: "))
        got = self.decide("make the cache red and delete the postgres circle")
        self.assertEqual(got["route"], "fast")
        self.assertEqual(
            got["actions"],
            [
                {"name": "update_element", "input": {"target": "cache", "color": "red"}},
                {"name": "delete_elements", "input": {"targets": ["db"]}},
            ],
        )
        got = self.decide("draw a tree and zoom in")
        self.assertEqual([a["name"] for a in got["actions"]], ["add_object", "zoom_view"])

    def test_one_clause_not_fast(self):
        got = self.decide("draw a tree and a flowchart")
        self.assertEqual((got["route"], got["actions"]), ("llm", None))
        self.assertTrue(got["reason"].startswith("part 2 'draw a flowchart'"), got["reason"])
        got = self.decide("draw an apple and then do something clever")
        self.assertEqual(got["route"], "llm")

    def test_whole_command_rule_first(self):
        got = self.decide("connect the cache and postgres")
        self.assertEqual((got["route"], got["reason"]), ("fast", "rule: add_arrow"))


class Catalog(unittest.TestCase):
    def test_extra_objects(self):
        from fastpath.decide import object_command
        from fastpath.rules import rule_command

        self.assertEqual(object_command("draw a mango")["object"], "mango")
        self.assertEqual(object_command("draw a fork and knife")["object"], "fork and knife")
        for text in ["draw a red circle", "add a blue square", "draw an up arrow"]:
            with self.subTest(text):
                self.assertIsNone(object_command(text))
        self.assertEqual(rule_command("draw a red circle", SCENE)[1][0]["name"], "add_shape")
        self.assertIsNone(object_command("draw a scroll"))  # "scroll" is a command word, not a picture
