"""
LoRA fine-tune GLiNER2.5-Decide on rows from make_train.py, through gliner2's ExtractorTrainer.

Each row's questions become one example per question (the text, one classification task with described labels), the
same layout gliner_eval.py's default `--layout batched` asks them in. `extra` and unlabelled questions are skipped.
`--context` (default on) adds gliner_eval's context prefix, so evaluate with `gliner_eval.py --context --adapter OUT/final`.

On the RTX 3050 (4 GB) only LoRA with gradient checkpointing fits: batch 8 = ~10 items/s at 2.5 GB, so train-v3's
105k items are ~3 h per epoch (`--rows 4500` is about half). Batch 4 without checkpointing runs out of memory, and a
full fine-tune needs ~5.4 GB for the weights and Adam state.

Setup (on top of gliner_eval.py's): eval/.venv/Scripts/python -m pip install "gliner2[train]==2.1.0"

Usage:
  python train_gliner.py --data F:/temp/laya-train/train-v3.jsonl --out F:/temp/gliner-train/lora-half --rows 4500
"""

from __future__ import annotations

import argparse
import json
import time

from gliner_eval import CONTEXT, MODEL, NOUL_LABELS, REVISION


def examples_of(path: str, rows: int, context: bool) -> list:
    from gliner2.training.data import Classification, InputExample

    out = []
    with open(path, encoding="utf-8") as f:
        for i, line in enumerate(f):
            if rows and i >= rows:
                break
            r = json.loads(line)
            text = (CONTEXT if context else "") + r["state"]["command"]
            for name, q in r["questions"].items():
                if name == "extra" or name not in r["expected"]:
                    continue
                exp = r["expected"][name]
                labels = {NOUL_LABELS.get(c, c): d for c, d in q["criteria"].items()}
                true = ("yes" if exp else "no") if q["type"] == "noul" else exp
                task = Classification(task=name, labels=list(labels), true_label=true, prompt=q["instructions"], label_descriptions=labels)
                out.append(InputExample(text=text, classifications=[task]))
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--rows", type=int, default=0, help="use only the first N rows (0 = all)")
    ap.add_argument("--no-context", action="store_true", help="train on the bare command (then evaluate without --context)")
    ap.add_argument("--epochs", type=int, default=1)
    ap.add_argument("--batch-size", type=int, default=8)
    ap.add_argument("--lr", type=float, default=5e-4, help="LoRA learning rate (gliner2's task_lr)")
    ap.add_argument("--bf16", action="store_true", help="bf16 instead of fp16 (the fp16 run at lr 5e-4 diverged)")
    ap.add_argument("--lora-r", type=int, default=16)
    args = ap.parse_args()

    from gliner2 import AutoExtractor
    from gliner2.training.trainer import ExtractorTrainer, TrainingConfig

    examples = examples_of(args.data, args.rows, not args.no_context)
    print(f"{len(examples)} examples from {args.rows or 'all'} rows")

    model = AutoExtractor.from_pretrained(MODEL, revision=REVISION)
    config = TrainingConfig(
        output_dir=args.out, num_epochs=args.epochs, batch_size=args.batch_size, task_lr=args.lr, eval_strategy="no",
        use_lora=True, lora_r=args.lora_r, lora_alpha=2.0 * args.lora_r, gradient_checkpointing=True, fp16=not args.bf16, bf16=args.bf16,
        num_workers=0, logging_steps=50, save_total_limit=1,
    )
    t0 = time.perf_counter()
    ExtractorTrainer(model, config).train(train_data=examples)
    print(f"Trained in {(time.perf_counter() - t0) / 60:.1f} min; adapter in {args.out}/final")


if __name__ == "__main__":
    main()
