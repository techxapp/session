"""
Fast-path sidecar: answers "can this command skip the LLM?" with a fine-tuned Laya checkpoint.

POST /decide {text, scene}  ->  {route: "fast" | "ignore" | "llm", actions: [{name, input}] | null, reason, model, ms, ...}
GET  /health                ->  {ok, checkpoint, threshold, device}

The Node server (server/src/fastpath.ts) calls /decide before the LLM: "fast" actions are streamed to the board
as they are, "ignore" drops chatter, and "llm" (or any failure) falls through to the normal model call. One
Laya call asks every question in fastpath/decide.py; code then picks the target when the command names it,
routes on confidence and builds the actions.

Setup (this machine): reuse the eval venv, which already has torch (CUDA) and laya.
  eval/.venv/Scripts/python fastpath/server.py
Env: LAYA_CHECKPOINT (fine-tuned checkpoint dir, required), FASTPATH_PORT (8788), FASTPATH_HOST (127.0.0.1),
     FASTPATH_THRESHOLD (0.8: no wrong actions on any eval set), LAYA_DEVICE (cuda / cpu, default Laya's choice),
     FASTPATH_KEEP_WARM_S (5; a tiny decision after this many idle seconds keeps the GPU clocked up; 0 disables).
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
from fastpath.decide import build_questions, draws_object, parse_answers, resolve_target, route_why, words  # noqa: E402

# Laya's head holds about this many target options; with more elements the target is left to the code rules.
MAX_TARGET_OPTIONS = 10
# Longer commands are almost never one simple action; skip the model call.
MAX_WORDS = 30


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
        if "target" in inp:
            inp["target"] = back[inp["target"]]
        if "targets" in inp:
            inp["targets"] = [back[t] for t in inp["targets"]]
        out.append({"name": a["name"], "input": inp})
    return out


class FastPath:
    def __init__(self, checkpoint: str, threshold: float, device: str | None, keep_warm_s: float = 5.0):
        import laya

        self.checkpoint, self.threshold, self.device = checkpoint, threshold, device
        self.name = f"laya:{Path(checkpoint).name}"
        self.router = laya.Router(device=device, default="english")
        self.model = self.router.register("tuned", checkpoint)
        self.router.load(self.model)
        self.lock = threading.Lock()  # one model, one call at a time
        self.last_call = 0.0
        self.warm()
        if keep_warm_s > 0:
            threading.Thread(target=self.keep_warm, args=(keep_warm_s,), daemon=True).start()

    def warm(self) -> None:
        self.decide("undo", {"elements": [], "selectedIds": [], "recentIds": []})

    def keep_warm(self, every_s: float) -> None:
        """Run a tiny decision whenever the model has been idle for `every_s`.

        A laptop GPU drops its clocks when idle: the first command after 40 s took 0.5 s instead of 0.19 s, and
        after a few minutes 1.3 s, past the Node server's timeout. At 5 s this costs about 4% of the GPU.
        """
        while True:
            time.sleep(every_s)
            if time.monotonic() - self.last_call >= every_s:
                self.warm()

    def decide(self, text: str, scene: dict) -> dict:
        t = time.perf_counter()
        if len(words(text)) > MAX_WORDS:
            return {"route": "llm", "actions": None, "reason": "long command", "model": self.name, "ms": 0}
        aliased, back = alias_scene(scene)
        questions = build_questions(aliased)
        if len(questions.get("target", {}).get("criteria", {})) > MAX_TARGET_OPTIONS + 1:
            del questions["target"]
        with self.lock:
            raw = self.router.predict({"command": text}, questions, model=self.model)
            self.last_call = time.monotonic()
        ans = parse_answers(raw)
        if "target" not in questions:
            ans["target"] = ("none", 0.0)  # unknown, not confidently "none"
        rule = resolve_target(text, aliased)
        if rule:
            ans["target"] = (rule[0], 1.0)
        decision, actions, why = route_why(ans, self.threshold)
        obj = draws_object(text, decision, actions)
        if obj:
            decision, actions, why = "llm", None, f"drawing a {obj} needs the LLM"
        return {
            "route": decision,
            "actions": unalias(actions, back) if actions else None,
            "reason": why,
            "model": self.name,
            "answers": {k: [v, round(c, 3)] for k, (v, c) in ans.items()},
            "target_rule": rule[1] if rule else None,
            "ms": round((time.perf_counter() - t) * 1000, 1),
        }


def handler_for(fast: FastPath):
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
            self._send(200, {"ok": True, "model": fast.name, "threshold": fast.threshold, "device": fast.device})

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


def main() -> None:
    checkpoint = os.environ.get("LAYA_CHECKPOINT")
    if not checkpoint or not Path(checkpoint, "rl_agent_config.json").exists():
        sys.exit("Set LAYA_CHECKPOINT to a fine-tuned Laya checkpoint dir (one with rl_agent_config.json).")
    host, port = os.environ.get("FASTPATH_HOST", "127.0.0.1"), int(os.environ.get("FASTPATH_PORT", 8788))
    fast = FastPath(
        checkpoint,
        float(os.environ.get("FASTPATH_THRESHOLD", 0.8)),
        os.environ.get("LAYA_DEVICE") or None,
        float(os.environ.get("FASTPATH_KEEP_WARM_S", 5)),
    )
    print(f"fast path ready on http://{host}:{port} (checkpoint {Path(checkpoint).name}, threshold {fast.threshold})", flush=True)
    ThreadingHTTPServer((host, port), handler_for(fast)).serve_forever()


if __name__ == "__main__":
    main()
