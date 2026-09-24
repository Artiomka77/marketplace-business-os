import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

function readDailyReportSecret(): string {
  return String(process.env.TELEGRAM_DAILY_REPORT_SECRET ?? "").trim();
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

export function rejectUnauthorizedDailyReport(
  request: Request
): NextResponse | null {
  const secret = readDailyReportSecret();
  const isProduction = process.env.NODE_ENV === "production";

  if (!secret) {
    if (isProduction) {
      return NextResponse.json(
        { ok: false, error: "Daily report is not configured" },
        { status: 503 }
      );
    }

    return null;
  }

  const header = request.headers.get("authorization");
  const bearer = header?.startsWith("Bearer ")
    ? header.slice("Bearer ".length)
    : "";

  if (!timingSafeEqualUtf8(bearer, secret)) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  return null;
}
