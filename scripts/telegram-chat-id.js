#!/usr/bin/env node

const token = process.env.TELEGRAM_BOT_TOKEN;

async function telegram(method, params = {}) {
  const url = new URL(`https://api.telegram.org/bot${token}/${method}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  const response = await fetch(url);
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) {
    throw new Error(body?.description || `Telegram ${method} failed with HTTP ${response.status}`);
  }
  return body.result;
}

function chatFromUpdate(update) {
  const message =
    update.message ||
    update.edited_message ||
    update.channel_post ||
    update.edited_channel_post ||
    update.my_chat_member ||
    update.chat_member;
  return message?.chat || null;
}

if (!token) {
  console.error("TELEGRAM_BOT_TOKEN is required in .env or environment.");
  process.exit(1);
}

try {
  const bot = await telegram("getMe");
  console.log(`Bot: @${bot.username || bot.id}`);

  const updates = await telegram("getUpdates", {
    allowed_updates: JSON.stringify(["message", "my_chat_member", "chat_member", "channel_post"]),
    limit: 100,
  });

  const chats = new Map();
  for (const update of updates) {
    const chat = chatFromUpdate(update);
    if (!chat?.id) continue;
    chats.set(String(chat.id), {
      id: String(chat.id),
      type: chat.type || "unknown",
      title: chat.title || chat.username || [chat.first_name, chat.last_name].filter(Boolean).join(" ") || "untitled",
    });
  }

  if (chats.size === 0) {
    console.log("No chat ids found yet. Send /start to the bot from the destination chat, then run this again.");
    process.exit(0);
  }

  console.log("Candidate TELEGRAM_CHAT_ID values:");
  for (const chat of chats.values()) {
    console.log(`- ${chat.id} (${chat.type}) ${chat.title}`);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
