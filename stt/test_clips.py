"""
Voice clips: the sidecar's clip store (server.Clips) and build_manifest.

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
        self.assertEqual((row["id"], row["heard"], row["seconds"], row["model"]), (clip, "Draw a blue box", 1.0, "moonshine:small"))
        with wave.open(str(self.dir / row["audio"])) as w:
            self.assertEqual((w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()), (1, 2, 16000, 16000))
        self.assertIsNone(self.clips.save([], "nothing", "m"))
        self.assertNotEqual(self.clips.save([0.1] * 160, "two", "m"), clip)

    def test_keeps_only_well_formed_labels(self) -> None:
        kept = self.clips.label(
            [
                {"clips": ["a-001"], "heard": "set june", "text": "  set   zoom  "},
                {"clips": ["../etc"], "text": "x"},  # not a clip id
                {"clips": [], "text": "x"},
                {"clips": ["a-002"], "text": " "},
                "junk",
            ]
        )
        self.assertEqual(kept, 1)
        self.assertEqual([(r["clips"], r["heard"], r["text"]) for r in rows(self.dir / "labels.jsonl")], [(["a-001"], "set june", "set zoom")])
        self.assertEqual(self.clips.label("not a list"), 0)


class ManifestTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        clips = Clips(self.dir)
        self.ids = [clips.save([0.1] * 8000, heard, "m") for heard in ["set june", "put it next to", "the database", "draw a box", "zoom in"]]

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def label(self, clips: list[str], text: str) -> None:
        Clips(self.dir).label([{"clips": clips, "text": text}])

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
