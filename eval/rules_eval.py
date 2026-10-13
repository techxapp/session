"""
Evaluate the rule tier (fastpath/rules.py) on its own: no model, no GPU, plain Python.

For each sample it reports which tier settles the command: "rules" (code answers it), "llm" (code knows it
needs the LLM, e.g. a measurement it can't build) or "next" (code passes; Laya, then the LLM, decide).

- Sets with a `rules` field per sample (samples_rules.jsonl): the expected actions, or null for commands that
  must fall through. Scored exactly, ignoring new-element ids.
- The Laya sets (samples*.jsonl with `expect`): a rule hit is scored against the action the Laya router would
  build from the expected answers (ignoring ids and move distance). Hits on commands the Laya router can't
  build (labels, renames, arrows, add_text) can't be scored that way and are listed for review.

Usage: python eval/rules_eval.py [--samples eval/samples_rules.jsonl]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent))
from eval.laya_eval import expected_of, expected_route  # noqa: E402
from fastpath.rules import rule_command  # noqa: E402

# Commands the Laya router sends to the LLM that rules may now build; anything else must not be ruled.
REVIEW_CATS = {"labelled_shape", "text", "rename", "arrow"}


def strip(actions: list[dict] | None, drop: set[str]) -> list[dict] | None:
    if actions is None:
        return None
    return [{"name": a["name"], "input": {k: v for k, v in a["input"].items() if k not in drop}} for a in actions]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--samples", default=str(HERE / "samples_rules.jsonl"))
    args = ap.parse_args()
    scenes = json.loads((HERE / "scenes.json").read_text())
    samples = [json.loads(line) for line in Path(args.samples).read_text(encoding="utf-8").splitlines() if line.strip()]

    hits, right, wrong, review, missed = 0, 0, [], [], []
    for s in samples:
        got = rule_command(s["text"], scenes[s["scene"]])
        tier = "next" if got is None else "rules" if got[0] == "fast" else got[0]
        actions = got[1] if got else None
        if "rules" in s:
            want = strip(s["rules"], {"id"})
            ok = strip(actions, {"id"}) == want if tier == "rules" else want is None
            if not ok:
                (wrong if tier == "rules" else missed).append((s, actions, want))
        else:
            exp_route, exp_action = expected_route(expected_of(s))
            if tier != "rules":
                ok = True
                if exp_route == "fast":
                    missed.append((s, None, exp_action))
            elif exp_route == "fast":
                ok = strip(actions, {"id", "distance"}) == strip(exp_action, {"id"})
                if not ok:
                    wrong.append((s, actions, exp_action))
            elif s["cat"] in REVIEW_CATS:
                ok = True
                review.append((s, actions, None))
            else:
                ok = False
                wrong.append((s, actions, exp_route))
        hits += tier == "rules"
        right += ok and tier == "rules"
        print(f"  #{s['id']:<4} {tier:<6} {'ok ' if ok else 'BAD'} {s['text']!r}  {got[2] if got else ''}")

    print(f"\n{Path(args.samples).name}: {len(samples)} commands, rules answered {hits} ({right} right, {len(wrong)} wrong)")
    for title, rows in (("Wrong (applied by rules)", wrong), ("Missed (rules passed, expected a rule answer)", missed),
                        ("Review (rules built what the Laya router sends to the LLM)", review)):  # fmt: skip
        if rows:
            print(f"\n{title}:")
            for s, got, want in rows:
                print(f"  #{s['id']} {s['text']!r}\n      got  {json.dumps(got)}\n      want {json.dumps(want)}")


if __name__ == "__main__":
    main()
