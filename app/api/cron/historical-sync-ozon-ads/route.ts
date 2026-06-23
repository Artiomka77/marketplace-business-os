import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const maxDuration = 10;

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Неизвестная ошибка";
}

export async function GET() {
  try {
    const marked = await prisma.historicalSyncJob.updateMany({
      where: {
        marketplace: "OZON",
        dataType: "ADS",
        status: {
          in: ["PENDING", "RUNNING", "ERROR", "RATE_LIMITED"],
        },
      },
      data: {
        status: "SUCCESS",
        finishedAt: new Date(),
        lastAttemptAt: new Date(),
        lastError:
          "Ozon Performance Ads отключён для ежедневного отчёта: рекламные расходы Ozon берём из Ozon Finance, чтобы не получать Vercel timeout.",
        cursorDate: null,
        cursorOffset: null,
      },
    });

    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: "OZON_PERFORMANCE_ADS_DISABLED_FOR_DAILY_REPORT",
      message:
        "Ozon Performance Ads не запускается в serverless-функции, потому что часто превышает лимит Vercel. Для ежедневного отчёта рекламные расходы Ozon берутся из Ozon Finance.",
      markedJobsSuccess: marked.count,
      executedAt: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: getErrorMessage(error),
        executedAt: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}
