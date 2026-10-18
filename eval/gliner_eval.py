"""
Evaluate GLiNER2.5-Decide (fastino, 340M DeBERTa-v3-large encoder) zero-shot on the same samples, questions and router as
laya_eval.py.

Each build_questions() question becomes one GLiNER classification task: instructions -> `prompt`, criteria -> labels with
descriptions (`noul` true/false -> labels "yes"/"no"). Confidence is gliner2's `include_confidence` score of the chosen label.
--layout:
  batched (default): one row per question, all rows in one encoder batch. Each row is ~30-75 tokens.
  joint: every question in one row, as gliner2's README suggests. That row is ~1,240 tokens with descriptions, more than
         twice the encoder's 512 positions, and the scores flatten (action confidence ~0.3-0.5 on clear commands).
--context prefixes the command with "Spoken to a whiteboard app: " (as jev_eval.py's --context; our variation).
--adapter DIR loads a LoRA adapter from train_gliner.py (merged into the weights, so it costs nothing at inference).
--fp32 keeps full precision; fp16 gives the same answers to 3 decimals at ~2.6x the speed on the RTX 3050.

Setup (on top of the laya_eval.py venv; adds gliner2, peft, accelerate, pydantic; torch/transformers stay as they are):
  eval/.venv/Scripts/python -m pip install "gliner2[local]==2.1.0"
The model (~1.7 GB) downloads from Hugging Face on first use; set HF_HOME to keep it off C:.

Usage:
  python gliner_eval.py [--layout batched|joint] [--context] [--adapter DIR] [--fp32] [--device cuda|cpu] [--threshold 0.6]
                        [--state command|scene] [--target-rules] [--samples FILE]
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from laya_eval import HERE, report, rules_tag, run_samples, samples_tag, save

MODEL = "fastino/GLiNER2.5-Decide"
REVISION = "9d1bfb848cd16d93ee56ccbc59cd92bf0f284d90"
CONTEXT = "Spoken to a whiteboard app: "
NOUL_LABELS = {"true": "yes", "false": "no"}


def adapter_name(path: str) -> str:
    """F:/temp/gliner-train/lora-half/final -> lora-half"""
    p = Path(path)
    return p.parent.name if p.name == "final" else p.name


def to_task(q: dict) -> dict:
    """A Laya-style question -> a gliner2 classification task with described labels."""
    return {"labels": {NOUL_LABELS.get(c, c): d for c, d in q["criteria"].items()}, "prompt": q["instructions"]}


def parse_results(merged: dict, questions: dict) -> dict:
    """gliner2 results -> {field: (value, confidence)}, matching decide.parse_answers."""
    out: dict = {}
    for name, q in questions.items():
        label, conf = merged[name]["label"], float(merged[name]["confidence"])
        out[name] = (label == "yes", conf) if q["type"] == "noul" else (label, conf)
    out.setdefault("target", ("none", 1.0))
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--layout", default="batched", choices=["batched", "joint"], help="see docstring")
    ap.add_argument("--context", action="store_true", help="prefix the command with a whiteboard context line")
    ap.add_argument("--adapter", default=None, help="LoRA adapter dir from train_gliner.py (OUT/final)")
    ap.add_argument("--fp32", action="store_true", help="full precision (default fp16 on CUDA)")
    ap.add_argument("--device", default=None, help="cuda or cpu (default: cuda if available)")
    ap.add_argument("--threshold", type=float, default=0.6, help="minimum confidence for every answer the fast path uses")
    ap.add_argument("--state", default="command", choices=["command", "scene"], help="see laya_eval.py")
    ap.add_argument("--samples", default=str(HERE / "samples.jsonl"))
    ap.add_argument("--target-rules", action="store_true", help="see laya_eval.resolve_target")
    ap.add_argument("--out", default=None, help="default: results/gliner-decide-<state>[-<adapter>][-joint][-ctx][-fp32][-cpu][-rules][-<sample set>].json")
    args = ap.parse_args()

    import torch
    from gliner2 import AutoExtractor

    device = args.device or ("cuda" if torch.cuda.is_available() else "cpu")
    half = device == "cuda" and not args.fp32
    args.model = "gliner2.5-decide" + (f"+{adapter_name(args.adapter)}" if args.adapter else "")
    suffix = (f"-{adapter_name(args.adapter)}" if args.adapter else "") + ("-joint" if args.layout == "joint" else "") + ("-ctx" if args.context else "") + ("-fp32" if args.fp32 else "")
    suffix += ("-cpu" if device == "cpu" else "") + rules_tag(args) + samples_tag(args.samples)
    args.out = args.out or str(HERE / "results" / f"gliner-decide-{args.state}{suffix}.json")

    scenes = json.loads((HERE / "scenes.json").read_text())
    samples = [json.loads(line) for line in Path(args.samples).read_text().splitlines() if line.strip()]

    t0 = time.perf_counter()
    model = AutoExtractor.from_pretrained(MODEL, revision=REVISION)
    if args.adapter:
        from peft import PeftModel

        model = PeftModel.from_pretrained(model, args.adapter).merge_and_unload()
    model = model.to(device)
    if half:
        model = model.half()
    load_s = time.perf_counter() - t0
    if device == "cuda":
        torch.cuda.reset_peak_memory_stats()

    def text_of(state: dict) -> str:
        # gliner2 classifies plain text; --state scene appends the board description.
        text = (CONTEXT if args.context else "") + state["command"]
        return text + "\nBoard: " + state["board"] if "board" in state else text

    def answer(state: dict, questions: dict) -> tuple[dict, int | None]:
        text = text_of(state)
        if args.layout == "joint":
            merged = model.classify_text(text, {k: to_task(q) for k, q in questions.items()}, include_confidence=True)
        else:
            schemas = [model._classification_schema({k: to_task(q)}) for k, q in questions.items()]
            merged = {}
            for r in model.batch_extract([text] * len(schemas), schemas, batch_size=len(schemas), include_confidence=True):
                merged.update(r)
        if device == "cuda":
            torch.cuda.synchronize()
        return parse_results(merged, questions), None

    rows = run_samples(answer, scenes, samples, args)
    peak_mb = round(torch.cuda.max_memory_allocated() / 2**20) if device == "cuda" else None

    print(f"Layout: {args.layout}   context: {args.context}   dtype: {'fp16' if half else 'fp32'}   device: {device}")
    report(rows, args, load_s, peak_mb)
    save(rows, args, {"adapter": args.adapter, "layout": args.layout, "context": args.context, "fp16": half, "device": device, "revision": REVISION, "peak_vram_mb": peak_mb})


if __name__ == "__main__":
    main()
