import { prisma } from "@/lib/prisma";

type MarketplaceCode = "WB" | "OZON";
type HistoricalDataType = "FINANCE" | "SALES" | "ADS" | "PRODUCTS";
type MarketplaceFilter = "WB" | "OZON" | "ALL";

type DatePeriod = {
  dateFrom: Date;
  dateTo: Date;
};

type CreateHistoricalSyncJobsOptions = {
  dateFromText?: string;
  dateToText?: string;
  companyId?: string | null;
  marketplace?: MarketplaceFilter;
};

type ConnectionRow = {
  companyId: string;
  marketplace: string;
  wbToken: string | null;
  ozonClientId: string | null;
  ozonApiKey: string | null;
  ozonPerformanceClientId: string | null;
  ozonPerformanceClientSecret: string | null;
  company: {
    id: string;
    name: string;
  };
};

const DEFAULT_HISTORICAL_START_DATE = "2025-01-01";
const DEFAULT_WB_ADS_HISTORICAL_START_DATE = "2025-01-01";
const COMPANY_WB_ADS_HISTORICAL_START_DATES: Record<string, string> = {
  "ИП Лебедева": "2025-03-01",
};

function parseDateOnly(value: string, label: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} должен быть в формате YYYY-MM-DD`);
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
    throw new Error(`${label} содержит некорректную дату`);
  }

  return date;
}

function getTodayUtcDateOnly() {
  const now = new Date();

  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
}

function formatDateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number) {
  const nextDate = new Date(date);
  nextDate.setUTCDate(nextDate.getUTCDate() + days);
  return nextDate;
}

function maxDate(left: Date, right: Date) {
  return left.getTime() >= right.getTime() ? new Date(left) : new Date(right);
}

function splitDateRange(dateFrom: Date, dateTo: Date, chunkDays: number) {
  const periods: DatePeriod[] = [];
  let cursor = new Date(dateFrom);

  while (cursor.getTime() <= dateTo.getTime()) {
    const chunkEndCandidate = addDays(cursor, chunkDays - 1);
    const chunkEnd =
      chunkEndCandidate.getTime() > dateTo.getTime()
        ? new Date(dateTo)
        : chunkEndCandidate;

    periods.push({
      dateFrom: new Date(cursor),
      dateTo: new Date(chunkEnd),
    });

    cursor = addDays(chunkEnd, 1);
  }

  return periods;
}

function getLastDayOfMonth(date: Date) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)
  );
}

function getFirstDayOfNextMonth(date: Date) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)
  );
}

function splitDateRangeByCalendarMonth(dateFrom: Date, dateTo: Date) {
  const periods: DatePeriod[] = [];
  let cursor = new Date(dateFrom);

  while (cursor.getTime() <= dateTo.getTime()) {
    const monthEndCandidate = getLastDayOfMonth(cursor);
    const chunkEnd =
      monthEndCandidate.getTime() > dateTo.getTime()
        ? new Date(dateTo)
        : monthEndCandidate;

    periods.push({
      dateFrom: new Date(cursor),
      dateTo: new Date(chunkEnd),
    });

    cursor = getFirstDayOfNextMonth(cursor);
  }

  return periods;
}

function getWbAdsHistoricalStartDateText(companyName: string) {
  return (
    COMPANY_WB_ADS_HISTORICAL_START_DATES[companyName] ??
    DEFAULT_WB_ADS_HISTORICAL_START_DATE
  );
}

function getWbAdsHistoricalPeriods(
  companyName: string,
  dateFrom: Date,
  dateTo: Date
) {
  const minAvailableDateText = getWbAdsHistoricalStartDateText(companyName);
  const minAvailableDate = parseDateOnly(
    minAvailableDateText,
    "WB_ADS_HISTORICAL_START_DATE"
  );

  const effectiveDateFrom = maxDate(dateFrom, minAvailableDate);

  if (effectiveDateFrom.getTime() > dateTo.getTime()) {
    return [];
  }

  return splitDateRange(effectiveDateFrom, dateTo, 7);
}

function getPlanForConnection(
  connection: ConnectionRow,
  dateFrom: Date,
  dateTo: Date
) {
  const marketplace = connection.marketplace as MarketplaceCode;

  if (marketplace === "OZON") {
    const ozonMonthlyPeriods = splitDateRangeByCalendarMonth(dateFrom, dateTo);

    const plan: { dataType: HistoricalDataType; periods: DatePeriod[] }[] = [
      {
        dataType: "FINANCE",
        periods: ozonMonthlyPeriods,
      },
      {
        dataType: "PRODUCTS",
        periods: [{ dateFrom, dateTo }],
      },
    ];

    if (
      connection.ozonPerformanceClientId &&
      connection.ozonPerformanceClientSecret
    ) {
      plan.push({
        dataType: "ADS",
        periods: ozonMonthlyPeriods,
      });
    }

    return plan;
  }

  if (marketplace === "WB") {
    return [
      {
        dataType: "FINANCE" as HistoricalDataType,
        periods: splitDateRange(dateFrom, dateTo, 30),
      },
      {
        dataType: "ADS" as HistoricalDataType,
        periods: getWbAdsHistoricalPeriods(
          connection.company.name,
          dateFrom,
          dateTo
        ),
      },
    ];
  }

  return [];
}

function getMarketplaceWhere(marketplace: MarketplaceFilter) {
  if (marketplace === "OZON") {
    return [
      {
        marketplace: "OZON",
        ozonClientId: {
          not: null,
        },
        ozonApiKey: {
          not: null,
        },
      },
    ];
  }

  if (marketplace === "WB") {
    return [
      {
        marketplace: "WB",
        wbToken: {
          not: null,
        },
      },
    ];
  }

  return [
    {
      marketplace: "WB",
      wbToken: {
        not: null,
      },
    },
    {
      marketplace: "OZON",
      ozonClientId: {
        not: null,
      },
      ozonApiKey: {
        not: null,
      },
    },
  ];
}

async function findExistingJob(params: {
  companyId: string;
  companyName: string;
  marketplace: string;
  dataType: string;
  dateFrom: Date;
  dateTo: Date;
}) {
  return prisma.historicalSyncJob.findFirst({
    where: {
      companyId: params.companyId,
      companyName: params.companyName,
      marketplace: params.marketplace,
      dataType: params.dataType,
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
    },
    select: {
      id: true,
      status: true,
    },
  });
}

async function createJobIfMissing(params: {
  companyId: string;
  companyName: string;
  marketplace: string;
  dataType: HistoricalDataType;
  dateFrom: Date;
  dateTo: Date;
}) {
  const existingJob = await findExistingJob(params);

  if (existingJob) {
    return {
      created: false,
      jobId: existingJob.id,
      status: existingJob.status,
    };
  }

  const job = await prisma.historicalSyncJob.create({
    data: {
      companyId: params.companyId,
      companyName: params.companyName,
      marketplace: params.marketplace,
      dataType: params.dataType,
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      cursorDate: params.dateFrom,
      status: "PENDING",
      totalSteps: 1,
      completedSteps: 0,
    },
    select: {
      id: true,
      status: true,
    },
  });

  return {
    created: true,
    jobId: job.id,
    status: job.status,
  };
}

export async function createHistoricalSyncJobs(
  options: CreateHistoricalSyncJobsOptions = {}
) {
  const marketplace = options.marketplace ?? "ALL";

  const dateFrom = parseDateOnly(
    options.dateFromText ?? DEFAULT_HISTORICAL_START_DATE,
    "dateFrom"
  );

  const dateTo = options.dateToText
    ? parseDateOnly(options.dateToText, "dateTo")
    : getTodayUtcDateOnly();

  if (dateFrom.getTime() > dateTo.getTime()) {
    throw new Error("dateFrom не может быть позже dateTo");
  }

  const connections = await prisma.marketplaceApiConnection.findMany({
    where: {
      isEnabled: true,
      ...(options.companyId ? { companyId: options.companyId } : {}),
      company: {
        isActive: true,
      },
      OR: getMarketplaceWhere(marketplace),
    },
    select: {
      companyId: true,
      marketplace: true,
      wbToken: true,
      ozonClientId: true,
      ozonApiKey: true,
      ozonPerformanceClientId: true,
      ozonPerformanceClientSecret: true,
      company: {
        select: {
          id: true,
          name: true,
        },
      },
    },
    orderBy: [{ marketplace: "asc" }, { companyId: "asc" }],
  });

  let createdJobs = 0;
  let skippedExistingJobs = 0;

  const summaries = [];

  for (const connection of connections) {
    const plan = getPlanForConnection(connection, dateFrom, dateTo);

    const summary = {
      companyId: connection.companyId,
      companyName: connection.company.name,
      marketplace: connection.marketplace,
      plannedJobs: 0,
      createdJobs: 0,
      skippedExistingJobs: 0,
      dataTypes: [] as {
        dataType: HistoricalDataType;
        plannedPeriods: number;
        createdJobs: number;
        skippedExistingJobs: number;
      }[],
    };

    for (const planItem of plan) {
      const dataTypeSummary = {
        dataType: planItem.dataType,
        plannedPeriods: planItem.periods.length,
        createdJobs: 0,
        skippedExistingJobs: 0,
      };

      for (const period of planItem.periods) {
        const result = await createJobIfMissing({
          companyId: connection.companyId,
          companyName: connection.company.name,
          marketplace: connection.marketplace,
          dataType: planItem.dataType,
          dateFrom: period.dateFrom,
          dateTo: period.dateTo,
        });

        summary.plannedJobs += 1;

        if (result.created) {
          createdJobs += 1;
          summary.createdJobs += 1;
          dataTypeSummary.createdJobs += 1;
        } else {
          skippedExistingJobs += 1;
          summary.skippedExistingJobs += 1;
          dataTypeSummary.skippedExistingJobs += 1;
        }
      }

      summary.dataTypes.push(dataTypeSummary);
    }

    summaries.push(summary);
  }

  return {
    dateFrom: formatDateOnly(dateFrom),
    dateTo: formatDateOnly(dateTo),
    marketplace,
    connections: connections.length,
    createdJobs,
    skippedExistingJobs,
    summaries,
    rules: {
      defaultWbAdsHistoricalStartDate: DEFAULT_WB_ADS_HISTORICAL_START_DATE,
      companyWbAdsHistoricalStartDates: COMPANY_WB_ADS_HISTORICAL_START_DATES,
    },
  };
}
