"""What happens to the machine in his house when the week goes badly.

Round eleven was the first review of this file on its own. Everything here was reproduced
before it was fixed, and every one of them was invisible to the 35 tests that already
existed -- those read the source; these run it.

    cd worker-pc && python -m unittest test_machine -v
"""

import ast
import io
import os
import sys
import tempfile
import unittest
from pathlib import Path

SOURCE_TEXT = (Path(__file__).parent / "worker.py").read_text(encoding="utf-8")
SOURCE = ast.parse(SOURCE_TEXT)


def load(*names, **extras):
    """Compiles just these definitions out of worker.py and runs them for real.

    worker.py cannot be imported here -- it loads a whisper model and exits without a live
    API_BASE -- so the definitions are lifted out of the parsed source. It is the real
    code, not a copy of it.
    """
    wanted = [
        node
        for node in SOURCE.body
        if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name in names
    ]
    if len(wanted) != len(names):
        missing = set(names) - {node.name for node in wanted}
        raise AssertionError(f"worker.py no longer has {sorted(missing)}")
    namespace = {
        "io": io, "os": os, "sys": sys, "time": __import__("time"), "Path": Path,
        "urlparse": __import__("urllib.parse", fromlist=["urlparse"]).urlparse,
        "ipaddress": __import__("ipaddress")
    }
    namespace.update(extras)
    module = ast.Module(body=wanted, type_ignores=[])
    exec(compile(ast.fix_missing_locations(module), "worker.py", "exec"), namespace)
    return namespace


class ASettingThatIsNotANumber(unittest.TestCase):
    """A blanked line in .env used to end the worker for good.

    Every numeric setting was `int(os.getenv(...))` at module level, so `BATCH_SIZE=` --
    which is what happens when somebody clears a value rather than deleting the line --
    raised at import, before anything could report it. The scheduled task then relaunched
    it every five minutes for ever, and the only sign anywhere was the app saying the PC
    was off, with no reason.
    """

    def setUp(self):
        self.said = []
        self.env = {}
        space = load("whole_number", say=self.said.append, os=self)
        self.whole_number = space["whole_number"]

    # stands in for `os` inside whole_number
    def getenv(self, name):
        return self.env.get(name)

    def test_a_blank_setting_falls_back_instead_of_crashing(self):
        self.env["BATCH_SIZE"] = ""
        self.assertEqual(self.whole_number("BATCH_SIZE", 3), 3)

    def test_a_typo_falls_back_and_says_so(self):
        self.env["POLL_SECONDS"] = "thirty"
        self.assertEqual(self.whole_number("POLL_SECONDS", 30), 30)
        self.assertTrue(any("POLL_SECONDS" in line for line in self.said), self.said)

    def test_a_nonsense_number_falls_back_too(self):
        self.env["BATCH_SIZE"] = "0"
        self.assertEqual(self.whole_number("BATCH_SIZE", 3), 3)
        self.env["BATCH_SIZE"] = "-4"
        self.assertEqual(self.whole_number("BATCH_SIZE", 3), 3)

    def test_a_real_setting_is_still_honoured(self):
        self.env["BATCH_SIZE"] = "7"
        self.assertEqual(self.whole_number("BATCH_SIZE", 3), 7)


class EverythingItHasToTellHim(unittest.TestCase):
    """Under the scheduled task, `print` was the same as saying nothing.

    The task runs pythonw.exe, which has no console and no inherited handles, so CPython
    sets sys.stdout and sys.stderr to None and every print became a silent no-op --
    including the one whose own comment calls itself loud, and the only place the real
    yt-dlp or whisper text has ever existed.
    """

    def test_nothing_is_left_calling_print(self):
        printing = [
            node
            for node in ast.walk(SOURCE)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "print"
            and not _inside(node, "say")
        ]
        self.assertEqual(printing, [], "a print outside say() is a message nobody receives")

    def test_it_writes_to_a_file_even_with_no_console_at_all(self):
        with tempfile.TemporaryDirectory() as folder:
            log = Path(folder) / "worker.log"
            space = load("say", LOG_PATH=log, MAX_LOG_BYTES=1000)
            real_stdout = sys.stdout
            sys.stdout = None  # exactly what pythonw gives it
            try:
                space["say"]("!! could not report failure for abc")
            finally:
                sys.stdout = real_stdout
            self.assertIn("could not report failure", log.read_text(encoding="utf-8"))

    def test_the_log_cannot_fill_his_disk(self):
        with tempfile.TemporaryDirectory() as folder:
            log = Path(folder) / "worker.log"
            log.write_text("x" * 500, encoding="utf-8")
            space = load("say", LOG_PATH=log, MAX_LOG_BYTES=100)
            space["say"]("after the rollover")
            self.assertIn("after the rollover", log.read_text(encoding="utf-8"))
            self.assertTrue(log.with_suffix(".log.old").exists(), "the old copy was not kept")
            self.assertLess(log.stat().st_size, 400, "the file did not roll over")

    def test_a_log_that_cannot_be_written_does_not_stop_the_work(self):
        space = load("say", LOG_PATH=Path("Z:/nowhere/at/all/worker.log"), MAX_LOG_BYTES=10)
        space["say"]("this must not raise")


def _inside(target, function_name):
    """Whether a node sits inside the named function definition."""
    for node in ast.walk(SOURCE):
        if isinstance(node, ast.FunctionDef) and node.name == function_name:
            if any(inner is target for inner in ast.walk(node)):
                return True
    return False


class ALiveBroadcast(unittest.TestCase):
    """yt-dlp reports no duration for a live stream, and zero is under every ceiling.

    So it was never asked about (D42), never refused, and the download ran until the
    broadcast ended -- one shared live link and the machine is gone for the afternoon with
    every other reel queued behind it. Exactly what D42 exists to make impossible.
    """

    def test_the_check_is_there_and_comes_before_the_length(self):
        text = SOURCE_TEXT
        self.assertIn('info.get("is_live")', text, "nothing anywhere looks at is_live")
        self.assertIn('info.get("live_status")', text)
        self.assertLess(
            text.index('info.get("is_live")'),
            text.index('duration = int(info.get("duration") or 0)'),
            "the live check must come before a length nobody can trust",
        )

    def test_it_is_refused_in_words_he_can_act_on(self):
        start = SOURCE_TEXT.index('info.get("is_live")')
        window = SOURCE_TEXT[start:start + 400]
        self.assertIn("live broadcast", window)
        self.assertIn("Save it again once", window, "it must say what to do about it")


class ALookupThatFailed(unittest.TestCase):
    """A DNS wobble used to record "asked, nobody named" for ever.

    `assert_public_host` raised the same Refused for "not a platform" and for a resolution
    failure, and the caller settles every Refused. So a ten-minute wobble in his connection
    permanently blanked the creator of every video the backfill touched while it lasted --
    the exact mistake the asked/not-asked distinction was invented to prevent.
    """

    def test_the_two_are_different_kinds_of_answer(self):
        self.assertIn("class CouldNotReach", SOURCE_TEXT)
        self.assertIn("raise CouldNotReach", SOURCE_TEXT)

    def test_a_resolution_failure_is_not_a_refusal(self):
        space = load(
            "assert_public_host",
            "host_is_allowed",
            "Refused",
            "CouldNotReach",
            socket=_BrokenDns(),
            ALLOWED_SUFFIXES=("instagram.com",),
        )
        with self.assertRaises(space["CouldNotReach"]):
            space["assert_public_host"]("https://instagram.com/reel/ABC/")

    def test_and_a_refusal_still_is_one(self):
        space = load(
            "assert_public_host",
            "host_is_allowed",
            "Refused",
            "CouldNotReach",
            socket=_BrokenDns(),
            ALLOWED_SUFFIXES=("instagram.com",),
        )
        with self.assertRaises(space["Refused"]):
            space["assert_public_host"]("https://not-a-platform.example/x")


class _BrokenDns:
    """A network that cannot answer. `gaierror` is what socket raises for that."""

    gaierror = type("gaierror", (OSError,), {})

    def getaddrinfo(self, host, port):
        raise self.gaierror("temporary failure in name resolution")


class WhatItWasHolding(unittest.TestCase):
    """A reboot used to lock a long video away for the rest of its eight-hour lease.

    The app said "being watched now" the whole time, and three of those -- one night of
    Windows updates -- retired it as "gave up after 3 attempts" having done nothing.
    """

    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.path = Path(self.folder.name) / "claimed.txt"
        self.space = load("remember_claim", "forget_claim", CLAIMS_PATH=self.path)

    def tearDown(self):
        self.folder.cleanup()

    def held(self):
        if not self.path.exists():
            return []
        return [line for line in self.path.read_text(encoding="utf-8").splitlines() if line]

    def test_what_is_claimed_is_written_down(self):
        self.space["remember_claim"]("aaa")
        self.space["remember_claim"]("bbb")
        self.assertEqual(self.held(), ["aaa", "bbb"])

    def test_and_forgotten_once_it_has_an_ending_of_its_own(self):
        self.space["remember_claim"]("aaa")
        self.space["remember_claim"]("bbb")
        self.space["forget_claim"]("aaa")
        self.assertEqual(self.held(), ["bbb"])

    def test_forgetting_something_it_never_held_is_harmless(self):
        self.space["forget_claim"]("never-seen")
        self.assertEqual(self.held(), [])

    def test_it_hands_back_what_the_last_run_was_holding(self):
        self.path.write_text("aaa\nbbb\n", encoding="utf-8")
        posted = []

        class Requests:
            RequestException = RuntimeError

            @staticmethod
            def post(url, json=None, headers=None, timeout=None):
                posted.append(url)
                return type("R", (), {"raise_for_status": lambda self: None})()

        space = load(
            "release_stale_claims",
            CLAIMS_PATH=self.path,
            API_BASE="https://api.test",
            HEADERS={},
            requests=Requests,
            say=lambda message: None,
        )
        space["release_stale_claims"]()
        self.assertEqual(
            posted,
            ["https://api.test/v1/sources/aaa/release", "https://api.test/v1/sources/bbb/release"],
        )
        self.assertFalse(self.path.exists(), "the list was not cleared once it was handed back")

    def test_and_keeps_the_list_if_it_cannot_reach_the_api(self):
        # Otherwise one bad moment at startup loses the record for good and the videos stay
        # locked for the rest of their lease.
        self.path.write_text("aaa\n", encoding="utf-8")

        class Requests:
            RequestException = RuntimeError

            @staticmethod
            def post(*args, **kwargs):
                raise RuntimeError("no network yet")

        space = load(
            "release_stale_claims",
            CLAIMS_PATH=self.path,
            API_BASE="https://api.test",
            HEADERS={},
            requests=Requests,
            say=lambda message: None,
        )
        space["release_stale_claims"]()
        self.assertEqual(self.held(), ["aaa"], "it forgot what it was still holding")


class TwoCopiesAtOnce(unittest.TestCase):
    """The README tells him to run it by hand while setting up, and the scheduled task
    only blocks a second TASK. Both used one media folder, and either one quitting ran
    `rmtree` over it -- deleting the audio of a video the other had been transcribing for
    an hour, which came back as "could not be downloaded or transcribed"."""

    def test_each_run_owns_its_own_folder(self):
        self.assertIn('MEDIA_DIR = MEDIA_ROOT / f"run-{os.getpid()}"', SOURCE_TEXT)
        self.assertIn("shutil.rmtree(MEDIA_DIR, ignore_errors=True)", SOURCE_TEXT)
        self.assertNotIn("shutil.rmtree(MEDIA_ROOT", SOURCE_TEXT)

    def test_a_folder_left_by_a_dead_run_is_cleared_and_a_live_one_is_not(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            mine = root / f"run-{os.getpid()}"
            dead = root / "run-999999"
            odd = root / "not-a-run"
            for one in (mine, dead, odd):
                one.mkdir()
                (one / "audio.wav").write_bytes(b"x" * 10)

            import shutil as real_shutil

            space = load(
                "sweep_old_runs",
                "still_running",
                MEDIA_ROOT=root,
                MEDIA_DIR=mine,
                shutil=real_shutil,
                say=lambda message: None,
            )
            space["sweep_old_runs"]()

            self.assertTrue(mine.exists(), "it cleared its own folder out from under itself")
            self.assertFalse(dead.exists(), "a dead run's audio was left on the disk")
            self.assertTrue(odd.exists(), "it removed something that was not a run folder")

    def test_a_run_that_is_still_going_is_left_alone(self):
        space = load("still_running")
        self.assertTrue(space["still_running"](os.getpid()))


if __name__ == "__main__":
    unittest.main()
