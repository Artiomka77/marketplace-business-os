import Link from "next/link";
import { prisma } from "@/lib/prisma";

type Props = {
  searchParams?: Promise<{
    period?: string;
    companyName?: string;
  }>;
};

const quickLinks = [
  {
    title: "Центр прибыли",
    description: "Единая картина прибыли, рекламы, налогов и проблемных зон.",
    href: "/profit-wb",
  },
  {
    title: "Аналитика маркетплейсов",
    description: "Прибыль WB/Ozon, ABC-анализ, остатки и связки рекламы.",
    href: "/analytics",
  },
  {
    title: "Финансы",
    description: "Операции, ОДДС, счета, кредиты и прогноз ликвидности.",
    href: "/finance",
  },
  {
    title: "Импорт отчётов",
    description: "Загрузка отчётов WB, Ozon, рекламы, остатков и себестоимости.",
    href: "/import",
  },
];

function formatCurrency(value: number) {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: 0,
  }).format(value);
}

function formatPercent(value: number) {
  return `${value.toFixed(1)}%`;
}

function formatDate(date?: Date | null) {
  if (!date) return "Нет данных";
  return date.toLocaleDateString("ru-RU");
}

function startOfDay(date: Date) {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
}

function nextDay(date: Date) {
  const result = startOfDay(date);
  result.setDate(result.getDate() + 1);
  return result;
}

function makePeriodKey(dateFrom: Date, dateTo: Date) {
  return `${dateFrom.toISOString()}__${dateTo.toISOString()}`;
}

function extractStockDate(fileName?: string | null, fallback?: Date) {
  const match = fileName?.match(/\d{4}_\d{1,2}_\d{1,2}/)?.[0];

  if (match) {
    const [year, month, day] = match.split("_");
    return `${day}.${month}.${year}`;
  }

  return fallback ? fallback.toLocaleDateString("ru-RU") : "Нет данных";
}

function metricCardClassName() {
  return "min-w-0 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6";
}

function metricValueClassName() {
  return "break-words text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl";
}

function subTextClassName() {
  return "mt-3 break-words text-sm leading-6 text-slate-500";
}

function companyBreakdownClassName() {
  return "mt-4 space-y-2 border-t border-slate-100 pt-4 text-sm";
}

function companyRowClassName() {
  return "flex items-center justify-between gap-3";
}

function safeNumber(value: unknown) {
  if (value === null || value === undefined) return 0;
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export default async function HomePage({ searchParams }: Props) {
  const params = searchParams ? await searchParams : {};

  const companyName =
    params.companyName && params.companyName !== "ALL"
      ? params.companyName
      : null;

  const companies = await prisma.company.findMany({
    orderBy: {
      name: "asc",
    },
  });

  const companyOptions = companies.map((company) => company.name);

  const wbFinancePeriods = await prisma.wbFinance.findMany({
    where: {
      ...(companyName ? { companyName } : {}),
      dateFrom: {
        not: null,
      },
      dateTo: {
        not: null,
      },
    },
    select: {
      dateFrom: true,
      dateTo: true,
    },
    orderBy: {
      dateTo: "desc",
    },
  });

  const periodMap = new Map<
    string,
    {
      key: string;
      dateFrom: Date;
      dateTo: Date;
      label: string;
    }
  >();

  for (const row of wbFinancePeriods) {
    if (!row.dateFrom || !row.dateTo) continue;

    const key = makePeriodKey(row.dateFrom, row.dateTo);

    if (!periodMap.has(key)) {
      periodMap.set(key, {
        key,
        dateFrom: row.dateFrom,
        dateTo: row.dateTo,
        label: `${formatDate(row.dateFrom)} — ${formatDate(row.dateTo)}`,
      });
    }
  }

  const periods = Array.from(periodMap.values());

  const selectedPeriod =
    periods.find((period) => period.key === params.period) ?? periods[0];

  const dateFrom = selectedPeriod?.dateFrom ?? null;
  const dateTo = selectedPeriod?.dateTo ?? null;
  const dateToExclusive = dateTo ? nextDay(dateTo) : null;

  const wbFinance = selectedPeriod
    ? await prisma.wbFinance.findMany({
        where: {
          dateFrom: selectedPeriod.dateFrom,
          dateTo: selectedPeriod.dateTo,
          ...(companyName ? { companyName } : {}),
        },
      })
    : [];

  const wbAds = selectedPeriod
    ? await prisma.wbAds.findMany({
        where: {
          dateFrom: selectedPeriod.dateFrom,
          dateTo: selectedPeriod.dateTo,
          ...(companyName ? { companyName } : {}),
        },
      })
    : [];

  const ozonFinance =
    dateFrom && dateToExclusive
      ? await prisma.ozonFinance.findMany({
          where: {
            ...(companyName ? { companyName } : {}),
            accrualDate: {
              gte: dateFrom,
              lt: dateToExclusive,
            },
          },
        })
      : [];

  const ozonAds =
    dateFrom && dateToExclusive
      ? await prisma.ozonAds.findMany({
          where: {
            ...(companyName ? { companyName } : {}),
            reportDate: {
              gte: dateFrom,
              lt: dateToExclusive,
            },
          },
        })
      : [];

  const latestStockImports = await prisma.importSession.findMany({
    where: {
      reportType: "WB_STOCK",
      ...(companyName ? { companyName } : {}),
    },
    orderBy: {
      createdAt: "desc",
    },
    take: companyName ? 1 : Math.max(companyOptions.length, 1),
  });

  const latestStockImportIds = latestStockImports.map((item) => item.id);

  const wbStocks =
    latestStockImportIds.length > 0
      ? await prisma.wbStock.findMany({
          where: {
            importSessionId: {
              in: latestStockImportIds,
            },
            ...(companyName ? { companyName } : {}),
          },
        })
      : [];

  const wbRevenue = wbFinance.reduce(
    (sum, item) => sum + safeNumber(item.salesAmount),
    0
  );

  const wbPayout = wbFinance.reduce(
    (sum, item) => sum + safeNumber(item.totalToPay),
    0
  );

  const wbLogistics = wbFinance.reduce(
    (sum, item) => sum + safeNumber(item.logisticsCost),
    0
  );

  const wbStorage = wbFinance.reduce(
    (sum, item) =>
      sum + safeNumber(item.storageCost) + safeNumber(item.acceptanceCost),
    0
  );

  const wbPenalties = wbFinance.reduce(
    (sum, item) => sum + safeNumber(item.penaltiesAmount),
    0
  );

  const wbAdsSpend = wbAds.reduce(
    (sum, item) => sum + safeNumber(item.spend),
    0
  );

  const ozonRevenue = ozonFinance.reduce(
    (sum, item) => sum + safeNumber(item.salesAmount),
    0
  );

  const ozonPayout = ozonFinance.reduce(
    (sum, item) => sum + safeNumber(item.totalAmount),
    0
  );

  const ozonAdsSpend = ozonAds.reduce(
    (sum, item) => sum + safeNumber(item.spend),
    0
  );

  const totalRevenue = wbRevenue + ozonRevenue;
  const totalPayout = wbPayout + ozonPayout;
  const totalAdsSpend = wbAdsSpend + ozonAdsSpend;

  const totalDrr = totalRevenue > 0 ? (totalAdsSpend / totalRevenue) * 100 : null;
  const wbDrr = wbRevenue > 0 ? (wbAdsSpend / wbRevenue) * 100 : null;
  const ozonDrr = ozonRevenue > 0 ? (ozonAdsSpend / ozonRevenue) * 100 : null;

  const financeByCompany = new Map<
    string,
    {
      wbRevenue: number;
      wbPayout: number;
      wbAds: number;
      ozonRevenue: number;
      ozonPayout: number;
      ozonAds: number;
    }
  >();

  function getCompanySummary(name: string) {
    const current = financeByCompany.get(name) ?? {
      wbRevenue: 0,
      wbPayout: 0,
      wbAds: 0,
      ozonRevenue: 0,
      ozonPayout: 0,
      ozonAds: 0,
    };

    financeByCompany.set(name, current);
    return current;
  }

  for (const item of wbFinance) {
    const name = item.companyName ?? "Без компании";
    const current = getCompanySummary(name);

    current.wbRevenue += safeNumber(item.salesAmount);
    current.wbPayout += safeNumber(item.totalToPay);
  }

  for (const item of wbAds) {
    const name = item.companyName ?? "Без компании";
    const current = getCompanySummary(name);

    current.wbAds += safeNumber(item.spend);
  }

  for (const item of ozonFinance) {
    const name = item.companyName ?? "Без компании";
    const current = getCompanySummary(name);

    current.ozonRevenue += safeNumber(item.salesAmount);
    current.ozonPayout += safeNumber(item.totalAmount);
  }

  for (const item of ozonAds) {
    const name = item.companyName ?? "Без компании";
    const current = getCompanySummary(name);

    current.ozonAds += safeNumber(item.spend);
  }

  const companyBreakdownRows = Array.from(financeByCompany.entries()).sort(
    ([a], [b]) => a.localeCompare(b, "ru")
  );

  const stockSummaryRows = wbStocks.filter(
    (item) => item.warehouseName === "__TOTAL__"
  );

  const totalStock = stockSummaryRows.reduce(
    (sum, item) =>
      sum +
      safeNumber(item.inTransitToCustomer) +
      safeNumber(item.inTransitReturns) +
      safeNumber(item.totalStock),
    0
  );

  const stockByCompany = new Map<string, number>();

  for (const item of stockSummaryRows) {
    const name = item.companyName ?? "Без компании";
    stockByCompany.set(
      name,
      (stockByCompany.get(name) ?? 0) +
        safeNumber(item.inTransitToCustomer) +
        safeNumber(item.inTransitReturns) +
        safeNumber(item.totalStock)
    );
  }

  const latestStockImport = latestStockImports[0] ?? null;
  const stockDate = extractStockDate(
    latestStockImport?.fileName,
    latestStockImport?.createdAt
  );

  const hasSelectedPeriod = Boolean(selectedPeriod);
  const hasAnyRevenue = totalRevenue > 0;
  const hasStockData = totalStock > 0;

  const attentionItems = [
    {
      title: "Проверь рекламу",
      text:
        totalDrr !== null && totalDrr > 12
          ? `ДРР за период ${formatPercent(totalDrr)} — стоит проверить кампании.`
          : "ДРР в пределах контроля или данных по рекламе недостаточно.",
      href: "/ads-mapping",
    },
    {
      title: "Проверь остатки",
      text: hasStockData
        ? `На WB сейчас ${formatNumber(totalStock)} шт. Нужно отдельно смотреть зависшие размеры и SKU.`
        : "Нет актуального среза остатков WB.",
      href: "/stocks",
    },
    {
      title: "Проверь прибыль",
      text: hasAnyRevenue
        ? "Выручка есть. Следующий уровень — смотреть маржинальную прибыль по SKU."
        : "За выбранный период нет выручки.",
      href: "/analytics",
    },
  ];

  return (
    <main className="min-h-screen bg-slate-100 p-4 sm:p-6 xl:p-10">
      <div className="mx-auto max-w-[1800px] space-y-8">
        <section className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <h1 className="break-words text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">
              Dashboard
            </h1>

            <p className="mt-2 text-slate-500">
              Управленческая панель: выручка, выплаты, реклама, остатки и зоны
              внимания.
            </p>
          </div>

          <div className="flex min-w-0 flex-col gap-4 2xl:flex-row 2xl:items-center">
            <form
              action="/"
              className="min-w-0 rounded-2xl border border-slate-200 bg-white px-4 py-4 shadow-sm sm:px-5"
            >
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
                Фильтры Dashboard
              </div>

              <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center">
                <select
                  name="period"
                  defaultValue={selectedPeriod?.key}
                  className="min-w-0 rounded-xl border border-slate-200 bg-slate-100 px-4 py-3 text-sm font-semibold"
                >
                  {periods.map((period) => (
                    <option key={period.key} value={period.key}>
                      {period.label}
                    </option>
                  ))}
                </select>

                <select
                  name="companyName"
                  defaultValue={params.companyName ?? "ALL"}
                  className="min-w-0 rounded-xl border border-slate-200 bg-slate-100 px-4 py-3 text-sm font-semibold"
                >
                  <option value="ALL">Все компании</option>

                  {companyOptions.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>

                <button
                  type="submit"
                  className="rounded-xl bg-slate-900 px-5 py-3 font-semibold text-white transition hover:bg-slate-800"
                >
                  Показать
                </button>
              </div>
            </form>

            <Link
              href="/import"
              className="rounded-2xl bg-slate-900 px-6 py-4 text-center font-semibold text-white transition hover:bg-slate-800"
            >
              Импортировать отчёт
            </Link>
          </div>
        </section>

        {!hasSelectedPeriod && (
          <section className="rounded-3xl border border-amber-200 bg-amber-50 p-6 text-amber-900">
            Нет доступных периодов WB Finance. Загрузите финансовый отчёт WB,
            чтобы Dashboard смог построить недельные показатели.
          </section>
        )}

        <section className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-4">
          <div className={metricCardClassName()}>
            <div className="mb-4 text-sm text-slate-500">Общая выручка</div>

            <div className={metricValueClassName()}>
              {hasAnyRevenue ? formatCurrency(totalRevenue) : "Нет данных"}
            </div>

            <div className={subTextClassName()}>
              {selectedPeriod?.label ?? "Период не выбран"}
            </div>

            <div className={companyBreakdownClassName()}>
              <div className="font-semibold text-slate-700">По компаниям</div>

              {companyBreakdownRows.length > 0 ? (
                companyBreakdownRows.map(([name, item]) => (
                  <div key={name} className={companyRowClassName()}>
                    <span className="text-slate-500">{name}</span>
                    <span className="font-semibold text-slate-900">
                      {formatCurrency(item.wbRevenue + item.ozonRevenue)}
                    </span>
                  </div>
                ))
              ) : (
                <div className="text-slate-400">Нет данных</div>
              )}
            </div>
          </div>

          <div className={metricCardClassName()}>
            <div className="mb-4 text-sm text-slate-500">Выручка WB</div>

            <div className={metricValueClassName()}>
              {wbRevenue > 0 ? formatCurrency(wbRevenue) : "Нет данных"}
            </div>

            <div className={subTextClassName()}>По данным WB Finance</div>

            <div className={companyBreakdownClassName()}>
              <div className="font-semibold text-slate-700">По компаниям</div>

              {companyBreakdownRows.length > 0 ? (
                companyBreakdownRows.map(([name, item]) => (
                  <div key={name} className={companyRowClassName()}>
                    <span className="text-slate-500">{name}</span>
                    <span className="font-semibold text-slate-900">
                      {formatCurrency(item.wbRevenue)}
                    </span>
                  </div>
                ))
              ) : (
                <div className="text-slate-400">Нет данных</div>
              )}
            </div>
          </div>

          <div className={metricCardClassName()}>
            <div className="mb-4 text-sm text-slate-500">Выручка Ozon</div>

            <div className={metricValueClassName()}>
              {ozonRevenue > 0 ? formatCurrency(ozonRevenue) : "Нет данных"}
            </div>

            <div className={subTextClassName()}>По данным Ozon Finance</div>

            <div className={companyBreakdownClassName()}>
              <div className="font-semibold text-slate-700">По компаниям</div>

              {companyBreakdownRows.length > 0 ? (
                companyBreakdownRows.map(([name, item]) => (
                  <div key={name} className={companyRowClassName()}>
                    <span className="text-slate-500">{name}</span>
                    <span className="font-semibold text-slate-900">
                      {formatCurrency(item.ozonRevenue)}
                    </span>
                  </div>
                ))
              ) : (
                <div className="text-slate-400">Нет данных</div>
              )}
            </div>
          </div>

          <div className={metricCardClassName()}>
            <div className="mb-4 text-sm text-slate-500">К выплате / начислено</div>

            <div className={metricValueClassName()}>
              {totalPayout !== 0 ? formatCurrency(totalPayout) : "Нет данных"}
            </div>

            <div className={subTextClassName()}>
              WB к оплате + Ozon начислено продавцу
            </div>

            <div className={companyBreakdownClassName()}>
              <div className="font-semibold text-slate-700">По компаниям</div>

              {companyBreakdownRows.length > 0 ? (
                companyBreakdownRows.map(([name, item]) => (
                  <div key={name} className={companyRowClassName()}>
                    <span className="text-slate-500">{name}</span>
                    <span className="font-semibold text-slate-900">
                      {formatCurrency(item.wbPayout + item.ozonPayout)}
                    </span>
                  </div>
                ))
              ) : (
                <div className="text-slate-400">Нет данных</div>
              )}
            </div>
          </div>
        </section>

        <section className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-4">
          <div className={metricCardClassName()}>
            <div className="mb-4 text-sm text-slate-500">Реклама всего</div>

            <div className={metricValueClassName()}>
              {totalAdsSpend > 0 ? formatCurrency(totalAdsSpend) : "Нет данных"}
            </div>

            <div className={subTextClassName()}>
              WB: {formatCurrency(wbAdsSpend)} · Ozon:{" "}
              {formatCurrency(ozonAdsSpend)}
            </div>

            <div className={companyBreakdownClassName()}>
              <div className="font-semibold text-slate-700">По компаниям</div>

              {companyBreakdownRows.length > 0 ? (
                companyBreakdownRows.map(([name, item]) => (
                  <div key={name} className={companyRowClassName()}>
                    <span className="text-slate-500">{name}</span>
                    <span className="font-semibold text-slate-900">
                      {formatCurrency(item.wbAds + item.ozonAds)}
                    </span>
                  </div>
                ))
              ) : (
                <div className="text-slate-400">Нет данных</div>
              )}
            </div>
          </div>

          <div className={metricCardClassName()}>
            <div className="mb-4 text-sm text-slate-500">ДРР общий</div>

            <div className={metricValueClassName()}>
              {totalDrr !== null ? formatPercent(totalDrr) : "Нет данных"}
            </div>

            <div className={subTextClassName()}>
              WB: {wbDrr !== null ? formatPercent(wbDrr) : "нет данных"} · Ozon:{" "}
              {ozonDrr !== null ? formatPercent(ozonDrr) : "нет данных"}
            </div>
          </div>

          <div className={metricCardClassName()}>
            <div className="mb-4 text-sm text-slate-500">Расходы WB</div>

            <div className={metricValueClassName()}>
              {wbLogistics + wbStorage + wbPenalties > 0
                ? formatCurrency(wbLogistics + wbStorage + wbPenalties)
                : "Нет данных"}
            </div>

            <div className={subTextClassName()}>
              Логистика: {formatCurrency(wbLogistics)}
              <br />
              Хранение/приёмка: {formatCurrency(wbStorage)}
              <br />
              Штрафы: {formatCurrency(wbPenalties)}
            </div>
          </div>

          <div className={metricCardClassName()}>
            <div className="mb-4 text-sm text-slate-500">Остатки WB</div>

            <div className={metricValueClassName()}>
              {hasStockData ? `${formatNumber(totalStock)} шт` : "Нет данных"}
            </div>

            <div className={subTextClassName()}>
              {hasStockData
                ? `Срез на дату: ${stockDate}`
                : "WB Остатки не загружены"}
            </div>

            <div className={companyBreakdownClassName()}>
              <div className="font-semibold text-slate-700">По компаниям</div>

              {Array.from(stockByCompany.entries()).length > 0 ? (
                Array.from(stockByCompany.entries())
                  .sort(([a], [b]) => a.localeCompare(b, "ru"))
                  .map(([name, qty]) => (
                    <div key={name} className={companyRowClassName()}>
                      <span className="text-slate-500">{name}</span>
                      <span className="font-semibold text-slate-900">
                        {formatNumber(qty)} шт
                      </span>
                    </div>
                  ))
              ) : (
                <div className="text-slate-400">Нет данных</div>
              )}
            </div>
          </div>
        </section>

        <section className="grid gap-5 xl:grid-cols-3">
          {attentionItems.map((item) => (
            <Link
              key={item.title}
              href={item.href}
              className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
            >
              <div className="text-sm font-semibold uppercase tracking-wide text-slate-400">
                Что требует внимания
              </div>

              <h2 className="mt-3 text-xl font-bold text-slate-900">
                {item.title}
              </h2>

              <p className="mt-3 text-sm leading-6 text-slate-500">
                {item.text}
              </p>

              <div className="mt-5 font-semibold text-slate-900">
                Открыть →
              </div>
            </Link>
          ))}
        </section>

        <section className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
          {quickLinks.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
            >
              <h2 className="text-xl font-bold text-slate-900">{item.title}</h2>

              <p className="mt-3 text-sm leading-6 text-slate-500">
                {item.description}
              </p>

              <div className="mt-5 font-semibold text-slate-900">
                Открыть →
              </div>
            </Link>
          ))}
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-8">
          <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-2xl font-bold">Сводка по компаниям</h2>

              <p className="mt-2 text-slate-500">
                WB и Ozon в разрезе юридических лиц за выбранный период.
              </p>
            </div>

            <Link
              href="/imports"
              className="rounded-xl border border-slate-300 px-5 py-3 text-center transition hover:bg-slate-100"
            >
              История импортов
            </Link>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[1050px] border-collapse">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500">
                  <th className="py-4 pr-4 text-left font-medium">Компания</th>
                  <th className="py-4 pr-4 text-left font-medium">
                    Выручка WB
                  </th>
                  <th className="py-4 pr-4 text-left font-medium">
                    Выручка Ozon
                  </th>
                  <th className="py-4 pr-4 text-left font-medium">
                    Выручка всего
                  </th>
                  <th className="py-4 pr-4 text-left font-medium">
                    Реклама всего
                  </th>
                  <th className="py-4 pr-4 text-left font-medium">ДРР</th>
                  <th className="py-4 pr-4 text-left font-medium">
                    К выплате / начислено
                  </th>
                </tr>
              </thead>

              <tbody>
                {companyBreakdownRows.map(([name, item]) => {
                  const companyRevenue = item.wbRevenue + item.ozonRevenue;
                  const companyAds = item.wbAds + item.ozonAds;
                  const companyDrr =
                    companyRevenue > 0 ? (companyAds / companyRevenue) * 100 : null;

                  return (
                    <tr
                      key={name}
                      className="border-b border-slate-100 transition hover:bg-slate-50"
                    >
                      <td className="py-5 pr-4 font-medium">{name}</td>

                      <td className="py-5 pr-4 font-semibold">
                        {formatCurrency(item.wbRevenue)}
                      </td>

                      <td className="py-5 pr-4 font-semibold">
                        {formatCurrency(item.ozonRevenue)}
                      </td>

                      <td className="py-5 pr-4 font-semibold">
                        {formatCurrency(companyRevenue)}
                      </td>

                      <td className="py-5 pr-4 font-semibold">
                        {formatCurrency(companyAds)}
                      </td>

                      <td className="py-5 pr-4 font-semibold">
                        {companyDrr !== null ? formatPercent(companyDrr) : "—"}
                      </td>

                      <td className="py-5 pr-4 font-semibold">
                        {formatCurrency(item.wbPayout + item.ozonPayout)}
                      </td>
                    </tr>
                  );
                })}

                {companyBreakdownRows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-slate-500">
                      Нет данных за выбранный период.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}