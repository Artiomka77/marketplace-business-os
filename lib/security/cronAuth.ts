import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

function readCronSecret(): string {
  return String(process.env.CRON_SECRET ?? "").trim();
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

export function isCronAuthorized(request: Request): boolean {
  const secret = readCronSecret();
  if (!secret) {
    return false;
  }

  const header = request.headers.get("authorization");
  if (!header || !header.startsWith("Bearer ")) {
    return false;
  }

  return timingSafeEqualUtf8(header.slice("Bearer ".length), secret);
}

export function rejectUnauthorizedCron(request: Request): NextResponse | null {
  if (isCronAuthorized(request)) {
    return null;
  }

  return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
}

export function cronAuthorizationHeader(): { Authorization: string } | Record<string, never> {
  const secret = readCronSecret();
  if (!secret) {
    return {};
  }

  return { Authorization: `Bearer ${secret}` };
}
