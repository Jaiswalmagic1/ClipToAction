# ClipToAction PC Worker

Claims pending reels from the API, downloads the audio, transcribes it, and posts the
transcript back. **Analysis does not happen here** — it runs in the Cloudflare Worker, so
users' AI keys never leave it.

Downloaded media is deleted the moment it is transcribed. Nothing is kept on disk.

## Prerequisites

`ffmpeg` must be on your PATH — `yt-dlp` uses it to extract audio.

```bash
winget install Gyan.FFmpeg
```

## Setup

```bash
python -m venv .venv
```

```bash
.venv\Scripts\activate
```

```bash
pip install -r requirements.txt
```

Copy `.env.example` to `.env` and fill in `API_BASE` and `SERVICE_TOKEN` (the same value you
set with `wrangler secret put WORKER_SERVICE_TOKEN`).

```bash
python worker.py
```

First run downloads the whisper model (~150 MB for `base`). After that it is offline.

## Behaviour

| Situation | What happens |
|---|---|
| Video longer than `MAX_DURATION_SEC` (default 30 min) | Skipped with a visible error, not silently dropped |
| Download or transcription fails | Error is posted back and shown in the app; retried up to 3 times, then marked `failed` |
| No speech in the video | Recorded as an error rather than saving an empty transcript |
| PC is off | Nothing is lost — sources stay `pending` and are picked up on the next run |

## Moving off the PC later

Only `API_BASE` and `SERVICE_TOKEN` tie this to a machine. Running it on a cloud VM is a
config change, not a rewrite. Note that Instagram blocks datacenter IPs far more
aggressively than home connections — that is why it runs on the PC for now.
