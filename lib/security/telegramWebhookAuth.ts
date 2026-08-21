import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

function readWebhookSecret(name: string): string {
  return String(process.env[name] ?? "").trim();
}

function timingSafeEqualUtf8(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");

  if (leftBuffer.length !== rightBuffer.length) {
    const dummy = Buffer.alloc(Math.max(leftBuffer.length, 1));
    timingSafeEqual(dummy, dummy);
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function isTelegramWebhookAuthorized(request: Request): boolean {
  const current = readWebhookSecret("TELEGRAM_WEBHOOK_SECRET");
  if (!current) {
    return false;
  }

  const incoming = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (timingSafeEqualUtf8(incoming, current)) {
    return true;
  }

  const previous = readWebhookSecret("TELEGRAM_WEBHOOK_SECRET_PREVIOUS");
  if (previous && timingSafeEqualUtf8(incoming, previous)) {
    return true;
  }

  return false;
}

export function rejectUnauthorizedTelegramWebhook(
  request: Request
): NextResponse | null {
  if (isTelegramWebhookAuthorized(request)) {
    return null;
  }

  return NextResponse.json({ ok: false }, { status: 401 });
}
