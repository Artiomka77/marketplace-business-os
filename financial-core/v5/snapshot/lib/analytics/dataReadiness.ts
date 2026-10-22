import { prisma } from "@/lib/prisma";

export type DataReadinessLevel = "ok" | "warning" | "danger";
export type DataReadinessStatus = "complete" | "preliminary" | "incomplete";

export type DataReadinessIssue = {
  kind:
    | "CURRENT_PERIOD"
    | "WB_WEEKLY_NOT_CLOSED"
    | "ORDER_DATA_MISSING"
    | "WB_FINANCE_MISSING"
    | "OZON_FINANCE_MISSING"
    | "OZON_REALIZATION_SUMMARY_INCOMPLETE"
    | "OZON_DISCOUNT_POINTS_INCOMPLETE"
    | "OZON_ADS_PENDING";
  level: Exclude<DataReadinessLevel, "ok">;
  title: string;
  text: string;
};

export type DataReadinessSummary = {
  status: DataReadinessStatus;
  isFinal: boolean;
  title: string;
  shortText: string;
  summaryText: string;
  issues: DataReadinessIssue[];
  counts: {
    companies: number;
    days: number;
    expectedOrderRows: number;
    orderRows: number;
    wbFinanceRows: number;
    wbSaleRows: number;
    wbAdsRows: number;
    ozonFinanceRows: number;
    ozonFinanceAdRows: number;
    ozonAdsRows: number;
  };
};

type DataReadinessParams = {
  dateFrom: string;
  dateTo: string;
  companyName?: string | null;
};

function parseIsoDay(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
}

function toIsoDay(date: Date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function getInclusiveDays(dateFrom: string, dateTo: string) {
  const start = parseIsoDay(dateFrom).getTime();
  const end = parseIsoDay(dateTo).getTime();
  return Math.max(1, Math.round((end - start) / 86_400_000) + 1);
}

function getMoscowTodayIso(now = new Date()) {
  return new Date(now.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function getMoscowWeekStartIso(todayIso: string) {
  const date = parseIsoDay(todayIso);
  const day = date.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  return toIsoDay(addDays(date, diff));
}

function buildCompanyWhere(companyNames: string[]) {
  if (companyNames.length === 1) return { companyName: companyNames[0] };
  return { companyName: { in: companyNames } };
}

function buildOrderWhere(companyNames: string[], dateFrom: Date, dateToExclusive: Date) {
  return {
    companyName: companyNames.length === 1 ? companyNames[0] : { in: companyNames },
    orderDate: {
      gte: dateFrom,
      lt: dateToExclusive,
    },
  };
}

function buildDateWhere(dateFrom: Date, dateToExclusive: Date) {
  return {
    gte: dateFrom,
    lt: dateToExclusive,
  };
}


type PeriodCoverageRow = {
  companyName: string | null;
  dateFrom: Date | string;
  dateTo: Date | string;
};

function getCoverageDateKey(value: Date | string) {
  return value instanceof Date
    ? value.toISOString().slice(0, 10)
    : String(value).slice(0, 10);
}

function dateKeyToDayNumber(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

function selectExactPeriodCoverage(
  rows: PeriodCoverageRow[],
  dateFrom: string,
  dateTo: string
) {
  const selectedStart = dateKeyToDayNumber(dateFrom);
  const selectedEnd = dateKeyToDayNumber(dateTo);

  const normalized = rows
    .map((row) => {
      const startKey = getCoverageDateKey(row.dateFrom);
      const endKey = getCoverageDateKey(row.dateTo);
      const start = dateKeyToDayNumber(startKey);
      const end = dateKeyToDayNumber(endKey);

      return {
        row,
        start: Math.min(start, end),
        end: Math.max(start, end),
      };
    })
    .filter(
      (item) =>
        item.start >= selectedStart &&
        item.end <= selectedEnd
    );

  const rowsByStart = new Map<number, typeof normalized>();

  for (const item of normalized) {
    const current = rowsByStart.get(item.start) ?? [];
    current.push(item);
    rowsByStart.set(item.start, current);
  }

  for (const items of rowsByStart.values()) {
    items.sort((left, right) => right.end - left.end);
  }

  const bestByNextDay = new Map<number, PeriodCoverageRow[]>();
  bestByNextDay.set(selectedStart, []);

  for (
    let dayNumber = selectedStart;
    dayNumber <= selectedEnd;
    dayNumber += 1
  ) {
    const currentPath = bestByNextDay.get(dayNumber);

    if (!currentPath) {
      continue;
    }

    for (const item of rowsByStart.get(dayNumber) ?? []) {
      const nextDay = item.end + 1;
      const candidatePath = [...currentPath, item.row];
      const existingPath = bestByNextDay.get(nextDay);

      if (!existingPath || candidatePath.length < existingPath.length) {
        bestByNextDay.set(nextDay, candidatePath);
      }
    }
  }

  return bestByNextDay.get(selectedEnd + 1) ?? null;
}

export function getDataReadinessTone(status: DataReadinessStatus) {
  if (status === "complete") {
    return {
      badgeClassName: "border-emerald-200 bg-emerald-50 text-emerald-700",
      panelClassName: "border-emerald-200 bg-emerald-50 text-emerald-900",
      icon: "✓",
    };
  }

  if (status === "incomplete") {
    return {
      badgeClassName: "border-red-200 bg-red-50 text-red-700",
      panelClassName: "border-red-200 bg-red-50 text-red-900",
      icon: "⚠",
    };
  }

  return {
    badgeClassName: "border-amber-200 bg-amber-50 text-amber-700",
    panelClassName: "border-amber-200 bg-amber-50 text-amber-900",
    icon: "⚠",
  };
}

export function getDataReadinessWarnings(summary: DataReadinessSummary) {
  if (summary.status === "complete") return [];
  return summary.issues.map((issue) => `${issue.title}: ${issue.text}`);
}

export async function getDataReadinessSummary(
  params: DataReadinessParams
): Promise<DataReadinessSummary> {
  const dateFrom = params.dateFrom;
  const dateTo = params.dateTo;
  const startDate = parseIsoDay(dateFrom);
  const dateToExclusive = addDays(parseIsoDay(dateTo), 1);
  const todayIso = getMoscowTodayIso();
  const currentWbWeekStartIso = getMoscowWeekStartIso(todayIso);
  const days = getInclusiveDays(dateFrom, dateTo);

  const companies = await prisma.company.findMany({
    where: {
      isActive: true,
      ...(params.companyName ? { name: params.companyName } : {}),
    },
    select: { name: true },
    orderBy: { name: "asc" },
  });

  const companyNames = companies.map((company) => company.name);
  const safeCompanyNames = companyNames.length > 0 ? companyNames : params.companyName ? [params.companyName] : [];

  if (safeCompanyNames.length === 0) {
    return {
      status: "incomplete",
      isFinal: false,
      title: "Нет активных компаний",
      shortText: "Нет компаний для расчёта",
      summaryText: "Система не нашла активных компаний для проверки готовности данных.",
      issues: [
        {
          kind: "ORDER_DATA_MISSING",
          level: "danger",
          title: "Нет активных компаний",
          text: "Проверьте настройки компаний перед расчётом финансового результата.",
        },
      ],
      counts: {
        companies: 0,
        days,
        expectedOrderRows: 0,
        orderRows: 0,
        wbFinanceRows: 0,
        wbSaleRows: 0,
        wbAdsRows: 0,
        ozonFinanceRows: 0,
        ozonFinanceAdRows: 0,
        ozonAdsRows: 0,
      },
    };
  }

  const companyWhere = buildCompanyWhere(safeCompanyNames);
  const dateRange = buildDateWhere(startDate, dateToExclusive);
  const reportEndInclusive = parseIsoDay(dateTo);

  const [
    orderRows,
    wbFinanceRows,
    wbSaleRows,
    wbAdsRows,
    ozonFinanceRows,
    ozonFinanceAdRows,
    ozonAdsRows,
    ozonFinanceCompanies,
  ] = await Promise.all([
    prisma.marketplaceDailyOrderStat.count({
      where: buildOrderWhere(safeCompanyNames, startDate, dateToExclusive),
    }),
    prisma.wbFinance.count({
      where: {
        ...companyWhere,
        dateFrom: { lte: reportEndInclusive },
        dateTo: { gte: startDate },
      },
    }),
    prisma.wbSale.count({
      where: {
        ...companyWhere,
        saleDate: dateRange,
      },
    }),
    prisma.wbAds.count({
      where: {
        ...companyWhere,
        dateFrom: { lte: reportEndInclusive },
        dateTo: { gte: startDate },
      },
    }),
    prisma.ozonFinance.count({
      where: {
        ...companyWhere,
        accrualDate: dateRange,
      },
    }),
    prisma.ozonFinance.count({
      where: {
        ...companyWhere,
        accrualDate: dateRange,
        OR: [
          { operationType: { contains: "реклам", mode: "insensitive" } },
          { operationType: { contains: "клик", mode: "insensitive" } },
          { operationType: { contains: "продвиж", mode: "insensitive" } },
        ],
      },
    }),
    prisma.ozonAds.count({
      where: {
        ...companyWhere,
        reportDate: dateRange,
      },
    }),
    prisma.ozonFinance.groupBy({
      by: ["companyName"],
      where: {
        ...companyWhere,
        accrualDate: dateRange,
      },
      _count: {
        _all: true,
      },
    }),
  ]);

  const issues: DataReadinessIssue[] = [];
  const expectedOrderRows = safeCompanyNames.length * days * 2;
  const includesToday = dateFrom <= todayIso && dateTo >= todayIso;
  const isFullyPastPeriod = dateTo < todayIso;
  const overlapsCurrentWbWeek = dateTo >= currentWbWeekStartIso && dateFrom <= todayIso;

  if (includesToday) {
    issues.push({
      kind: "CURRENT_PERIOD",
      level: "warning",
      title: "Период ещё не закрыт",
      text: "Выбранный период включает сегодняшний день. Показатели по заказам, рекламе, начислениям и прибыли являются предварительными до завершения синхронизаций.",
    });
  }

  if (overlapsCurrentWbWeek) {
    issues.push({
      kind: "WB_WEEKLY_NOT_CLOSED",
      level: "warning",
      title: "WB-неделя ещё не закрыта",
      text: "Для WB главным источником являются еженедельные финансовые отчёты. Текущая неделя ещё не закрыта, поэтому прибыль WB за этот участок считается предварительно.",
    });
  }

  // Важно: MarketplaceDailyOrderStat используется для оперативных заказов и ДРР от заказов,
  // но не является источником закрытого финансового результата.
  // Для завершённых WB-недель приоритет — WB weekly finance/sales.
  // Поэтому частичная загрузка дневных заказов не должна делать финансовый статус периода
  // "Данные неполные". Отдельный бейдж "Заказы загружены частично" уже показывается
  // на Dashboard через hasPartialOrderCoverage(current).

  if (isFullyPastPeriod && wbFinanceRows === 0 && wbSaleRows > 0) {
    issues.push({
      kind: "WB_FINANCE_MISSING",
      level: "danger",
      title: "Нет WB weekly finance",
      text: "Есть WB-продажи, но не найден еженедельный финансовый отчёт WB за период. Финальный WB-результат нельзя считать закрытым.",
    });
  }

  if (ozonFinanceRows === 0 && (ozonAdsRows > 0 || orderRows > 0)) {
    issues.push({
      kind: "OZON_FINANCE_MISSING",
      level: isFullyPastPeriod ? "danger" : "warning",
      title: "Ozon Finance не загружен",
      text: "Для Ozon финансовый результат должен опираться на Ozon Finance. Пока его нет, прибыль и расходы Ozon предварительные.",
    });
  }

  const ozonActivityCompanyNames = ozonFinanceCompanies
    .filter((row) => row.companyName && row._count._all > 0)
    .map((row) => row.companyName as string);

  // Проверка готовности обязана использовать те же границы дат,
  // что и канонический Ozon-расчёт. Prisma DateTime может смещать
  // календарную дату из-за часового пояса, поэтому интервалы читаем
  // как PostgreSQL date и группируем точно так же, как в
  // profitAnalyticsOzon.ts.
  const ozonRealizationSummaryRows: PeriodCoverageRow[] = [];
  const ozonDiscountSummaryRows: PeriodCoverageRow[] = [];

  for (const activityCompanyName of ozonActivityCompanyNames) {
    const [realizationRows, discountRows] = await Promise.all([
      prisma.$queryRaw<PeriodCoverageRow[]>`
        SELECT
          "companyName",
          "dateFrom"::date AS "dateFrom",
          "dateTo"::date AS "dateTo"
        FROM "OzonRealizationSummary"
        WHERE "dateFrom"::date >= CAST(${dateFrom} AS date)
          AND "dateTo"::date <= CAST(${dateTo} AS date)
          AND "companyName" = ${activityCompanyName}
        GROUP BY
          "companyName",
          "dateFrom"::date,
          "dateTo"::date
        ORDER BY
          "dateFrom"::date,
          "dateTo"::date
      `,
      prisma.$queryRaw<PeriodCoverageRow[]>`
        SELECT
          "companyName",
          "dateFrom"::date AS "dateFrom",
          "dateTo"::date AS "dateTo"
        FROM "OzonDiscountPointsSummary"
        WHERE "dateFrom"::date >= CAST(${dateFrom} AS date)
          AND "dateTo"::date <= CAST(${dateTo} AS date)
          AND "companyName" = ${activityCompanyName}
        GROUP BY
          "companyName",
          "dateFrom"::date,
          "dateTo"::date
        ORDER BY
          "dateFrom"::date,
          "dateTo"::date
      `,
    ]);

    ozonRealizationSummaryRows.push(...realizationRows);
    ozonDiscountSummaryRows.push(...discountRows);
  }

  const realizationCoverageMissingCompanies = ozonActivityCompanyNames.filter(
    (companyName) =>
      !selectExactPeriodCoverage(
        ozonRealizationSummaryRows.filter(
          (row) => row.companyName === companyName
        ),
        dateFrom,
        dateTo
      )
  );

  if (realizationCoverageMissingCompanies.length > 0) {
    issues.push({
      kind: "OZON_REALIZATION_SUMMARY_INCOMPLETE",
      level: isFullyPastPeriod ? "danger" : "warning",
      title: "Налоговая выручка Ozon покрыта не полностью",
      text: `Нет точного непересекающегося покрытия отчётами начислений для: ${realizationCoverageMissingCompanies.join(", ")}.`,
    });
  }

  const discountCoverageMissingCompanies = ozonActivityCompanyNames.filter(
    (companyName) =>
      !selectExactPeriodCoverage(
        ozonDiscountSummaryRows.filter(
          (row) => row.companyName === companyName
        ),
        dateFrom,
        dateTo
      )
  );

  if (discountCoverageMissingCompanies.length > 0) {
    issues.push({
      kind: "OZON_DISCOUNT_POINTS_INCOMPLETE",
      level: isFullyPastPeriod ? "danger" : "warning",
      title: "Баллы Ozon покрыты не полностью",
      text: `Нет точного непересекающегося покрытия отчётами баллов для: ${discountCoverageMissingCompanies.join(", ")}.`,
    });
  }

  if (ozonFinanceRows > 0 && ozonFinanceAdRows === 0 && ozonAdsRows === 0 && !isFullyPastPeriod) {
    issues.push({
      kind: "OZON_ADS_PENDING",
      level: "warning",
      title: "Ozon-реклама может прийти позже",
      text: "В Ozon Finance пока нет рекламных списаний, и Performance Ads тоже не найден. Retry-загрузка должна продолжать проверку до появления данных.",
    });
  }

  const hasDanger = issues.some((issue) => issue.level === "danger");
  const status: DataReadinessStatus = hasDanger
    ? "incomplete"
    : issues.length > 0
      ? "preliminary"
      : "complete";

  const title =
    status === "complete"
      ? "Данные периода полные"
      : status === "incomplete"
        ? "Данные периода неполные"
        : "Данные периода предварительные";

  const shortText =
    status === "complete"
      ? "Данные полные"
      : status === "incomplete"
        ? "Данные неполные"
        : "Данные предварительные";

  const summaryText =
    status === "complete"
      ? "Критичных предупреждений по финансовым источникам данных не найдено. Финансовый результат можно использовать как закрытый для выбранного периода."
      : status === "incomplete"
        ? "Есть критичные проблемы с финансовыми источниками данных. Финансовый результат нужно использовать только после исправления загрузки."
        : "Финансовые показатели рассчитаны по текущим доступным данным, но период или финансовые источники ещё не закрыты. Используйте результат как предварительный.";

  return {
    status,
    isFinal: status === "complete",
    title,
    shortText,
    summaryText,
    issues,
    counts: {
      companies: safeCompanyNames.length,
      days,
      expectedOrderRows,
      orderRows,
      wbFinanceRows,
      wbSaleRows,
      wbAdsRows,
      ozonFinanceRows,
      ozonFinanceAdRows,
      ozonAdsRows,
    },
  };
}
