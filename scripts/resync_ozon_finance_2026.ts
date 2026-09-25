import { prisma } from "../lib/prisma";
import { syncOzonFinance } from "../lib/ozon/syncOzon";

type OzonConnectionRow = {
  companyId: string;
  marketplace: string;
  isEnabled: boolean;
  ozonClientId: string | null;
  ozonApiKey: string | null;
  company: {
    id: string;
    name: string;
  };
};

type Period = {
  dateFrom: Date;
  dateTo: Date;
  dateFromText: string;
  dateToText: string;
};

type CategorySummaryRow = {
  companyName: string | null;
  category: string | null;
  rowsCount: bigint | number;
  amount: unknown;
};

type FinanceSummaryRow = {
  companyName: string | null;
  rowsCount: bigint | number;
  minDate: Date | null;
  maxDate: Date | null;
};

function envText(name: string, fallback = "") {
  return String(process.env[name] ?? fallback).trim();
}

function envBoolean(name: string, fallback = false) {
  const value = envText(name).toLowerCase();
  if (!value) return fallback;
  return ["1", "true", "yes", "y", "да"].includes(value);
}

function envNumber(name: string, fallback: number) {
  const value = Number(envText(name));
  return Number.isFinite(value) ? value : fallback;
}

function parseDateOnlyUtc(value: string, label: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} must be YYYY-MM-DD, got: ${value}`);
  }

  const [yearText, monthText, dayText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`${label} contains invalid date: ${value}`);
  }

  return date;
}

function todayUtcDateOnly() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function formatDateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

function firstDayOfNextMonth(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
}

function lastDayOfMonth(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
}

function minDate(left: Date, right: Date) {
  return left.getTime() <= right.getTime() ? new Date(left) : new Date(right);
}

function splitByCalendarMonth(dateFrom: Date, dateTo: Date): Period[] {
  const periods: Period[] = [];
  let cursor = new Date(dateFrom);

  while (cursor.getTime() <= dateTo.getTime()) {
    const periodTo = minDate(lastDayOfMonth(cursor), dateTo);

    periods.push({
      dateFrom: new Date(cursor),
      dateTo: new Date(periodTo),
      dateFromText: formatDateOnly(cursor),
      dateToText: formatDateOnly(periodTo),
    });

    cursor = firstDayOfNextMonth(cursor);
  }

  return periods;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseCompanyNames() {
  const value = envText("COMPANY_NAMES", "ИП Петров,ИП Лебедева");
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeAmount(value: unknown) {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (value && typeof value === "object" && "toNumber" in value) {
    return (value as { toNumber: () => number }).toNumber();
  }

  const number = Number(String(value ?? "0").replace(",", "."));
  return Number.isFinite(number) ? number : 0;
}

function formatRub(value: unknown) {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 2,
  }).format(normalizeAmount(value));
}

function formatCount(value: bigint | number) {
  return Number(value).toLocaleString("ru-RU");
}

async function getOzonConnections(companyNames: string[]) {
  return prisma.marketplaceApiConnection.findMany({
    where: {
      marketplace: "OZON",
      isEnabled: true,
      ozonClientId: { not: null },
      ozonApiKey: { not: null },
      company: {
        isActive: true,
        name: { in: companyNames },
      },
    },
    select: {
      companyId: true,
      marketplace: true,
      isEnabled: true,
      ozonClientId: true,
      ozonApiKey: true,
      company: {
        select: {
          id: true,
          name: true,
        },
      },
    },
    orderBy: [{ companyId: "asc" }],
  }) as Promise<OzonConnectionRow[]>;
}

async function printFinanceSummary(dateFrom: Date, dateTo: Date, companyNames: string[]) {
  const rows = await prisma.$queryRaw<FinanceSummaryRow[]>`
    SELECT
      "companyName",
      COUNT(*) AS "rowsCount",
      MIN("accrualDate") AS "minDate",
      MAX("accrualDate") AS "maxDate"
    FROM "OzonFinance"
    WHERE "companyName" = ANY(${companyNames})
      AND "accrualDate" >= ${dateFrom}
      AND "accrualDate" < ${new Date(dateTo.getTime() + 24 * 60 * 60 * 1000)}
    GROUP BY "companyName"
    ORDER BY "companyName"
  `;

  console.log("\nOzonFinance summary:");
  if (rows.length === 0) {
    console.log("  no rows");
    return;
  }

  for (const row of rows) {
    console.log(
      `  ${row.companyName}: rows=${formatCount(row.rowsCount)}, min=${row.minDate ? formatDateOnly(row.minDate) : "-"}, max=${row.maxDate ? formatDateOnly(row.maxDate) : "-"}`
    );
  }
}

async function printCategorySummary(dateFrom: Date, dateTo: Date, companyNames: string[]) {
  const rows = await prisma.$queryRaw<CategorySummaryRow[]>`
    SELECT
      "companyName",
      "category",
      COUNT(*) AS "rowsCount",
      COALESCE(SUM("amount"), 0) AS "amount"
    FROM "OzonFinancialCategoryFact"
    WHERE "companyName" = ANY(${companyNames})
      AND "operationDate" >= ${dateFrom}
      AND "operationDate" < ${new Date(dateTo.getTime() + 24 * 60 * 60 * 1000)}
    GROUP BY "companyName", "category"
    ORDER BY "companyName", "category"
  `;

  console.log("\nOzonFinancialCategoryFact summary:");
  if (rows.length === 0) {
    console.log("  no rows");
    return;
  }

  for (const row of rows) {
    console.log(
      `  ${row.companyName} | ${row.category}: rows=${formatCount(row.rowsCount)}, amount=${formatRub(row.amount)}`
    );
  }

  const excludedRows = rows.filter((row) => String(row.category ?? "").startsWith("EXCLUDED_"));
  console.log("\nExcluded from profit summary:");
  if (excludedRows.length === 0) {
    console.log("  no EXCLUDED_* rows found");
    return;
  }

  for (const row of excludedRows) {
    console.log(
      `  ${row.companyName} | ${row.category}: rows=${formatCount(row.rowsCount)}, amount=${formatRub(row.amount)}`
    );
  }
}

async function main() {
  const dryRun = envBoolean("DRY_RUN", true);
  const continueOnError = envBoolean("CONTINUE_ON_ERROR", false);
  const sleepMs = envNumber("RESYNC_SLEEP_MS", 1500);
  const companyNames = parseCompanyNames();

  const dateFrom = parseDateOnlyUtc(envText("RESYNC_DATE_FROM", "2026-01-01"), "RESYNC_DATE_FROM");
  const dateTo = process.env.RESYNC_DATE_TO
    ? parseDateOnlyUtc(envText("RESYNC_DATE_TO"), "RESYNC_DATE_TO")
    : todayUtcDateOnly();

  if (dateFrom.getTime() > dateTo.getTime()) {
    throw new Error(`RESYNC_DATE_FROM is later than RESYNC_DATE_TO: ${formatDateOnly(dateFrom)} > ${formatDateOnly(dateTo)}`);
  }

  const periods = splitByCalendarMonth(dateFrom, dateTo);
  const connections = await getOzonConnections(companyNames);

  console.log("Ozon Finance resync 2026");
  console.log(`DRY_RUN=${dryRun}`);
  console.log(`CONTINUE_ON_ERROR=${continueOnError}`);
  console.log(`Period: ${formatDateOnly(dateFrom)} — ${formatDateOnly(dateTo)}`);
  console.log(`Companies requested: ${companyNames.join(", ")}`);
  console.log(`Connections found: ${connections.length}`);

  for (const connection of connections) {
    console.log(`  - ${connection.company.name}: companyId=${connection.companyId}`);
  }

  if (connections.length === 0) {
    throw new Error("No active Ozon connections found for requested companies");
  }

  console.log("\nMonthly periods:");
  for (const period of periods) {
    console.log(`  - ${period.dateFromText} — ${period.dateToText}`);
  }

  await printFinanceSummary(dateFrom, dateTo, companyNames);
  await printCategorySummary(dateFrom, dateTo, companyNames);

  if (dryRun) {
    console.log("\nDRY_RUN=true, no data was changed.");
    return;
  }

  console.log("\nStarting real resync...");

  for (const connection of connections) {
    console.log(`\n=== ${connection.company.name} ===`);

    for (const period of periods) {
      console.log(`\nSync Ozon Finance: ${connection.company.name} ${period.dateFromText} — ${period.dateToText}`);

      try {
        const result = await syncOzonFinance(connection.companyId, {
          dateFrom: period.dateFrom,
          dateTo: period.dateTo,
        });

        console.log(
          `OK: rows=${result.rows}, period=${result.dateFrom} — ${result.dateTo}`
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`FAILED: ${connection.company.name} ${period.dateFromText} — ${period.dateToText}`);
        console.error(message);

        if (!continueOnError) {
          throw error;
        }
      }

      if (sleepMs > 0) {
        await sleep(sleepMs);
      }
    }
  }

  console.log("\nReal resync finished. Final summaries:");
  await printFinanceSummary(dateFrom, dateTo, companyNames);
  await printCategorySummary(dateFrom, dateTo, companyNames);
}

main()
  .catch((error) => {
    console.error("OZON_FINANCE_RESYNC_2026_FAILED");
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
