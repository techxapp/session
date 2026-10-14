"""Tests for the rule tier (fastpath/rules.py), no model needed: python -m unittest fastpath.test_rules"""

import unittest

from fastpath.rules import Command, rule_command

SCENE = {
    "elements": [
        {"id": "api", "type": "rectangle", "label": "API Gateway", "color": "blue"},
        {"id": "cache", "type": "rectangle", "label": "Cache", "color": "orange"},
        {"id": "db", "type": "ellipse", "label": "Postgres"},
        {"id": "title", "type": "text", "label": "Sprint Board"},
        {"id": "s1", "type": "sticky", "label": "Buy milk", "color": "yellow"},
        {"id": "s2", "type": "sticky", "label": "Ship v2", "color": "yellow"},
        {"id": "tree", "type": "image", "label": "tree"},
        {"id": "a1", "type": "arrow", "from": "api", "to": "db"},
    ],
    "selectedIds": ["cache"],
    "recentIds": ["db"],
}


def actions(text: str):
    got = rule_command(text, SCENE)
    return got[1] if got and got[0] == "fast" else None


class Normalise(unittest.TestCase):
    def test_fillers_stutters_politeness_and_corrections(self):
        self.assertEqual(Command("um can you delete the, the cache please").w, ["delete", "the", "cache"])
        self.assertEqual(Command("make it red, no wait, blue").w, ["make", "it", "blue"])
        self.assertEqual(Command("move it left sorry I mean right").w, ["move", "it", "right"])
        self.assertEqual(Command("make it red or blue").w, ["make", "it", "red", "or", "blue"])


class Rules(unittest.TestCase):
    def test_answers(self):
        U = lambda t, **k: {"name": "update_element", "input": {"target": t, **k}}  # noqa: E731
        cases = {
            "undo": [{"name": "undo_last_command", "input": {}}],
            "oops, go back": [{"name": "undo_last_command", "input": {}}],
            "wipe the whole board": [{"name": "clear_board", "input": {"confirm": True}}],
            "delete it": [{"name": "delete_elements", "input": {"targets": ["cache"]}}],
            "remove the api gateway from the board": [{"name": "delete_elements", "input": {"targets": ["api"]}}],
            "delete all the notes": [{"name": "delete_elements", "input": {"targets": ["s1", "s2"]}}],
            "make the API red": [U("api", color="red")],
            "change the colour of postgres to grey": [U("db", color="gray")],
            "turn the yellow notes pink": [U("s1", color="pink"), U("s2", color="pink")],
            "make the tree big": [U("tree", size="large")],
            "make the title medium sized": [U("title", size="medium")],
            "nudge it a bit to the left": [{"name": "move_element", "input": {"target": "cache", "direction": "left", "distance": "little"}}],
            "move postgres down": [{"name": "move_element", "input": {"target": "db", "direction": "down"}}],
            "draw a big red circle": [{"name": "add_shape", "input": {"kind": "ellipse", "color": "red", "size": "large"}}],
            "put a sticky note at the bottom": [{"name": "add_shape", "input": {"kind": "sticky", "placement": {"region": "bottom"}}}],
            "add a box called Payments API": [{"name": "add_shape", "input": {"id": "payments-api", "kind": "rectangle", "label": "Payments API"}}],
            "add a heading saying Q3 goals": [{"name": "add_text", "input": {"id": "q3-goals", "text": "Q3 goals", "style": "heading"}}],
            "rename the cache to Redis": [U("cache", label="Redis")],
            "change the label of the ship v2 note to ship v3": [U("s2", label="ship v3")],
            "change the title to Retro": [U("title", label="Retro")],
            "connect the cache to postgres": [{"name": "add_arrow", "input": {"from": "cache", "to": "db"}}],
            "draw a red dotted arrow between the api and the cache": [
                {"name": "add_arrow", "input": {"from": "api", "to": "cache", "color": "red", "style": "dotted"}}
            ],
            "draw a tree": [{"name": "add_object", "input": {"id": "tree", "object": "tree"}}],
        }
        for text, want in cases.items():
            with self.subTest(text):
                self.assertEqual(actions(text), want)

    def test_falls_through(self):
        for text in [
            "make it bigger",
            "make it red or blue",
            "change the cache to a circle",
            "change the title to red and bold",
            "make the tree red",  # objects have no colour
            "delete the database",  # a synonym: Laya's job
            "delete the box",  # two boxes
            "delete the cache next to the api",
            "move it next to postgres",
            "move the cache to the left of the api",
            "rename all the notes to done",
            "add a box called payments and connect it to the api",
            "add a sticky saying call mom on the right",
            "add a box called payments no wait billing",
            "add three boxes",
            "connect the api to the database",
            "connect the cache to the cache",
            "I'll delete that later",
            "what if we made the api red",
            "the cache is red",
            "write that down",
            "clear",
            "let's grab a tree",  # casual verb: Laya decides whether it's for the board
            "hey can you hear me",
        ]:
            with self.subTest(text):
                self.assertIsNone(rule_command(text, SCENE))

    def test_measurements_settle_in_code(self):
        self.assertEqual(rule_command("draw a box 10 ft wide", SCENE)[0], "fast")
        self.assertEqual(rule_command("I walked 20 ft", SCENE)[:2], ("llm", None))


KIDS = {
    "elements": [
        {"id": "boy", "type": "image", "label": "boy"},
        {"id": "girl", "type": "image", "label": "girl"},
        {"id": "dog", "type": "image", "label": "dog"},
        {"id": "house", "type": "rectangle", "label": "House"},
    ],
    "selectedIds": [],
    "recentIds": ["dog"],
}


class Motion(unittest.TestCase):
    def test_answers(self):
        A = lambda **k: [{"name": "animate_element", "input": k}]  # noqa: E731
        cases = {
            "boy moving towards girl": A(target="boy", toward="girl"),
            "the boy walks towards the girl": A(target="boy", toward="girl"),
            "the boy is walking up to the girl please": A(target="boy", toward="girl"),
            "the dog runs to the house": A(target="dog", toward="house", speed="fast"),
            "the dog is running away from the boy": A(target="dog", away_from="boy", speed="fast"),
            "the girl strolls over to the house": A(target="girl", toward="house", speed="slow"),
            "move the boy towards the girl": A(target="boy", toward="girl"),
            "it goes to the girl": A(target="dog", toward="girl"),
        }
        for text, want in cases.items():
            with self.subTest(text):
                got = rule_command(text, KIDS)
                self.assertEqual(got and got[:2], ("fast", want))

    def test_needs_llm(self):
        for text in [
            "the boy walks to the girl and then to the house",
            "the boy walks slowly to the girl",
            "the dog chases the boy across the board",
            "the boy walks to the boy",
            "the kid walks to the girl",  # a synonym
        ]:
            with self.subTest(text):
                self.assertEqual(rule_command(text, KIDS)[:2], ("llm", None))

    def test_not_motion(self):
        for text in ["move the boy to the left of the girl", "move the boy next to the girl", "put the boy next to the girl"]:
            with self.subTest(text):
                self.assertIsNone(rule_command(text, KIDS))


class Scroll(unittest.TestCase):
    def test_answers(self):
        S = lambda **k: [{"name": "scroll_view", "input": k}]  # noqa: E731
        cases = {
            "scroll down": S(direction="down"),
            "pan left a bit": S(direction="left", distance="little"),
            "scroll the page up a lot": S(direction="up", distance="far"),
            "scroll down a page": S(direction="down", distance="far"),
            "move the view right": S(direction="right"),
            "um, scroll left, no wait, right": S(direction="right"),
            "can you scroll a little further down please": S(direction="down", distance="little"),
            "go to the left": S(direction="left"),
            "scroll all the way up": S(edge="top"),
            "scroll all the way to the left": S(edge="left"),
            "back to the top": S(edge="top"),
            "go to the bottom of the board": S(edge="bottom"),
            "jump to the start": S(edge="top"),
            "go to postgres": S(to="db"),
            "take me to the cache": S(to="cache"),
            "scroll down to the api gateway": S(to="api"),
            "show me the sprint board": S(to="title"),
            "focus on it": S(to="cache"),
            "show everything": S(fit="all"),
            "show me the whole board": S(fit="all"),
            "zoom to fit": S(fit="all"),
        }
        for text, want in cases.items():
            with self.subTest(text):
                got = rule_command(text, SCENE)
                self.assertEqual(got and got[:2], ("fast", want))

    def test_needs_llm(self):
        for text in [
            "scroll down and add a box",
            "scroll the api down",
            "scroll a bit",
            "pan up and to the left",
            "scroll to the database",  # a synonym
            "move the camera somewhere else",
        ]:
            with self.subTest(text):
                self.assertEqual(rule_command(text, SCENE)[:2], ("llm", None))

    def test_not_scroll(self):
        self.assertEqual(actions("move the cache down"), [{"name": "move_element", "input": {"target": "cache", "direction": "down"}}])
        for text in ["show me a tree", "move the canvas down", "zoom in"]:
            with self.subTest(text):
                got = rule_command(text, SCENE)
                self.assertFalse(got and got[1] and got[1][0]["name"] == "scroll_view")


class Diagram(unittest.TestCase):
    def test_needs_llm(self):
        for text in [
            "draw a flowchart for user login",
            "um, sketch the architecture of a web app",
            "make an org chart for a small startup",
            "draw a mind map about holidays",
            "show the ci pipeline",
        ]:
            with self.subTest(text):
                self.assertEqual(rule_command(text, SCENE)[:2], ("llm", None))

    def test_templates_still_win(self):
        got = rule_command("add a box labelled architecture", SCENE)
        self.assertEqual(got and got[0], "fast")


class Plot(unittest.TestCase):
    def test_needs_llm(self):
        for text in [
            "plot y = x^2",
            "y = 2x + 1",
            "draw the graph of sin x",
            "f(x) = x**3",
            "make a pie chart of rent 40 food 30 other 30",
            "draw a column chart of sales",
            "add a bar chart",
            "please draw a parabola",
        ]:
            with self.subTest(text):
                got = rule_command(text, SCENE)
                self.assertEqual(got and got[:2], ("llm", None))
                self.assertEqual(got[2], "graph needs the LLM")

    def test_org_chart_is_a_diagram(self):
        self.assertEqual(rule_command("make an org chart", SCENE)[2], "diagram needs the LLM")

    def test_templates_still_win(self):
        got = rule_command("add a box labelled chart", SCENE)
        self.assertEqual(got and got[0], "fast")

    def test_chart_edits_need_llm(self):
        chart = {
            "id": "c",
            "type": "chart",
            "label": "Spending",
            "data": 'pie; labels ["Rent","Eating out","Q2"]; series "2024" [40,30,30]; unit "k"; colors blue, red, green',
        }
        scene = {**SCENE, "elements": [*SCENE["elements"], chart]}
        for text in ["set Q2 to 20", "remove eating out", "make 2024 bigger"]:
            with self.subTest(text):
                self.assertEqual(rule_command(text, scene), ("llm", None, "graph needs the LLM"))
        self.assertIsNone(rule_command("set Q2 to 20", SCENE))  # no chart on the board
        self.assertIsNone(rule_command("make it k", scene))  # the unit is not a name
        self.assertEqual(rule_command("make the cache red", scene)[0], "fast")


if __name__ == "__main__":
    unittest.main()
