import { NextResponse } from "next/server";
import { rejectUnauthorizedCron } from "@/lib/security/cronAuth";
import { prisma } from "@/lib/prisma";
import { lastClosedMondaySundayWeek } from "@/lib/wb/closedWeekFinalizer";
import { ensureClosedWeekProfitJobMatrix } from "@/lib/profitReadModel/ensureClosedWeekProfitJobMatrix";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const denied = rejectUnauthorizedCron(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const closed = lastClosedMondaySundayWeek();
  const dateFrom = url.searchParams.get("dateFrom") ?? closed.dateFrom;
  const dateTo = url.searchParams.get("dateTo") ?? closed.dateTo;
  if (!dateFrom || !dateTo) {
    return NextResponse.json(
      { ok: false, error: "dateFrom and dateTo are required" },
      { status: 400 },
    );
  }

  const profitJobMatrix = await ensureClosedWeekProfitJobMatrix({
    prisma,
    dateFrom,
    dateTo,
    priority: 40,
  });
  return NextResponse.json({ ok: true, dateFrom, dateTo, profitJobMatrix });
}
