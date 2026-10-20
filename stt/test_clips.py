"""
Voice clips: the sidecar's clip writer (server.Clips) and build_manifest. Labels are written by the API server
(server/src/clips.ts); here they are appended to labels.jsonl directly, in the same format.

Needs the speech venv (server.py imports moonshine_voice; no model is loaded):
  F:/temp/moonshine-venv/Scripts/python -m unittest discover -s stt -p "test_*.py"
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import build_manifest  # noqa: E402
from server import Clips  # noqa: E402


def rows(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()] if path.is_file() else []


class ClipsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.clips = Clips(self.dir)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_saves_line_audio_as_16k_wav_with_a_row(self) -> None:
        clip = self.clips.save([0.0, 0.5, -0.5, 2.0] * 4000, "Draw a blue box", "moonshine:small")
        self.assertIsNotNone(clip)
        row = rows(self.dir / "clips.jsonl")[0]
        self.assertEqual(
            (row["id"], row["heard"], row["seconds"], row["source"], row["model"]), (clip, "Draw a blue box", 1.0, "moonshine", "moonshine:small")
        )
        with wave.open(str(self.dir / row["audio"])) as w:
            self.assertEqual((w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()), (1, 2, 16000, 16000))
        self.assertIsNone(self.clips.save([], "nothing", "m"))
        self.assertNotEqual(self.clips.save([0.1] * 160, "two", "m"), clip)


class ManifestTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        clips = Clips(self.dir)
        self.ids = [clips.save([0.1] * 8000, heard, "m") for heard in ["set june", "put it next to", "the database", "draw a box", "zoom in"]]

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def label(self, clips: list[str], text: str) -> None:
        Clips(self.dir).append("labels.jsonl", {"clips": clips, "text": text, "from": "activity"})

    def test_labelled_clips_with_joined_lines_and_last_label_winning(self) -> None:
        a, b, c, d, e = self.ids
        self.label([a], "set zoo")
        self.label([a], "set zoom")  # a later fix wins
        self.label([b, c], "put it next to the database")
        self.label(["missing-1"], "dropped: no such clip")
        train, eval_rows = build_manifest.build(self.dir, heard=False, eval_frac=0, seed=0)
        self.assertEqual(eval_rows, [])
        by_text = {r["text"]: r for r in train}
        self.assertEqual(set(by_text), {"set zoom", "put it next to the database"})
        joined = by_text["put it next to the database"]
        self.assertEqual(joined["heard"], "put it next to the database")
        # Two 0.5 s lines + 0.3 s of silence.
        self.assertEqual(joined["seconds"], 1.3)
        self.assertTrue((self.dir / joined["audio"]).is_file())

    def test_heard_adds_unfixed_clips_to_train_only(self) -> None:
        a = self.ids[0]
        self.label([a], "set zoom")
        self.label([self.ids[3]], "draw a fox")
        train, eval_rows = build_manifest.build(self.dir, heard=True, eval_frac=0.5, seed=0)
        self.assertEqual(len(eval_rows), 1)
        self.assertIn(eval_rows[0]["text"], {"set zoom", "draw a fox"})
        texts = sorted(r["text"] for r in train)
        self.assertEqual(len(texts), 4)  # one label + the three unfixed clips with their heard text
        self.assertTrue({"put it next to", "the database", "zoom in"} <= set(texts))

    def test_sources_and_deleted_clips(self) -> None:
        a, b, c, d, e = self.ids
        clips = Clips(self.dir)
        clips.session = "cloud"  # the API server's ids differ from the sidecar's
        cloud = clips.save([0.1] * 8000, "Undo.", "deepgram:nova-3")
        # A Deepgram row as the API server writes it, and an old Moonshine row with no source.
        lines = (self.dir / "clips.jsonl").read_text(encoding="utf-8").splitlines()
        lines[-1] = json.dumps({**json.loads(lines[-1]), "source": "deepgram"})
        lines[0] = json.dumps({k: v for k, v in json.loads(lines[0]).items() if k != "source"})
        (self.dir / "clips.jsonl").write_text("".join(line + "\n" for line in lines), encoding="utf-8")
        (self.dir / "audio" / f"{e}.wav").unlink()  # deleted in the dashboard
        train, _ = build_manifest.build(self.dir, heard=True, eval_frac=0, seed=0)
        self.assertEqual({r["id"]: r["source"] for r in train}, {a: "moonshine", b: "moonshine", c: "moonshine", d: "moonshine", cloud: "deepgram"})
        train, _ = build_manifest.build(self.dir, heard=True, eval_frac=0, seed=0, sources={"deepgram"})
        self.assertEqual([(r["id"], r["text"]) for r in train], [(cloud, "Undo.")])
        # Corrections from every source, unfixed clips only from the cloud.
        self.label([a], "set zoom")
        train, _ = build_manifest.build(self.dir, heard=False, eval_frac=0, seed=0, heard_sources={"deepgram"})
        self.assertEqual(sorted((r["id"], r["text"]) for r in train), sorted([(a, "set zoom"), (cloud, "Undo.")]))

    def test_manifest_loads_in_moonshine_format(self) -> None:
        self.label([self.ids[0]], "set zoom")
        train, _ = build_manifest.build(self.dir, heard=False, eval_frac=0, seed=0)
        build_manifest.write_jsonl(self.dir / "train.jsonl", train)
        from moonshine_voice.lora.manifest import load_manifest  # stdlib-only part of the LoRA extra

        [utt] = load_manifest(str(self.dir / "train.jsonl"))
        self.assertEqual(utt.text, "set zoom")
        self.assertTrue(Path(utt.audio).is_file())


if __name__ == "__main__":
    unittest.main()
