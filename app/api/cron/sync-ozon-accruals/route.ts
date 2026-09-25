import { NextRequest, NextResponse } from "next/server";
import { rejectUnauthorizedCron } from "@/lib/security/cronAuth";

import { prisma } from "@/lib/prisma";
import { syncOzonFinance } from "@/lib/ozon/syncOzon";
import {
  aggregateOzonAccrualRouteResults,
  classifyOzonByDayRouteOutcome,
  resolveOzonAccrualSyncWindow,
} from "@/lib/ozon/ozonAccrualSyncWindow";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const EXPECTED_COMPANIES = ["ИП Петров", "ИП Лебедева"] as const;

export async function GET(request: NextRequest) {
  const cronDenied = rejectUnauthorizedCron(request);
  if (cronDenied) return cronDenied;
  const url = new URL(request.url);
  const { dateFromText, dateToText, dateFrom, dateTo, mode } =
    resolveOzonAccrualSyncWindow({
      exactDate: url.searchParams.get("date"),
    });
  const connections = await prisma.marketplaceApiConnection.findMany({
    where: {
      marketplace: "OZON",
      isEnabled: true,
      company: { isActive: true },
    },
    select: {
      companyId: true,
      company: { select: { name: true } },
    },
    orderBy: { companyId: "asc" },
  });

  const actualCompanies = connections.map((item) => item.company.name).sort();
  const expectedCompanies = [...EXPECTED_COMPANIES].sort();
  if (JSON.stringify(actualCompanies) !== JSON.stringify(expectedCompanies)) {
    return NextResponse.json(
      {
        ok: false,
        error: "Expected exactly both active Ozon companies",
        expectedCompanies,
        actualCompanies,
      },
      { status: 500 },
    );
  }

  const results: Array<Record<string, unknown>> = [];

  for (const connection of connections) {
    try {
      const result = await syncOzonFinance(connection.companyId, {
        dateFrom,
        dateTo,
      });
      const accrualByDay = result.accrualByDay;
      if (!accrualByDay || "skipped" in accrualByDay) {
        throw new Error(
          `Ozon /by-day did not execute: ${String(accrualByDay?.reason ?? "missing result")}`,
        );
      }

      const classified = classifyOzonByDayRouteOutcome({
        executionOk: result.byDayCanonicalStep?.status === "EXECUTION_SUCCESS",
        ingestStatus: accrualByDay.ingestStatus,
        coverageComplete: accrualByDay.coverageComplete,
        windowPartial: accrualByDay.windowPartial,
        pendingDays: accrualByDay.pendingDays,
        failFinality: accrualByDay.failFinality,
      });
      const legacyObsolete =
        result.legacyFinanceStep?.status === "OBSOLETE_METHOD";

      results.push({
        companyName: connection.company.name,
        ok: classified.ok,
        executionOk: classified.executionOk,
        sourceReadiness: classified.sourceReadiness,
        rows: result.rows,
        accrualRows: accrualByDay.accrualRows,
        coverageComplete: accrualByDay.coverageComplete,
        ingestStatus: accrualByDay.ingestStatus,
        windowPartial: accrualByDay.windowPartial,
        persistedDays: accrualByDay.persistedDays,
        pendingDays: accrualByDay.pendingDays,
        requeuedSnapshots: accrualByDay.snapshotInvalidation.requeuedJobs,
        legacyFinanceStep: result.legacyFinanceStep ?? null,
        byDayCanonicalStep: result.byDayCanonicalStep ?? null,
        note: legacyObsolete
          ? "LEGACY_FINANCE_OBSOLETE_BYDAY_CONTINUED"
          : null,
      });
    } catch (error) {
      results.push({
        companyName: connection.company.name,
        ok: false,
        executionOk: false,
        sourceReadiness: "FAILED",
        error: String(error instanceof Error ? error.message : error).slice(0, 1000),
      });
    }
  }

  const summary = aggregateOzonAccrualRouteResults(
    results as Array<{
      companyName: string;
      ok: boolean;
      executionOk?: boolean;
      sourceReadiness?: "READY" | "PRELIMINARY" | "PENDING" | "FAILED";
      coverageComplete?: boolean;
      ingestStatus?: string;
      windowPartial?: boolean;
      persistedDays?: string[];
      pendingDays?: string[];
      error?: string;
    }>,
  );

  return NextResponse.json(
    {
      ok: summary.ok,
      partial: summary.partial,
      attemptedOk: summary.attemptedOk,
      purpose: "Ozon accrual /by-day automatic sync for the rolling 3 completed Moscow days",
      batchOkMeaning:
        "ok=true only when every company executionOk and sourceReadiness=READY; FAILED never masquerades as ok",
      windowMode: mode,
      dateFrom: dateFromText,
      dateTo: dateToText,
      companies: connections.length,
      results,
      executedAt: new Date().toISOString(),
    },
    { status: summary.httpStatus },
  );
}
