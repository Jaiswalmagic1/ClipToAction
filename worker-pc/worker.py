"""ClipToAction enrichment worker.

Runs on Jaiswal's PC for now. Claims pending sources from the Cloudflare Worker API,
downloads the audio, transcribes it, and posts the transcript back. Analysis does NOT
happen here -- it runs in the Cloudflare Worker, so users' AI keys never leave it.

Media files are deleted as soon as they are transcribed. Nothing is kept on disk.

Host-agnostic by design: it only needs API_BASE and SERVICE_TOKEN, so moving it to a
cloud VM later is a config change, not a rewrite.
"""

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

API_BASE = os.getenv("API_BASE", "").rstrip("/")
SERVICE_TOKEN = os.getenv("SERVICE_TOKEN", "")
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "small")
POLL_SECONDS = int(os.getenv("POLL_SECONDS", "30"))
BATCH_SIZE = int(os.getenv("BATCH_SIZE", "3"))
# 6 hours, and still a real ceiling rather than no ceiling (D42). Past this no answer he
# could give would help: the machine would be tied up for most of a day and the words would
# not fit in the column that holds them, so it is refused out loud rather than accepted and
# left to rot.
MAX_DURATION_SEC = int(os.getenv("MAX_DURATION_SEC", "21600"))
# Past this, HE IS ASKED before anything is downloaded (D42). Nothing about the videos he
# saves all the time -- 11 to 18 minutes -- comes near it, and that is the point: a warning
# that always appears is a warning nobody reads.
WARN_ABOVE_SEC = int(os.getenv("WARN_ABOVE_SEC", "1800"))
# As much transcript as the notebook will hold for one video. Checked HERE, before the work
# and not after it: a six-hour video whose words did not fit would otherwise be discovered
# at the last step, having already had three hours of the machine.
MAX_TRANSCRIPT_CHARS = int(os.getenv("MAX_TRANSCRIPT_CHARS", "400000"))
# Past this, a video stops being a reel and starts being something you come back to. It
# gets times written into the transcript so there is a way back into the video.
LONG_VIDEO_SEC = int(os.getenv("LONG_VIDEO_SEC", "600"))
MARK_EVERY_SEC = 30
# Filling in who made the videos already saved (D40). Deliberately slow: this reads
# metadata for videos that are already finished, so it may never compete with a reel
# somebody is waiting on, and Facebook and Instagram will rate-limit a machine that asks
# two hundred questions in two minutes. Two at a time, with a pause between each, and only
# when there is no real work.
CREATOR_BATCH = int(os.getenv("CREATOR_BATCH", "2"))
CREATOR_PAUSE_SEC = int(os.getenv("CREATOR_PAUSE_SEC", "20"))
# How long to leave the whole backfill alone after a lookup fails. A failure usually means
# the platform is throttling this machine, and the worst possible response to being
# throttled is to keep asking -- so it stops for half an hour rather than working down the
# queue burning attempts on questions that are not being answered.
CREATOR_BACKOFF_SEC = int(os.getenv("CREATOR_BACKOFF_SEC", "1800"))
MEDIA_DIR = Path(__file__).parent / "media"

if not API_BASE or not SERVICE_TOKEN:
    sys.exit("Missing API_BASE or SERVICE_TOKEN. Copy .env.example to .env and fill it in.")

HEADERS = {"X-Service-Token": SERVICE_TOKEN}

print(f"Loading whisper model '{WHISPER_MODEL}' (first run downloads it)...")
model = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")
print("Model ready.")


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
        print(f"  !! could not report failure for {source_id}: {error}")


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
        raise Refused(f"Could not resolve {host}.") from error

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
                f"This video is {duration // 60} minutes long, which is more than can be "
                "processed in one go."
            )

        downloader.download([source["url_original"]])

    audio_path = target.with_suffix(".wav")
    if not audio_path.exists():
        raise FileNotFoundError("Audio extraction produced no file.")

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
        print(f"  ! could not report the creator for {source_id}: {error}")


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
        print(f"  ! could not ask which videos need a creator: {error}")
        return

    pending = payload.get("sources", [])
    if not pending:
        return
    print(f"- filling in who made {len(pending)} of {payload.get('remaining', '?')} videos")

    for index, source in enumerate(pending):
        try:
            # A private address is this URL's own problem and will be next time too, so it
            # is settled rather than counted -- pausing the whole backfill for half an hour
            # over something that can never succeed would be the wrong shape of caution.
            try:
                assert_public_host(source["url_original"])
            except Refused:
                print(f"  . {source['id']} does not resolve publicly; leaving it alone")
                report_creator(source["id"], None, asked=True)
                continue

            with YoutubeDL({"quiet": True, "no_warnings": True, "noplaylist": True}) as reader:
                name = creator_from(reader.extract_info(source["url_original"], download=False))
        # Deliberately broad, and deliberately not reported as a failure of the video:
        # this runs over reels that are already finished and analysed.
        except Exception as error:  # noqa: BLE001
            print(
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


def post_transcript(source_id, text, lang, title, duration, creator):
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
        print(f"  !! could not ask about {source_id}: {error}")


def process(source, limits):
    print(f"- {source['platform']}: {source['url_canonical']}")
    try:
        audio_path, title, duration, creator = download_audio(source, limits)
        text, lang = transcribe(
            audio_path, duration, limits["max_transcript_chars"], limits["long_video_sec"]
        )
        post_transcript(source["id"], text, lang, title, duration, creator)
        print(f"  transcribed {len(text)} chars ({lang})")
    except NeedsPermission as waiting:
        # A question, not a failure. It sits waiting for an answer and keeps no error.
        print(f"  waiting for permission: {waiting}")
        ask_about_length(source["id"], waiting)
    # Deliberately broad: a whisper RuntimeError or an OSError killing the loop would
    # strand every source in this batch, and the operator would see clips stuck on
    # "pending" with no error anywhere.
    except Exception as error:  # noqa: BLE001
        # The full text goes to this machine's console only. What gets posted is a short
        # classification, because sources.error is read by every user who saved the reel
        # and an exception string can carry a URL, a path, or a provider's response.
        print(f"  failed: {type(error).__name__}: {error}")
        report_failure(source["id"], classify_failure(error))
    finally:
        cleanup(source["id"])


def main():
    MEDIA_DIR.mkdir(exist_ok=True)
    print(f"Polling {API_BASE} every {POLL_SECONDS}s. Ctrl+C to stop.")

    while True:
        try:
            batch, limits = claim_batch()
        except requests.RequestException as error:
            print(f"Queue unreachable: {error}")
            time.sleep(POLL_SECONDS)
            continue

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
        print("\nStopped.")
    finally:
        shutil.rmtree(MEDIA_DIR, ignore_errors=True)
