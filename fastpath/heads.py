"""
Single-pass decision model for the voice-board fast path: one encoder pass answers every question of a command.
The sidecar loads it with HEADS_CHECKPOINT (fastpath/server.py); eval/train_heads.py trains it and eval/heads_eval.py
evaluates it.

Laya (like SemIf and GLiNER) runs once per question, with the question and its option descriptions as input: 12 passes
of a few hundred tokens per command. Here the questions are trained heads, so the input is only the command and the
board's elements:

  [CLS] command [SEP] element 1 [SEP] element 2 [SEP] ...

The element texts are the target question's option descriptions (decide.describe_element: 'box "Postgres" blue
(selected)'), so train rows from make_train.py and the eval scenes give the same input.
- Each closed-set question (QUESTIONS) has a learned query that attention-pools the token states, then a small MLP
  over that question's options (decide.build_questions' option ids, in its order; noul = ["false", "true"]).
- `target` is a pointer: each element's span (mean of its tokens) is scored against the target query, plus a `none`
  score, softmaxed together, so any number of elements fits (Laya's head holds about 10).
Confidence = the top option's softmax probability after per-question temperature scaling, fitted on held-out rows by
train_heads.py.

`Decider.answer` returns {field: (value, confidence)} like decide.parse_answers, so decide.py's guard / route /
compose and laya_eval's run_samples / report take the answers unchanged.

Checkpoint layout (train_heads.py writes it): model.safetensors (encoder + heads, fp16), encoder/config.json,
tokenizer/, heads.json (options, temperatures, questions version, training summary).
"""

from __future__ import annotations

import json
from pathlib import Path

import torch
from torch import nn

from fastpath.decide import QUESTIONS_VERSION, build_questions

CONFIG_FILE = "heads.json"
# Every question decide.build_questions asks except `target`, which is the pointer. (`extra`, still labelled in
# train-v3, is no longer asked.)
QUESTIONS = ["on_board", "route", "action", "view", "color", "kind", "size", "direction", "core", "multi_step", "needs_text"]
EMPTY_SCENE = {"elements": [], "selectedIds": [], "recentIds": []}
MAX_LEN = 256


def question_options() -> tuple[dict[str, list[str]], list[str]]:
    """({question: option ids}, noul question names), from decide.build_questions."""
    qs = build_questions(EMPTY_SCENE)
    noul = [n for n in QUESTIONS if qs[n]["type"] == "noul"]
    return {n: ["false", "true"] if n in noul else list(qs[n]["criteria"]) for n in QUESTIONS}, noul


def label_index(options: list[str], value) -> int:
    """An expected answer (bool for noul, option id for choice) -> its option index."""
    return options.index(str(value).lower() if isinstance(value, bool) else value)


def mlp(d_in: int, hidden: int, d_out: int) -> nn.Module:
    return nn.Sequential(nn.Linear(d_in, hidden), nn.GELU(), nn.Dropout(0.1), nn.Linear(hidden, d_out))


class HeadsModel(nn.Module):
    def __init__(self, encoder: nn.Module, options: dict[str, list[str]], hidden: int = 512):
        super().__init__()
        d = encoder.config.hidden_size
        self.encoder = encoder
        self.names = list(options)
        # One learned query per question, plus the target pointer's (the last).
        self.queries = nn.Parameter(torch.randn(len(self.names) + 1, d) * d**-0.5)
        self.heads = nn.ModuleDict({n: mlp(d, hidden, len(o)) for n, o in options.items()})
        self.point_el = nn.Linear(d, hidden)
        self.point_q = nn.Linear(d, hidden)
        self.point_out = nn.Linear(hidden, 1)
        self.none_head = mlp(d, hidden, 1)
        self.register_buffer("temperature", torch.ones(len(self.names) + 1))

    def forward(self, input_ids, attention_mask, el_start, el_end, el_mask) -> dict[str, torch.Tensor]:
        """Logits per question [B, options], and `target` [B, 1 + elements] (index 0 = none, masked elements -inf)."""
        h = self.encoder(input_ids=input_ids, attention_mask=attention_mask).last_hidden_state
        scores = torch.einsum("bld,qd->bql", h, self.queries.to(h.dtype)) * h.shape[-1] ** -0.5
        scores = scores.masked_fill(~attention_mask.bool()[:, None, :], float("-inf"))
        pooled = torch.einsum("bql,bld->bqd", scores.softmax(-1), h)
        out = {n: self.heads[n](pooled[:, i]) for i, n in enumerate(self.names)}

        pos = torch.arange(h.shape[1], device=h.device)
        span = ((pos >= el_start[..., None]) & (pos < el_end[..., None]) & el_mask[..., None]).to(h.dtype)  # [B, E, L]
        el = torch.einsum("bel,bld->bed", span, h) / span.sum(-1, keepdim=True).clamp(min=1)
        t = pooled[:, -1]
        el_scores = self.point_out(torch.tanh(self.point_el(el) + self.point_q(t)[:, None])).squeeze(-1)
        out["target"] = torch.cat([self.none_head(t), el_scores.masked_fill(~el_mask, float("-inf"))], dim=1)
        return out


def encode_pieces(tok, command: str, descriptions: list[str]) -> tuple[list[int], list[list[int]]]:
    enc = tok([command, *descriptions], add_special_tokens=False)["input_ids"]
    return enc[0], enc[1:]


def assemble(tok, cmd: list[int], els: list[list[int]], max_len: int) -> tuple[list[int], list[int], list[int]]:
    """[CLS] command [SEP] el1 [SEP] ... -> (ids, element starts, element ends); elements past max_len are dropped."""
    ids = [tok.cls_token_id, *cmd[: max_len // 2], tok.sep_token_id]
    starts, ends = [], []
    for e in els:
        if len(ids) + len(e) + 1 > max_len:
            break
        starts.append(len(ids))
        ids += e
        ends.append(len(ids))
        ids.append(tok.sep_token_id)
    return ids, starts, ends


def collate(seqs: list[tuple[list[int], list[int], list[int]]], pad_id: int) -> dict[str, torch.Tensor]:
    n, length, els = len(seqs), max(len(s[0]) for s in seqs), max(len(s[1]) for s in seqs)
    batch = {
        "input_ids": torch.full((n, length), pad_id, dtype=torch.long),
        "attention_mask": torch.zeros((n, length), dtype=torch.long),
        "el_start": torch.zeros((n, els), dtype=torch.long),
        "el_end": torch.zeros((n, els), dtype=torch.long),
        "el_mask": torch.zeros((n, els), dtype=torch.bool),
    }
    for i, (ids, starts, ends) in enumerate(seqs):
        batch["input_ids"][i, : len(ids)] = torch.tensor(ids)
        batch["attention_mask"][i, : len(ids)] = 1
        batch["el_start"][i, : len(starts)] = torch.tensor(starts, dtype=torch.long)
        batch["el_end"][i, : len(ends)] = torch.tensor(ends, dtype=torch.long)
        batch["el_mask"][i, : len(starts)] = True
    return batch


def no_init_weights():
    """Skip random init of weights a checkpoint is about to overwrite (~25 s for ModernBERT-large on CPU)."""
    try:
        from transformers.initialization import no_init_weights
    except ImportError:  # transformers 4.x
        from transformers.modeling_utils import no_init_weights
    return no_init_weights()


def init_encoder(init: str):
    """(encoder, tokenizer) to train from: a Laya checkpoint dir (its fine-tuned ModernBERT) or a Hub encoder id."""
    from safetensors.torch import load_file
    from transformers import AutoConfig, AutoModel, AutoTokenizer

    p = Path(init)
    if (p / "rl_agent_config.json").exists():
        with no_init_weights():
            enc = AutoModel.from_config(AutoConfig.from_pretrained(p / "encoder"), attn_implementation="sdpa")
        weights = {k.removeprefix("encoder."): v for k, v in load_file(p / "model.safetensors").items() if k.startswith("encoder.")}
        enc.load_state_dict(weights, strict=True)
        tok = AutoTokenizer.from_pretrained(p / "tokenizer")
    else:
        enc = AutoModel.from_pretrained(init, attn_implementation="sdpa")
        tok = AutoTokenizer.from_pretrained(init)
    return enc.float(), tok


def save_checkpoint(model: HeadsModel, tok, cfg: dict, path: str) -> None:
    from safetensors.torch import save_file

    out = Path(path)
    out.mkdir(parents=True, exist_ok=True)
    save_file({k: v.detach().half().cpu().contiguous() for k, v in model.state_dict().items()}, str(out / "model.safetensors"))
    model.encoder.config.save_pretrained(out / "encoder")
    tok.save_pretrained(out / "tokenizer")
    (out / CONFIG_FILE).write_text(json.dumps(cfg, indent=2))


def load_checkpoint(path: str) -> tuple[HeadsModel, object, dict]:
    """(model in fp32 on CPU, tokenizer, heads.json); refuses a checkpoint trained on other questions."""
    from safetensors.torch import load_file
    from transformers import AutoConfig, AutoModel, AutoTokenizer

    p = Path(path)
    cfg = json.loads((p / CONFIG_FILE).read_text())
    options, noul = question_options()
    if cfg["questions_version"] != QUESTIONS_VERSION or cfg["options"] != options or cfg["noul"] != noul:
        raise ValueError(f"{path} was trained on other questions than fastpath/decide.py asks now (v{QUESTIONS_VERSION})")
    with no_init_weights():
        enc = AutoModel.from_config(AutoConfig.from_pretrained(p / "encoder"), attn_implementation="sdpa")
    model = HeadsModel(enc, cfg["options"], cfg["hidden"])
    model.load_state_dict(load_file(p / "model.safetensors"), strict=True)
    return model.float(), AutoTokenizer.from_pretrained(p / "tokenizer"), cfg


class Decider:
    """Loads a checkpoint and answers one command: `answer(command, {element id: description})`."""

    def __init__(self, path: str, device: str | None = None, fp32: bool = False, int8: bool = False):
        model, self.tok, self.cfg = load_checkpoint(path)
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        if int8:  # dynamic int8 Linear layers, CPU only
            if self.device != "cpu":
                raise ValueError("--int8 is for CPU")
            model = torch.ao.quantization.quantize_dynamic(model, {nn.Linear}, dtype=torch.qint8)
        elif self.device != "cpu" and not fp32:
            model = model.to(torch.bfloat16)
        self.model = model.to(self.device).eval()
        self.options, self.noul = self.cfg["options"], set(self.cfg["noul"])
        self.temperature = model.temperature.float().cpu()
        self.max_len = self.cfg.get("max_len", MAX_LEN)

    @torch.inference_mode()
    def answer(self, command: str, elements: dict[str, str]) -> tuple[dict, int]:
        """({field: (value, confidence)}, input tokens); `target` only when the board has elements."""
        el_ids = list(elements)
        cmd, els = encode_pieces(self.tok, command, list(elements.values()))
        seq = assemble(self.tok, cmd, els, self.max_len)
        batch = {k: v.to(self.device) for k, v in collate([seq], self.tok.pad_token_id).items()}
        out = self.model(**batch)
        names = [*self.model.names, "target"]
        # One device -> host copy for every head.
        logits = torch.cat([out[n][0].float() for n in names]).cpu().split([out[n].shape[1] for n in names])
        answers: dict = {}
        for i, name in enumerate(names):
            p = (logits[i] / self.temperature[i]).softmax(-1)
            conf, k = (float(x) for x in p.max(-1))
            k = int(k)
            if name == "target":
                if el_ids:
                    answers["target"] = ("none" if k == 0 else el_ids[k - 1], conf)
            elif name in self.noul:
                answers[name] = (self.options[name][k] == "true", conf)
            else:
                answers[name] = (self.options[name][k], conf)
        answers.setdefault("target", ("none", 1.0))
        return answers, len(seq[0])
