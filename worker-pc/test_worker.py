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


def load_functions(*names):
    """Compiles just these functions out of worker.py, with no whisper and no .env.

    The module cannot be imported -- it loads a model and exits without a live API_BASE --
    but these are pure functions, so lifting their definitions out of the parsed source and
    running them is the real code, not a copy of it.
    """
    wanted = [
        node
        for node in SOURCE.body
        if isinstance(node, ast.FunctionDef) and node.name in names
    ]
    namespace = {"MARK_EVERY_SEC": default_of("MARK_EVERY_SEC") or 30}
    module = ast.Module(body=wanted, type_ignores=[])
    exec(compile(ast.fix_missing_locations(module), "worker.py", "exec"), namespace)
    return namespace


class Segment:
    """Stands in for one of faster-whisper's segments: a start time and some words."""

    def __init__(self, start, text):
        self.start = start
        self.text = text


class LongVideoSettings(unittest.TestCase):
    """The 30-minute ceiling is gone and long videos carry times now (D33)."""

    def test_the_ceiling_allows_a_real_talk(self):
        limit = int(default_of("MAX_DURATION_SEC"))
        self.assertGreaterEqual(
            limit,
            7200,
            "MAX_DURATION_SEC below two hours refuses the talks this was built for (D33)",
        )

    def test_the_ceiling_is_still_a_ceiling(self):
        """Removing it entirely is not the fix. A machine tied up for six hours strands
        every reel behind it, and the refusal is what makes that visible."""
        limit = int(default_of("MAX_DURATION_SEC"))
        self.assertLessEqual(limit, 4 * 3600, "there must still be a real limit (D33)")

    def test_only_a_long_video_gets_times_written_into_it(self):
        """A reel's transcript must come back exactly as it always has -- one block of
        speech, no markers. Everything already stored was made that way."""
        source = (Path(__file__).parent / "worker.py").read_text(encoding="utf-8")
        self.assertIn(
            "if duration_sec > LONG_VIDEO_SEC:",
            source,
            "marking must be conditional, or every reel's transcript changes shape",
        )

    def test_the_length_actually_reaches_transcribe(self):
        """The condition above is dead code if the caller never passes the duration."""
        source = (Path(__file__).parent / "worker.py").read_text(encoding="utf-8")
        self.assertIn(
            "transcribe(audio_path, duration)",
            source,
            "process() must hand transcribe() the duration it just measured",
        )


class TimeMarkers(unittest.TestCase):
    def setUp(self):
        self.fns = load_functions("clock", "mark_times")

    def test_the_clock_reads_the_way_a_player_shows_it(self):
        clock = self.fns["clock"]
        self.assertEqual(clock(0), "0:00:00")
        self.assertEqual(clock(72), "0:01:12")
        self.assertEqual(clock(3723), "1:02:03")

    def test_a_mark_lands_every_half_minute_at_most(self):
        segments = [Segment(t, f"line at {t}") for t in (0, 10, 20, 31, 40, 62)]
        marked = self.fns["mark_times"](segments)
        self.assertEqual(marked.count("["), 3, "one at 0, one past 30, one past 60")
        self.assertIn("[0:00:00]", marked)
        self.assertIn("[0:00:31]", marked)
        self.assertIn("[0:01:02]", marked)

    def test_a_mark_never_lands_inside_a_sentence(self):
        segments = [Segment(0, "The price"), Segment(45, "is fixed.")]
        marked = self.fns["mark_times"](segments)
        self.assertEqual(marked, "[0:00:00] The price [0:00:45] is fixed.")

    def test_a_long_silence_does_not_produce_a_run_of_markers(self):
        """Counting the next mark from the clock rather than from the segment that was
        actually marked gives [0:00:30] [0:01:00] [0:01:30] all in a row after a pause."""
        segments = [Segment(0, "before"), Segment(600, "after")]
        marked = self.fns["mark_times"](segments)
        self.assertEqual(marked, "[0:00:00] before [0:10:00] after")

    def test_empty_segments_are_skipped_rather_than_marked(self):
        segments = [Segment(0, "words"), Segment(31, "   "), Segment(62, "more words")]
        marked = self.fns["mark_times"](segments)
        self.assertEqual(marked, "[0:00:00] words [0:01:02] more words")


class CreatorBackfill(unittest.TestCase):
    """Filling in who made the videos already saved (D40).

    The whole risk here is being rate-limited by Facebook or Instagram, which would cost
    transcription and not just this. So what is guarded is the pacing, not the parsing.
    """

    def setUp(self):
        self.source = (Path(__file__).parent / "worker.py").read_text(encoding="utf-8")

    def test_it_only_runs_when_there_is_no_real_work(self):
        """It must sit inside the `if not batch:` arm of the poll loop, not beside it."""
        idle_arm = self.source[self.source.index("if not batch:"):]
        self.assertIn(
            "fill_in_creators()",
            idle_arm,
            "the backfill must never compete with a reel somebody is waiting on (D40)",
        )
        self.assertEqual(
            self.source.count("fill_in_creators()\n"),
            1,
            "the backfill is called from exactly one place, and that place is the idle arm",
        )

    def test_there_is_a_pause_between_each_one(self):
        self.assertIn(
            "time.sleep(CREATOR_PAUSE_SEC)",
            self.source,
            "without a pause this asks a platform two hundred questions in two minutes",
        )
        self.assertGreaterEqual(int(default_of("CREATOR_PAUSE_SEC")), 10)
        self.assertLessEqual(int(default_of("CREATOR_BATCH")), 5)

    def test_nothing_is_ever_downloaded_again(self):
        """A backfill that re-downloaded 212 videos is not a backfill, it is an outage."""
        backfill = self.source[self.source.index("def fill_in_creators"):]
        backfill = backfill[: backfill.index("def clock(")]
        self.assertIn("download=False", backfill)
        self.assertNotIn("downloader.download(", backfill)
        self.assertNotIn("FFmpegExtractAudio", backfill)

    def test_a_private_address_is_still_refused(self):
        """This reaches out to a URL like the downloader does, so it needs the same check."""
        backfill = self.source[self.source.index("def fill_in_creators"):]
        backfill = backfill[: backfill.index("def clock(")]
        self.assertIn("assert_public_host(source[", backfill)

    def test_every_attempt_is_reported_even_when_nobody_is_named(self):
        """Otherwise a video the platform will not name is asked about on every poll."""
        backfill = self.source[self.source.index("def fill_in_creators"):]
        backfill = backfill[: backfill.index("def clock(")]
        self.assertIn('json={"creator": name}', backfill)
        # The post is outside the try that catches the lookup failing, so a video with no
        # creator is still reported.
        self.assertLess(
            backfill.index("except Exception as error"),
            backfill.index("requests.post"),
            "the report must happen after the failure is swallowed, not inside the try",
        )


class CreatorFromMetadata(unittest.TestCase):
    def setUp(self):
        self.creator_from = load_functions("creator_from")["creator_from"]

    def test_the_first_field_the_platform_filled_in_wins(self):
        self.assertEqual(self.creator_from({"uploader": "Rumee"}), "Rumee")
        self.assertEqual(self.creator_from({"channel": "Rumee"}), "Rumee")
        self.assertEqual(
            self.creator_from({"uploader": "  ", "uploader_id": "@rumee"}),
            "@rumee",
            "a blank field is not a name",
        )

    def test_nobody_named_is_None_and_never_a_guess(self):
        self.assertIsNone(self.creator_from({}))
        self.assertIsNone(self.creator_from({"uploader": None, "channel": ""}))
        self.assertIsNone(self.creator_from({"title": "Video by someone"}))

    def test_an_absurd_name_is_cut_rather_than_stored_whole(self):
        self.assertEqual(len(self.creator_from({"uploader": "x" * 5000})), 200)


if __name__ == "__main__":
    unittest.main()
