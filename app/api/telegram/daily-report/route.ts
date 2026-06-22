import { NextResponse } from "next/server";

import {
  buildDailyReport,
  formatDailyReportForTelegram,
} from "@/lib/telegram/dailyReport";
import {
  getTelegramAllowedChatIds,
  sendTelegramMessage,
} from "@/lib/telegram/sendTelegramMessage";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function isRequestAllowed(req: Request) {
  const secret = process.env.TELEGRAM_DAILY_REPORT_SECRET ?? "";

  if (!secret) return true;

  const url = new URL(req.url);
  const querySecret = url.searchParams.get("secret");
  const authHeader = req.headers.get("authorization");
  const bearer = authHeader?.startsWith("Bearer ")
    ? authHeader.replace("Bearer ", "")
    : null;

  return querySecret === secret || bearer === secret;
}

export async function GET(req: Request) {
  if (!isRequestAllowed(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const date = url.searchParams.get("date") ?? undefined;
  const from = url.searchParams.get("from") ?? undefined;
  const to = url.searchParams.get("to") ?? undefined;
  const preset = url.searchParams.get("period") ?? url.searchParams.get("preset") ?? undefined;
  const shouldSend = url.searchParams.get("send") !== "false";

  const allowedPresets = [
    "yesterday",
    "day_before_yesterday",
    "3d",
    "current_week",
    "7d",
    "15d",
    "month",
    "3m",
    "6m",
    "year",
    // Старые значения оставляем для обратной совместимости ссылок и команд.
    "30d",
    "90d",
    "365d",
  ] as const;

  const report = await buildDailyReport({
    date,
    from,
    to,
    preset: allowedPresets.includes(preset as any)
      ? (preset as (typeof allowedPresets)[number])
      : undefined,
  });
  const message = formatDailyReportForTelegram(report);

  if (!shouldSend) {
    return NextResponse.json({
      ok: true,
      sent: false,
      date: report.dateLabel,
      message,
      report,
    });
  }

  const chatIds = getTelegramAllowedChatIds();

  if (chatIds.length === 0) {
    return NextResponse.json(
      {
        ok: false,
        error: "TELEGRAM_ALLOWED_CHAT_IDS is empty",
        date: report.dateLabel,
        message,
      },
      { status: 400 }
    );
  }

  for (const chatId of chatIds) {
    await sendTelegramMessage({
      chatId,
      text: message,
    });
  }

  return NextResponse.json({
    ok: true,
    sent: true,
    recipients: chatIds.length,
    date: report.dateLabel,
  });
}
