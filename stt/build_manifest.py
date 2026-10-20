"""
Turn the speech sidecar's voice clips into training manifests for Moonshine's LoRA fine-tuning.

Reads STT_CLIPS_DIR (default stt/clips): clips.jsonl (one row per recorded line, with what Moonshine heard) and
labels.jsonl (the true text for one or more clips, sent when a line is fixed in the activity panel; the last label
for a clip wins). A label over several clips (a command joined from lines split by a pause) becomes one clip: the
WAVs are joined with a short silence into joined/. Writes train.jsonl and eval.jsonl next to them, in the
{"audio", "text"} format that `python -m moonshine_voice.lora --train-manifest` reads (paths relative to the folder).

Only labelled clips are used by default. --heard also adds the clips nobody fixed, with Moonshine's own text: most
of those were heard right, so they teach the model your voice, but any it got wrong teach the mistake. They go to
train only; eval is always labelled clips (a split by clip, so the eval shows how often fixed mistakes come right).

Stdlib only:  python stt/build_manifest.py [--dir DIR] [--heard] [--eval-frac 0.2] [--seed 0]

Then, in a venv with `moonshine-voice[finetune]` (needs torch; not set up on this machine yet):
  python -m moonshine_voice.lora --train-manifest stt/clips/train.jsonl --eval-manifest stt/clips/eval.jsonl \\
      --model moonshine-ai/moonshine-streaming-small --eval --canary --output-dir F:/temp/moonshine-lora
It mixes in general English (yodas-en-replay) by default so the model doesn't forget other speech, and --canary
scores LibriSpeech to show any loss. `--export` turns the result into the runtime's ONNX graphs.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import wave
from pathlib import Path

GAP_SECONDS = 0.3  # silence between the lines of a joined command


def read_jsonl(path: Path) -> list[dict]:
    if not path.is_file():
        return []
    rows = []
    for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if line.strip():
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                print(f"{path.name}:{n}: skipped a broken line", file=sys.stderr)
    return rows


def join_wavs(folder: Path, sources: list[str], name: str) -> str | None:
    """Concatenate clips (same format) with GAP_SECONDS of silence between; returns the joined clip's path."""
    out = Path("joined") / f"{name}.wav"
    frames, params = [], None
    for src in sources:
        with wave.open(str(folder / src), "rb") as w:
            p = (w.getnchannels(), w.getsampwidth(), w.getframerate())
            if params and p != params:
                return None
            params = p
            frames.append(w.readframes(w.getnframes()))
    channels, width, rate = params
    gap = b"\0" * int(GAP_SECONDS * rate) * channels * width
    (folder / "joined").mkdir(exist_ok=True)
    with wave.open(str(folder / out), "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(width)
        w.setframerate(rate)
        w.writeframes(gap.join(frames))
    return out.as_posix()


def seconds_of(folder: Path, audio: str) -> float:
    with wave.open(str(folder / audio), "rb") as w:
        return round(w.getnframes() / w.getframerate(), 2)


def build(folder: Path, heard: bool, eval_frac: float, seed: int) -> tuple[list[dict], list[dict]]:
    clips = {c["id"]: c for c in read_jsonl(folder / "clips.jsonl") if (folder / c.get("audio", "")).is_file()}
    # The last label for a set of clips wins; a clip in a later label leaves any earlier one it was part of.
    latest: dict[tuple[str, ...], dict] = {}
    for label in read_jsonl(folder / "labels.jsonl"):
        key = tuple(label.get("clips") or [])
        if not key or not all(c in clips for c in key):
            continue
        for old in [k for k in latest if set(k) & set(key)]:
            del latest[old]
        latest[key] = label

    labelled = []
    for key, label in latest.items():
        audio = clips[key[0]]["audio"] if len(key) == 1 else join_wavs(folder, [clips[c]["audio"] for c in key], "+".join(key))
        if audio:
            heard_text = " ".join(clips[c]["heard"] for c in key)
            labelled.append({"audio": audio, "text": label["text"], "seconds": seconds_of(folder, audio), "heard": heard_text, "id": "+".join(key)})

    rng = random.Random(seed)
    rng.shuffle(labelled)
    n_eval = round(len(labelled) * eval_frac) if len(labelled) > 1 else 0
    eval_rows, train = labelled[:n_eval], labelled[n_eval:]
    if heard:
        used = {c for key in latest for c in key}
        train += [
            {"audio": c["audio"], "text": c["heard"], "seconds": c["seconds"], "heard": c["heard"], "id": c["id"]}
            for c in clips.values()
            if c["id"] not in used and c.get("heard")
        ]
    return train, eval_rows


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    default_dir = os.environ.get("STT_CLIPS_DIR") or Path(__file__).resolve().parent / "clips"
    ap.add_argument("--dir", type=Path, default=Path(default_dir), help="clips folder (default STT_CLIPS_DIR or stt/clips)")
    ap.add_argument("--heard", action="store_true", help="also train on unfixed clips, with Moonshine's own text")
    ap.add_argument("--eval-frac", type=float, default=0.2, help="share of the labelled clips held out for eval.jsonl")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()
    if not (args.dir / "clips.jsonl").is_file():
        sys.exit(f"no clips in {args.dir}: turn on Settings > Keep voice clips and talk to the board first")
    train, eval_rows = build(args.dir, args.heard, args.eval_frac, args.seed)
    write_jsonl(args.dir / "train.jsonl", train)
    write_jsonl(args.dir / "eval.jsonl", eval_rows)
    mins = lambda rows: sum(r["seconds"] for r in rows) / 60  # noqa: E731
    print(f"train.jsonl: {len(train)} clips, {mins(train):.1f} min; eval.jsonl: {len(eval_rows)} clips, {mins(eval_rows):.1f} min")


if __name__ == "__main__":
    main()
