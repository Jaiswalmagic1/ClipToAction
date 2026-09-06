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

First run downloads the whisper model (~500 MB for `small`). After that it is offline.

## The transcript always comes back in English

Whisper is asked to **translate**, never to write the spoken language down (D28). Asked to
write Hindi in Hindi it produces broken text on the Hinglish these reels are actually in,
and every summary, topic and search built on top inherits it. This is not a model-size
problem — it was measured at `base`, `small` and `medium`, and all three fail the same way.
Do not put `task="transcribe"` back.

`transcripts.lang` still records what was **spoken**; `engine` ends in `:translate` to say
the text beside it is English.

```bash
python -m unittest discover -p "test_*.py" -v
```

Those tests read the source rather than importing it, so they need no model and no `.env`,
and they run in CI on every push. They also guard the two things added since: that a very
long video is asked about **before** anything is downloaded (D42), and that the creator
backfill is paced and backs off rather than hammering a platform that is throttling it
(D40).

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
| Video longer than `WARN_ABOVE_SEC` (default 30 min) | **Nothing is downloaded.** The length is read from the metadata, reported back, and the app asks first — how long it runs, how long this machine will be busy, that everything else queues behind it, and that it can spend a day of an AI key. A refusal parks it, and parked is never failed (D42) |
| Video longer than `LONG_VIDEO_SEC` (default 10 min) | Times are written into the transcript every half minute, and the AI is asked for chapters rather than a 3-sentence summary (D33) |
| Video longer than `MAX_DURATION_SEC` (default 6 hours) | Refused. The **API** makes this call from the reported length; this machine's own setting is only a guard for something already approved |
| Transcript longer than `MAX_TRANSCRIPT_CHARS` | Refused out loud rather than silently cut — a summary of a transcript missing its last hour would look complete and be wrong |
| A long video is in the queue | It holds the machine for its whole length. Reels shared meanwhile wait behind it — the queue is one at a time |
| Download or transcription fails | Error is posted back and shown in the app; retried up to 3 times, then marked `failed` |
| No speech in the video | Recorded as an error rather than saving an empty transcript |
| PC is off | Nothing is lost — sources stay `pending` and are picked up on the next run, oldest first |
| Worker dies mid-reel | That reel is handed back out after 15 minutes rather than being stuck — or after 8 hours for a video long enough that 15 minutes would steal it mid-job |
| Worker stops altogether | Every queue call is a heartbeat, so the app notices the silence and says so |
| Nothing to do | It fills in who made the videos saved before that was recorded (D40) — metadata only, two at a time, `CREATOR_PAUSE_SEC` apart, and it goes quiet for `CREATOR_BACKOFF_SEC` after any failed lookup |

## Settings, and the trap in them

**`.env` overrides every default in `worker.py`, and `.env` is gitignored.** Changing a
default in the code does nothing on a machine that already has a `.env` — this has cost the
project two separate sessions. When a setting changes, it has to be changed in `.env` **and
the worker restarted**, or it has not happened.

`.env.example` lists every setting with what it is for. Copy the ones you need; anything
absent falls back to the code's default, which is the safest place to leave most of them.

The two that actually matter on a new machine are still only `API_BASE` and
`SERVICE_TOKEN`.

## Moving off the PC later

Only `API_BASE` and `SERVICE_TOKEN` tie this to a machine. Running it on a cloud VM is a
config change, not a rewrite. Note that Instagram blocks datacenter IPs far more
aggressively than home connections — that is why it runs on the PC for now.
