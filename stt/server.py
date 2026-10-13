"""
Speech-to-text sidecar: streams microphone audio from the browser into Moonshine (on-device, CPU) and sends text back.

WebSocket on STT_PORT (the web dev server proxies /stt here). One connection is one listening session; a new
connection takes over and closes the previous one (one transcriber, and its key terms, are shared).
  client -> server  {"type": "start", "sampleRate": 48000, "keyterms": [...]}   first message
                    binary frames: mono float32 PCM at that rate (Moonshine resamples to 16 kHz itself)
                    {"type": "keyterms", "terms": [...]}   board labels to bias decoding toward ("Postgres")
                    {"type": "stop"}   finish the line being spoken, answer "stopped" and close
  server -> client  {"type": "ready", "model"}
                    {"type": "partial", "id", "text"}       the line being spoken; unstable, display only
                    {"type": "final", "id", "text", "ms"}   Moonshine's VAD ended the line: run it as a command
                    {"type": "stopped"} | {"type": "error", "message"}

Setup (this machine): its own venv, since Moonshine needs no torch (it runs on CPU through a bundled onnxruntime):
  uv venv F:/temp/moonshine-venv --python "C:/Program Files/Python310/python.exe"
  uv pip install --python F:/temp/moonshine-venv/Scripts/python.exe -r stt/requirements.txt
  F:/temp/moonshine-venv/Scripts/python stt/server.py
Env: STT_MODEL (small | medium; streaming English, default small), STT_PORT (8789), STT_HOST (127.0.0.1),
     MOONSHINE_VOICE_CACHE (Moonshine's model cache; the model downloads there on first start),
     MOONSHINE_ORT_SINGLE_THREAD (defaults to 1 here: onnxruntime's thread pool spin-waits, so the default used
     ~4 cores for ~0.2 s less delay; single-threaded Small takes about half a core).
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import sys
import time

os.environ.setdefault("MOONSHINE_ORT_SINGLE_THREAD", "1")  # read by the native library, so set before loading it

import numpy as np  # noqa: E402
from moonshine_voice.download import get_model_for_language  # noqa: E402
from moonshine_voice.transcriber import ModelArch, Transcriber, TranscriptEventListener  # noqa: E402
from websockets.asyncio.server import ServerConnection, serve  # noqa: E402
from websockets.exceptions import ConnectionClosed  # noqa: E402

ARCHS = {"small": ModelArch.SMALL_STREAMING, "medium": ModelArch.MEDIUM_STREAMING}
# A long key-term list costs accuracy on the words not in it.
MAX_KEYTERMS = 50
MAX_KEYTERM_CHARS = 40


def clean_keyterms(terms: object) -> list[str]:
    """Board labels as Moonshine key terms: one line, no commas (its delimiter), deduplicated, capped."""
    out: list[str] = []
    seen: set[str] = set()
    for t in terms if isinstance(terms, list) else []:
        t = re.sub(r"\s+", " ", str(t).replace(",", " ")).strip()[:MAX_KEYTERM_CHARS]
        if t and t.lower() not in seen:
            seen.add(t.lower())
            out.append(t)
    return out[-MAX_KEYTERMS:]


class Lines(TranscriptEventListener):
    """Turns a transcription pass's events (fired on the worker thread) into messages for the browser."""

    def __init__(self) -> None:
        self.out: list[dict] = []

    def on_line_text_changed(self, event) -> None:
        if not event.line.is_complete:
            self.out.append({"type": "partial", "id": str(event.line.line_id), "text": event.line.text})

    def on_line_completed(self, event) -> None:
        line = event.line
        self.out.append({"type": "final", "id": str(line.line_id), "text": line.text.strip(), "ms": line.last_transcription_latency_ms})
        sys.stderr.write(f"final ({line.last_transcription_latency_ms} ms): {line.text.strip()}\n")

    def take(self) -> list[dict]:
        out, self.out = self.out, []
        return out


class Engine:
    """One loaded model shared by the sessions; native calls run one at a time on a worker thread."""

    def __init__(self, model: str) -> None:
        t = time.perf_counter()
        path, arch = get_model_for_language("en", ARCHS[model])
        self.transcriber = Transcriber(path, arch)
        self.name = f"moonshine:{model}"
        self.lock = asyncio.Lock()
        self.terms: list[str] | None = None
        self.current: ServerConnection | None = None
        sys.stderr.write(f"loaded {self.name} in {time.perf_counter() - t:.1f}s\n")

    async def call(self, fn, *args):
        async with self.lock:
            return await asyncio.to_thread(fn, *args)

    async def set_keyterms(self, terms: object) -> None:
        terms = clean_keyterms(terms)
        if terms != self.terms:
            await self.call(self.transcriber.set_keyterms, terms)  # takes effect on the next pass
            self.terms = terms


async def session(engine: Engine, ws: ServerConnection) -> None:
    if engine.current is not None:
        await engine.current.close(1000, "Listening moved to another tab.")
    engine.current = ws
    lines = Lines()
    stream = None
    rate = 16000
    audio: list[np.ndarray] = []
    wake = asyncio.Event()
    state = {"stopping": False, "closed": False}

    async def send(messages: list[dict]) -> None:
        for m in messages:
            try:
                await ws.send(json.dumps(m))
            except ConnectionClosed:
                return

    async def worker() -> None:
        """Feed audio as it arrives. A backlog goes in as one chunk, so a slow pass is not followed by many."""
        try:
            while True:
                await wake.wait()
                wake.clear()
                while audio and not state["closed"]:
                    chunk = np.concatenate(audio)
                    audio.clear()
                    await engine.call(stream.add_audio, chunk, rate)
                    await send(lines.take())
                if state["closed"]:
                    return
                if state["stopping"]:
                    await engine.call(stream.stop)  # completes the line being spoken
                    await send(lines.take() + [{"type": "stopped"}])
                    return
        except Exception as err:
            await send([{"type": "error", "message": f"Speech recognition failed: {err}"}])
            await ws.close(1011, "speech recognition failed")

    task = None
    try:
        async for msg in ws:
            if isinstance(msg, bytes):
                if stream is not None and not state["stopping"]:
                    audio.append(np.frombuffer(msg, dtype=np.float32))
                    wake.set()
                continue
            m = json.loads(msg)
            if m.get("type") == "start" and stream is None:
                rate = int(m.get("sampleRate") or 16000)
                await engine.set_keyterms(m.get("keyterms"))
                stream = await engine.call(engine.transcriber.create_stream)
                stream.add_listener(lines)
                await engine.call(stream.start)
                task = asyncio.create_task(worker())
                await send([{"type": "ready", "model": engine.name}])
                sys.stderr.write(f"listening ({rate} Hz)\n")
            elif m.get("type") == "keyterms":
                await engine.set_keyterms(m.get("terms"))
            elif m.get("type") == "stop" and task is not None:
                state["stopping"] = True
                wake.set()
                await task
                await ws.close()
    except ConnectionClosed:
        pass
    finally:
        state["closed"] = True
        wake.set()
        if task is not None:
            await task  # never cancel mid-call: the native pass would outlive the stream it uses
        if stream is not None:
            await engine.call(stream.close)
        if engine.current is ws:
            engine.current = None
        sys.stderr.write("stopped listening\n")


async def main() -> None:
    model = os.environ.get("STT_MODEL", "small")
    if model not in ARCHS:
        sys.exit(f"STT_MODEL must be one of {', '.join(ARCHS)}")
    host, port = os.environ.get("STT_HOST", "127.0.0.1"), int(os.environ.get("STT_PORT", 8789))
    engine = Engine(model)
    async with serve(lambda ws: session(engine, ws), host, port):
        print(f"speech-to-text ready on ws://{host}:{port} ({engine.name})", flush=True)
        await asyncio.get_running_loop().create_future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
