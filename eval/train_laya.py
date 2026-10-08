"""
Fine-tune Laya on rows from make_train.py, through laya.train.finetune.

Two things the `laya-train` CLI can't do:
- laya 0.4.0's finetune scores the base model before moving it to the device, which crashes on CUDA; the model
  is moved when it is loaded instead.
- `--unfreeze-top N` trains the heads plus only the top N encoder layers. A full fine-tune of the 421M
  ModernBERT-large needs about 7 GB with AdamW, more than a 4 GB GPU has; `--freeze-encoder` trains the heads only.

Usage:
  python train_laya.py --data F:/temp/laya-train/train.jsonl --out F:/temp/laya-train/ckpt-heads --freeze-encoder
  python train_laya.py --data ... --out F:/temp/laya-train/ckpt-top4 --unfreeze-top 4
"""

from __future__ import annotations

import argparse

import torch
from laya import train


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--base", default="convaiinnovations/laya")
    ap.add_argument("--freeze-encoder", action="store_true")
    ap.add_argument("--unfreeze-top", type=int, default=0, help="train only the top N encoder layers (plus the heads)")
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--micro-batch", type=int, default=8)
    ap.add_argument("--grad-accum", type=int, default=8)
    ap.add_argument("--loss", default="rlcd", choices=train.LOSSES)
    ap.add_argument("--no-checkpointing", action="store_true", help="keep activations instead of recomputing them: faster, more memory")
    ap.add_argument("--shuffle-options", action="store_true", help="random option order for choice questions each epoch")
    args = ap.parse_args()
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    load = train.load_checkpoint

    def load_on_device(model_dir: str):
        model, tok, cfg = load(model_dir)
        if args.unfreeze_top:
            layers = model.encoder.layers
            for p in model.encoder.parameters():
                p.requires_grad_(False)
            for layer in layers[-args.unfreeze_top :]:
                for p in layer.parameters():
                    p.requires_grad_(True)
            for p in model.encoder.final_norm.parameters():
                p.requires_grad_(True)
        n = sum(p.numel() for p in model.parameters() if p.requires_grad)
        print(f"trainable parameters: {n / 1e6:.1f}M of {sum(p.numel() for p in model.parameters()) / 1e6:.1f}M", flush=True)
        return model.to(device), tok, cfg

    train.load_checkpoint = load_on_device
    config = train.TrainConfig(
        epochs=args.epochs,
        micro_batch=args.micro_batch,
        grad_accum=args.grad_accum,
        loss=args.loss,
        freeze_encoder=args.freeze_encoder,
        shuffle_options=("choice",) if args.shuffle_options else (),
        log_every=200,
        gradient_checkpointing=False if args.no_checkpointing else None,
    )
    summary = train.finetune(args.data, args.base, args.out, config, device=str(device))
    print({k: v for k, v in summary.items() if not isinstance(v, (list, dict))})


if __name__ == "__main__":
    main()
