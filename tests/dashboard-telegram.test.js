import test from "node:test";
import assert from "node:assert/strict";

import { createTelegramNotifier } from "../dashboard/src/server/telegram.js";

test("telegram notifier sends errors and completion events", async () => {
  const calls = [];
  const notifier = createTelegramNotifier({
    botToken: "bot-token",
    chatId: "chat-id",
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return { ok: true, status: 200, text: async () => "{}" };
    },
  });

  await notifier.notifyEvent({
    machineId: "worker-a",
    severity: "error",
    type: "range.failed",
    message: "range failed",
  });
  await notifier.notifyEvent({
    machineId: "worker-a",
    severity: "success",
    type: "pipeline.completed",
    message: "done",
  });

  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /botbot-token\/sendMessage$/);
  assert.match(calls[0].body.text, /worker-a/);
  assert.match(calls[1].body.text, /pipeline.completed/);
});

test("telegram notifier ignores low-value progress events", async () => {
  let calls = 0;
  const notifier = createTelegramNotifier({
    botToken: "bot-token",
    chatId: "chat-id",
    fetchImpl: async () => {
      calls++;
      return { ok: true, status: 200, text: async () => "{}" };
    },
  });

  const result = await notifier.notifyEvent({
    machineId: "worker-a",
    severity: "info",
    type: "range.download.started",
    message: "download",
  });

  assert.equal(result.skipped, true);
  assert.equal(calls, 0);
});

test("telegram notifier reports send failures without throwing", async () => {
  const notifier = createTelegramNotifier({
    botToken: "bot-token",
    chatId: "chat-id",
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => "bad" }),
  });

  const result = await notifier.notifyEvent({
    machineId: "worker-a",
    severity: "error",
    type: "range.failed",
    message: "range failed",
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 500);
});

test("telegram notifier respects enablement severity and dedupe settings", async () => {
  let now = 1000;
  const calls = [];
  const notifier = createTelegramNotifier({
    botToken: "bot-token",
    chatId: "chat-id",
    now: () => new Date(now),
    fetchImpl: async (url, options) => {
      calls.push(JSON.parse(options.body));
      return { ok: true, status: 200, text: async () => "{}" };
    },
  });
  const settings = {
    notifications: {
      telegramEnabled: true,
      dedupeWindowMs: 1000,
      minSeverity: "warn",
    },
  };
  const event = {
    machineId: "worker-a",
    severity: "error",
    type: "range.failed",
    message: "same failure",
  };

  assert.equal((await notifier.notifyEvent({ ...event, severity: "info" }, settings)).skipped, true);
  assert.equal((await notifier.notifyEvent(event, settings)).ok, true);
  assert.equal((await notifier.notifyEvent(event, settings)).skipped, true);
  now += 1001;
  assert.equal((await notifier.notifyEvent(event, settings)).ok, true);
  assert.equal((await notifier.notifyEvent(event, { notifications: { telegramEnabled: false } })).skipped, true);
  assert.equal(calls.length, 2);
});

test("telegram notifier sends to multiple explicit chat ids", async () => {
  const calls = [];
  const notifier = createTelegramNotifier({
    botToken: "bot-token",
    chatId: "chat-a, chat-b",
    fetchImpl: async (url, options) => {
      calls.push(JSON.parse(options.body));
      return { ok: true, status: 200, text: async () => "{}" };
    },
  });

  const result = await notifier.notifyEvent({
    machineId: "worker-a",
    severity: "error",
    type: "range.failed",
    message: "range failed",
  });

  assert.equal(result.ok, true);
  assert.equal(result.sent, 2);
  assert.deepEqual(calls.map((call) => call.chat_id), ["chat-a", "chat-b"]);
});
