"""Guards the two settings that decide whether a transcript is usable at all (D28).

These are read off the source rather than by importing worker.py, on purpose: importing it
loads a whisper model and demands a live API_BASE and SERVICE_TOKEN, so a test that imported
it would need a machine with the model downloaded and the .env filled in. The regression
this actually has to catch is somebody tidying a keyword argument away, and that is visible
in the source.

    cd worker-pc && python -m unittest test_worker -v
"""

import ast
import unittest
from pathlib import Path

SOURCE = ast.parse((Path(__file__).parent / "worker.py").read_text(encoding="utf-8"))


def find_call(name):
    """Returns the `<something>.<name>(...)` call in worker.py, or None."""
    for node in ast.walk(SOURCE):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            if node.func.attr == name:
                return node
    return None


def default_of(setting):
    """Returns the fallback in `os.getenv("<setting>", "<default>")`."""
    for node in ast.walk(SOURCE):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "getenv"
            and node.args
            and isinstance(node.args[0], ast.Constant)
            and node.args[0].value == setting
        ):
            return node.args[1].value if len(node.args) > 1 else None
    return None


class TranscriptionSettings(unittest.TestCase):
    def test_whisper_is_asked_to_translate(self):
        """Transcribe mode returns broken Devanagari for Hinglish. Measured at three
        model sizes; every one of them is wrong. See D28 before changing this."""
        call = find_call("transcribe")
        self.assertIsNotNone(call, "worker.py no longer calls model.transcribe")
        tasks = [k.value.value for k in call.keywords if k.arg == "task"]
        self.assertEqual(
            tasks,
            ["translate"],
            'model.transcribe must be called with task="translate" (D28)',
        )

    def test_model_default_is_not_smaller_than_small(self):
        """base translates correctly but drops words. small keeps them. D28."""
        too_small = {"tiny", "tiny.en", "base", "base.en"}
        self.assertNotIn(
            default_of("WHISPER_MODEL"),
            too_small,
            "WHISPER_MODEL's default dropped below small -- words go missing (D28)",
        )

    def test_the_engine_records_that_the_text_was_translated(self):
        """lang is the language spoken; the text is English. The engine string is the
        only thing that says so, so a stored row is not misread later. D28."""
        source = (Path(__file__).parent / "worker.py").read_text(encoding="utf-8")
        self.assertIn(
            'f"faster-whisper:{WHISPER_MODEL}:translate"',
            source,
            "the engine string must say :translate, or lang=hi beside English text lies",
        )


if __name__ == "__main__":
    unittest.main()
