import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Telegraf } from "telegraf";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const token = process.env.TELEGRAM_BOT_TOKEN;
const ideasFile = path.resolve(__dirname, process.env.IDEAS_FILE || "../data/ideas.json");

if (!token || token === "paste_botfather_token_here") {
  console.error("Missing TELEGRAM_BOT_TOKEN. Copy .env.example to .env and paste your BotFather token.");
  process.exit(1);
}

const bot = new Telegraf(token);

function extractUrl(text = "") {
  const match = text.match(/https?:\/\/[^\s]+/i);
  return match ? match[0].replace(/[),.]+$/, "") : "";
}

function platformFromUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (host.includes("youtube") || host.includes("youtu.be")) return "YouTube";
    if (host.includes("instagram")) return "Instagram";
    if (host.includes("facebook") || host.includes("fb.watch")) return "Facebook";
    if (host.includes("linkedin")) return "LinkedIn";
    if (host.includes("x.com") || host.includes("twitter")) return "X";
    return host.split(".")[0].replace(/^./, (char) => char.toUpperCase());
  } catch {
    return "Unknown";
  }
}

async function readIdeas() {
  try {
    const raw = await fs.readFile(ideasFile, "utf8");
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeIdeas(ideas) {
  await fs.mkdir(path.dirname(ideasFile), { recursive: true });
  await fs.writeFile(ideasFile, JSON.stringify(ideas, null, 2), "utf8");
}

function buildIdea(url, ctx) {
  const platform = platformFromUrl(url);
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    title: `${platform} video idea`,
    url,
    platform,
    category: "Business",
    topic: "To be derived from video",
    notes: `Saved from ${platform}. Automated enrichment pending.`,
    action: "Review this link and derive the next business action.",
    effort: "Low",
    impact: "High",
    status: "Save",
    source: "telegram",
    telegram: {
      chatId: ctx.chat?.id,
      username: ctx.from?.username || "",
      firstName: ctx.from?.first_name || ""
    },
    createdAt: new Date().toISOString(),
    enriched: false
  };
}

bot.start((ctx) => {
  ctx.reply("Send or share any video link here. Only the link is needed.");
});

bot.on("text", async (ctx) => {
  const url = extractUrl(ctx.message.text);
  if (!url) {
    await ctx.reply("Please send only a video link.");
    return;
  }

  const ideas = await readIdeas();
  const exists = ideas.some((idea) => idea.url === url);
  if (exists) {
    await ctx.reply("Already saved. I will not duplicate it.");
    return;
  }

  const idea = buildIdea(url, ctx);
  ideas.unshift(idea);
  await writeIdeas(ideas);
  await ctx.reply(`Saved link from ${idea.platform}. Enrichment will happen next.`);
});

bot.catch((error) => {
  console.error("Telegram bot error:", error);
});

bot.launch();
console.log(`ClipToAction Telegram bot running. Saving to ${ideasFile}`);

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));