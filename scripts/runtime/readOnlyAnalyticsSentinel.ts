/**
 * READ-ONLY analytics sentinel. Source only — not scheduled.
 *
 * Modes: db | canonical | all
 * Exit 0 = healthy
 * Exit 2 = transient DB unavailable
 * Exit 3 = non-transient canonical/application failure
 */

import { getDashboardDailyAnalytics } from "@/lib/analytics/dashboardDailyAnalytics";
import { loadCanonicalAnalyticsForUi } from "@/lib/analytics/loadCanonicalAnalyticsForUi";
import { getProfitAnalytics } from "@/lib/analytics/profitAnalytics";
import { getProfitAnalyticsOzon } from "@/lib/analytics/profitAnalyticsOzon";
import { getDefaultLastCompletedWeekRange } from "@/lib/date/defaultPeriod";
import {
  classifyDatabaseError,
  isTransientDatabaseError,
} from "@/lib/db/transientDatabaseError";
import { getSafePrismaPoolSnapshot, prisma } from "@/lib/prisma";

type SentinelMode = "db" | "canonical" | "all";

type SurfaceResult = {
  surface: "dashboard" | "profit-wb" | "profit-ozon" | "db";
  status: "OK" | "UNAVAILABLE" | "ERROR";
  safeCode?: string;
};

function parseMode(argv: string[]): SentinelMode {
  const raw = argv.find((arg) => arg.startsWith("--mode="))?.slice("--mode=".length);
  if (raw === "db" || raw === "canonical" || raw === "all") return raw;
  if (argv.includes("db")) return "db";
  if (argv.includes("canonical")) return "canonical";
  return "all";
}

function parsePeriod(argv: string[]): { dateFrom: string; dateTo: string } {
  const from = argv.find((arg) => arg.startsWith("--dateFrom="))?.slice("--dateFrom=".length);
  const to = argv.find((arg) => arg.startsWith("--dateTo="))?.slice("--dateTo=".length);
  if (from && to) return { dateFrom: from, dateTo: to };
  return getDefaultLastCompletedWeekRange();
}

async function probeDb(): Promise<SurfaceResult> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { surface: "db", status: "OK" };
  } catch (error) {
    if (isTransientDatabaseError(error)) {
      const classification = classifyDatabaseError(error, {
        consumedFullConnectBudget: true,
      });
      return {
        surface: "db",
        status: "UNAVAILABLE",
        safeCode:
          classification.kind === "transient_database"
            ? classification.safeCode
            : "NON_TRANSIENT",
      };
    }
    throw error;
  }
}

async function probeCanonical(
  period: { dateFrom: string; dateTo: string },
): Promise<SurfaceResult[]> {
  const companyName = "ALL";
  const results: SurfaceResult[] = [];

  const dashboard = await loadCanonicalAnalyticsForUi({
    surface: "dashboard",
    log: false,
    executeRead: () =>
      getDashboardDailyAnalytics({
        dateFrom: period.dateFrom,
        dateTo: period.dateTo,
        companyName,
      }),
  });
  results.push({
    surface: "dashboard",
    status: dashboard.status,
    safeCode:
      dashboard.status === "UNAVAILABLE" ? dashboard.reason.safeCode : undefined,
  });

  const wb = await loadCanonicalAnalyticsForUi({
    surface: "profit-wb",
    log: false,
    executeRead: () =>
      getProfitAnalytics({
        dateFrom: period.dateFrom,
        dateTo: period.dateTo,
        companyName,
      }),
  });
  results.push({
    surface: "profit-wb",
    status: wb.status,
    safeCode: wb.status === "UNAVAILABLE" ? wb.reason.safeCode : undefined,
  });

  const ozon = await loadCanonicalAnalyticsForUi({
    surface: "profit-ozon",
    log: false,
    executeRead: () =>
      getProfitAnalyticsOzon({
        dateFrom: period.dateFrom,
        dateTo: period.dateTo,
        companyName,
      }),
  });
  results.push({
    surface: "profit-ozon",
    status: ozon.status,
    safeCode: ozon.status === "UNAVAILABLE" ? ozon.reason.safeCode : undefined,
  });

  return results;
}

async function main() {
  const mode = parseMode(process.argv.slice(2));
  const period = parsePeriod(process.argv.slice(2));
  const surfaces: SurfaceResult[] = [];

  try {
    if (mode === "db" || mode === "all") {
      surfaces.push(await probeDb());
    }
    if (mode === "canonical" || mode === "all") {
      surfaces.push(...(await probeCanonical(period)));
    }
  } catch (error) {
    const classification = classifyDatabaseError(error);
    const summary = {
      event: "read_only_analytics_sentinel",
      mode,
      period,
      status: "ERROR",
      exitCode: 3,
      pool: getSafePrismaPoolSnapshot(),
      safeCode: classification.safeCode,
      surfaces,
    };
    console.log(JSON.stringify(summary));
    process.exit(3);
  }

  const unavailable = surfaces.some((row) => row.status === "UNAVAILABLE");
  const failed = surfaces.some((row) => row.status === "ERROR");
  const exitCode = failed ? 3 : unavailable ? 2 : 0;
  const summary = {
    event: "read_only_analytics_sentinel",
    mode,
    period,
    status: failed ? "ERROR" : unavailable ? "UNAVAILABLE" : "OK",
    exitCode,
    pool: getSafePrismaPoolSnapshot(),
    surfaces,
  };
  console.log(JSON.stringify(summary));
  process.exit(exitCode);
}

main().catch((error) => {
  const classification = classifyDatabaseError(error);
  console.log(
    JSON.stringify({
      event: "read_only_analytics_sentinel",
      status: "ERROR",
      exitCode: classification.transient ? 2 : 3,
      pool: getSafePrismaPoolSnapshot(),
      safeCode: classification.safeCode,
    }),
  );
  process.exit(classification.transient ? 2 : 3);
});
