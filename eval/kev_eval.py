"""
Evaluate Kev (jaredpalmer/kev: LoRA decision models on Qwen3.5 bases, same System One wire format as Jev) on the same
samples, questions and router as laya_eval.py, through a running `kev.serve`.

Answers are parsed like jev_eval.py's (noul = P(yes), confidence max(p, 1 - p); choice = top probability, or Kev's own
`confidence` = (p_max - 1/K) / (1 - 1/K) with --confidence jev). Unlike Jev, Kev reads a noul's true/false `criteria`.
--context adds jev_eval's whiteboard line to the state.

Measured on the RTX 3050 (Kev-0.8B v1.0, bf16, 12 questions of ~1,100 tokens): 3.2 s per command, ~80-100 ms per question asked
alone (`action` 470 ms); a repeated text isn't faster. Only Kev-0.8B fits the RTX 3050 (4 GB); Kev-4B is ~8 GB in bf16. Kev can be fine-tuned (`kev.train --init_from`;
`--batch 1 --accum 8 --dtype bf16` fits 0.8B on 4 GB per its README).

Setup (Windows; the repo's `uv sync` would install CPU-only torch from PyPI):
  git clone https://github.com/jaredpalmer/kev.git F:/Program/kev && cd F:/Program/kev
  uv venv --python 3.13 .venv
  uv pip install --python .venv/Scripts/python.exe "torch==2.8.*" --index-url https://download.pytorch.org/whl/cu128
  uv pip install --python .venv/Scripts/python.exe -e ".[serve]"
  uv pip install --python .venv/Scripts/python.exe "triton-windows<3.5" "flash-linear-attention==0.5.2"   (fast DeltaNet kernels; 4.9 -> 3.2 s per command)
  HF_HOME=F:\\Program\\huggingface .venv/Scripts/python -m kev.serve --run jaredpalmer/kev-0.8b@v1.0 --port 8009 --device cuda
The harness itself needs only the standard library.

Usage:
  python kev_eval.py [--url http://127.0.0.1:8009] [--context] [--confidence top|jev] [--threshold 0.6]
                     [--state command|scene] [--target-rules] [--samples FILE]
"""

from __future__ import annotations

import argparse
import json
import re
import time
import urllib.request
from pathlib import Path

from jev_eval import CONTEXT, parse_jev
from laya_eval import HERE, report, rules_tag, run_samples, samples_tag, save


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8009", help="a running `kev.serve`")
    ap.add_argument("--context", action="store_true", help="tell the model the state is a whiteboard command")
    ap.add_argument("--confidence", default="top", choices=["top", "jev"], help="choice confidence: top probability or Kev's `confidence`")
    ap.add_argument("--threshold", type=float, default=0.6, help="minimum confidence for every answer the fast path uses")
    ap.add_argument("--state", default="command", choices=["command", "scene"], help="see laya_eval.py")
    ap.add_argument("--samples", default=str(HERE / "samples.jsonl"))
    ap.add_argument("--target-rules", action="store_true", help="see laya_eval.resolve_target")
    ap.add_argument("--out", default=None, help="default: results/kev-<checkpoint>-<state>[-ctx][-kevconf][-rules][-<sample set>].json")
    args = ap.parse_args()

    with urllib.request.urlopen(args.url + "/v1/models", timeout=10) as r:
        models = json.load(r)
    # The loaded checkpoint, e.g. jaredpalmer/kev-0.8b@v1.0 -> kev-0.8b-v1.0; else the first model card's name.
    loaded = json.dumps(models)
    m = re.search(r"jaredpalmer/(kev-[\w.]+)(?:@([\w.]+))?", loaded) or re.search(r"(kev-[\w.]+)", loaded)
    args.model = "-".join(g for g in m.groups() if g) if m else "kev"
    suffix = ("-ctx" if args.context else "") + ("-kevconf" if args.confidence == "jev" else "") + rules_tag(args) + samples_tag(args.samples)
    args.out = args.out or str(HERE / "results" / f"{args.model}-{args.state}{suffix}.json")

    scenes = json.loads((HERE / "scenes.json").read_text())
    samples = [json.loads(line) for line in Path(args.samples).read_text().splitlines() if line.strip()]

    def answer(state: dict, questions: dict) -> tuple[dict, int | None]:
        if args.context:
            state = {"context": CONTEXT, **state}
        body = json.dumps({"model": "kev-latest", "state": state, "questions": questions}).encode()
        req = urllib.request.Request(args.url + "/v1/systemone", body, {"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=120) as r:
            raw = json.load(r)
        return parse_jev(raw, args.confidence), raw.get("usage", {}).get("input_tokens")

    t0 = time.perf_counter()
    rows = run_samples(answer, scenes, samples, args)
    print(f"Context line: {args.context}   confidence: {args.confidence}   run: {time.perf_counter() - t0:.0f}s")
    # Load time and GPU memory are the server's, not measured here.
    report(rows, args, 0.0, None)
    save(rows, args, {"context": args.context, "confidence": args.confidence, "models": models})


if __name__ == "__main__":
    main()
