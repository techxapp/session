"""
Train the single-pass heads model (fastpath/heads.py) on rows from make_train.py.

One example per command (not one per question, as train_laya.py / train_gliner.py do), with the command and the
board's elements as input, so an epoch of train-v3 is 9,000 short sequences instead of 105k long ones. Unlabelled
answers (groups, several targets, arrows; `extra`, which decide.py no longer asks) are left out of the loss. Element
order is shuffled every epoch, so the pointer can't learn positions.

--init is a Laya checkpoint dir (default: ckpt-v3, whose ModernBERT-large encoder has already been fine-tuned on board
commands) or a Hub encoder id (answerdotai/ModernBERT-large, answerdotai/ModernBERT-base) for comparison.

Memory (RTX 3050, 4 GB): AdamW keeps ~16 bytes per trainable parameter, so a full fine-tune of ModernBERT-large
(395M, ~6.3 GB) doesn't fit. --unfreeze-top N trains the heads plus the top N of its 28 layers (~12M parameters
each); frozen parameters are kept in fp16 on CUDA. -1 trains everything (fits for ModernBERT-base, 149M).
Sequences are short (~20-120 tokens), so activations are small and no gradient checkpointing is needed.

The last --calib-frac of the (seeded, shuffled) rows is held out: per-question accuracy is reported on it after every
epoch, and at the end each question's softmax temperature is fitted on it (lowest NLL on a grid), which is what makes
a 0.8 threshold mean roughly 80%. Synthetic held-out rows are easier than real commands, so the eval sets
(heads_eval.py) are the real check.

Usage:
  python train_heads.py --data F:/temp/laya-train/train-v3.jsonl --out F:/temp/heads-train/large-laya-top8
  python train_heads.py --data ... --out F:/temp/heads-train/base-hub --init answerdotai/ModernBERT-base --unfreeze-top -1
Then: python heads_eval.py --checkpoint F:/temp/heads-train/large-laya-top8 --target-rules [--samples ...]
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import time
from pathlib import Path

import torch
import torch.nn.functional as F

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from fastpath.heads import MAX_LEN, QUESTIONS_VERSION, HeadsModel, assemble, collate, encode_pieces, init_encoder, label_index, question_options, save_checkpoint  # noqa: E402

DEFAULT_INIT = "F:/temp/laya-train/ckpt-v3"
CONFIDENT = 0.8  # the sidecar's FASTPATH_THRESHOLD: confident-wrong answers at this level are reported


def to_example(row: dict, tok, options: dict[str, list[str]]) -> dict:
    crit = row["questions"].get("target", {}).get("criteria", {})
    el_ids = [k for k in crit if k != "none"]
    cmd, els = encode_pieces(tok, row["state"]["command"], [crit[k] for k in el_ids])
    exp = row["expected"]
    t = exp.get("target")
    return {
        "cmd": cmd,
        "els": els,
        "labels": [label_index(opts, exp[n]) if n in exp else -100 for n, opts in options.items()],
        # 0 = none, i + 1 = element i; lists / "several" / missing are unlabelled.
        "target": 0 if t == "none" else el_ids.index(t) + 1 if isinstance(t, str) and t in el_ids else -100,
    }


def make_batch(examples: list[dict], tok, max_len: int, rng: random.Random | None) -> dict[str, torch.Tensor]:
    seqs, targets = [], []
    for ex in examples:
        order = list(range(len(ex["els"])))
        if rng:
            rng.shuffle(order)
        ids, starts, ends = assemble(tok, ex["cmd"], [ex["els"][i] for i in order], max_len)
        t = ex["target"]
        if t > 0:
            at = order.index(t - 1)
            t = at + 1 if at < len(starts) else -100  # its element was cut off by max_len
        seqs.append((ids, starts, ends))
        targets.append(t)
    batch = collate(seqs, tok.pad_token_id)
    batch["labels"] = torch.tensor([ex["labels"] for ex in examples])
    batch["target"] = torch.tensor(targets)
    return batch


def loss_of(out: dict, batch: dict, names: list[str]) -> torch.Tensor:
    losses = []
    for i, n in enumerate([*names, "target"]):
        y = batch["target"] if n == "target" else batch["labels"][:, i]
        if (y >= 0).any():
            losses.append(F.cross_entropy(out[n].float(), y, ignore_index=-100))
    return torch.stack(losses).sum()


@torch.no_grad()
def collect(model: HeadsModel, examples: list[dict], tok, args, device, amp) -> dict[str, tuple[torch.Tensor, torch.Tensor]]:
    """{question: (logits [N, options], labels [N])} on held-out examples; target logits padded with -inf."""
    model.eval()
    names = [*model.names, "target"]
    logits: dict[str, list] = {n: [] for n in names}
    labels: dict[str, list] = {n: [] for n in names}
    for i in range(0, len(examples), args.batch_size):
        batch = make_batch(examples[i : i + args.batch_size], tok, args.max_len, None)
        with torch.autocast("cuda", dtype=torch.bfloat16, enabled=amp):
            out = model(**{k: batch[k].to(device) for k in ("input_ids", "attention_mask", "el_start", "el_end", "el_mask")})
        for j, n in enumerate(names):
            logits[n] += list(out[n].float().cpu())
            labels[n] += (batch["target"] if n == "target" else batch["labels"][:, j]).tolist()
    model.train()
    width = max(len(x) for x in logits["target"])
    logits["target"] = [F.pad(x, (0, width - len(x)), value=float("-inf")) for x in logits["target"]]
    return {n: (torch.stack(logits[n]), torch.tensor(labels[n])) for n in names}


def fit_temperature(logits: torch.Tensor, labels: torch.Tensor) -> float:
    keep = labels >= 0
    if keep.sum() < 10:
        return 1.0
    grid = torch.logspace(-0.7, 1.0, 80)  # 0.2 .. 10
    nll = [F.cross_entropy(logits[keep] / t, labels[keep]).item() for t in grid]
    return float(grid[min(range(len(grid)), key=nll.__getitem__)])


def held_out_report(stats: dict, temps: dict[str, float] | None = None) -> dict:
    """Per question: labelled rows, accuracy, and (with temperatures) confident-wrong answers at CONFIDENT."""
    rep = {}
    for n, (logits, labels) in stats.items():
        keep = labels >= 0
        if not keep.any():
            continue
        lg, y = logits[keep], labels[keep]
        p = (lg / (temps or {}).get(n, 1.0)).softmax(-1)
        conf, pred = p.max(-1)
        rep[n] = {"n": int(keep.sum()), "acc": round((pred == y).float().mean().item(), 4)}
        if temps:
            rep[n] |= {"temperature": round(temps[n], 3), "confident_wrong": int(((conf >= CONFIDENT) & (pred != y)).sum())}
    return rep


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, help="make_train.py rows (e.g. F:/temp/laya-train/train-v3.jsonl)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--init", default=DEFAULT_INIT, help="Laya checkpoint dir or Hub encoder id")
    ap.add_argument("--unfreeze-top", type=int, default=8, help="train the top N encoder layers (+ heads); -1 = all, 0 = heads only")
    ap.add_argument("--epochs", type=int, default=4)
    ap.add_argument("--batch-size", type=int, default=32)
    ap.add_argument("--encoder-lr", type=float, default=2e-5)
    ap.add_argument("--head-lr", type=float, default=3e-4)
    ap.add_argument("--hidden", type=int, default=512, help="head MLP width")
    ap.add_argument("--max-len", type=int, default=MAX_LEN)
    ap.add_argument("--calib-frac", type=float, default=0.1)
    ap.add_argument("--rows", type=int, default=0, help="use only the first N rows (0 = all)")
    ap.add_argument("--device", default=None)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--log-every", type=int, default=50)
    args = ap.parse_args()

    random.seed(args.seed)
    torch.manual_seed(args.seed)
    device = torch.device(args.device or ("cuda" if torch.cuda.is_available() else "cpu"))
    amp = device.type == "cuda"

    options, noul = question_options()
    encoder, tok = init_encoder(args.init)
    model = HeadsModel(encoder, options, args.hidden)

    layers = model.encoder.layers
    if args.unfreeze_top >= 0:
        for p in model.encoder.parameters():
            p.requires_grad_(False)
        if args.unfreeze_top:
            for layer in layers[-args.unfreeze_top :]:
                layer.requires_grad_(True)
            model.encoder.final_norm.requires_grad_(True)
        if amp:  # frozen weights only feed bf16 matmuls; fp16 storage is lossless for Laya's fp16 checkpoint
            for p in model.encoder.parameters():
                if not p.requires_grad:
                    p.data = p.data.half()
    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    print(f"trainable parameters: {trainable / 1e6:.1f}M of {sum(p.numel() for p in model.parameters()) / 1e6:.1f}M "
          f"(top {args.unfreeze_top if args.unfreeze_top >= 0 else len(layers)} of {len(layers)} layers)", flush=True)  # fmt: skip
    model.to(device).train()

    rows = []
    with open(args.data, encoding="utf-8") as f:
        for i, line in enumerate(f):
            if args.rows and i >= args.rows:
                break
            rows.append(json.loads(line))
    random.Random(args.seed).shuffle(rows)
    n_calib = max(1, int(len(rows) * args.calib_frac))
    t = time.perf_counter()
    examples = [to_example(r, tok, options) for r in rows]
    train, calib = examples[:-n_calib], examples[-n_calib:]
    print(f"{len(train)} train / {len(calib)} held-out commands, tokenized in {time.perf_counter() - t:.1f}s", flush=True)

    enc_params = [p for p in model.encoder.parameters() if p.requires_grad]
    head_params = [p for n, p in model.named_parameters() if not n.startswith("encoder.") and p.requires_grad]
    opt = torch.optim.AdamW([{"params": enc_params, "lr": args.encoder_lr}, {"params": head_params, "lr": args.head_lr}], weight_decay=0.01)
    steps = args.epochs * -(-len(train) // args.batch_size)
    warm = max(1, int(0.06 * steps))
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: (s + 1) / warm if s < warm else max(0.0, (steps - s) / max(1, steps - warm)))
    if amp:
        torch.cuda.reset_peak_memory_stats()

    rng, step, t0, history = random.Random(args.seed), 0, time.perf_counter(), []
    for epoch in range(args.epochs):
        rng.shuffle(train)
        te, run_loss, seen = time.perf_counter(), 0.0, 0
        for i in range(0, len(train), args.batch_size):
            batch = {k: v.to(device) for k, v in make_batch(train[i : i + args.batch_size], tok, args.max_len, rng).items()}
            with torch.autocast("cuda", dtype=torch.bfloat16, enabled=amp):
                out = model(**{k: batch[k] for k in ("input_ids", "attention_mask", "el_start", "el_end", "el_mask")})
            loss = loss_of(out, batch, model.names)
            opt.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_([p for p in model.parameters() if p.requires_grad], 1.0)
            opt.step()
            sched.step()
            step, run_loss, seen = step + 1, run_loss + loss.item(), seen + len(batch["labels"])
            if step % args.log_every == 0:
                print(f"  step {step}/{steps}  loss {run_loss / args.log_every:.4f}  {seen / (time.perf_counter() - te):.0f} commands/s", flush=True)
                run_loss = 0.0
        rep = held_out_report(collect(model, calib, tok, args, device, amp))
        history.append({"epoch": epoch + 1, "minutes": round((time.perf_counter() - te) / 60, 2), "held_out": rep})
        print(f"epoch {epoch + 1}: {(time.perf_counter() - te) / 60:.1f} min; held-out accuracy "
              + ", ".join(f"{n} {r['acc']:.3f}" for n, r in rep.items()), flush=True)  # fmt: skip

    stats = collect(model, calib, tok, args, device, amp)
    temps = {n: fit_temperature(*stats[n]) for n in stats}
    model.temperature.copy_(torch.tensor([temps[n] for n in [*model.names, "target"]]))
    final = held_out_report(stats, temps)
    print(f"\nHeld-out after temperature scaling (confident = p >= {CONFIDENT}):")
    for n, r in final.items():
        print(f"  {n:<11} acc {r['acc']:.3f} of {r['n']:<5} T {r['temperature']:<6} confident wrong {r['confident_wrong']}")

    peak_mb = round(torch.cuda.max_memory_allocated() / 2**20) if amp else None
    minutes = (time.perf_counter() - t0) / 60
    print(f"Trained in {minutes:.1f} min" + (f", peak GPU memory {peak_mb} MB" if peak_mb else ""))
    cfg = {
        "questions_version": QUESTIONS_VERSION,
        "options": options,
        "noul": noul,
        "hidden": args.hidden,
        "max_len": args.max_len,
        "temperatures": temps,
        "training": {**{k: v for k, v in vars(args).items() if k != "out"}, "train_rows": len(train), "held_out_rows": len(calib),
                     "minutes": round(minutes, 1), "peak_vram_mb": peak_mb, "trainable_m": round(trainable / 1e6, 1)},  # fmt: skip
        "held_out": final,
        "history": history,
    }
    save_checkpoint(model, tok, cfg, args.out)
    print(f"Checkpoint: {args.out}")


if __name__ == "__main__":
    main()
