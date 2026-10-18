"""
Evaluate Jev (feder-cr/jev: jevos-v5 on CPU through OpenVINO) on the same samples, questions and router as laya_eval.py.

Jev serves TypeSafe Jev's wire format, which is also Laya's, so build_questions() is sent unchanged and one HTTP request
asks all of a command's questions. Differences from Laya the adapter has to cover:
  - A `noul` answer is only P(yes): no confidence, and the question's `criteria` (the true/false descriptions) are
    ignored by the server (same token count and answer with or without them). Confidence here is max(p, 1 - p).
  - A `choice` answer has `probabilities` and `confidence`; --confidence picks the router's confidence: `top` (the top
    option's probability, as in semif_eval.py; default) or `jev` (the server's own `confidence`, undocumented).
  - The model doesn't know the text is a whiteboard command: with a bare state "make the box red" gets P(on_board) 0.03.
    --context adds a line to the state saying so (our variation, not Jev's).
Not fine-tunable (no training code or recipe is published), so this is a zero-shot comparison with Laya.

Setup (Windows), from the jevos-v5 release (https://github.com/feder-cr/jev/releases/tag/jevos-v5):
  unzip jev-windows-x64.zip           (into F:/temp, giving F:/temp/jev)
  cd jev && unzip ../jevos-v5-openvino-int8.zip     (creates model/)
  jev.exe serve                       (127.0.0.1:8017; --threads N, default all logical CPUs)
The harness needs only the standard library.

Usage:
  python jev_eval.py [--url http://127.0.0.1:8017] [--context] [--confidence top|jev] [--threshold 0.6]
                     [--state command|scene] [--target-rules] [--samples FILE]
"""

from __future__ import annotations

import argparse
import json
import time
import urllib.request
from pathlib import Path

from laya_eval import HERE, report, rules_tag, run_samples, samples_tag, save

CONTEXT = "A command spoken to a voice-controlled whiteboard app, which draws and edits shapes, text and arrows."


def parse_jev(raw: dict, confidence: str) -> dict:
    """Jev answers -> {field: (value, confidence)}, matching decide.parse_answers."""
    out: dict = {}
    for name, ans in raw["answers"].items():
        if ans["type"] == "noul":
            p = float(ans["noul"])
            out[name] = (p >= 0.5, max(p, 1 - p))
        else:
            conf = ans["confidence"] if confidence == "jev" else max(ans["probabilities"].values())
            out[name] = (ans["choice"], float(conf))
    out.setdefault("target", ("none", 1.0))
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8017", help="a running `jev serve`")
    ap.add_argument("--context", action="store_true", help="tell the model the state is a whiteboard command (see docstring)")
    ap.add_argument("--confidence", default="top", choices=["top", "jev"], help="choice confidence: top probability or Jev's `confidence`")
    ap.add_argument("--threshold", type=float, default=0.6, help="minimum confidence for every answer the fast path uses")
    ap.add_argument("--state", default="command", choices=["command", "scene"], help="see laya_eval.py")
    ap.add_argument("--samples", default=str(HERE / "samples.jsonl"))
    ap.add_argument("--target-rules", action="store_true", help="see laya_eval.resolve_target")
    ap.add_argument("--out", default=None, help="default: results/jev-<model>-<state>[-ctx][-jevconf][-rules][-<sample set>].json")
    args = ap.parse_args()

    with urllib.request.urlopen(args.url + "/health", timeout=10) as r:
        health = json.load(r)
    if health.get("status") != "ready":
        raise SystemExit(f"Jev is not ready: {health}")
    args.model = health["model"]
    suffix = ("-ctx" if args.context else "") + ("-jevconf" if args.confidence == "jev" else "") + rules_tag(args) + samples_tag(args.samples)
    args.out = args.out or str(HERE / "results" / f"jev-{args.model}-{args.state}{suffix}.json")

    scenes = json.loads((HERE / "scenes.json").read_text())
    samples = [json.loads(line) for line in Path(args.samples).read_text().splitlines() if line.strip()]

    def answer(state: dict, questions: dict) -> tuple[dict, int | None]:
        if args.context:
            state = {"context": CONTEXT, **state}
        body = json.dumps({"model": "jev-latest", "state": state, "questions": questions}).encode()
        req = urllib.request.Request(args.url + "/v1/systemone", body, {"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=120) as r:
            raw = json.load(r)
        return parse_jev(raw, args.confidence), raw.get("usage", {}).get("input_tokens")

    t0 = time.perf_counter()
    rows = run_samples(answer, scenes, samples, args)
    print(f"Context line: {args.context}   confidence: {args.confidence}   run: {time.perf_counter() - t0:.0f}s")
    # Load time is the server's, not measured here; Jev runs on CPU, so there is no GPU memory to report.
    report(rows, args, 0.0, None)
    save(rows, args, {"context": args.context, "confidence": args.confidence, "engine": health.get("engine"), "fingerprint": health.get("fingerprint")})


if __name__ == "__main__":
    main()
