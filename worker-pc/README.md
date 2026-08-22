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

## Letting it run itself

Started by hand, this only runs while somebody remembers to start it — and nobody
remembers a program on a PC for long. One command fixes that:

```bash
powershell -ExecutionPolicy Bypass -File autostart.ps1
```

It registers a scheduled task that starts the worker when you log in, restarts it if it
crashes, and runs it with no window in the way. No administrator rights: it runs as you.

To start it straight away without logging out again:

```bash
powershell -Command "Start-ScheduledTask ClipToActionWorker"
```

To stop it running on its own:

```bash
powershell -ExecutionPolicy Bypass -File autostart.ps1 -Remove
```

**You should never need to check on it.** The app shows a warning in the notebook when the
worker has gone quiet, and says when it was last running. That is the only place worth
looking, and it stays out of the way while everything is working.

## Behaviour

| Situation | What happens |
|---|---|
| Video longer than `MAX_DURATION_SEC` (default 30 min) | Skipped with a visible error, not silently dropped |
| Download or transcription fails | Error is posted back and shown in the app; retried up to 3 times, then marked `failed` |
| No speech in the video | Recorded as an error rather than saving an empty transcript |
| PC is off | Nothing is lost — sources stay `pending` and are picked up on the next run, oldest first |
| Worker dies mid-reel | That reel is handed back out after 15 minutes rather than being stuck |
| Worker stops altogether | Every queue call is a heartbeat, so the app notices the silence and says so |

## Moving off the PC later

Only `API_BASE` and `SERVICE_TOKEN` tie this to a machine. Running it on a cloud VM is a
config change, not a rewrite. Note that Instagram blocks datacenter IPs far more
aggressively than home connections — that is why it runs on the PC for now.
