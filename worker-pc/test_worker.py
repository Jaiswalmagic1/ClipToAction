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
        """Removing it entirely is not the fix. A machine tied up all day strands every
        reel behind it, and the refusal is what makes that visible. Raised from 3 hours to
        6 by D42, together with a warning he has to answer before anything downloads."""
        limit = int(default_of("MAX_DURATION_SEC"))
        self.assertLessEqual(limit, 6 * 3600, "there must still be a real limit (D33, D42)")

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
            "transcribe(audio_path, duration,",
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

    def test_there_is_a_pause_between_each_one_but_not_after_the_last(self):
        self.assertIn(
            "time.sleep(CREATOR_PAUSE_SEC)",
            self.source,
            "without a pause this asks a platform two hundred questions in two minutes",
        )
        # A pause after the final one costs an idle poll twenty seconds for nothing.
        self.assertIn("if index < len(pending) - 1:", self.source)
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

    def test_a_lookup_that_answered_settles_the_question(self):
        """A platform that answered "nobody" IS an answer -- that video must leave the
        queue, or it is asked about on every idle poll for ever."""
        backfill = self.source[self.source.index("def fill_in_creators"):]
        backfill = backfill[: backfill.index("def clock(")]
        self.assertIn("report_creator(source[\"id\"], name, asked=True)", backfill)

    def test_a_lookup_that_failed_settles_nothing(self):
        """This is the one that matters. Reporting a FAILED lookup as though the platform
        had answered is how a single rate-limit walks the whole backfill queue, marking two
        hundred videos "asked, nobody named" without anything ever having been asked -- and
        the creator column then stays empty for ever with nothing on screen saying why."""
        backfill = self.source[self.source.index("def fill_in_creators"):]
        backfill = backfill[: backfill.index("def clock(")]
        failure = backfill[backfill.index("except Exception as error"):]
        self.assertIn("asked=False", failure)

    def test_one_failure_stops_the_pass_and_quietens_the_backfill(self):
        """Being throttled is the likeliest cause of a failure, and the worst possible
        answer to being throttled is to keep asking."""
        backfill = self.source[self.source.index("def fill_in_creators"):]
        backfill = backfill[: backfill.index("def clock(")]
        failure = backfill[backfill.index("except Exception as error"):]
        self.assertIn("_creator_quiet_until = time.monotonic() + CREATOR_BACKOFF_SEC", failure)
        self.assertIn("return", failure)
        self.assertIn("if time.monotonic() < _creator_quiet_until:", backfill)
        self.assertGreaterEqual(int(default_of("CREATOR_BACKOFF_SEC")), 600)

    def test_a_rejected_report_is_not_mistaken_for_an_accepted_one(self):
        """requests does not raise on a 4xx or a 5xx."""
        reporter = self.source[self.source.index("def report_creator"):]
        reporter = reporter[: reporter.index("def fill_in_creators")]
        self.assertIn("response.raise_for_status()", reporter)


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


class AskingBeforeAVeryLongVideo(unittest.TestCase):
    """Nothing is downloaded until he has said yes (D42)."""

    def setUp(self):
        self.source = (Path(__file__).parent / "worker.py").read_text(encoding="utf-8")

    def test_only_our_own_refusals_are_pasted_onto_a_shared_row(self):
        """sources.error is read by every user who saved the reel, so it may only ever carry
        a sentence this file wrote.

        It used to pass through any ValueError, which is the base class of half of yt-dlp's
        and ctranslate2's errors as well -- their messages quote filesystem paths, model
        cache locations and URLs. And four of `requests`' own exceptions are ValueErrors
        too, one of which (InvalidHeader) QUOTES the offending header value: this worker's
        only header is the service token.
        """
        body = self.source[self.source.index("def classify_failure"):]
        body = body[: body.index("def cleanup")]
        self.assertIn("isinstance(error, Refused)", body)
        self.assertNotIn(
            "isinstance(error, ValueError)",
            body,
            "a bare ValueError branch lets third-party messages onto a shared row",
        )
        self.assertLess(
            body.index("requests.RequestException"),
            body.index("isinstance(error, Refused)"),
            "a requests exception must be classified before our own refusals",
        )

    def test_every_refusal_this_file_writes_uses_that_class(self):
        """A refusal raised as a plain ValueError would come back as the generic
        "could not be downloaded or transcribed" and its careful wording would be lost."""
        for message in (
            "Link has no host.",
            "resolves to a private address",
            "Source id is not a UUID",
            "No speech found in this video.",
            "more than can be",
            "characters of speech",
        ):
            where = self.source.index(message)
            raiser = self.source.rfind("raise ", 0, where)
            self.assertIn(
                "raise Refused",
                self.source[raiser : raiser + 20],
                f"'{message}' is not raised as a Refused",
            )

    def test_an_older_api_gets_the_behaviour_it_can_handle(self):
        """An API from before D42 has no route to ask him about a long video. Asking anyway
        posts to an address that answers 404, the report is lost, and the video sits claimed
        until its attempts run out and it is retired as "gave up after 3 attempts" -- a
        video he was meant to be ASKED about, thrown away. So against an older API this
        does not ask at all, which makes restarting this worker safe at any point in a
        deploy, in either order."""
        body = self.source[self.source.index("def claim_batch"):]
        body = body[: body.index("def report_failure")]
        self.assertIn("if not limits:", body)
        self.assertIn('"warn_above_sec": None', body)
        self.assertIn("ask_above is not None", self.source)

    def test_the_rules_come_from_the_api_not_from_this_machine(self):
        """MAX_DURATION_SEC and WARN_ABOVE_SEC live in a gitignored .env that overrides the
        code, and a stale value there silently changes what the app is telling him -- the
        trap that left three of his videos failed for a month. The API sends its own
        thresholds with the work now, and those win."""
        self.assertIn('payload.get("limits")', self.source)
        for name in ("warn_above_sec", "max_video_sec", "max_transcript_chars"):
            self.assertIn(f'limits["{name}"]', self.source, f"{name} is not read from the API")
        # And the local settings are still the fallback, so an older API keeps working.
        self.assertIn('sent("warn_above_sec", WARN_ABOVE_SEC)', self.source)
        self.assertIn('sent("max_video_sec", MAX_DURATION_SEC)', self.source)
        # `is None`, not `or`: 0 is a real answer to two of these, and a server saying
        # "ask about everything" must not be read as saying nothing at all.
        self.assertIn("fallback if value is None else int(value)", self.source)

    def test_the_refusal_message_names_no_setting_and_no_machine(self):
        """It goes onto a row every saver of the reel reads."""
        body = self.source[self.source.index("def download_audio"):]
        body = body[: body.index("def creator_from")]
        self.assertNotIn("MAX_DURATION_SEC of", body)
        self.assertIn("more than can be", body)

    def test_a_rejected_question_is_not_mistaken_for_an_asked_one(self):
        """requests does not raise on a 4xx or a 5xx. Without this, a rejected report reads
        as an accepted one: the video stays claimed, is re-claimed until its attempts run
        out, and is retired as "gave up after 3 attempts" -- a video he was supposed to be
        ASKED about, thrown away instead, with no visible cause."""
        asker = self.source[self.source.index("def ask_about_length"):]
        asker = asker[: asker.index("def process(source, limits)")]
        self.assertIn("response.raise_for_status()", asker)

    def test_the_warning_sits_clear_of_the_videos_he_saves_all_the_time(self):
        """His long videos are 11 to 18 minutes. A warning that always appears is one
        nobody reads, which would be worse than having none."""
        warn = int(default_of("WARN_ABOVE_SEC"))
        self.assertGreater(warn, 20 * 60, "18-minute videos must never be asked about (D42)")
        self.assertLessEqual(warn, 60 * 60, "an hour-long video must be asked about")

    def test_the_check_happens_before_the_download_and_not_after(self):
        """Stopping after the download has already run is not stopping."""
        body = self.source[self.source.index("def download_audio"):]
        body = body[: body.index("def creator_from")]
        self.assertLess(
            body.index("raise NeedsPermission"),
            body.index("downloader.download("),
            "the question must come before the download, or it saves nothing (D42)",
        )

    def test_the_api_decides_what_is_too_long_not_this_machine(self):
        """MAX_DURATION_SEC lives in a gitignored .env that overrides the code. If the
        ceiling were checked first, a stale value there would silently hard-fail videos the
        app had just promised to ASK him about -- which is exactly how the three long
        videos ended up failed in the first place."""
        body = self.source[self.source.index("def download_audio"):]
        body = body[: body.index("def creator_from")]
        self.assertLess(
            body.index("raise NeedsPermission"),
            body.index("more than can be"),
            "the permission check must come before this machine's own ceiling (D42)",
        )

    def test_permission_already_given_is_honoured_without_asking_again(self):
        self.assertIn(
            'not source.get("long_ok")',
            self.source,
            "an approved video must not be asked about a second time",
        )

    def test_waiting_for_an_answer_is_not_reported_as_a_failure(self):
        """`parked` and `needs_ok` must never reach report_failure -- a video he has not
        answered about yet is not a video that could not be read."""
        process = self.source[self.source.index("def process(source, limits)"):]
        process = process[: process.index("def main()")]
        self.assertLess(
            process.index("except NeedsPermission"),
            process.index("except Exception as error"),
            "the question must be caught before the catch-all, or it becomes a failure",
        )
        asked = process[process.index("except NeedsPermission"): process.index("except Exception")]
        self.assertIn("ask_about_length", asked)
        self.assertNotIn("report_failure", asked)

    def test_a_transcript_too_big_to_store_is_refused_out_loud(self):
        """Silently cutting the last hour off would be worse than refusing it: the summary
        would look complete and be wrong."""
        self.assertIn("MAX_TRANSCRIPT_CHARS", self.source)
        transcribe = self.source[self.source.index("def transcribe("):]
        transcribe = transcribe[: transcribe.index("def post_transcript")]
        self.assertIn("len(text) > ceiling", transcribe)
        self.assertNotIn("text[:", transcribe)


if __name__ == "__main__":
    unittest.main()
