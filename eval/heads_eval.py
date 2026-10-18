"""
Evaluate a fastpath/heads.py checkpoint (from train_heads.py) on the same samples, questions and router as laya_eval.py.

One encoder pass per command: the input is the command plus the board's elements (the target question's option
descriptions); the other questions' text isn't read, their answers come from trained heads. The checkpoint must have
been trained on the questions fastpath/decide.py asks now (fastpath.heads.load_checkpoint checks the option lists).

--device cpu [--int8] [--threads N] measures the CPU-only setup (dynamic int8 Linear layers with --int8).

Usage:
  python heads_eval.py --checkpoint F:/temp/heads-train/large-laya-top8 [--device cuda|cpu] [--int8] [--fp32]
                       [--threshold 0.8] [--target-rules] [--samples FILE]
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from laya_eval import HERE, report, rules_tag, run_samples, samples_tag, save


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", required=True, help="train_heads.py output dir")
    ap.add_argument("--device", default=None, help="cuda or cpu (default: cuda if available)")
    ap.add_argument("--fp32", action="store_true", help="full precision on CUDA (default bf16)")
    ap.add_argument("--int8", action="store_true", help="CPU only: dynamic int8 Linear layers")
    ap.add_argument("--threads", type=int, default=None, help="CPU threads (torch.set_num_threads)")
    ap.add_argument("--threshold", type=float, default=0.6, help="minimum confidence for every answer the fast path uses")
    ap.add_argument("--samples", default=str(HERE / "samples.jsonl"))
    ap.add_argument("--target-rules", action="store_true", help="see laya_eval.resolve_target")
    ap.add_argument("--out", default=None, help="default: results/heads-<checkpoint>[-int8][-cpu][-rules][-<sample set>].json")
    args = ap.parse_args()

    import torch
    from fastpath.heads import Decider

    if args.threads:
        torch.set_num_threads(args.threads)
    device = args.device or ("cuda" if torch.cuda.is_available() else "cpu")
    args.model = "heads-" + Path(args.checkpoint).name
    args.state = "command"  # the board reaches the model as the element list, never as format_scene text
    suffix = ("-int8" if args.int8 else "") + ("-fp32" if args.fp32 else "") + ("-cpu" if device == "cpu" else "")
    args.out = args.out or str(HERE / "results" / f"{args.model}{suffix}{rules_tag(args)}{samples_tag(args.samples)}.json")

    scenes = json.loads((HERE / "scenes.json").read_text())
    samples = [json.loads(line) for line in Path(args.samples).read_text().splitlines() if line.strip()]

    t0 = time.perf_counter()
    decider = Decider(args.checkpoint, device=device, fp32=args.fp32, int8=args.int8)
    load_s = time.perf_counter() - t0
    if device == "cuda":
        torch.cuda.reset_peak_memory_stats()

    def answer(state: dict, questions: dict) -> tuple[dict, int | None]:
        crit = questions.get("target", {}).get("criteria", {})
        return decider.answer(state["command"], {k: v for k, v in crit.items() if k != "none"})

    rows = run_samples(answer, scenes, samples, args)
    peak_mb = round(torch.cuda.max_memory_allocated() / 2**20) if device == "cuda" else None

    dtype = "int8" if args.int8 else "fp32" if args.fp32 or device == "cpu" else "bf16"
    print(f"Checkpoint: {args.checkpoint}   device: {device}   dtype: {dtype}   threads: {torch.get_num_threads()}")
    report(rows, args, load_s, peak_mb)
    save(rows, args, {"checkpoint": args.checkpoint, "device": device, "dtype": dtype, "peak_vram_mb": peak_mb})


if __name__ == "__main__":
    main()
