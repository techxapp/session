"""
Speech-to-text sidecar: streams microphone audio from the browser into Moonshine (on-device, CPU) and sends text back.

WebSocket on STT_PORT (the web dev server proxies /stt here). One connection is one listening session; a new
session takes over and closes the previous one (one transcriber, and its key terms, are shared).
  client -> server  {"type": "start", "sampleRate": 48000, "keyterms": [...], "record": false}   first message
                    binary frames: mono float32 PCM at that rate (Moonshine resamples to 16 kHz itself)
                    {"type": "keyterms", "terms": [...]}   board labels to bias decoding toward ("Postgres")
                    {"type": "stop"}   finish the line being spoken, answer "stopped" and close
  server -> client  {"type": "ready", "model", "recording"}
                    {"type": "partial", "id", "text"}       the line being spoken; unstable, display only
                    {"type": "final", "id", "text", "ms", "clip"?}   Moonshine's VAD ended the line: run it as a command
                    {"type": "stopped"} | {"type": "error", "message"}

Voice clips (for fine-tuning Moonshine on your own voice; see stt/build_manifest.py): with "record": true, each
final line's audio (Moonshine's own 16 kHz cut of it, i.e. what the model heard) is saved as
STT_CLIPS_DIR/audio/<clip>.wav plus a clips.jsonl row {id, audio, heard, seconds, source: "moonshine", model, at},
and the final message names the clip. Nothing is recorded unless the browser asks. Everything else about the folder
(labels from the activity panel and the clips dashboard, deleting, Deepgram/AssemblyAI clips) is the API server's
(server/src/clips.ts).

Setup (this machine): its own venv, since Moonshine needs no torch (it runs on CPU through a bundled onnxruntime):
  uv venv F:/temp/moonshine-venv --python "C:/Program Files/Python310/python.exe"
  uv pip install --python F:/temp/moonshine-venv/Scripts/python.exe -r stt/requirements.txt
  F:/temp/moonshine-venv/Scripts/python stt/server.py
Env: STT_MODEL (small | medium; streaming English, default small), STT_PORT (8789), STT_HOST (127.0.0.1),
     STT_MODEL_DIR (a fine-tuned model instead of the download: a folder holding the runtime's .ort graphs,
     streaming_config.json and tokenizer.bin, as `moonshine_voice.lora --export` + quantizing make them; STT_MODEL
     must name the size it was trained from),
     STT_CLIPS_DIR (voice clips; default stt/clips, gitignored; a relative path is from the repo root, as the API
     server reads it),
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
import wave
from pathlib import Path

os.environ.setdefault("MOONSHINE_ORT_SINGLE_THREAD", "1")  # read by the native library, so set before loading it

import numpy as np  # noqa: E402
from moonshine_voice.download import get_model_for_language  # noqa: E402
from moonshine_voice.transcriber import ModelArch, Transcriber, TranscriptEventListener  # noqa: E402
from websockets.asyncio.server import ServerConnection, serve  # noqa: E402
from websockets.exceptions import ConnectionClosed  # noqa: E402
from websockets.http11 import Request, Response  # noqa: E402

ARCHS = {"small": ModelArch.SMALL_STREAMING, "medium": ModelArch.MEDIUM_STREAMING}
# A long key-term list costs accuracy on the words not in it.
MAX_KEYTERMS = 50
MAX_KEYTERM_CHARS = 40
CLIP_RATE = 16000  # Moonshine hands each line's audio over at its own rate
MAX_TEXT_CHARS = 500
REPO = Path(__file__).resolve().parent.parent


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


def now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S")


def one_line(text: object) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip()[:MAX_TEXT_CHARS]


def clips_dir() -> Path:
    """STT_CLIPS_DIR, relative to the repo root (as server/src/clips.ts reads it); default stt/clips."""
    return REPO / (os.environ.get("STT_CLIPS_DIR") or "stt/clips")


class Clips:
    """Writes Moonshine's lines into the voice-clip folder: audio/<clip>.wav + a clips.jsonl row."""

    def __init__(self, folder: Path) -> None:
        self.folder = folder
        self.session = time.strftime("%Y%m%d-%H%M%S")
        self.count = 0

    def save(self, audio: list[float] | None, heard: str, model: str) -> str | None:
        """Write one line's audio; returns the clip id (None if there was no audio)."""
        if not audio:
            return None
        self.count += 1
        clip = f"{self.session}-{self.count:03d}"
        pcm = (np.clip(np.asarray(audio, dtype=np.float32), -1, 1) * 32767).astype("<i2")
        (self.folder / "audio").mkdir(parents=True, exist_ok=True)
        with wave.open(str(self.folder / "audio" / f"{clip}.wav"), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(CLIP_RATE)
            w.writeframes(pcm.tobytes())
        seconds = round(len(pcm) / CLIP_RATE, 2)
        row = {"id": clip, "audio": f"audio/{clip}.wav", "heard": one_line(heard), "seconds": seconds, "source": "moonshine", "model": model}
        self.append("clips.jsonl", {**row, "at": now()})
        return clip

    def append(self, name: str, row: dict) -> None:
        self.folder.mkdir(parents=True, exist_ok=True)
        with open(self.folder / name, "a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")


class Lines(TranscriptEventListener):
    """Turns a transcription pass's events (fired on the worker thread) into messages for the browser."""

    def __init__(self, model: str) -> None:
        self.out: list[dict] = []
        self.model = model
        self.clips: Clips | None = None  # set when the browser asked to keep voice clips

    def on_line_text_changed(self, event) -> None:
        if not event.line.is_complete:
            self.out.append({"type": "partial", "id": str(event.line.line_id), "text": event.line.text})

    def on_line_completed(self, event) -> None:
        line = event.line
        text = line.text.strip()
        msg = {"type": "final", "id": str(line.line_id), "text": text, "ms": line.last_transcription_latency_ms}
        if self.clips is not None and text:
            try:
                clip = self.clips.save(line.audio_data, text, self.model)
                if clip:
                    msg["clip"] = clip
            except OSError as err:
                sys.stderr.write(f"couldn't save the clip: {err}\n")
        self.out.append(msg)
        saved = f" -> {msg['clip']}" if "clip" in msg else ""
        sys.stderr.write(f"final ({line.last_transcription_latency_ms} ms){saved}: {text}\n")

    def take(self) -> list[dict]:
        out, self.out = self.out, []
        return out


class Engine:
    """One loaded model shared by the sessions; native calls run one at a time on a worker thread."""

    def __init__(self, model: str, clips_dir: Path, model_dir: Path | None = None) -> None:
        t = time.perf_counter()
        if model_dir:
            path, arch = str(model_dir), ARCHS[model]
        else:
            path, arch = get_model_for_language("en", ARCHS[model])
        self.transcriber = Transcriber(path, arch)
        self.name = f"moonshine:{model}" + (f" ({model_dir.name})" if model_dir else "")
        self.lock = asyncio.Lock()
        self.terms: list[str] | None = None
        self.current: ServerConnection | None = None
        self.clips = Clips(clips_dir)
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
    lines = Lines(engine.name)
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
                if engine.current is not None and engine.current is not ws:
                    await engine.current.close(1000, "Listening moved to another tab.")
                engine.current = ws
                rate = int(m.get("sampleRate") or 16000)
                lines.clips = engine.clips if m.get("record") is True else None
                await engine.set_keyterms(m.get("keyterms"))
                stream = await engine.call(engine.transcriber.create_stream)
                stream.add_listener(lines)
                await engine.call(stream.start)
                task = asyncio.create_task(worker())
                await send([{"type": "ready", "model": engine.name, "recording": lines.clips is not None}])
                sys.stderr.write(f"listening ({rate} Hz{', keeping clips' if lines.clips else ''})\n")
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
        if stream is not None:
            sys.stderr.write("stopped listening\n")


def same_origin(ws: ServerConnection, request: Request) -> Response | None:
    """Refuse pages from other sites: WebSockets skip CORS, and this socket can record (voice clips)."""
    origin = request.headers.get("Origin")
    if origin and origin.split("://", 1)[-1] != request.headers.get("Host"):
        return ws.respond(403, "Origin not allowed\n")
    return None


async def main() -> None:
    model = os.environ.get("STT_MODEL", "small")
    if model not in ARCHS:
        sys.exit(f"STT_MODEL must be one of {', '.join(ARCHS)}")
    host, port = os.environ.get("STT_HOST", "127.0.0.1"), int(os.environ.get("STT_PORT", 8789))
    model_dir = Path(os.environ["STT_MODEL_DIR"]) if os.environ.get("STT_MODEL_DIR") else None
    if model_dir and not (model_dir / "tokenizer.bin").is_file():
        sys.exit(f"STT_MODEL_DIR {model_dir} has no tokenizer.bin: export and quantize the model into it first")
    engine = Engine(model, clips_dir(), model_dir)
    async with serve(lambda ws: session(engine, ws), host, port, process_request=same_origin):
        print(f"speech-to-text ready on ws://{host}:{port} ({engine.name})", flush=True)
        await asyncio.get_running_loop().create_future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
