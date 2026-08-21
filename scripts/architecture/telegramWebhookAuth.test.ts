import assert from "node:assert/strict";
import test from "node:test";

import {
  isTelegramWebhookAuthorized,
  rejectUnauthorizedTelegramWebhook,
} from "../../lib/security/telegramWebhookAuth";

function webhookRequest(secret?: string, url = "http://127.0.0.1/api/telegram/webhook") {
  const headers = secret
    ? { "x-telegram-bot-api-secret-token": secret }
    : undefined;
  return new Request(url, { method: "POST", headers });
}

test("webhook missing env is denied", () => {
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
  delete process.env.TELEGRAM_WEBHOOK_SECRET_PREVIOUS;
  assert.equal(isTelegramWebhookAuthorized(webhookRequest("anything")), false);
  assert.equal(rejectUnauthorizedTelegramWebhook(webhookRequest("anything"))?.status, 401);
});

test("webhook blank env is denied", () => {
  process.env.TELEGRAM_WEBHOOK_SECRET = "   ";
  delete process.env.TELEGRAM_WEBHOOK_SECRET_PREVIOUS;
  assert.equal(isTelegramWebhookAuthorized(webhookRequest("x")), false);
});

test("webhook missing header is denied", () => {
  process.env.TELEGRAM_WEBHOOK_SECRET = "cur";
  delete process.env.TELEGRAM_WEBHOOK_SECRET_PREVIOUS;
  assert.equal(isTelegramWebhookAuthorized(webhookRequest()), false);
  assert.equal(rejectUnauthorizedTelegramWebhook(webhookRequest())?.status, 401);
});

test("webhook wrong header is denied", () => {
  process.env.TELEGRAM_WEBHOOK_SECRET = "cur";
  delete process.env.TELEGRAM_WEBHOOK_SECRET_PREVIOUS;
  assert.equal(isTelegramWebhookAuthorized(webhookRequest("bad")), false);
});

test("webhook current secret is accepted", () => {
  process.env.TELEGRAM_WEBHOOK_SECRET = "cur";
  delete process.env.TELEGRAM_WEBHOOK_SECRET_PREVIOUS;
  assert.equal(isTelegramWebhookAuthorized(webhookRequest("cur")), true);
  assert.equal(rejectUnauthorizedTelegramWebhook(webhookRequest("cur")), null);
});

test("webhook previous is ignored when unset", () => {
  process.env.TELEGRAM_WEBHOOK_SECRET = "cur";
  delete process.env.TELEGRAM_WEBHOOK_SECRET_PREVIOUS;
  assert.equal(isTelegramWebhookAuthorized(webhookRequest("old")), false);
});

test("webhook previous is accepted only when SET", () => {
  process.env.TELEGRAM_WEBHOOK_SECRET = "cur";
  process.env.TELEGRAM_WEBHOOK_SECRET_PREVIOUS = "old";
  assert.equal(isTelegramWebhookAuthorized(webhookRequest("old")), true);
  assert.equal(isTelegramWebhookAuthorized(webhookRequest("cur")), true);
  assert.equal(isTelegramWebhookAuthorized(webhookRequest("oth")), false);
});

test("webhook query fallback is not used", () => {
  process.env.TELEGRAM_WEBHOOK_SECRET = "cur";
  delete process.env.TELEGRAM_WEBHOOK_SECRET_PREVIOUS;
  const req = new Request(
    "http://127.0.0.1/api/telegram/webhook?secret=cur",
    { method: "POST" }
  );
  assert.equal(isTelegramWebhookAuthorized(req), false);
});
