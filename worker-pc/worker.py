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
# 3 hours. Long enough for the talks and interviews people actually save, and still a
# real ceiling -- past this the machine is tied up for hours and everything else queues
# behind it, so it is refused out loud rather than accepted and left to rot.
MAX_DURATION_SEC = int(os.getenv("MAX_DURATION_SEC", "10800"))
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
MEDIA_DIR = Path(__file__).parent / "media"

if not API_BASE or not SERVICE_TOKEN:
    sys.exit("Missing API_BASE or SERVICE_TOKEN. Copy .env.example to .env and fill it in.")

HEADERS = {"X-Service-Token": SERVICE_TOKEN}

print(f"Loading whisper model '{WHISPER_MODEL}' (first run downloads it)...")
model = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")
print("Model ready.")


def claim_batch():
    response = requests.get(
        f"{API_BASE}/v1/queue", params={"limit": BATCH_SIZE}, headers=HEADERS, timeout=30
    )
    response.raise_for_status()
    return response.json().get("sources", [])


def report_failure(source_id, message):
    """Every failure goes back to the API so the app can show it. Never swallowed."""
    try:
        requests.post(
            f"{API_BASE}/v1/sources/{source_id}/error",
            json={"error": str(message)[:500]},
            headers=HEADERS,
            timeout=30,
        )
    except requests.RequestException as error:
        print(f"  ! could not report failure for {source_id}: {error}")


UUID_PATTERN = re.compile(r"\A[0-9a-fA-F-]{36}\Z")


def assert_public_host(url):
    """Refuses anything resolving inside a private network.

    The API already restricts saves to known platforms, but this worker runs on a home
    LAN -- a router admin page, a NAS, or a cloud metadata endpoint is one bad URL away.
    Two independent checks are cheaper than trusting one.
    """
    host = urlparse(url).hostname
    if not host:
        raise ValueError("Link has no host.")

    try:
        resolved = socket.getaddrinfo(host, None)
    except socket.gaierror as error:
        raise ValueError(f"Could not resolve {host}.") from error

    for entry in resolved:
        address = ipaddress.ip_address(entry[4][0])
        if (
            address.is_private
            or address.is_loopback
            or address.is_link_local
            or address.is_reserved
            or address.is_multicast
        ):
            raise ValueError(f"{host} resolves to a private address; refusing to fetch it.")


def download_audio(source):
    """Downloads audio only and returns (path, title, duration_sec)."""
    if not UUID_PATTERN.match(source["id"]):
        raise ValueError("Source id is not a UUID; refusing to build a path from it.")

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
        if duration > MAX_DURATION_SEC:
            raise ValueError(
                f"Video is {duration // 60} minutes long, over the {MAX_DURATION_SEC // 60} minute limit."
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


def fill_in_creators():
    """Fills in who made the videos saved before this was recorded (D40).

    Metadata only -- `download=False` -- so nothing is fetched twice and no audio is
    touched. Called only when there was no real work in this poll, one at a time with a
    pause between, because being rate-limited here would cost transcription too.

    Every attempt is reported whether it found a name or not. That is what makes the queue
    shrink: a video whose platform will not say who made it must leave it, or it comes back
    on every poll for ever.
    """
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

    for source in pending:
        name = None
        try:
            assert_public_host(source["url_original"])
            with YoutubeDL({"quiet": True, "no_warnings": True, "noplaylist": True}) as reader:
                name = creator_from(reader.extract_info(source["url_original"], download=False))
        # Deliberately broad, and deliberately not reported as a failure of the video:
        # this runs over reels that are already finished and analysed. The worst case is
        # that nobody is named, which the app already shows correctly.
        except Exception as error:  # noqa: BLE001
            print(f"  . no creator for {source['id']}: {type(error).__name__}")

        try:
            requests.post(
                f"{API_BASE}/v1/sources/{source['id']}/creator",
                json={"creator": name},
                headers=HEADERS,
                timeout=30,
            )
        except requests.RequestException as error:
            # Not marked, so it is asked again next time round. Nothing is lost.
            print(f"  ! could not report the creator for {source['id']}: {error}")

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


def transcribe(audio_path, duration_sec=0):
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
    if duration_sec > LONG_VIDEO_SEC:
        text = mark_times(segments)
    else:
        text = " ".join(segment.text.strip() for segment in segments).strip()
    if not text:
        raise ValueError("No speech found in this video.")
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
    """Turns an exception into text that is safe for every user of a shared row to read."""
    if isinstance(error, ValueError):
        # Our own checks -- the messages are written to be shown (too long, private host).
        return str(error)[:200]
    if isinstance(error, requests.RequestException):
        return "Could not reach ClipToAction while processing this video."
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


def process(source):
    print(f"- {source['platform']}: {source['url_canonical']}")
    try:
        audio_path, title, duration, creator = download_audio(source)
        text, lang = transcribe(audio_path, duration)
        post_transcript(source["id"], text, lang, title, duration, creator)
        print(f"  transcribed {len(text)} chars ({lang})")
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
            batch = claim_batch()
        except requests.RequestException as error:
            print(f"Queue unreachable: {error}")
            time.sleep(POLL_SECONDS)
            continue

        for source in batch:
            process(source)

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
