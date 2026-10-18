"""
Fast-path sidecar: answers "can this command skip the LLM?" with code rules, then a local decision model: a fine-tuned
Laya checkpoint or a single-pass heads checkpoint (fastpath/heads.py).

POST /decide {text, scene}  ->  {route: "fast" | "ignore" | "llm", actions: [{name, input}] | null, reason, model, ms,
                                 tools?: {core: [group] | null}, ...}
GET  /health                ->  {ok, model, threshold, device, awake}

The Node server (server/src/fastpath.ts) calls /decide before the LLM: "fast" actions are streamed to the board
as they are, "ignore" drops chatter, and "llm" (or any failure) falls through to the normal model call.
First the rules (fastpath/rules.py) try to settle the command in code. Otherwise the model answers every
question in fastpath/decide.py (Laya: one pass per question; heads: one pass for all); code then picks the target
when the command names it, routes on confidence and builds the actions. With neither checkpoint set the sidecar runs
rules only (no torch needed) and passes the rest to the LLM.

Setup (this machine): reuse the eval venv, which already has torch (CUDA) and laya.
  eval/.venv/Scripts/python fastpath/server.py
Env: LAYA_CHECKPOINT (fine-tuned Laya checkpoint dir) or HEADS_CHECKPOINT (eval/train_heads.py output); set at most
     one, neither = rules only. FASTPATH_PORT (8788), FASTPATH_HOST (127.0.0.1),
     FASTPATH_THRESHOLD (0.8: no wrong actions on any eval set), FASTPATH_DEVICE (cuda / cpu; default: Laya's choice
     (LAYA_DEVICE is still read), cpu for heads), FASTPATH_THREADS (CPU threads for heads on cpu, default 4),
     FASTPATH_KEEP_WARM_S (5, 0 on cpu; a tiny decision after this many idle seconds keeps the GPU clocked up;
     0 disables),
     FASTPATH_IDLE_UNLOAD_S (900; with no /decide request for this long the model is unloaded (GPU or RAM) and
     keep-warm stops; the next request wakes it in the background and is answered by the LLM; 0 disables),
     FASTPATH_TOOLS_THRESHOLD (0.97; confidence for the `tools` hint: which core tool groups the cloud model gets;
     at 0.9 one of 70 eval commands would have lost its drawing tools).
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from fastpath.decide import (  # noqa: E402
    QUESTIONS_FILE,
    QUESTIONS_VERSION,
    build_questions,
    code_answers,
    draws_object,
    guard,
    object_command,
    parse_answers,
    resolve_target,
    route_object,
    route_why,
    tool_hint,
    words,
)
from fastpath.rules import rule_command  # noqa: E402
from fastpath.split import split_command  # noqa: E402

# Laya's head holds about this many target options; with more elements the target is left to the code rules.
MAX_TARGET_OPTIONS = 10
# Longer commands are almost never one simple action; skip the model call.
MAX_WORDS = 30
# `model` of answers settled by fastpath/rules.py, shown as the route badge's model.
RULES_MODEL = "rules"


def reply(route: str, actions: list[dict] | None, reason: str, model: str, t: float, **extra) -> dict:
    return {"route": route, "actions": actions, "reason": reason, "model": model, "ms": round((time.perf_counter() - t) * 1000, 1), **extra}


def code_answer(text: str, scene: dict, t: float) -> dict | None:
    """The answer when code settles the command without a decision model (too long, or a rule matches), else None."""
    if len(words(text)) > MAX_WORDS:
        return reply("llm", None, "long command", RULES_MODEL, t)
    ruled = rule_command(text, scene)
    return reply(*ruled, RULES_MODEL, t, answers={}, target_rule=None) if ruled else None


def decide_command(decide_one, text: str, scene: dict, t: float, model: str) -> dict:
    """A rule answer for the whole command, else each clause of a split command, else `decide_one` on the whole.

    A split command ("draw an apple and a mango") is fast only when every clause is fast on its own; the first
    clause that isn't sends the whole command to the LLM, without asking about the remaining clauses.
    """
    if len(words(text)) > MAX_WORDS:
        return reply("llm", None, "long command", RULES_MODEL, t)
    ruled = rule_command(text, scene)
    if ruled and ruled[0] == "fast":
        return reply(*ruled, RULES_MODEL, t, answers={}, target_rule=None)
    clauses = split_command(text, scene)
    if not clauses:
        return decide_one(text)
    answers = []
    for n, clause in enumerate(clauses, 1):
        got = decide_one(clause)
        answers.append({"text": clause, "route": got["route"], "reason": got["reason"], "model": got["model"]})
        if got["route"] != "fast" or not got["actions"]:
            return reply("llm", None, f"part {n} '{clause}': {got['reason']}", got["model"], t, parts=answers)
        answers[-1]["actions"] = got["actions"]
    actions = [a for part in answers for a in part.pop("actions")]
    by = RULES_MODEL if all(a["model"] == RULES_MODEL for a in answers) else model
    return reply("fast", actions, "split: " + " + ".join(a["reason"] for a in answers), by, t, parts=answers)


class RulesOnly:
    """The sidecar without a decision model: rule answers only, everything else goes to the LLM."""

    name, threshold, device, asleep = RULES_MODEL, None, None, False

    def decide(self, text: str, scene: dict) -> dict:
        t = time.perf_counter()
        return decide_command(lambda part: self.decide_one(part, scene), text, scene, t, self.name)

    def decide_one(self, text: str, scene: dict) -> dict:
        t = time.perf_counter()
        return code_answer(text, scene, t) or reply("llm", None, "no rule matched", RULES_MODEL, t)


def alias_scene(scene: dict) -> tuple[dict, dict[str, str]]:
    """Short ids (e1, e2, ...) like the ones Laya was fine-tuned on, plus the map back to the real ids.

    Element ids drawn by hand in Excalidraw are random 20-character strings the model never saw in training.
    """
    to_alias = {el["id"]: f"e{i + 1}" for i, el in enumerate(scene["elements"])}
    elements = []
    for el in scene["elements"]:
        el = {**el, "id": to_alias[el["id"]]}
        for end in ("from", "to"):
            if el.get(end) in to_alias:
                el[end] = to_alias[el[end]]
        elements.append(el)
    aliased = {
        **scene,
        "elements": elements,
        "selectedIds": [to_alias[i] for i in scene.get("selectedIds", []) if i in to_alias],
        "recentIds": [to_alias[i] for i in scene.get("recentIds", []) if i in to_alias],
    }
    return aliased, {a: real for real, a in to_alias.items()}


def unalias(actions: list[dict], back: dict[str, str]) -> list[dict]:
    out = []
    for a in actions:
        inp = dict(a["input"])
        for key in ("target", "to", "on"):  # update/move, scroll_view, zoom_view
            if key in inp:
                inp[key] = back[inp[key]]
        if "targets" in inp:
            inp["targets"] = [back[t] for t in inp["targets"]]
        out.append({"name": a["name"], "input": inp})
    return out


class LayaModel:
    """A fine-tuned Laya checkpoint: one pass per question. Its target head holds about 10 elements."""

    max_targets = MAX_TARGET_OPTIONS

    def __init__(self, checkpoint: str, device: str | None):
        import laya

        self.name, self.device = f"laya:{Path(checkpoint).name}", device
        self.router = laya.Router(device=device, default="english")
        self.model = self.router.register("tuned", checkpoint)
        self.load()

    def load(self) -> None:
        self.router.load(self.model)

    def unload(self) -> None:
        self.router.unload(self.model)

    def answers(self, text: str, questions: dict) -> dict:
        return parse_answers(self.router.predict({"command": text}, questions, model=self.model))


class HeadsDecider:
    """A fastpath/heads.py checkpoint: one pass answers every question; the target is a pointer over any number of elements."""

    max_targets = None

    def __init__(self, checkpoint: str, device: str):
        self.checkpoint, self.device = checkpoint, device
        self.name = f"heads:{Path(checkpoint).name}"
        self.decider = None
        self.load()

    def load(self) -> None:
        from fastpath.heads import Decider

        self.decider = Decider(self.checkpoint, device=self.device)

    def unload(self) -> None:
        self.decider = None
        if self.device != "cpu":
            import torch

            torch.cuda.empty_cache()

    def answers(self, text: str, questions: dict) -> dict:
        crit = questions.get("target", {}).get("criteria", {})
        return self.decider.answer(text, {k: v for k, v in crit.items() if k != "none"})[0]


class FastPath:
    def __init__(self, model, threshold: float, keep_warm_s: float = 5.0, idle_unload_s: float = 900.0, tools_threshold: float = 0.97):
        """`model`: a LayaModel or HeadsDecider (name, device, max_targets, load(), unload(), answers(text, questions))."""
        self.model, self.threshold, self.device, self.name = model, threshold, model.device, model.name
        # A wrong tool hint can leave the cloud model without a tool it needs, so it takes more confidence than a fast action.
        self.tools_threshold = tools_threshold
        self.lock = threading.Lock()  # one model, one call at a time
        self.last_call = 0.0  # last model call, including keep-warm ones
        self.last_request = time.monotonic()  # last /decide request: what idle unload measures
        self.asleep = False  # model unloaded from the GPU
        self.waking = False
        self.state_lock = threading.Lock()  # guards asleep/waking transitions
        self.warm()
        if keep_warm_s > 0 or idle_unload_s > 0:
            tick = keep_warm_s if keep_warm_s > 0 else 30.0
            threading.Thread(target=self.housekeeping, args=(tick, keep_warm_s, idle_unload_s), daemon=True).start()

    def warm(self) -> None:
        self.decide("undo", {"elements": [], "selectedIds": [], "recentIds": []}, warming=True)

    def housekeeping(self, tick_s: float, keep_warm_s: float, idle_unload_s: float) -> None:
        """Keep the GPU clocked up while in use, and free it after a long idle spell.

        A laptop GPU drops its clocks when idle: the first command after 40 s took 0.5 s instead of 0.19 s, and
        after a few minutes 1.3 s, past the Node server's timeout. So after `keep_warm_s` idle seconds a tiny
        decision runs (about 4% of the GPU at 5 s). After `idle_unload_s` without any request the model is
        unloaded instead, and the next request wakes it (see `wake`).
        """
        while True:
            time.sleep(tick_s)
            if self.asleep:
                continue
            now = time.monotonic()
            if idle_unload_s > 0 and now - self.last_request >= idle_unload_s:
                with self.lock:  # re-check: a request may have arrived while waiting for the lock
                    if time.monotonic() - self.last_request >= idle_unload_s:
                        self.model.unload()
                        self.asleep = True
                        sys.stderr.write(f"idle for {idle_unload_s:.0f}s: model unloaded\n")
            elif keep_warm_s > 0 and now - self.last_call >= keep_warm_s:
                self.warm()

    def wake(self) -> None:
        """Reload the model in the background; requests are answered by the LLM until it is back."""
        with self.state_lock:
            if not self.asleep or self.waking:
                return
            self.waking = True
        threading.Thread(target=self._wake, daemon=True).start()

    def _wake(self) -> None:
        t = time.perf_counter()
        try:
            self.model.load()
            self.warm()
            self.asleep = False
            sys.stderr.write(f"model reloaded in {time.perf_counter() - t:.1f}s\n")
        except Exception as err:  # stay asleep; the next request tries again
            sys.stderr.write(f"model reload failed: {type(err).__name__}: {err}\n")
        finally:
            self.waking = False

    def decide(self, text: str, scene: dict, warming: bool = False) -> dict:
        if warming:
            return self.ask(text, scene, warming=True)
        self.last_request = time.monotonic()
        if self.asleep:
            self.wake()
        return decide_command(lambda part: self.decide_one(part, scene), text, scene, time.perf_counter(), self.name)

    def decide_one(self, text: str, scene: dict) -> dict:
        """One command (or clause): rules, measurements and clear-verb objects in code, else the model."""
        return code_answer(text, scene, time.perf_counter()) or self.ask(text, scene)

    def ask(self, text: str, scene: dict, warming: bool = False) -> dict:
        """The model's answers for the command, routed."""
        t = time.perf_counter()
        obj = object_command(text)  # only a casual one is left ("let's grab a tree"): Laya checks it's for the board
        aliased, back = alias_scene(scene)
        questions = build_questions(aliased)
        if self.model.max_targets and len(questions.get("target", {}).get("criteria", {})) > self.model.max_targets + 1:
            del questions["target"]
        with self.lock:
            if self.asleep and not warming:  # unloaded after the check above, or still reloading
                return {"route": "llm", "actions": None, "reason": "fast path waking up", "model": self.name, "ms": 0}
            ans = self.model.answers(text, questions)
            self.last_call = time.monotonic()
        ans = {**ans, **code_answers(text)}
        if "target" not in questions:
            ans["target"] = ("none", 0.0)  # unknown, not confidently "none"
        rule = resolve_target(text, aliased)
        if rule:
            ans["target"] = (rule[0], 1.0)
        ans = guard(ans, text, rule)
        decision, actions, why = route_why(ans, self.threshold)
        if obj:  # casual "let's grab a tree": fast only if the model agrees it's a board command
            decision, actions, why = route_object(obj, ans, self.threshold)
        elif drawn := draws_object(text, decision, actions):
            decision, actions, why = "llm", None, f"drawing a {drawn} needs the LLM"
        return {
            "route": decision,
            "actions": unalias(actions, back) if actions else None,
            "reason": why,
            "model": self.name,
            "tools": tool_hint(ans, self.tools_threshold),
            "answers": {k: [v, round(c, 3)] for k, (v, c) in ans.items()},
            "target_rule": rule[1] if rule else None,
            "ms": round((time.perf_counter() - t) * 1000, 1),
        }


def handler_for(fast: FastPath | RulesOnly):
    class Handler(BaseHTTPRequestHandler):
        def _send(self, code: int, body: dict) -> None:
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            try:
                self.wfile.write(data)
            except ConnectionError:  # the caller timed out and went to the cloud model
                pass

        def do_GET(self) -> None:
            if self.path != "/health":
                return self._send(404, {"error": "not found"})
            self._send(200, {"ok": True, "model": fast.name, "threshold": fast.threshold, "device": fast.device,
                                  "awake": not fast.asleep})

        def do_POST(self) -> None:
            if self.path != "/decide":
                return self._send(404, {"error": "not found"})
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))))
                text, scene = body["text"], body["scene"]
                if not isinstance(text, str) or not isinstance(scene.get("elements"), list):
                    raise ValueError("expected {text, scene}")
            except (ValueError, KeyError, TypeError, AttributeError) as err:
                return self._send(400, {"error": str(err)})
            try:
                self._send(200, fast.decide(text, scene))
            except Exception as err:  # the caller falls back to the LLM
                self._send(500, {"error": f"{type(err).__name__}: {err}"})

        def log_message(self, fmt: str, *args) -> None:  # one line per request on stderr, without the default noise
            sys.stderr.write(f"{self.command} {self.path} {args[1] if len(args) > 1 else ''}\n")

    return Handler


def laya_model(checkpoint: str, device: str | None) -> LayaModel:
    if not Path(checkpoint, "rl_agent_config.json").exists():
        sys.exit("LAYA_CHECKPOINT must be a fine-tuned Laya checkpoint dir (one with rl_agent_config.json).")
    marker = Path(checkpoint, QUESTIONS_FILE)
    trained_on = json.loads(marker.read_text())["questions"] if marker.exists() else 2
    if trained_on != QUESTIONS_VERSION:
        sys.exit(
            f"{Path(checkpoint).name} was trained on questions v{trained_on}, but fastpath/decide.py asks v{QUESTIONS_VERSION}. "
            "Retrain it (eval/make_train.py + eval/train_laya.py) or run rules only (unset LAYA_CHECKPOINT)."
        )
    return LayaModel(checkpoint, device)


def heads_model(checkpoint: str, device: str) -> HeadsDecider:
    from fastpath.heads import CONFIG_FILE

    if not Path(checkpoint, CONFIG_FILE).exists():
        sys.exit(f"HEADS_CHECKPOINT must be a heads checkpoint dir from eval/train_heads.py (one with {CONFIG_FILE}).")
    if device == "cpu":
        import torch

        torch.set_num_threads(int(os.environ.get("FASTPATH_THREADS", 4)))
    try:
        return HeadsDecider(checkpoint, device)
    except ValueError as err:  # trained on other questions (fastpath.heads.load_checkpoint)
        sys.exit(f"{err}. Retrain it with eval/train_heads.py or run rules only (unset HEADS_CHECKPOINT).")


def main() -> None:
    laya_dir, heads_dir = os.environ.get("LAYA_CHECKPOINT"), os.environ.get("HEADS_CHECKPOINT")
    host, port = os.environ.get("FASTPATH_HOST", "127.0.0.1"), int(os.environ.get("FASTPATH_PORT", 8788))
    if laya_dir and heads_dir:
        sys.exit("Set LAYA_CHECKPOINT or HEADS_CHECKPOINT, not both.")
    if not laya_dir and not heads_dir:
        print(f"fast path ready on http://{host}:{port} (rules only: no LAYA_CHECKPOINT or HEADS_CHECKPOINT)", flush=True)
        ThreadingHTTPServer((host, port), handler_for(RulesOnly())).serve_forever()
        return
    device = os.environ.get("FASTPATH_DEVICE")
    model = laya_model(laya_dir, device or os.environ.get("LAYA_DEVICE") or None) if laya_dir else heads_model(heads_dir, device or "cpu")
    # Keep-warm only helps a GPU that clocks down when idle.
    keep_warm = os.environ.get("FASTPATH_KEEP_WARM_S", "0" if model.device == "cpu" else "5")
    fast = FastPath(
        model,
        float(os.environ.get("FASTPATH_THRESHOLD", 0.8)),
        float(keep_warm),
        float(os.environ.get("FASTPATH_IDLE_UNLOAD_S", 900)),
        float(os.environ.get("FASTPATH_TOOLS_THRESHOLD", 0.97)),
    )
    where = model.device or "default device"
    print(f"fast path ready on http://{host}:{port} ({fast.name} on {where}, threshold {fast.threshold})", flush=True)
    ThreadingHTTPServer((host, port), handler_for(fast)).serve_forever()


if __name__ == "__main__":
    main()
