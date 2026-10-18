"""Sidecar wiring with a fake decision model: what the model is asked and how its answers come back (no torch)."""

from __future__ import annotations

import unittest

from fastpath.server import MAX_TARGET_OPTIONS, FastPath


def answers(**over) -> dict:
    ans = {
        "on_board": (True, 1.0), "route": ("simple", 1.0), "action": ("delete_elements", 1.0), "target": ("none", 1.0),
        "color": ("none", 1.0), "kind": ("none", 1.0), "size": ("none", 1.0), "direction": ("none", 1.0),
        "view": ("none", 1.0), "multi_step": (False, 1.0), "needs_text": (False, 1.0), "core": ("edit", 1.0),
    }  # fmt: skip
    return {**ans, **over}


class FakeModel:
    """Answers with a fixed target chosen by its description, as a trained model would; records each call's questions."""

    name, device = "fake:test", "cpu"

    def __init__(self, max_targets: int | None, pick: str):
        self.max_targets, self.pick, self.asked = max_targets, pick, []

    def load(self) -> None: ...

    def unload(self) -> None: ...

    def answers(self, text: str, questions: dict) -> dict:
        self.asked.append(questions)
        crit = questions.get("target", {}).get("criteria", {})
        hit = next((k for k, d in crit.items() if self.pick in d), None)
        return answers(target=(hit, 0.99)) if hit else answers()


def board(n: int) -> dict:
    """n boxes with Excalidraw-style ids; the last one is labelled Postgres."""
    els = [{"id": f"Xk{i}aaaaaaaaaaaaaaaaa", "type": "rectangle", "label": "Postgres" if i == n - 1 else f"Box {i}"} for i in range(n)]
    return {"elements": els, "selectedIds": [], "recentIds": []}


class TestModelWiring(unittest.TestCase):
    def ask(self, model: FakeModel, scene: dict) -> dict:
        return FastPath(model, 0.8, keep_warm_s=0, idle_unload_s=0).ask("bin the database thing", scene)

    def test_heads_model_gets_every_element_and_ids_map_back(self):
        scene = board(MAX_TARGET_OPTIONS + 5)
        model = FakeModel(None, '"Postgres"')
        got = self.ask(model, scene)
        self.assertEqual(len(model.asked[-1]["target"]["criteria"]), MAX_TARGET_OPTIONS + 6)  # + "none"
        self.assertEqual(got["route"], "fast")
        self.assertEqual(got["actions"], [{"name": "delete_elements", "input": {"targets": [scene["elements"][-1]["id"]]}}])
        self.assertEqual(got["model"], "fake:test")

    def test_laya_sized_model_loses_the_target_question_on_a_big_board(self):
        model = FakeModel(MAX_TARGET_OPTIONS, '"Postgres"')
        got = self.ask(model, board(MAX_TARGET_OPTIONS + 5))
        self.assertNotIn("target", model.asked[-1])
        self.assertEqual(got["route"], "llm")  # unknown target, not confidently "none"


if __name__ == "__main__":
    unittest.main()
