import { NextResponse } from "next/server";
import { rejectUnauthorizedCron } from "@/lib/security/cronAuth";
import { prisma } from "@/lib/prisma";
import {
  lastClosedMondaySundayWeek,
  planWbClosedWeekFinalize,
} from "@/lib/wb/closedWeekFinalizer";
import {
  extractReportIds,
  wbFinanceRequest,
  WB_FINANCE_REPORTS_LIST_URL,
  buildFinanceReportsListBody,
  WbFinanceScopeError,
} from "@/lib/wb/wbFinanceApi";
import {
  syncWbFinanceMissingReports,
  syncWbSalesByReportNumber,
} from "@/lib/wb/syncWb";
import { ensureClosedWeekProfitJobMatrix } from "@/lib/profitReadModel/ensureClosedWeekProfitJobMatrix";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function isoDay(date: Date) {
  return date.toISOString().slice(0, 10);
}

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

  const connections = await prisma.marketplaceApiConnection.findMany({
    where: { marketplace: "WB", isEnabled: true, wbToken: { not: null } },
    select: { companyId: true, wbToken: true, company: { select: { name: true } } },
  });

  const results = [];
  for (const connection of connections) {
    if (!connection.wbToken) continue;
    try {
      const listed = await wbFinanceRequest({
        url: WB_FINANCE_REPORTS_LIST_URL,
        token: connection.wbToken,
        body: buildFinanceReportsListBody({ dateFrom, dateTo, period: "weekly" }),
      });
      const reportIds = extractReportIds(listed.body);
      const persistedRows = await prisma.wbSale.findMany({
        where: {
          companyName: connection.company.name,
          reportNumber: { in: reportIds },
        },
        select: { reportNumber: true },
      });
      const plan = planWbClosedWeekFinalize({
        dateFrom,
        dateTo,
        listedReports: reportIds.map((reportId) => ({ reportId })),
        persistedReportIds: persistedRows
          .map((row) => String(row.reportNumber ?? ""))
          .filter(Boolean),
      });

      if (!listed.ok && listed.status !== 204) {
        results.push({
          companyId: connection.companyId,
          ok: false,
          plan,
          error: `WB Finance list HTTP ${listed.status}`,
        });
        continue;
      }

      await syncWbFinanceMissingReports(connection.companyId, {
        dateFrom: new Date(`${dateFrom}T00:00:00.000Z`),
        dateTo: new Date(`${dateTo}T00:00:00.000Z`),
      });

      for (const reportId of plan.idsToFetch) {
        await syncWbSalesByReportNumber(connection.companyId, reportId, {
          dateFrom: new Date(`${dateFrom}T00:00:00.000Z`),
          dateTo: new Date(`${dateTo}T00:00:00.000Z`),
        });
      }

      results.push({
        companyId: connection.companyId,
        companyName: connection.company.name,
        ok: true,
        plan,
        fetched: plan.idsToFetch,
        asOf: isoDay(new Date()),
      });
    } catch (error) {
      const scopeDenied = error instanceof WbFinanceScopeError;
      results.push({
        companyId: connection.companyId,
        ok: false,
        scopeDenied,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let profitJobMatrix: Awaited<
    ReturnType<typeof ensureClosedWeekProfitJobMatrix>
  > | null = null;
  let profitJobMatrixError: string | null = null;
  try {
    profitJobMatrix = await ensureClosedWeekProfitJobMatrix({
      prisma,
      dateFrom,
      dateTo,
      priority: 40,
    });
  } catch (error) {
    profitJobMatrixError =
      error instanceof Error ? error.message : String(error);
  }

  return NextResponse.json({
    ok: results.every((row) => row.ok) && !profitJobMatrixError,
    source: "WB_FINANCE_API",
    manualFilesRequired: false,
    dateFrom,
    dateTo,
    results,
    profitJobMatrix,
    profitJobMatrixError,
  });
}

