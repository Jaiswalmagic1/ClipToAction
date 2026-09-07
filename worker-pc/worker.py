"""ClipToAction enrichment worker.

Runs on Jaiswal's PC for now. Claims pending sources from the Cloudflare Worker API,
downloads the audio, transcribes it, and posts the transcript back. Analysis does NOT
happen here -- it runs in the Cloudflare Worker, so users' AI keys never leave it.

Media files are deleted as soon as they are transcribed. Nothing is kept on disk.

Host-agnostic by design: it only needs API_BASE and SERVICE_TOKEN, so moving it to a
cloud VM later is a config change, not a rewrite.
"""

import io
import ipaddress
import os
import re
import shutil
import socket
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

import requests
from dotenv import load_dotenv
from faster_whisper import WhisperModel
from yt_dlp import YoutubeDL

load_dotenv()

LOG_PATH = Path(__file__).parent / "worker.log"
MAX_LOG_BYTES = 2 * 1024 * 1024


def say(message):
    """Everything this file has to tell anybody.

    It used to be `print`, and under the scheduled task that was the same as saying
    nothing. The task runs `pythonw.exe`, which has no console and no inherited handles, so
    CPython sets sys.stdout and sys.stderr to None and every print in this file became a
    silent no-op -- including the one whose own comment says it is "loud, because the
    alternative is a silent retirement", and including the only place the real yt-dlp or
    whisper text has ever existed. A crash was the same: the process died, the task
    restarted it five minutes later, and there was no trace of it anywhere.

    So it goes to a file beside this one, and to the console as well when there is a
    console. The file is capped and rolled over rather than rotated properly -- one
    previous copy is enough to see what happened last night, and this must never be the
    thing that fills his disk.
    """
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {message}"
    try:
        if LOG_PATH.exists() and LOG_PATH.stat().st_size > MAX_LOG_BYTES:
            LOG_PATH.replace(LOG_PATH.with_suffix(".log.old"))
        with io.open(LOG_PATH, "a", encoding="utf-8") as handle:
            handle.write(line + "\n")
    except OSError:
        # A log that cannot be written is not a reason to stop transcribing.
        pass
    if sys.stdout is not None:
        try:
            print(line)
        except (OSError, ValueError):
            pass


def whole_number(name, fallback):
    """A setting that is a number, or the default -- never a crash at import.

    Every one of these was `int(os.getenv(...))` at module level. A blanked line in .env
    (`BATCH_SIZE=` reads as an empty string, which is what happens when somebody clears a
    value instead of deleting the line) or one typo raised at import, before anything could
    report it, and the scheduled task then relaunched it every five minutes for ever. The
    only sign anywhere was the app saying the PC was off, with no reason.
    """
    raw = (os.getenv(name) or "").strip()
    if not raw:
        return fallback
    try:
        value = int(raw)
    except ValueError:
        say(f"!! {name} is not a whole number ('{raw}'); using {fallback}")
        return fallback
    if value <= 0:
        say(f"!! {name} must be more than zero (got {value}); using {fallback}")
        return fallback
    return value


API_BASE = os.getenv("API_BASE", "").rstrip("/")
SERVICE_TOKEN = os.getenv("SERVICE_TOKEN", "")
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "small") or "small"
POLL_SECONDS = whole_number("POLL_SECONDS", 30)
BATCH_SIZE = whole_number("BATCH_SIZE", 3)
# 6 hours, and still a real ceiling rather than no ceiling (D42). Past this no answer he
# could give would help: the machine would be tied up for most of a day and the words would
# not fit in the column that holds them, so it is refused out loud rather than accepted and
# left to rot.
MAX_DURATION_SEC = whole_number("MAX_DURATION_SEC", 21600)
# Past this, HE IS ASKED before anything is downloaded (D42). Nothing about the videos he
# saves all the time -- 11 to 18 minutes -- comes near it, and that is the point: a warning
# that always appears is a warning nobody reads.
WARN_ABOVE_SEC = whole_number("WARN_ABOVE_SEC", 1800)
# As much transcript as the notebook will hold for one video. Checked HERE, before the work
# and not after it: a six-hour video whose words did not fit would otherwise be discovered
# at the last step, having already had three hours of the machine.
MAX_TRANSCRIPT_CHARS = whole_number("MAX_TRANSCRIPT_CHARS", 400000)
# Past this, a video stops being a reel and starts being something you come back to. It
# gets times written into the transcript so there is a way back into the video.
LONG_VIDEO_SEC = whole_number("LONG_VIDEO_SEC", 600)
MARK_EVERY_SEC = 30
# What the downloaded audio weighs per second: 16,000 samples a second, one channel, two
# bytes a sample -- the settings this file passes to ffmpeg. It is here so a video whose
# platform reported no length can still be measured before the transcription starts.
WAV_BYTES_PER_SEC = 16000 * 1 * 2
# When a run folder counts as abandoned whatever its process id says. Nothing this machine
# does takes a day, and Windows reuses process numbers.
STALE_RUN_SEC = 24 * 60 * 60
# And when to stop keeping a folder just because its work could not be handed back. See
# sweep_finished_runs.
GIVE_UP_ON_HANDBACK_SEC = 7 * 24 * 60 * 60
# Filling in who made the videos already saved (D40). Deliberately slow: this reads
# metadata for videos that are already finished, so it may never compete with a reel
# somebody is waiting on, and Facebook and Instagram will rate-limit a machine that asks
# two hundred questions in two minutes. Two at a time, with a pause between each, and only
# when there is no real work.
CREATOR_BATCH = whole_number("CREATOR_BATCH", 2)
CREATOR_PAUSE_SEC = whole_number("CREATOR_PAUSE_SEC", 20)
# How long to leave the whole backfill alone after a lookup fails. A failure usually means
# the platform is throttling this machine, and the worst possible response to being
# throttled is to keep asking -- so it stops for half an hour rather than working down the
# queue burning attempts on questions that are not being answered.
CREATOR_BACKOFF_SEC = whole_number("CREATOR_BACKOFF_SEC", 1800)
# One folder per run, inside media/.
#
# It used to be `media/` itself, shared, with `shutil.rmtree(MEDIA_DIR)` on the way out --
# so a second copy started by hand (which the README tells him to do while setting it up)
# would delete the audio of a video the scheduled one had been transcribing for an hour.
# The victim reported "could not be downloaded or transcribed" and burned an attempt for
# something that had worked. A run now owns its own folder and removes only that.
MEDIA_ROOT = Path(__file__).parent / "media"
MEDIA_DIR = MEDIA_ROOT / f"run-{os.getpid()}"
# What THIS run has claimed and not finished, so a crash or a reboot can hand it back
# rather than leaving it locked (see release_stale_claims).
#
# Inside the run's own folder, like the audio. It was in the shared one, which undid the
# reason the folder was made per-run in the first place: a second copy started by hand read
# the scheduled copy's list at startup and handed back work that was in progress.
CLAIMS_PATH = MEDIA_DIR / "claimed.txt"

if not API_BASE or not SERVICE_TOKEN:
    sys.exit("Missing API_BASE or SERVICE_TOKEN. Copy .env.example to .env and fill it in.")

HEADERS = {"X-Service-Token": SERVICE_TOKEN}

say(f"Loading whisper model '{WHISPER_MODEL}' (first run downloads it)...")
model = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")
say("Model ready.")


def claim_batch():
    """Claims work, and takes the rules with it.

    `limits` is the API's own thresholds (D45). They used to live only in this machine's
    gitignored .env, where a stale value silently changed what the app was telling him --
    the trap that left three of his videos failed for a month. Falling back to the local
    settings keeps this working against an older API, and nothing else reads them.
    """
    response = requests.get(
        f"{API_BASE}/v1/queue", params={"limit": BATCH_SIZE}, headers=HEADERS, timeout=30
    )
    response.raise_for_status()
    payload = response.json()
    limits = payload.get("limits")

    # An API that sends no limits at all is one from before any of this existed, and it has
    # no route to ask him about a long video either. Asking anyway would post to an address
    # that answers 404, the report would be lost, and the video would sit claimed until its
    # attempts ran out and it was retired as "gave up after 3 attempts" -- a video he was
    # meant to be ASKED about, thrown away.
    #
    # So against an older API this behaves exactly as it did before D42: no question, and
    # this machine's own ceiling. That makes restarting this worker safe at any point in a
    # deploy, in either order.
    if not limits:
        return payload.get("sources", []), {
            "warn_above_sec": None,
            "max_video_sec": MAX_DURATION_SEC,
            "max_transcript_chars": MAX_TRANSCRIPT_CHARS,
            "long_video_sec": LONG_VIDEO_SEC,
        }

    # `is None` rather than `or`, because 0 is a real answer to two of these -- a server
    # saying "ask about everything" would otherwise be read as saying nothing at all.
    def sent(name, fallback):
        value = limits.get(name)
        return fallback if value is None else int(value)

    return payload.get("sources", []), {
        "warn_above_sec": sent("warn_above_sec", WARN_ABOVE_SEC),
        "max_video_sec": sent("max_video_sec", MAX_DURATION_SEC),
        "max_transcript_chars": sent("max_transcript_chars", MAX_TRANSCRIPT_CHARS),
        # Whether times go INTO the transcript. It has to match the number the API uses to
        # decide whether the prompt ASKS for them, or an hour-long talk is told to copy
        # time markers out of a transcript that has none -- and comes back with no
        # chapters, which is the one thing D33 exists to produce.
        "long_video_sec": sent("long_video_sec", LONG_VIDEO_SEC),
    }


def report_failure(source_id, message):
    """Every failure goes back to the API so the app can show it. Never swallowed."""
    try:
        response = requests.post(
            f"{API_BASE}/v1/sources/{source_id}/error",
            json={"error": str(message)[:500]},
            headers=HEADERS,
            timeout=30,
        )
        # requests does not raise on a 4xx or a 5xx, and this is the one reporter that had
        # no check -- the helper whose whole job is that a failure is never swallowed. A
        # rejected report looked exactly like an accepted one, so the real reason was lost
        # and the video was eventually retired as "gave up after 3 attempts" instead.
        response.raise_for_status()
    except requests.RequestException as error:
        say(f"  !! could not report failure for {source_id}: {error}")


UUID_PATTERN = re.compile(r"\A[0-9a-fA-F-]{36}\Z")


# The sites this worker will fetch from. Deliberately a copy of the API's own list rather
# than something read from it: the whole point of a second check is that it does not depend
# on the first one being right.
ALLOWED_SUFFIXES = (
    "youtube.com",
    "youtu.be",
    "instagram.com",
    "facebook.com",
    "fb.watch",
    "fb.com",
    "x.com",
    "twitter.com",
    "linkedin.com",
)


def host_is_allowed(host):
    """True when the host is one of the platforms, or a subdomain of one."""
    host = (host or "").lower().rstrip(".")
    return any(host == suffix or host.endswith("." + suffix) for suffix in ALLOWED_SUFFIXES)


def assert_public_host(url):
    """Refuses anything that is not a platform, or that resolves inside a private network.

    The API already restricts saves to known platforms, but this worker runs on a home
    LAN -- a router admin page, a NAS, or a cloud metadata endpoint is one bad URL away.
    Two independent checks are cheaper than trusting one.

    The platform check is HERE as well, and that is the part that was missing. The two
    checks used two different URL parsers, and the parsers disagreed: a single backslash
    made the API read the host as youtube.com and this file read it as somebody else's
    address entirely, so the wall approved one host and the machine behind it evaluated
    another. The API refuses that shape now -- and this asks the same question again, in
    its own words, on the address it is actually about to fetch.
    """
    host = urlparse(url).hostname
    if not host:
        raise Refused("Link has no host.")

    if not host_is_allowed(host):
        raise Refused(f"{host} is not a site ClipToAction fetches from.")

    try:
        resolved = socket.getaddrinfo(host, None)
    except socket.gaierror as error:
        # Not a refusal. Nothing was learnt about this address -- see CouldNotReach.
        raise CouldNotReach(f"Could not resolve {host} just now.") from error

    for entry in resolved:
        address = ipaddress.ip_address(entry[4][0])
        if (
            address.is_private
            or address.is_loopback
            or address.is_link_local
            or address.is_reserved
            or address.is_multicast
        ):
            raise Refused(f"{host} resolves to a private address; refusing to fetch it.")


class CouldNotReach(Exception):
    """A question this machine could not get an answer to -- yet.

    Not the same as a refusal, and telling them apart is the whole point. `Refused` means
    the answer will be the same tomorrow, so the question is settled. This means nothing
    was learnt: a DNS timeout, a router restarting. They shared one exception, so a
    ten-minute wobble in his connection permanently recorded "asked, nobody named" against
    every video the backfill touched while it lasted -- which is precisely the mistake the
    asked/not-asked distinction was invented to prevent.
    """


class Refused(ValueError):
    """A refusal this file decided on, with a message written to be READ.

    It exists to separate our own sentences from everybody else's. `sources.error` is shown
    to every user who saved the reel, so it must never carry a third-party exception --
    yt-dlp's and faster-whisper's ValueErrors routinely quote a filesystem path or a URL,
    and "isinstance(error, ValueError)" could not tell those from ours.
    """


class NeedsPermission(Exception):
    """This video is long enough that he has to be asked before anything is downloaded.

    Carries what the app needs to write the warning: how long it is, what it is called and
    who made it. Not a failure -- process() reports it as a question, and the video sits
    waiting for an answer rather than being marked as broken (D42).
    """

    def __init__(self, duration, title, creator):
        super().__init__(f"{duration // 60} minutes; waiting to be approved")
        self.duration = duration
        self.title = title
        self.creator = creator


def download_audio(source, limits):
    """Downloads audio only and returns (path, title, duration_sec, creator).

    Reads the metadata first and stops there when the video is long enough to need his
    permission and has not been given it (D42). Nothing is fetched in that case: the whole
    point is that a two-hour download does not start behind his back.
    """
    if not UUID_PATTERN.match(source["id"]):
        raise Refused("Source id is not a UUID; refusing to build a path from it.")

    assert_public_host(source["url_original"])

    target = MEDIA_DIR / source["id"]
    options = {
        "format": "bestaudio/best",
        "outtmpl": f"{target}.%(ext)s",
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "postprocessors": [
            {"key": "FFmpegExtractAudio", "preferredcodec": "wav", "preferredquality": "0"}
        ],
        "postprocessor_args": ["-ar", "16000", "-ac", "1"],
    }

    with YoutubeDL(options) as downloader:
        info = downloader.extract_info(source["url_original"], download=False)

        # A broadcast, not a video. yt-dlp reports no duration for one, and zero is under
        # every ceiling -- so it was never asked about, never refused, and the download ran
        # until the broadcast ended. One shared live link and the machine is gone for the
        # afternoon, filling the disk, with every other reel queued behind it: exactly what
        # D42 exists to make impossible, walking straight through it.
        if info.get("is_live") or info.get("live_status") in ("is_live", "is_upcoming", "post_live"):
            raise Refused(
                "This is a live broadcast rather than a finished video. Save it again once "
                "it has ended."
            )

        duration = int(info.get("duration") or 0)

        # Long enough to be worth asking about, and nobody has said yes yet. Stop here --
        # before the download, which is the only place stopping is worth anything.
        #
        # This is checked BEFORE the ceiling on purpose. The API decides what is too long
        # -- it holds MAX_VIDEO_SEC and refuses outright -- and it hears the real duration
        # from this report. The ceiling below is only a guard for a video somebody has
        # already approved, so a stale value in this machine's gitignored .env can no
        # longer quietly refuse videos the app has just told him it would ask about.
        ask_above = limits["warn_above_sec"]
        if ask_above is not None and duration > ask_above and not source.get("long_ok"):
            raise NeedsPermission(duration, info.get("title"), creator_from(info))

        # Approved, and still past what this machine will take on. The message is written
        # to be READ -- it goes onto a row every saver of the reel sees -- so it names no
        # setting and no machine. With the ceiling coming from the API this should be
        # unreachable; it is here so that a machine which genuinely cannot take the job
        # says so rather than starting it.
        if duration > limits["max_video_sec"]:
            raise Refused(
                f"This video is {spell_out_length(duration)} long, which is more than can be "
                "processed in one go."
            )

        downloader.download([source["url_original"]])

    audio_path = target.with_suffix(".wav")
    if not audio_path.exists():
        raise FileNotFoundError("Audio extraction produced no file.")

    # Now measure what actually arrived, because the metadata may have said nothing.
    #
    # Instagram routinely reports no duration at all (Facebook reports it), and
    # `int(None or 0)` is zero -- which is under every threshold, so the question was never
    # asked and the ceiling never applied. A video he was never asked about could then hold
    # the machine for hours with everything he shares queued behind it, and if its words
    # ran past what the notebook holds it would be refused AFTER the work: the exact
    # failure D45 closed for videos whose length is known.
    #
    # The audio is the honest answer. It is 16kHz, mono, 16-bit by the settings above, so
    # the file is exactly 32,000 bytes a second and the length is arithmetic rather than
    # another guess. Asking here costs the download -- minutes -- instead of the hours of
    # transcription that follow it, and the audio is removed before the question is asked
    # so nothing is left on the disk while it waits.
    if not duration:
        duration = int(audio_path.stat().st_size / WAV_BYTES_PER_SEC)

        ask_above = limits["warn_above_sec"]
        if ask_above is not None and duration > ask_above and not source.get("long_ok"):
            audio_path.unlink(missing_ok=True)
            raise NeedsPermission(duration, info.get("title"), creator_from(info))

        if duration > limits["max_video_sec"]:
            audio_path.unlink(missing_ok=True)
            raise Refused(
                f"This video is {spell_out_length(duration)} long, which is more than can be "
                "processed in one go."
            )

    return audio_path, info.get("title"), duration, creator_from(info)


def creator_from(info):
    """Who made it, from whatever the platform actually filled in (D40).

    The platforms disagree about which field carries this. YouTube fills `uploader` and
    `channel`; Instagram and Facebook fill `uploader` for some videos, `uploader_id` for
    others and nothing at all for the rest. Nothing is invented -- None is the honest
    answer and the app shows the video without a name.
    """
    for field in ("uploader", "channel", "creator", "uploader_id"):
        value = str(info.get(field) or "").strip()
        if value:
            return value[:200]
    return None


# When the backfill may next run. A failed lookup pushes this into the future.
_creator_quiet_until = 0.0


def report_creator(source_id, name, asked):
    """Sends one answer back. `asked` is whether the platform actually answered.

    That distinction is the whole safety of this feature. A lookup that succeeded and
    named nobody SETTLES the question and the video leaves the queue. A lookup that failed
    settles nothing -- reporting it as though it had is how one rate-limit marks two
    hundred videos "asked, nobody named" without anything ever having been asked.
    """
    try:
        response = requests.post(
            f"{API_BASE}/v1/sources/{source_id}/creator",
            json={"creator": name, "asked": asked},
            headers=HEADERS,
            timeout=30,
        )
        # requests does not raise on a 4xx or a 5xx, so without this a rejected report
        # looks exactly like an accepted one.
        response.raise_for_status()
    except requests.RequestException as error:
        # Nothing was recorded, so it comes round again. Nothing is lost.
        say(f"  ! could not report the creator for {source_id}: {error}")


def fill_in_creators():
    """Fills in who made the videos saved before this was recorded (D40).

    Metadata only -- `download=False` -- so nothing is fetched twice and no audio is
    touched. Called only when there was no real work in this poll, a couple at a time with
    a pause between, because being rate-limited here would cost transcription too.

    And when a lookup DOES fail, this stops: one failure ends the pass and quietens the
    whole backfill for half an hour. A failure almost always means the platform is
    throttling this machine, and working down the queue while that is true would burn a
    hundred videos' attempts on questions nobody is answering.
    """
    global _creator_quiet_until
    if time.monotonic() < _creator_quiet_until:
        return

    try:
        response = requests.get(
            f"{API_BASE}/v1/creators",
            params={"limit": CREATOR_BATCH},
            headers=HEADERS,
            timeout=30,
        )
        response.raise_for_status()
        payload = response.json()
    except requests.RequestException as error:
        # Quiet for the same half hour a lookup failure buys. This branch had a bare
        # return, so the backoff D40 was built for did not cover the API question at all --
        # and against a Worker that answers 401 (an old deployment, or a token that no
        # longer matches) this asked again every thirty seconds, for ever. Measured on his
        # own machine: 196 consecutive failures in under two hours, with nothing else in
        # the log.
        say(f"  ! could not ask which videos need a creator: {error}")
        _creator_quiet_until = time.monotonic() + CREATOR_BACKOFF_SEC
        return

    pending = payload.get("sources", [])
    if not pending:
        return
    say(f"- filling in who made {len(pending)} of {payload.get('remaining', '?')} videos")

    for index, source in enumerate(pending):
        try:
            # A private address is this URL's own problem and will be next time too, so it
            # is settled rather than counted -- pausing the whole backfill for half an hour
            # over something that can never succeed would be the wrong shape of caution.
            try:
                assert_public_host(source["url_original"])
            except Refused:
                say(f"  . {source['id']} is not a public address; leaving it alone")
                report_creator(source["id"], None, asked=True)
                continue

            with YoutubeDL({"quiet": True, "no_warnings": True, "noplaylist": True}) as reader:
                name = creator_from(reader.extract_info(source["url_original"], download=False))
        # Deliberately broad, and deliberately not reported as a failure of the video:
        # this runs over reels that are already finished and analysed.
        except Exception as error:  # noqa: BLE001
            say(
                f"  . could not look up {source['id']}: {type(error).__name__}"
                " -- pausing the backfill"
            )
            report_creator(source["id"], None, asked=False)
            _creator_quiet_until = time.monotonic() + CREATOR_BACKOFF_SEC
            return

        report_creator(source["id"], name, asked=True)
        # Not after the last one: an idle poll would otherwise cost an extra pause for
        # nothing, every time.
        if index < len(pending) - 1:
            time.sleep(CREATOR_PAUSE_SEC)


def spell_out_length(seconds):
    """A length in the words the app uses everywhere else.

    This message goes onto a row every saver of the reel reads, and the app spells "5 hours
    and 30 minutes" while this wrote "330 minutes" -- a figure a person has to convert.
    """
    whole = max(round((seconds or 0) / 60), 0)
    if whole == 0:
        return "under a minute"
    if whole == 1:
        return "a minute"
    if whole < 60:
        return f"{whole} minutes"
    hours, rest = divmod(whole, 60)
    hour_part = "an hour" if hours == 1 else f"{hours} hours"
    if not rest:
        return hour_part
    return f"{hour_part} and {'1 minute' if rest == 1 else f'{rest} minutes'}"


def clock(seconds):
    """Seconds as h:mm:ss -- the same shape the video player shows, so it can be typed in."""
    total = int(seconds)
    return f"{total // 3600}:{total % 3600 // 60:02d}:{total % 60:02d}"


def mark_times(segments):
    """Writes [h:mm:ss] into the speech every half minute, never mid-sentence.

    The mark goes before a segment, never inside one, so a sentence is never cut in half
    by a timestamp. The next mark is counted from the segment that was actually marked
    rather than from the clock, so a long silence does not come back as a run of markers
    catching up with each other.
    """
    parts = []
    next_mark = 0.0
    for segment in segments:
        piece = segment.text.strip()
        if not piece:
            continue
        if segment.start >= next_mark:
            parts.append(f"[{clock(segment.start)}]")
            next_mark = segment.start + MARK_EVERY_SEC
        parts.append(piece)
    return " ".join(parts).strip()


def transcribe(audio_path, duration_sec=0, max_chars=None, long_above=None):
    """Always task="translate" -- the transcript comes back in English whatever was spoken.

    Asked to write Hindi down in Hindi, whisper produces broken Devanagari on the
    Hinglish these reels are actually in, and everything downstream inherits it (D28).
    Same audio, same model, translate instead: clean English, and far quicker, because
    a failing decode is retried at rising temperatures before it gives up.

    A reel comes back exactly as it always has: one block of speech, no markers. Only a
    long video gets times written into it -- on an hour of talk, a point with no time
    against it cannot be found again, which is most of the reason for saving it.
    """
    segments, info = model.transcribe(str(audio_path), task="translate", vad_filter=True)
    if duration_sec > (LONG_VIDEO_SEC if long_above is None else long_above):
        text = mark_times(segments)
    else:
        text = " ".join(segment.text.strip() for segment in segments).strip()
    if not text:
        raise Refused("No speech found in this video.")
    ceiling = max_chars or MAX_TRANSCRIPT_CHARS
    if len(text) > ceiling:
        # Said plainly rather than silently cut. A transcript with its last hour missing
        # would be worse than none: the summary would look complete and be wrong.
        raise Refused(
            f"This video produced {len(text) // 1000}k characters of speech, more than the "
            f"{ceiling // 1000}k a single video can hold."
        )
    return text, info.language


# How many times to offer a finished transcript before giving up on it, and how long to
# wait between goes.
#
# The transcript exists in one place when this runs: a variable in memory. The audio it came
# from is deleted by `cleanup` in the `finally` a few lines later, and nothing writes the
# text to disk. So one blip on his broadband threw away however long the machine had just
# spent -- and on a six-hour video (D42) that is hours of it. The work is recoverable in the
# sense that the API puts the video back in the queue and it is downloaded and transcribed
# again from scratch; it is not recoverable in the sense that matters, which is his evening.
POST_TRIES = 4
POST_PAUSE_SEC = 5


def post_transcript(source_id, text, lang, title, duration, creator):
    for attempt in range(POST_TRIES):
        try:
            return _post_transcript_once(source_id, text, lang, title, duration, creator)
        except requests.RequestException as error:
            # A REFUSAL is final -- the API has looked at this and said no, and asking again
            # says the same thing. Anything else is the network, and the network comes back.
            answer = getattr(error, "response", None)
            if answer is not None and 400 <= answer.status_code < 500:
                raise
            if attempt == POST_TRIES - 1:
                raise
            say(
                f"  ! could not hand back the transcript ({error}); trying again in "
                f"{POST_PAUSE_SEC}s ({attempt + 1} of {POST_TRIES - 1})"
            )
            time.sleep(POST_PAUSE_SEC)
    return None


def _post_transcript_once(source_id, text, lang, title, duration, creator):
    response = requests.post(
        f"{API_BASE}/v1/sources/{source_id}/transcript",
        json={
            "text": text,
            "lang": lang,
            # D40. Who made it, so the notebook can be searched by creator. None where the
            # platform did not say, which the API stores as "asked, nobody named".
            "creator": creator,
            # ":translate" matters. lang is the language that was *spoken*, while the
            # text is always English (D28) -- without this the row reads as a lie.
            "engine": f"faster-whisper:{WHISPER_MODEL}:translate",
            "title": title,
            "duration_sec": duration,
        },
        headers=HEADERS,
        timeout=60,
    )
    response.raise_for_status()


def classify_failure(error):
    """Turns an exception into text that is safe for every user of a shared row to read.

    The order of these two matters and is not obvious. `InvalidURL`, `MissingSchema`,
    `InvalidSchema` and `InvalidHeader` all inherit from BOTH RequestException and
    ValueError -- so with ValueError first, their raw text went straight onto the shared
    row. `InvalidHeader`'s message QUOTES the offending header value, and this worker's
    only header is the service token: a token with a stray character in it would have
    published itself into a column every saver of the reel can read.
    """
    if isinstance(error, requests.RequestException):
        return "Could not reach ClipToAction while processing this video."
    if isinstance(error, Refused):
        # OUR OWN refusals only, and only because their messages were written to be shown.
        # This used to be `ValueError`, which is the base class of half of yt-dlp's and
        # ctranslate2's errors as well -- their messages quote filesystem paths, model
        # cache locations and URLs, and every one of those went onto a row that every
        # saver of the reel can read.
        return str(error)[:200]
    if isinstance(error, FileNotFoundError):
        return "The audio could not be extracted from this video."
    return "This video could not be downloaded or transcribed."


def cleanup(source_id):
    """Removes every file this source produced, not just the .wav we ended up with.

    When ffmpeg extraction fails, yt-dlp has already written the source .m4a/.webm and
    download_audio raises before returning a path -- so keying cleanup off the return
    value leaves that file behind for good.
    """
    if not UUID_PATTERN.match(source_id):
        return
    for leftover in MEDIA_DIR.glob(f"{source_id}.*"):
        leftover.unlink(missing_ok=True)


def ask_about_length(source_id, waiting):
    """Hands the length back so the app can ask him, and downloads nothing (D42)."""
    try:
        response = requests.post(
            f"{API_BASE}/v1/sources/{source_id}/too-long",
            json={
                "duration_sec": waiting.duration,
                "title": waiting.title,
                "creator": waiting.creator,
            },
            headers=HEADERS,
            timeout=30,
        )
        # requests does not raise on a 4xx or a 5xx. Without this a REJECTED report reads
        # as an accepted one: the video would stay in 'downloading', be re-claimed until
        # its attempts ran out, and be retired as "gave up after 3 attempts" -- a video he
        # was supposed to be ASKED about, thrown away instead, with no visible cause.
        response.raise_for_status()
    except requests.RequestException as error:
        # Loud, because the alternative is the silent retirement described above. Nothing
        # was downloaded, and the claim simply expires so it is asked again.
        say(f"  !! could not ask about {source_id}: {error}")


def remember_claim(source_id, claimed_at):
    """Writes down what this run is holding, so a crash does not lock it away.

    The claim TIME goes down with the id. A hand-back names the claim it means, not just
    the video — otherwise it cancels whoever is holding it now, which on a machine running
    two copies is the one that is actually working.
    """
    try:
        with io.open(CLAIMS_PATH, "a", encoding="utf-8") as handle:
            handle.write(f"{source_id} {int(claimed_at or 0)}\n")
    except OSError:
        pass


def forget_claim(source_id):
    """Removes one id from the list, once it has reached an ending of its own."""
    try:
        if not CLAIMS_PATH.exists():
            return
        with io.open(CLAIMS_PATH, encoding="utf-8") as handle:
            kept = [
                line
                for line in handle.read().splitlines()
                if line.strip() and line.split(" ")[0] != source_id
            ]
        with io.open(CLAIMS_PATH, "w", encoding="utf-8") as handle:
            handle.write("\n".join(kept) + ("\n" if kept else ""))
    except OSError:
        pass


def release_stale_claims():
    """Hands back anything a run that is no longer going was still holding.

    A claim is a lease, and the lease for a video somebody approved is eight hours -- the
    length of the job it has to cover. So a reboot five minutes into a six-hour video left
    it locked for the remaining seven hours and fifty-five, with the app saying "being
    watched now" the whole time. Three of those -- one Windows update night is enough --
    and it was retired as "gave up after 3 attempts" having done nothing at all.

    It reads the lists of runs that have STOPPED, never this run's own and never a live
    one's: those belong to a machine that is working, and handing back work in progress is
    how three hours of transcription disappears with no error anywhere.

    Nothing here reports a failure. No work was attempted, so the attempt is given back
    with it -- but only a few times per video (see MAX_FREE_RELEASES in the Worker), or a
    video that kills this process on sight would loop for ever without ever being retired.

    Each id is forgotten as it is handed back, one at a time. Clearing the whole list only
    at the end meant one id that kept failing had the others handed back again at every
    single start.
    """
    # What a version before this one was holding. It kept its list outside the run
    # folders, so on the upgrade itself there would have been nothing to find and the work
    # would have sat locked for its whole lease.
    # The version before this one kept its list here, outside the run folders, so on the
    # upgrade itself there would be nothing to find and the work would sit locked for its
    # whole lease. It is only safe to read while no other copy is going: a running one of
    # that version appends to it as it works, and handing back work in progress is the
    # thing the rest of this function exists to prevent.
    legacy = MEDIA_ROOT / "claimed.txt"
    somebodyElseIsGoing = any(
        folder != MEDIA_DIR and folder.is_dir() and pid_of(folder) and still_running(pid_of(folder))
        for folder in MEDIA_ROOT.glob("run-*")
    )

    for held in ([] if somebodyElseIsGoing else [legacy]) + [
        folder / "claimed.txt" for folder in sorted(MEDIA_ROOT.glob("run-*")) if has_stopped(folder)
    ]:
        if not held.exists():
            continue
        try:
            with io.open(held, encoding="utf-8") as handle:
                lines = [line.strip() for line in handle.read().splitlines() if line.strip()]
        except OSError:
            continue

        for line in lines:
            parts = line.split(" ")
            source_id = parts[0]
            claimed_at = parts[1] if len(parts) > 1 else "0"

            # No claim time, nothing to hand back with. A hand-back names the claim it
            # means, so that it cannot cancel work a different machine is doing now -- and
            # a line with no time can never satisfy that. Asking anyway got a 400 every
            # start, kept the line for ever, and then the sweep deleted the folder under
            # it. The lease expiring is the answer for these, which costs time and loses
            # nothing.
            if claimed_at == "0":
                say(f"  . {source_id} was noted without a claim time; leaving it to time out")
                drop_line(held, line)
                continue

            try:
                response = requests.post(
                    f"{API_BASE}/v1/sources/{source_id}/release",
                    json={"claimed_at": int(claimed_at)},
                    headers=HEADERS,
                    timeout=30,
                )
                response.raise_for_status()
                say(f"- handed back {source_id}, which an earlier run was still holding")
            except (requests.RequestException, ValueError) as error:
                say(f"!! could not hand back {source_id}: {error}")
                continue
            drop_line(held, line)

    # Only now, and only what is finished with. A folder whose list still has something in
    # it is one whose hand-backs did not get through -- the network not being up yet is the
    # ordinary case on a machine that has just booted, which is exactly the restart this
    # feature is for. Deleting it there took the record away for good.
    sweep_finished_runs()


def drop_line(path, wanted):
    """Removes one line from a file, so a hand-back is never made twice."""
    try:
        with io.open(path, encoding="utf-8") as handle:
            kept = [line for line in handle.read().splitlines() if line.strip() != wanted]
        with io.open(path, "w", encoding="utf-8") as handle:
            handle.write("\n".join(kept) + ("\n" if kept else ""))
    except OSError:
        pass


def pid_of(folder):
    """The process id a run folder is named after, or 0 when it is not one of ours."""
    try:
        return int(folder.name.split("-", 1)[1])
    except (IndexError, ValueError):
        return 0


def has_stopped(folder):
    """Whether the run that owns this folder is over.

    ONE rule, used by the reader and by the sweep. They had a rule each, and the sweep's
    was the more generous -- so a folder whose process number Windows had handed to some
    unrelated live program was DELETED after a day without its list ever being read, which
    is the loss the reader exists to prevent.
    """
    if folder == MEDIA_DIR or not folder.is_dir() or not pid_of(folder):
        return False
    try:
        stale = time.time() - folder.stat().st_mtime > STALE_RUN_SEC
    except OSError:
        # Somebody else removed it between the listing and now -- two copies, which the
        # setup instructions encourage. Nothing to do and nothing to report.
        return False
    return stale or not still_running(pid_of(folder))


def sweep_finished_runs():
    """Removes the folders of runs that are no longer going.

    The per-run folder is deleted on the way out, and a hard kill -- End Task, a power cut,
    a reboot -- skips that. Nothing swept at startup, so a six-hour video's audio (about
    700MB of wav) sat there until somebody noticed.
    """
    for folder in list(MEDIA_ROOT.glob("run-*")):
        if not has_stopped(folder):
            continue
        held = folder / "claimed.txt"
        try:
            still_held = held.exists() and held.read_text(encoding="utf-8").strip()
            # And a backstop, because "keep it until the hand-back gets through" has no
            # end of its own. A rotated service token or an API address that has moved
            # means it NEVER gets through, and the folder -- with a long video's audio in
            # it, about 700MB -- would be kept for ever, which is the disk filling this
            # exists to stop. A week is far longer than any outage worth waiting through,
            # and by then the claim's own lease expired days ago.
            ancient = time.time() - folder.stat().st_mtime > GIVE_UP_ON_HANDBACK_SEC
            if still_held and not ancient:
                say(f"- keeping {folder.name}: it is still holding work nobody has taken back")
                continue
            if still_held:
                say(f"- clearing {folder.name}: its work could not be handed back for a week")
        except OSError:
            continue
        shutil.rmtree(folder, ignore_errors=True)
        say(f"- cleared {folder.name}, left behind by a run that is no longer going")


def still_running(pid):
    """Whether a process id is alive. Wrong in only the safe direction: if this cannot
    tell, it says yes and the folder is left alone."""
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False
    except Exception:  # noqa: BLE001
        return True


def process(source, limits):
    say(f"- {source['platform']}: {source['url_canonical']}")
    try:
        audio_path, title, duration, creator = download_audio(source, limits)
        text, lang = transcribe(
            audio_path, duration, limits["max_transcript_chars"], limits["long_video_sec"]
        )
        post_transcript(source["id"], text, lang, title, duration, creator)
        say(f"  transcribed {len(text)} chars ({lang})")
    except NeedsPermission as waiting:
        # A question, not a failure. It sits waiting for an answer and keeps no error.
        say(f"  waiting for permission: {waiting}")
        ask_about_length(source["id"], waiting)
    # Deliberately broad: a whisper RuntimeError or an OSError killing the loop would
    # strand every source in this batch, and the operator would see clips stuck on
    # "pending" with no error anywhere.
    except Exception as error:  # noqa: BLE001
        # The full text goes to this machine's console only. What gets posted is a short
        # classification, because sources.error is read by every user who saved the reel
        # and an exception string can carry a URL, a path, or a provider's response.
        say(f"  failed: {type(error).__name__}: {error}")
        report_failure(source["id"], classify_failure(error))
    finally:
        # Whatever happened, this source has an ending of its own now -- transcribed,
        # waiting on an answer, or reported as failed. Nothing to hand back.
        forget_claim(source["id"])
        cleanup(source["id"])


def main():
    MEDIA_ROOT.mkdir(exist_ok=True)
    MEDIA_DIR.mkdir(exist_ok=True)
    # Reads what the stopped runs were holding, hands it back, and only then removes the
    # folders it has finished with.
    release_stale_claims()
    say(f"Polling {API_BASE} every {POLL_SECONDS}s. Ctrl+C to stop.")

    while True:
        # A sign of life on this run's own folder, every time round.
        #
        # "Abandoned" is judged partly on how long the folder has gone untouched, because
        # Windows hands the same process number out again and a dead run's number can look
        # alive. But the folder is only touched when work happens -- so a copy that had
        # been polling quietly for a day looked abandoned to the next one, which then handed
        # back its claims and deleted its media folder out from under it.
        try:
            MEDIA_DIR.touch(exist_ok=True)
        except OSError:
            pass

        try:
            batch, limits = claim_batch()
        except requests.RequestException as error:
            say(f"Queue unreachable: {error}")
            time.sleep(POLL_SECONDS)
            continue

        # Written down BEFORE any of them is worked on. It used to be recorded inside
        # process(), one at a time -- so of the three a batch claims, two were held and
        # unrecorded, and a reboot handed back a third of what it was holding.
        for source in batch:
            remember_claim(source["id"], source.get("claimed_at"))

        for source in batch:
            process(source, limits)

        if not batch:
            # Only when there is nothing anybody is waiting for (D40).
            fill_in_creators()
            time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        say("Stopped.")
    finally:
        # This run's own folder, never the shared one -- see MEDIA_DIR.
        shutil.rmtree(MEDIA_DIR, ignore_errors=True)
