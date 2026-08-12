"""ClipToAction enrichment worker.

Runs on Jaiswal's PC for now. Claims pending sources from the Cloudflare Worker API,
downloads the audio, transcribes it, and posts the transcript back. Analysis does NOT
happen here -- it runs in the Cloudflare Worker, so users' AI keys never leave it.

Media files are deleted as soon as they are transcribed. Nothing is kept on disk.

Host-agnostic by design: it only needs API_BASE and SERVICE_TOKEN, so moving it to a
cloud VM later is a config change, not a rewrite.
"""

import os
import shutil
import sys
import time
from pathlib import Path

import requests
from dotenv import load_dotenv
from faster_whisper import WhisperModel
from yt_dlp import YoutubeDL
from yt_dlp.utils import DownloadError

load_dotenv()

API_BASE = os.getenv("API_BASE", "").rstrip("/")
SERVICE_TOKEN = os.getenv("SERVICE_TOKEN", "")
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "base")
POLL_SECONDS = int(os.getenv("POLL_SECONDS", "30"))
BATCH_SIZE = int(os.getenv("BATCH_SIZE", "3"))
MAX_DURATION_SEC = int(os.getenv("MAX_DURATION_SEC", "1800"))
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


def download_audio(source):
    """Downloads audio only and returns (path, title, duration_sec)."""
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

    return audio_path, info.get("title"), duration


def transcribe(audio_path):
    segments, info = model.transcribe(str(audio_path), vad_filter=True)
    text = " ".join(segment.text.strip() for segment in segments).strip()
    if not text:
        raise ValueError("No speech found in this video.")
    return text, info.language


def post_transcript(source_id, text, lang, title, duration):
    response = requests.post(
        f"{API_BASE}/v1/sources/{source_id}/transcript",
        json={
            "text": text,
            "lang": lang,
            "engine": f"faster-whisper:{WHISPER_MODEL}",
            "title": title,
            "duration_sec": duration,
        },
        headers=HEADERS,
        timeout=60,
    )
    response.raise_for_status()


def process(source):
    print(f"- {source['platform']}: {source['url_canonical']}")
    audio_path = None
    try:
        audio_path, title, duration = download_audio(source)
        text, lang = transcribe(audio_path)
        post_transcript(source["id"], text, lang, title, duration)
        print(f"  transcribed {len(text)} chars ({lang})")
    except (DownloadError, ValueError, FileNotFoundError, requests.RequestException) as error:
        print(f"  failed: {error}")
        report_failure(source["id"], error)
    finally:
        if audio_path and audio_path.exists():
            audio_path.unlink()


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
            time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        shutil.rmtree(MEDIA_DIR, ignore_errors=True)
