"""
Evaluate Laya as a "fast path" for voice-board commands.

For each sample, one Laya call asks every question at once (is this for the board? which
action? which element? which color/kind/size/direction? is it multi-step? does it need new
text?). A router then decides:

  ignore -> confidently not a board command, drop it
  fast   -> a single, text-free action that code can assemble from the answers
  llm    -> anything else (labels, arrows, several actions, low confidence)

Fast-path answers are assembled into a board action and compared with the action built
the same way from the expected answers.

Setup (Windows): build the venv from a python.org Python, not Miniconda -- Miniconda's bundled
MSVC runtime makes torch fail with WinError 1114 on c10.dll.
  "C:\\Program Files\\Python310\\python.exe" -m venv eval/.venv
  eval/.venv/Scripts/python -m pip install torch --index-url https://download.pytorch.org/whl/cu130
  eval/.venv/Scripts/python -m pip install laya

Usage:
  python laya_eval.py [--model english|multilingual|typed-decisions] [--device cuda|cpu] [--threshold 0.6] [--state command|scene]
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from pathlib import Path

HERE = Path(__file__).parent

# The decision logic lives in fastpath/decide.py, shared with the app's sidecar; names are re-exported for the
# other eval scripts.
sys.path.insert(0, str(HERE.parent))
from fastpath.decide import (  # noqa: E402, F401
    COLORS,
    FIELDS,
    SEVERAL,
    build_questions,
    format_scene,
    parse_answers,
    resolve_target,
    route,
    words,
)


def expected_of(sample: dict) -> dict:
    e = {"target": "none", "color": "none", "kind": "none", "size": "none", "direction": "none", "multi_step": False, "needs_text": False}
    e.update(sample["expect"])
    e["on_board"] = e["action"] != "none"
    return e


def expected_route(e: dict) -> tuple[str, list[dict] | None]:
    """The router's decision if every answer were the expected one, fully confident."""
    return route({k: (v, 1.0) for k, v in e.items()}, 1.0)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="english", choices=["english", "multilingual", "typed-decisions"], help="Laya checkpoint")
    ap.add_argument("--device", default=None, help="cuda, cpu or mps (default: Laya's choice)")
    ap.add_argument("--threshold", type=float, default=0.6, help="minimum confidence for every answer the fast path uses")
    ap.add_argument(
        "--state",
        default="command",
        choices=["command", "scene"],
        help="'command': state is the command only (elements reach the model via the target options); 'scene': also include the board description",
    )
    ap.add_argument("--checkpoint", default=None, help="local fine-tuned checkpoint dir (from laya-train); replaces --model")
    ap.add_argument("--samples", default=str(HERE / "samples.jsonl"))
    ap.add_argument("--target-rules", action="store_true", help="let resolve_target() pick the target when the command names it")
    ap.add_argument("--out", default=None, help="default: results/laya-<model>-<state>[-rules][-<sample set>].json")
    args = ap.parse_args()
    args.out = args.out or str(HERE / "results" / f"laya-{Path(args.checkpoint).name if args.checkpoint else args.model}-{args.state}{rules_tag(args)}{samples_tag(args.samples)}.json")

    scenes = json.loads((HERE / "scenes.json").read_text())
    samples = [json.loads(line) for line in Path(args.samples).read_text().splitlines() if line.strip()]

    import laya

    t0 = time.perf_counter()
    router = laya.Router(device=args.device, default="english")
    if args.checkpoint:
        args.model = router.register("tuned", args.checkpoint)
    router.load(args.model)
    load_s = time.perf_counter() - t0

    def predict(state: dict, questions: dict) -> dict:
        return router.predict(state, questions, model=args.model)

    try:
        import torch

        cuda = torch.cuda.is_available() and args.device != "cpu"
        if cuda:
            torch.cuda.reset_peak_memory_stats()
    except ImportError:
        cuda = False

    def answer(state: dict, questions: dict) -> tuple[dict, int | None]:
        raw = predict(state, questions)
        if raw.get("usage", {}).get("truncated"):
            print(f"warning: state was truncated: {raw['usage'].get('truncated_questions')}")
        return parse_answers(raw), raw.get("usage", {}).get("input_tokens")

    rows = run_samples(answer, scenes, samples, args)

    peak_mb = None
    if cuda:
        import torch

        peak_mb = round(torch.cuda.max_memory_allocated() / 2**20)

    report(rows, args, load_s, peak_mb)
    save(rows, args, {"peak_vram_mb": peak_mb})


def samples_tag(path: str) -> str:
    """'' for the dev set (samples.jsonl), else '-<name>' so other sets don't overwrite its results."""
    stem = Path(path).stem
    return "" if stem == "samples" else "-" + stem.removeprefix("samples_")


def rules_tag(args) -> str:
    return "-rules" if args.target_rules else ""


def run_samples(answer, scenes: dict, samples: list[dict], args) -> list[dict]:
    """Ask every sample's questions through `answer(state, questions) -> (answers, input_tokens)` and route them."""
    # Warm-up so the first sample's latency isn't dominated by kernel setup.
    answer({"command": "undo"}, build_questions(scenes["empty"]))

    rows = []
    for s in samples:
        scene = scenes[s["scene"]]
        state = {"command": s["text"]}
        if args.state == "scene":
            state["board"] = format_scene(scene)
        t = time.perf_counter()
        ans, input_tokens = answer(state, build_questions(scene))
        model_target = ans["target"]
        rule = resolve_target(s["text"], scene) if args.target_rules else None
        if rule:
            ans["target"] = (rule[0], 1.0)
        ms = (time.perf_counter() - t) * 1000
        got_route, got_action = route(ans, args.threshold)
        exp = expected_of(s)
        exp_route, exp_action = expected_route(exp)
        rows.append(
            {
                "id": s["id"],
                "cat": s["cat"],
                "text": s["text"],
                "ms": round(ms, 1),
                "input_tokens": input_tokens,
                "answers": {k: [v, round(c, 3)] for k, (v, c) in ans.items()},
                "target_rule": rule[1] if rule else None,
                "model_target": [model_target[0], round(model_target[1], 3)],
                "expected": exp,
                "route": got_route,
                "expected_route": exp_route,
                "action": got_action,
                "expected_action": exp_action,
                "fast_correct": got_route == "fast" and got_action == exp_action,
            }
        )
    return rows


def save(rows: list[dict], args, extra: dict) -> None:
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    meta = {"model": args.model, "state": args.state, "threshold": args.threshold, "target_rules": args.target_rules}
    out.write_text(json.dumps({**meta, **extra, "rows": rows}, indent=2))
    print(f"\nPer-sample details: {out}")


def pct(n: int, d: int) -> str:
    return f"{n}/{d} ({100 * n / d:.0f}%)" if d else "n/a"


def report(rows: list[dict], args, load_s: float, peak_mb: int | None) -> None:
    lat = sorted(r["ms"] for r in rows)
    print(f"Model: {args.model}   state: {args.state}   threshold: {args.threshold}   target rules: {args.target_rules}   samples: {len(rows)}")
    print(f"Load: {load_s:.1f}s   latency p50 {statistics.median(lat):.0f} ms, p95 {lat[int(0.95 * (len(lat) - 1))]:.0f} ms, max {lat[-1]:.0f} ms")
    if peak_mb is not None:
        print(f"Peak GPU memory: {peak_mb} MB")

    print("\nPer-question accuracy (argmax, ignoring confidence):")
    for f in ["on_board", *FIELDS]:
        # Score a field on fast-path samples (where every field matters) and wherever the sample states it.
        scored = [r for r in rows if r["expected_route"] == "fast" or f in ("on_board", "action", "multi_step", "needs_text") or f in r["expected"] and r["expected"][f] != "none"]
        if f == "target":
            scored = [r for r in scored if "target" in r["answers"] or r["expected"]["target"] != "none"]
        ok = sum(r["answers"].get(f, ["none"])[0] == r["expected"][f] for r in scored)
        print(f"  {f:<11} {pct(ok, len(scored))}")

    if args.target_rules:
        ruled = [r for r in rows if r["target_rule"]]
        by_rule = ", ".join(f"{k} {sum(r['target_rule'] == k for r in ruled)}" for k in ("set", "label", "label word", "kind", "pronoun"))
        single = [r for r in ruled if isinstance(r["expected"]["target"], str) and r["expected"]["target"] not in ("none", SEVERAL)]
        sets = [r for r in rows if isinstance(r["expected"]["target"], list) or r["expected"]["target"] == SEVERAL]
        print(f"\nTarget rules fired on {len(ruled)}/{len(rows)} commands ({by_rule})")
        print(f"  one named element: rule right {sum(r['answers']['target'][0] == r['expected']['target'] for r in single)}/{len(single)}, model right {sum(r['model_target'][0] == r['expected']['target'] for r in single)}/{len(single)}")
        if sets:
            print(f"  groups of elements: rule right {sum(r['answers']['target'][0] == r['expected']['target'] for r in sets)}/{len(sets)}")

    fast = [r for r in rows if r["route"] == "fast"]
    exp_fast = [r for r in rows if r["expected_route"] == "fast"]
    print("\nRouting:")
    print(f"  route matches expected:        {pct(sum(r['route'] == r['expected_route'] for r in rows), len(rows))}")
    print(f"  fast-path coverage:            {pct(sum(r['fast_correct'] for r in exp_fast), len(exp_fast))} of fast-eligible commands handled correctly without the LLM")
    print(f"  fast-path precision:           {pct(sum(r['fast_correct'] for r in fast), len(fast))} of fast-routed commands produced the right action")
    wrong_fast = [r for r in fast if not r["fast_correct"]]
    wrong_ignore = [r for r in rows if r["route"] == "ignore" and r["expected_route"] != "ignore"]
    print(f"  wrong actions applied:         {len(wrong_fast)}")
    print(f"  real commands dropped:         {len(wrong_ignore)}")
    print(f"  chatter correctly ignored:     {pct(sum(r['route'] == 'ignore' for r in rows if r['expected_route'] == 'ignore'), sum(r['expected_route'] == 'ignore' for r in rows))}")

    print("\nBy category (route / correct):")
    cats: dict[str, list[dict]] = {}
    for r in rows:
        cats.setdefault(r["cat"], []).append(r)
    for cat, rs in cats.items():
        routes = ", ".join(f"{k}={sum(r['route'] == k for r in rs)}" for k in ("fast", "llm", "ignore") if any(r["route"] == k for r in rs))
        good = sum(r["fast_correct"] if r["expected_route"] == "fast" else r["route"] == r["expected_route"] for r in rs)
        print(f"  {cat:<15} {good}/{len(rs)} ok   [{routes}]")

    print("\nThreshold sweep (same answers, re-routed):")
    print("  threshold  fast-routed  correct  wrong-applied  coverage  chatter-ignored  commands-dropped")
    n_fast = len(exp_fast)
    n_chat = sum(r["expected_route"] == "ignore" for r in rows)
    for t in (0.0, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8):
        rerouted = [(r, *route({k: tuple(v) for k, v in r["answers"].items()}, t)) for r in rows]
        fr = [(r, a) for r, rt, a in rerouted if rt == "fast"]
        good = sum(a == r["expected_action"] for r, a in fr)
        ign = sum(rt == "ignore" and r["expected_route"] == "ignore" for r, rt, _ in rerouted)
        drop = sum(rt == "ignore" and r["expected_route"] != "ignore" for r, rt, _ in rerouted)
        print(f"  {t:<9.1f}  {len(fr):<11}  {good:<7}  {len(fr) - good:<13}  {pct(good, n_fast):<8}  {ign}/{n_chat:<14}  {drop}")

    if wrong_fast or wrong_ignore:
        print("\nHarmful mistakes:")
        for r in wrong_fast:
            print(f"  #{r['id']} {r['text']!r}: applied {r['action']} expected {r['expected_action'] or r['expected_route']}")
        for r in wrong_ignore:
            print(f"  #{r['id']} {r['text']!r}: ignored a real command")


if __name__ == "__main__":
    main()
