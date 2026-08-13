# ClipToAction Telegram Bot

Purpose: mobile inbox for ClipToAction.

## Logic

1. User shares/sends only a link to Telegram bot.
2. Bot extracts the first URL.
3. Bot saves it into `../data/ideas.json`.
4. ClipToAction app can load `data/ideas.json` and show the saved links.
5. Enrichment later derives title, topic, summary, category, action, effort, and impact from the video.

## Setup

1. In Telegram, open `@BotFather`.
2. Send `/newbot`.
3. Copy the bot token.
4. In this folder, copy `.env.example` to `.env`.
5. Paste the token into `.env`.
6. Run:

```bash
npm install
npm start
```

## Current storage

The bot writes to local `data/ideas.json`.

For always-on mobile use, deploy this bot to a small server later. Running only on your PC means the bot works only while your PC/server process is running.