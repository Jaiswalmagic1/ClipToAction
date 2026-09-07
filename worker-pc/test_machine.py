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
import time
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

    The record lives in the run's OWN folder, and a hand-back names the claim it means.
    Both were learnt the hard way: a shared list plus a state-only release meant the copy
    he starts by hand, on its next start, cancelled the scheduled copy's work in progress.
    """

    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.root = Path(self.folder.name)
        self.mine = self.root / f"run-{os.getpid()}"
        self.mine.mkdir()
        self.path = self.mine / "claimed.txt"
        self.space = load("remember_claim", "forget_claim", CLAIMS_PATH=self.path)

    def tearDown(self):
        self.folder.cleanup()

    def held(self):
        if not self.path.exists():
            return []
        return [line for line in self.path.read_text(encoding="utf-8").splitlines() if line]

    def test_what_is_claimed_is_written_down_with_when(self):
        self.space["remember_claim"]("aaa", 1700)
        self.space["remember_claim"]("bbb", 1800)
        self.assertEqual(self.held(), ["aaa 1700", "bbb 1800"])

    def test_and_forgotten_once_it_has_an_ending_of_its_own(self):
        self.space["remember_claim"]("aaa", 1700)
        self.space["remember_claim"]("bbb", 1800)
        self.space["forget_claim"]("aaa")
        self.assertEqual(self.held(), ["bbb 1800"])

    def test_forgetting_something_it_never_held_is_harmless(self):
        self.space["forget_claim"]("never-seen")
        self.assertEqual(self.held(), [])

    def dead_run_holding(self, lines):
        """A folder belonging to a run that has stopped, with a list in it."""
        dead = self.root / "run-999999"
        dead.mkdir()
        (dead / "claimed.txt").write_text(lines, encoding="utf-8")
        return dead

    def releasing(self, requests_stub):
        import shutil as real_shutil

        return load(
            "release_stale_claims",
            "sweep_finished_runs",
            "has_stopped",
            "drop_line",
            "pid_of",
            "still_running",
            STALE_RUN_SEC=24 * 60 * 60,
            GIVE_UP_ON_HANDBACK_SEC=7 * 24 * 60 * 60,
            shutil=real_shutil,
            CLAIMS_PATH=self.path,
            MEDIA_ROOT=self.root,
            MEDIA_DIR=self.mine,
            API_BASE="https://api.test",
            HEADERS={},
            requests=requests_stub,
            say=lambda message: None,
        )

    def test_it_hands_back_what_a_stopped_run_was_holding(self):
        dead = self.dead_run_holding("aaa 1700\nbbb 1800\n")
        posted = []

        class Requests:
            RequestException = RuntimeError

            @staticmethod
            def post(url, json=None, headers=None, timeout=None):
                posted.append((url, json))
                return type("R", (), {"raise_for_status": lambda self: None})()

        self.releasing(Requests)["release_stale_claims"]()
        self.assertEqual(
            posted,
            [
                ("https://api.test/v1/sources/aaa/release", {"claimed_at": 1700}),
                ("https://api.test/v1/sources/bbb/release", {"claimed_at": 1800}),
            ],
        )
        # Everything it was holding is back, so the folder itself is finished with.
        self.assertFalse(
            dead.exists(),
            "the folder was kept after everything in it had been handed back",
        )

    def test_it_never_touches_what_a_LIVE_run_is_holding(self):
        # A DIFFERENT run, still going. The first version of this test used this process's
        # own folder, which an earlier branch skips before the liveness check is ever
        # reached — so it passed with that check deleted, and the guard the whole feature
        # rests on was untested.
        live = self.root / f"run-{os.getpid() + 1}"
        live.mkdir()
        (live / "claimed.txt").write_text("theirs 1700\n", encoding="utf-8")
        self.path.write_text("mine 1700\n", encoding="utf-8")
        posted = []

        class Requests:
            RequestException = RuntimeError

            @staticmethod
            def post(url, json=None, headers=None, timeout=None):
                posted.append(url)
                return type("R", (), {"raise_for_status": lambda self: None})()

        space = self.releasing(Requests)
        # Every number reads as alive, which is the case this is about.
        space["still_running"] = lambda pid: True
        space["release_stale_claims"]()
        self.assertEqual(posted, [], "it handed back work a running copy was doing")
        self.assertTrue(live.exists())

    def test_one_that_cannot_be_handed_back_does_not_undo_the_others(self):
        # Clearing the whole list only at the end meant one id that kept failing had the
        # others handed back again at every single start.
        dead = self.dead_run_holding("good 1700\nbad 1800\n")

        class Requests:
            RequestException = RuntimeError

            @staticmethod
            def post(url, json=None, headers=None, timeout=None):
                if "bad" in url:
                    raise RuntimeError("no")
                return type("R", (), {"raise_for_status": lambda self: None})()

        self.releasing(Requests)["release_stale_claims"]()
        left = (dead / "claimed.txt").read_text(encoding="utf-8").split()
        self.assertNotIn("good", left, "one it handed back is still on the list")
        self.assertIn("bad", left, "one it could not hand back was forgotten")


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
                "sweep_finished_runs",
                "has_stopped",
                "still_running",
                "pid_of",
                MEDIA_ROOT=root,
                MEDIA_DIR=mine,
                STALE_RUN_SEC=24 * 60 * 60,
                GIVE_UP_ON_HANDBACK_SEC=7 * 24 * 60 * 60,
                shutil=real_shutil,
                say=lambda message: None,
            )
            space["sweep_finished_runs"]()

            self.assertTrue(mine.exists(), "it cleared its own folder out from under itself")
            self.assertFalse(dead.exists(), "a dead run's audio was left on the disk")
            self.assertTrue(odd.exists(), "it removed something that was not a run folder")

    def test_a_run_that_is_still_going_is_left_alone(self):
        space = load("still_running")
        self.assertTrue(space["still_running"](os.getpid()))




class TheQuestionBeforeALongVideo(unittest.TestCase):
    """The one requirement he was most emphatic about, executed rather than read.

    The tests that already guarded this compared string positions in the source -- they
    pass with the condition inverted, with `long_ok` read from the wrong place, or with the
    branch unreachable. An acceptance review found the gate open for a video whose platform
    reports no duration at all, which Instagram routinely does: `int(None or 0)` is zero,
    zero is under every threshold, and a video he was never asked about held the machine
    for as long as it liked.
    """

    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.media = Path(self.folder.name)
        self.downloaded = []
        self.limits = {
            "warn_above_sec": 1800,
            "max_video_sec": 21600,
            "max_transcript_chars": 400000,
            "long_video_sec": 600,
        }

    def tearDown(self):
        self.folder.cleanup()

    def run_it(self, reported_duration, real_seconds=60, long_ok=0, live=False):
        """Runs the real download_audio with yt-dlp and the network stood in for."""
        media = self.media
        downloaded = self.downloaded
        bytes_per_sec = 16000 * 2

        class FakeDownloader:
            def __init__(self, options):
                self.options = options

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def extract_info(self, url, download=False):
                info = {"title": "A talk", "uploader": "Somebody"}
                if reported_duration is not None:
                    info["duration"] = reported_duration
                if live:
                    info["is_live"] = True
                return info

            def download(self, urls):
                downloaded.append(urls)
                # ffmpeg would leave exactly this: 16kHz, mono, 16-bit.
                target = media / source["id"]
                # Sparse rather than written out: six hours of audio is 690MB and
                # only its size matters here.
                with io.open(target.with_suffix(".wav"), "wb") as handle:
                    handle.truncate(real_seconds * bytes_per_sec)

        source = {
            "id": "11111111-2222-3333-4444-555555555555",
            "url_original": "https://instagram.com/reel/ABC/",
            "url_canonical": "https://instagram.com/reel/ABC",
            "platform": "Instagram",
            "long_ok": long_ok,
        }

        space = load(
            "download_audio",
            "creator_from",
            "spell_out_length",
            "Refused",
            "NeedsPermission",
            "CouldNotReach",
            UUID_PATTERN=__import__("re").compile(r"\A[0-9a-fA-F-]{36}\Z"),
            MEDIA_DIR=media,
            WAV_BYTES_PER_SEC=bytes_per_sec,
            YoutubeDL=FakeDownloader,
            assert_public_host=lambda url: None,
        )
        return space, source, space["download_audio"](source, self.limits)

    def test_the_videos_he_saves_all_the_time_are_never_asked_about(self):
        for minutes in (1, 11, 18, 29):
            self.downloaded.clear()
            _, _, (path, title, duration, creator) = self.run_it(minutes * 60)
            self.assertEqual(duration, minutes * 60)
            self.assertTrue(self.downloaded, f"{minutes} minutes was not even downloaded")

    def test_a_long_one_asks_first_and_downloads_nothing(self):
        space = load("NeedsPermission")
        with self.assertRaises(Exception) as caught:
            self.run_it(69 * 60)
        self.assertEqual(type(caught.exception).__name__, "NeedsPermission")
        self.assertEqual(self.downloaded, [], "it started downloading before he answered")

    def test_and_goes_ahead_once_he_has_said_yes(self):
        _, _, (path, title, duration, creator) = self.run_it(69 * 60, long_ok=1)
        self.assertEqual(duration, 69 * 60)
        self.assertTrue(self.downloaded)

    def test_past_the_ceiling_it_is_refused_even_when_approved(self):
        with self.assertRaises(Exception) as caught:
            self.run_it(7 * 3600, long_ok=1)
        self.assertEqual(type(caught.exception).__name__, "Refused")
        self.assertEqual(self.downloaded, [])

    def test_a_video_whose_platform_reports_no_length_is_still_asked_about(self):
        # Instagram routinely reports nothing. `int(None or 0)` is zero, zero is under
        # every threshold, and the question was never asked. The audio is measured now --
        # 16kHz mono 16-bit is exactly 32,000 bytes a second, so it is arithmetic.
        with self.assertRaises(Exception) as caught:
            self.run_it(None, real_seconds=69 * 60)
        self.assertEqual(type(caught.exception).__name__, "NeedsPermission")
        self.assertEqual(
            caught.exception.duration,
            69 * 60,
            "it asked, but about a length it had not actually measured",
        )
        left = list(self.media.glob("*.wav"))
        self.assertEqual(left, [], "it left the audio on the disk while it waited")

    def test_a_short_one_with_no_reported_length_is_not_nagged_about(self):
        _, _, (path, title, duration, creator) = self.run_it(None, real_seconds=40)
        self.assertEqual(duration, 40)
        self.assertTrue(path.exists())

    def test_and_one_past_the_ceiling_with_no_reported_length_is_refused(self):
        with self.assertRaises(Exception) as caught:
            self.run_it(None, real_seconds=7 * 3600, long_ok=1)
        self.assertEqual(type(caught.exception).__name__, "Refused")
        self.assertEqual(list(self.media.glob("*.wav")), [])

    def test_a_live_broadcast_never_starts(self):
        with self.assertRaises(Exception) as caught:
            self.run_it(None, live=True)
        self.assertEqual(type(caught.exception).__name__, "Refused")
        self.assertEqual(self.downloaded, [])


class AFolderWhoseNumberCameRoundAgain(unittest.TestCase):
    """Windows hands the same process number out again.

    So a folder left behind by a dead run whose number now belongs to some unrelated live
    program was kept for good -- about 700MB of wav for a long video, which is exactly the
    disk filling the sweep was added to stop.
    """

    def test_a_day_old_folder_goes_whatever_the_number_says(self):
        import shutil as real_shutil

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            mine = root / f"run-{os.getpid()}"
            mine.mkdir()
            # Named after a process that IS alive -- this one -- but a day untouched.
            reused = root / f"run-{os.getpid() + 1}"
            reused.mkdir()
            (reused / "audio.wav").write_bytes(b"x" * 10)
            old = time.time() - 2 * 24 * 60 * 60
            os.utime(reused, (old, old))

            space = load(
                "sweep_finished_runs",
                "has_stopped",
                "still_running",
                "pid_of",
                MEDIA_ROOT=root,
                MEDIA_DIR=mine,
                STALE_RUN_SEC=24 * 60 * 60,
                GIVE_UP_ON_HANDBACK_SEC=7 * 24 * 60 * 60,
                shutil=real_shutil,
                say=lambda message: None,
            )
            # Every number reads as alive, which is the worst case.
            space["still_running"] = lambda pid: True
            space["sweep_finished_runs"]()
            self.assertFalse(reused.exists(), "a day-old folder was kept because of PID reuse")
            self.assertTrue(mine.exists())


class NothingIsSweptWhileItStillHoldsWork(unittest.TestCase):
    """A folder is only removed once its list is empty.

    The order used to be: hand back what you can, then delete the folder — including the
    list of what could NOT be handed back. The ordinary case for that is a machine that has
    just booted and whose network is not up yet, which is exactly the restart this whole
    feature exists for. The record went, and the video sat locked for its full lease.
    """

    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.root = Path(self.folder.name)
        self.mine = self.root / f"run-{os.getpid()}"
        self.mine.mkdir()
        self.dead = self.root / "run-999999"
        self.dead.mkdir()

    def tearDown(self):
        self.folder.cleanup()

    def running(self, requests_stub):
        import shutil as real_shutil

        return load(
            "release_stale_claims",
            "sweep_finished_runs",
            "has_stopped",
            "drop_line",
            "pid_of",
            "still_running",
            CLAIMS_PATH=self.mine / "claimed.txt",
            MEDIA_ROOT=self.root,
            MEDIA_DIR=self.mine,
            STALE_RUN_SEC=24 * 60 * 60,
            GIVE_UP_ON_HANDBACK_SEC=7 * 24 * 60 * 60,
            API_BASE="https://api.test",
            HEADERS={},
            requests=requests_stub,
            shutil=real_shutil,
            say=lambda message: None,
        )

    def test_a_folder_whose_work_could_not_be_handed_back_is_kept(self):
        (self.dead / "claimed.txt").write_text("aaa 1700\n", encoding="utf-8")

        class Requests:
            RequestException = RuntimeError

            @staticmethod
            def post(*args, **kwargs):
                raise RuntimeError("the network is not up yet")

        self.running(Requests)["release_stale_claims"]()
        self.assertTrue(self.dead.exists(), "the record was deleted before it was acted on")
        self.assertIn("aaa", (self.dead / "claimed.txt").read_text(encoding="utf-8"))

    def test_and_is_cleared_once_it_has_been(self):
        (self.dead / "claimed.txt").write_text("aaa 1700\n", encoding="utf-8")
        (self.dead / "audio.wav").write_bytes(b"x" * 10)

        class Requests:
            RequestException = RuntimeError

            @staticmethod
            def post(*args, **kwargs):
                return type("R", (), {"raise_for_status": lambda self: None})()

        self.running(Requests)["release_stale_claims"]()
        self.assertFalse(self.dead.exists(), "the audio was left on the disk for good")

    def test_a_folder_left_by_a_reused_process_number_is_read_before_it_is_cleared(self):
        # Windows hands the same number out again. The sweep already knew that; the reader
        # did not, so a day-old folder was deleted without its list ever being looked at.
        reused = self.root / f"run-{os.getpid() + 1}"
        reused.mkdir()
        (reused / "claimed.txt").write_text("bbb 1800\n", encoding="utf-8")
        old = time.time() - 2 * 24 * 60 * 60
        os.utime(reused, (old, old))
        posted = []

        class Requests:
            RequestException = RuntimeError

            @staticmethod
            def post(url, json=None, headers=None, timeout=None):
                posted.append(url)
                return type("R", (), {"raise_for_status": lambda self: None})()

        space = self.running(Requests)
        space["still_running"] = lambda pid: True
        space["release_stale_claims"]()
        self.assertEqual(posted, ["https://api.test/v1/sources/bbb/release"])

    def test_what_the_PREVIOUS_version_was_holding_is_still_handed_back(self):
        # It kept its list outside the run folders. On the upgrade itself there would have
        # been nothing to find, and the work would have sat locked for its whole lease.
        (self.root / "claimed.txt").write_text("ccc 1900\n", encoding="utf-8")
        posted = []

        class Requests:
            RequestException = RuntimeError

            @staticmethod
            def post(url, json=None, headers=None, timeout=None):
                posted.append(url)
                return type("R", (), {"raise_for_status": lambda self: None})()

        self.running(Requests)["release_stale_claims"]()
        self.assertEqual(posted, ["https://api.test/v1/sources/ccc/release"])

    def test_a_claim_noted_without_a_time_is_let_go_rather_than_asked_about_for_ever(self):
        # A hand-back names the claim it means, so a line with no time can never satisfy
        # it. Asking anyway got a 400 at every start and the line stayed for ever.
        (self.dead / "claimed.txt").write_text("ddd 0\n", encoding="utf-8")
        posted = []

        class Requests:
            RequestException = RuntimeError

            @staticmethod
            def post(url, json=None, headers=None, timeout=None):
                posted.append(url)
                return type("R", (), {"raise_for_status": lambda self: None})()

        self.running(Requests)["release_stale_claims"]()
        self.assertEqual(posted, [], "it asked about a claim it could not name")
        self.assertFalse(self.dead.exists(), "the line was kept and asked about for ever")


if __name__ == "__main__":
    unittest.main()
