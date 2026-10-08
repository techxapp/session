"""
Evaluate SemIf (option logits from a small LLM) on the same samples, questions and router as laya_eval.py.

Each question becomes one SemIf decision: the model sees the state, the question and lettered option
descriptions, and the option letters' next-token logits are softmaxed into probabilities. All of a
command's questions share one state, so they are scored with SemIf's shared-prefix mode (one prefill,
one restored branch per question). Confidence is the top option's probability, which SemIf does not
calibrate, unlike Laya's answer_confidence; the report's threshold sweep shows what that costs.

Uses SemIf's llama.cpp backend (quantized GGUF) with GPU offload added: SemIf itself runs llama.cpp on
CPU only, so --gpu-layers 0 reproduces its own setup.

--layout question-first is our variation, not SemIf's: the prompt JSON lists the question and options
before the evidence, so each question's prefix (about 120 tokens, identical for every command) is
prefilled once and cached, and a command only decodes its own ~25 tokens per question. The answer is
still read from the letter logits at the generation slot, with SemIf's tokenizer checks.

Setup (Windows, on top of the laya_eval.py venv):
  git clone https://github.com/TheoLeeCJ/SemIf eval/.semif     (imported from eval/.semif/src, not installed:
                                                               its pyproject pins torch 2.10 and would downgrade the venv)
  set CMAKE_ARGS=-DGGML_CUDA=on -DCMAKE_CUDA_ARCHITECTURES=86   (RTX 30xx; needs CUDA toolkit + VS C++ tools)
  eval/.venv/Scripts/python -m pip install llama-cpp-python==0.3.35 --no-cache-dir
Model files (pinned GGUF + reference tokenizer) download from Hugging Face on first use.

Usage:
  python semif_eval.py [--model minicpm5-2b|qwen3.5-2b|qwen3.5-4b] [--layout command-first|question-first]
                       [--gpu-layers 99] [--threshold 0.6] [--state command|scene]
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

from laya_eval import HERE, build_questions, report, rules_tag, run_samples, samples_tag, save

sys.path.insert(0, str(HERE / ".semif" / "src"))

from semif_phase1 import llamacpp_backend  # noqa: E402
from semif_phase1.core import DIRECT_SYSTEM, LETTERS, softmax, validate_row  # noqa: E402
from semif_phase1.direct import _slot_ids  # noqa: E402

# (tokenizer repo, revision, GGUF repo, revision, file); minicpm5-2b and qwen3.5-4b are the
# browser-ladder checkpoints pinned in SemIf's manifests/models.json.
MODELS = {
    "minicpm5-2b": (
        "openbmb/MiniCPM5-2B",
        "12a3808a956f869c767195e9266b59c4d21d92e2",
        "openbmb/MiniCPM5-2B-GGUF",
        "2079a22f3beaa4e306449978533478fe0522f4b3",
        "MiniCPM5-2B-Q4_K_M.gguf",
    ),
    # Not in SemIf's ladder; same quantizer as the 4B for a like-for-like comparison.
    "qwen3.5-2b": (
        "Qwen/Qwen3.5-2B",
        "15852e8c16360a2fea060d615a32b45270f8a8fc",
        "bartowski/Qwen_Qwen3.5-2B-GGUF",
        "7d26695454df6de5fbcce2e58681e62dae06ce43",
        "Qwen_Qwen3.5-2B-Q4_K_M.gguf",
    ),
    "qwen3.5-4b": (
        "Qwen/Qwen3.5-4B",
        "851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a",
        "bartowski/Qwen_Qwen3.5-4B-GGUF",
        "4168f45a16a1290d65a4ec0fa312ae917a4c15d6",
        "Qwen_Qwen3.5-4B-Q4_K_M.gguf",
    ),
}


def to_rows(state: dict, questions: dict) -> list[dict]:
    """Laya-style questions -> SemIf decision rows. Only option descriptions reach the model, not ids."""
    return [
        {
            "id": name,
            "state": state,
            "question": q["instructions"],
            "options": [{"id": oid, "description": desc} for oid, desc in q["criteria"].items()],
        }
        for name, q in questions.items()
    ]


def parse_results(results: list[dict], questions: dict) -> dict:
    """SemIf results -> {field: (value, confidence)}, matching laya_eval.parse_answers."""
    out: dict = {}
    for r in results:
        probs = dict(zip(r["option_ids"], r["probabilities"]))
        best = max(probs, key=probs.get)
        if questions[r["id"]]["type"] == "noul":
            out[r["id"]] = (probs["true"] >= 0.5, probs[best])
        else:
            out[r["id"]] = (best, probs[best])
    out.setdefault("target", ("none", 1.0))
    return out


class QuestionFirstScorer:
    """Score decisions with the question before the evidence, caching each question's prefix state.

    Built on SemIf's llama.cpp engine (prefill / save_state / restore_state / branch_logits); only the
    prompt layout differs from SemIf's direct prompt.
    """

    def __init__(self, model, tokenizer):
        self.engine = model.engine
        self.vocab = model.vocab
        self.tokenizer = tokenizer
        self.cache: dict[str, tuple[list[int], object]] = {}  # prefix text -> (prefix ids, saved state)
        self.prefill_seconds = 0.0

    def _messages(self, row: dict) -> list[dict]:
        validate_row(row)
        payload = {
            "criterion": row["question"],
            "options": [{"letter": LETTERS[i], "description": o["description"]} for i, o in enumerate(row["options"])],
            "evidence": row["state"],
        }
        return [{"role": "system", "content": DIRECT_SYSTEM}, {"role": "user", "content": json.dumps(payload, ensure_ascii=False)}]

    def _encode(self, row: dict) -> tuple[list[int], list[int], str]:
        """Full prompt ids, answer-slot ids and the state-independent prefix text, with SemIf's checks."""
        messages = self._messages(row)
        prompt = self.tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True, enable_thinking=False)
        ids = self.tokenizer.encode(prompt, add_special_tokens=False)
        slots = _slot_ids(self.tokenizer, len(row["options"]))
        for letter, token in zip(LETTERS, slots):
            if self.tokenizer.encode(prompt + letter, add_special_tokens=False) != ids + [token]:
                raise ValueError(f"{row['id']}: answer boundary changes tokenization for slot {letter}")
        if llamacpp_backend._gguf_tokenize(self.engine.lib, self.vocab, prompt) != ids:
            raise ValueError(f"{row['id']}: GGUF tokenization disagrees with the reference tokenizer")
        payload = messages[-1]["content"]
        state_json = json.dumps(row["state"], ensure_ascii=False)
        if prompt.count(payload) != 1 or not payload.endswith(state_json + "}"):
            raise ValueError("Cannot locate the evidence in the rendered prompt")
        prefix_text = prompt[: prompt.index(payload)] + payload[: -len(state_json) - 1]
        return ids, slots, prefix_text

    def _prefix(self, prefix_text: str) -> tuple[list[int], object]:
        if prefix_text not in self.cache:
            # Drop the last token: it can merge with the evidence that follows (same trick as SemIf's _state_prefix).
            ids = self.tokenizer.encode(prefix_text, add_special_tokens=False)[:-1]
            t = time.perf_counter()
            self.engine.clear()
            self.engine.prefill(ids)
            self.cache[prefix_text] = (ids, self.engine.save_state())
            self.prefill_seconds += time.perf_counter() - t
        return self.cache[prefix_text]

    def warm(self, rows: list[dict]) -> None:
        for row in rows:
            self._prefix(self._encode(row)[2])

    def score(self, rows: list[dict]) -> tuple[list[dict], int]:
        results, suffix_tokens = [], 0
        for row in rows:
            ids, slots, prefix_text = self._encode(row)
            prefix, state = self._prefix(prefix_text)
            if ids[: len(prefix)] != prefix or len(ids) <= len(prefix):
                raise ValueError(f"{row['id']}: cached prefix does not match the full prompt")
            self.engine.restore_state(state)
            logits = self.engine.branch_logits(len(prefix), ids[len(prefix) :])
            suffix_tokens += len(ids) - len(prefix)
            results.append({"id": row["id"], "option_ids": [o["id"] for o in row["options"]], "probabilities": softmax(logits[slots].tolist())})
        return results, suffix_tokens


def gpu_used_mb() -> int | None:
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"], capture_output=True, text=True, check=True
        ).stdout
        return int(out.split()[0])
    except (OSError, subprocess.CalledProcessError, ValueError, IndexError):
        return None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="minicpm5-2b", choices=sorted(MODELS))
    ap.add_argument("--gpu-layers", type=int, default=99, help="layers offloaded to the GPU; 0 = SemIf's CPU-only setup")
    ap.add_argument("--threads", type=int, default=8, help="CPU threads for llama.cpp")
    ap.add_argument("--threshold", type=float, default=0.6, help="minimum confidence for every answer the fast path uses")
    ap.add_argument("--state", default="command", choices=["command", "scene"], help="see laya_eval.py")
    ap.add_argument("--samples", default=str(HERE / "samples.jsonl"))
    ap.add_argument(
        "--layout",
        default="command-first",
        choices=["command-first", "question-first"],
        help="command-first: SemIf's prompt (shared command prefix); question-first: cached question prefixes (see docstring)",
    )
    ap.add_argument("--target-rules", action="store_true", help="see laya_eval.resolve_target")
    ap.add_argument("--out", default=None, help="default: results/semif-<model>-<state>[-qfirst][-cpu][-rules][-<sample set>].json")
    args = ap.parse_args()
    suffix = ("-qfirst" if args.layout == "question-first" else "") + ("-cpu" if args.gpu_layers == 0 else "") + rules_tag(args) + samples_tag(args.samples)
    args.out = args.out or str(HERE / "results" / f"semif-{args.model}-{args.state}{suffix}.json")

    from huggingface_hub import hf_hub_download

    scenes = json.loads((HERE / "scenes.json").read_text())
    samples = [json.loads(line) for line in Path(args.samples).read_text().splitlines() if line.strip()]

    tok_repo, tok_rev, gguf_repo, gguf_rev, gguf_file = MODELS[args.model]
    gguf = hf_hub_download(gguf_repo, gguf_file, revision=gguf_rev)

    cpu_params = llamacpp_backend._cpu_model_params

    def offload_params(library):
        params = cpu_params(library)
        params.n_gpu_layers = args.gpu_layers
        return params

    llamacpp_backend._cpu_model_params = offload_params

    before_mb = gpu_used_mb()
    t0 = time.perf_counter()
    model, tokenizer, metadata = llamacpp_backend.load_model(tok_repo, tok_rev, gguf, threads=args.threads, context_tokens=2048)
    load_s = time.perf_counter() - t0

    extra: dict = {"layout": args.layout}
    if args.layout == "question-first":
        scorer = QuestionFirstScorer(model, tokenizer)
        # The 8 fixed questions are cached once; the target question is cached per board (its options list the
        # elements), which in the app would happen when the board changes, not on the command's critical path.
        t = time.perf_counter()
        for scene in scenes.values():
            scorer.warm(to_rows({"command": "placeholder"}, build_questions(scene)))
        warm_s = time.perf_counter() - t
        extra.update(cached_prefixes=len(scorer.cache), warm_seconds=round(warm_s, 2))
        print(f"Cached {len(scorer.cache)} question prefixes in {warm_s:.1f}s")

        def answer(state: dict, questions: dict) -> tuple[dict, int | None]:
            results, suffix_tokens = scorer.score(to_rows(state, questions))
            return parse_results(results, questions), suffix_tokens

    else:

        def answer(state: dict, questions: dict) -> tuple[dict, int | None]:
            results, timing = llamacpp_backend.score_shared(model, tokenizer, to_rows(state, questions), metadata, max_tokens=2048)
            return parse_results(results, questions), timing["prefix_tokens"] + timing["true_suffix_tokens"]

    rows = run_samples(answer, scenes, samples, args)
    after_mb = gpu_used_mb()
    gpu_mb = after_mb - before_mb if after_mb is not None and before_mb is not None else None

    print(f"Layout: {args.layout}")
    report(rows, args, load_s, gpu_mb)
    extra.update(gpu_mb=gpu_mb, gpu_layers=args.gpu_layers, gguf=metadata["gguf"], llama_cpp_python=metadata["llama_cpp_python_version"])
    save(rows, args, extra)


if __name__ == "__main__":
    main()
