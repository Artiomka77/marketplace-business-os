import { prisma } from "@/lib/prisma";

type CreateWbSalesHistoricalJobsOptions = {
  companyId?: string | null;
};

type CompanyRow = {
  id: string;
  name: string;
};

type WbFinanceReportRow = {
  reportNumber: string | null;
  dateFrom: Date | null;
  dateTo: Date | null;
};

function normalizeReportNumber(value: unknown) {
  return String(value ?? "").trim();
}

function formatDate(date: Date | null) {
  if (!date) return null;
  return date.toISOString().slice(0, 10);
}

async function getWbCompanies(options: CreateWbSalesHistoricalJobsOptions) {
  const connections = await prisma.marketplaceApiConnection.findMany({
    where: {
      marketplace: "WB",
      wbToken: {
        not: null,
      },
      ...(options.companyId ? { companyId: options.companyId } : {}),
    },
    select: {
      companyId: true,
    },
  });

  const companyIds = Array.from(
    new Set(
      connections
        .map((connection) => connection.companyId)
        .filter((companyId): companyId is string => Boolean(companyId))
    )
  );

  if (companyIds.length === 0) {
    return [];
  }

  const companies = await prisma.company.findMany({
    where: {
      id: {
        in: companyIds,
      },
    },
    select: {
      id: true,
      name: true,
    },
    orderBy: {
      name: "asc",
    },
  });

  return companies;
}

async function getFinanceReports(companyName: string) {
  const rows = await prisma.wbFinance.findMany({
    where: {
      companyName,
      reportNumber: {
        not: null,
      },
    },
    orderBy: [{ dateFrom: "asc" }, { createdAt: "asc" }],
    select: {
      reportNumber: true,
      dateFrom: true,
      dateTo: true,
    },
  });

  const seen = new Set<string>();
  const uniqueReports: WbFinanceReportRow[] = [];

  for (const row of rows) {
    const reportNumber = normalizeReportNumber(row.reportNumber);

    if (!reportNumber || seen.has(reportNumber)) {
      continue;
    }

    seen.add(reportNumber);

    uniqueReports.push({
      reportNumber,
      dateFrom: row.dateFrom,
      dateTo: row.dateTo,
    });
  }

  return uniqueReports;
}

async function getLoadedSalesReportNumbers(
  companyName: string,
  reportNumbers: string[]
) {
  if (reportNumbers.length === 0) {
    return new Set<string>();
  }

  const rows = await prisma.wbSale.findMany({
    where: {
      companyName,
      reportNumber: {
        in: reportNumbers,
      },
    },
    select: {
      reportNumber: true,
    },
    distinct: ["reportNumber"],
  });

  return new Set(
    rows
      .map((row) => normalizeReportNumber(row.reportNumber))
      .filter(Boolean)
  );
}

async function getExistingJobReportNumbers(
  companyId: string,
  reportNumbers: string[]
) {
  if (reportNumbers.length === 0) {
    return new Set<string>();
  }

  const rows = await prisma.historicalSyncJob.findMany({
    where: {
      companyId,
      marketplace: "WB",
      dataType: "SALES",
      cursorReportNumber: {
        in: reportNumbers,
      },
    },
    select: {
      cursorReportNumber: true,
    },
  });

  return new Set(
    rows
      .map((row) => normalizeReportNumber(row.cursorReportNumber))
      .filter(Boolean)
  );
}

async function createJobsForCompany(company: CompanyRow) {
  const financeReports = await getFinanceReports(company.name);
  const reportNumbers = financeReports
    .map((report) => normalizeReportNumber(report.reportNumber))
    .filter(Boolean);

  const loadedSalesReportNumbers = await getLoadedSalesReportNumbers(
    company.name,
    reportNumbers
  );

  const existingJobReportNumbers = await getExistingJobReportNumbers(
    company.id,
    reportNumbers
  );

  let createdJobs = 0;
  let skippedLoadedSales = 0;
  let skippedExistingJobs = 0;
  let skippedWithoutDates = 0;

  for (const report of financeReports) {
    const reportNumber = normalizeReportNumber(report.reportNumber);

    if (!reportNumber) {
      continue;
    }

    if (!report.dateFrom || !report.dateTo) {
      skippedWithoutDates += 1;
      continue;
    }

    if (loadedSalesReportNumbers.has(reportNumber)) {
      skippedLoadedSales += 1;
      continue;
    }

    if (existingJobReportNumbers.has(reportNumber)) {
      skippedExistingJobs += 1;
      continue;
    }

    await prisma.historicalSyncJob.create({
      data: {
        companyId: company.id,
        companyName: company.name,
        marketplace: "WB",
        dataType: "SALES",
        dateFrom: report.dateFrom,
        dateTo: report.dateTo,
        cursorReportNumber: reportNumber,
        status: "PENDING",
        totalSteps: 1,
        completedSteps: 0,
      },
    });

    existingJobReportNumbers.add(reportNumber);
    createdJobs += 1;
  }

  return {
    companyId: company.id,
    companyName: company.name,
    financeReports: financeReports.length,
    createdJobs,
    skippedLoadedSales,
    skippedExistingJobs,
    skippedWithoutDates,
  };
}

export async function createWbSalesHistoricalJobs(
  options: CreateWbSalesHistoricalJobsOptions = {}
) {
  const companies = await getWbCompanies(options);
  const summaries = [];

  for (const company of companies) {
    summaries.push(await createJobsForCompany(company));
  }

  return {
    companies: companies.length,
    createdJobs: summaries.reduce((sum, row) => sum + row.createdJobs, 0),
    skippedLoadedSales: summaries.reduce(
      (sum, row) => sum + row.skippedLoadedSales,
      0
    ),
    skippedExistingJobs: summaries.reduce(
      (sum, row) => sum + row.skippedExistingJobs,
      0
    ),
    skippedWithoutDates: summaries.reduce(
      (sum, row) => sum + row.skippedWithoutDates,
      0
    ),
    summaries,
  };
}