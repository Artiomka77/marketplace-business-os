import Link from "next/link";
import { prisma } from "@/lib/prisma";

type Props = {
  searchParams?: Promise<{
    period?: string;
  }>;
};

const ACTIVE_COMPANY_NAME = "ИП Петров";
const ACTIVE_MARKETPLACE_CODE = "WB";

function formatCurrency(value: number) {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatDate(date?: Date | null) {
  if (!date) return "Нет данных";
  return date.toLocaleDateString("ru-RU");
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

function isActiveWbAccount(companyName: string, marketplaceCode: string) {
  return (
    companyName === ACTIVE_COMPANY_NAME &&
    marketplaceCode === ACTIVE_MARKETPLACE_CODE
  );
}

function metricCardClassName() {
  return "min-w-0 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6 xl:p-7";
}

function metricValueClassName() {
  return "break-words text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl";
}

export default async function HomePage({ searchParams }: Props) {
  const params = searchParams ? await searchParams : {};
  const selectedPeriodKey = params.period;

  const companies = await prisma.company.findMany({
    include: {
      marketplaceAccounts: {
        include: {
          marketplace: true,
        },
      },
    },
    orderBy: {
      name: "asc",
    },
  });

  const financeRows = await prisma.wbFinance.findMany({
    where: {
      dateFrom: {
        not: null,
      },
      dateTo: {
        not: null,
      },
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

  for (const row of financeRows) {
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
    periods.find((period) => period.key === selectedPeriodKey) ?? periods[0];

  const wbFinance = selectedPeriod
    ? await prisma.wbFinance.findMany({
        where: {
          dateFrom: selectedPeriod.dateFrom,
          dateTo: selectedPeriod.dateTo,
        },
      })
    : [];

  const wbAds = selectedPeriod
    ? await prisma.wbAds.findMany({
        where: {
          dateFrom: selectedPeriod.dateFrom,
          dateTo: selectedPeriod.dateTo,
        },
      })
    : [];

  const latestStockImport = await prisma.importSession.findFirst({
    where: {
      reportType: "WB_STOCK",
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  const wbStocks = latestStockImport
    ? await prisma.wbStock.findMany({
        where: {
          importSessionId: latestStockImport.id,
        },
      })
    : [];

  const totalRevenue = wbFinance.reduce(
    (sum, item) => sum + Number(item.salesAmount ?? 0),
    0
  );

  const totalPayout = wbFinance.reduce(
    (sum, item) => sum + Number(item.totalToPay ?? 0),
    0
  );

  const totalAdSpend = wbAds.reduce(
    (sum, item) => sum + Number(item.spend ?? 0),
    0
  );

  const stockSummaryRows = wbStocks.filter(
    (item) => item.warehouseName === "__TOTAL__"
  );

  const totalStock = stockSummaryRows.reduce(
    (sum, item) =>
      sum +
      Number(item.inTransitToCustomer ?? 0) +
      Number(item.inTransitReturns ?? 0) +
      Number(item.totalStock ?? 0),
    0
  );

  const hasFinanceData = wbFinance.length > 0;
  const hasAdsData = wbAds.length > 0;
  const hasStockData = stockSummaryRows.length > 0;

  const drr =
    hasFinanceData && hasAdsData && totalRevenue > 0
      ? (totalAdSpend / totalRevenue) * 100
      : null;

  const stockDate = extractStockDate(
    latestStockImport?.fileName,
    latestStockImport?.createdAt
  );

  return (
    <main className="flex min-h-screen bg-slate-100">
      <aside className="hidden w-72 shrink-0 flex-col border-r border-slate-200 bg-white p-6 lg:flex">
        <div className="mb-10">
          <h1 className="text-3xl font-bold tracking-tight">Marketplace OS</h1>

          <p className="mt-2 text-sm text-slate-500">Analytics Platform</p>
        </div>

<nav className="space-y-2">
  <Link
    href="/"
    className="block rounded-xl bg-slate-900 px-5 py-4 font-medium text-white"
  >
    Dashboard
  </Link>

  <Link
    href="/import"
    className="block rounded-xl px-5 py-4 text-slate-700 transition hover:bg-slate-100"
  >
    Импорт отчетов
  </Link>

  <Link
    href="/profit"
    className="block rounded-xl px-5 py-4 text-slate-700 transition hover:bg-slate-100"
  >
    Прибыль WB по SKU
  </Link>

  <Link
    href="/profit-ozon"
    className="block rounded-xl px-5 py-4 text-slate-700 transition hover:bg-slate-100"
  >
    Прибыль Ozon по SKU
  </Link>

  <Link
    href="/stocks"
    className="block rounded-xl px-5 py-4 text-slate-700 transition hover:bg-slate-100"
  >
    Остатки
  </Link>

  <Link
    href="/ads-mapping"
    className="block rounded-xl px-5 py-4 text-slate-700 transition hover:bg-slate-100"
  >
    Связка рекламы WB
  </Link>

  <Link
    href="/imports"
    className="block rounded-xl px-5 py-4 text-slate-700 transition hover:bg-slate-100"
  >
    История импортов
  </Link>
</nav>

        <div className="mt-auto pt-10">
          <div className="rounded-2xl bg-slate-100 p-5">
            <div className="mb-2 text-sm text-slate-500">Активная компания</div>

            <div className="font-semibold">ИП Петров</div>

            <div className="mt-1 text-sm text-slate-500">
              Wildberries / Ozon
            </div>
          </div>
        </div>
      </aside>

      <section className="min-w-0 flex-1 p-4 sm:p-6 xl:p-10">
        <div className="mb-8 flex flex-col gap-5 xl:mb-10 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <h2 className="break-words text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">
              Dashboard
            </h2>

            <p className="mt-2 text-slate-500">
              Полная оцифровка бизнеса маркетплейсов
            </p>
          </div>

          <div className="flex min-w-0 flex-col gap-4 2xl:flex-row 2xl:items-center">
            <form
              action="/"
              className="min-w-0 rounded-2xl border border-slate-200 bg-white px-4 py-4 shadow-sm sm:px-5"
            >
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
                Отчетный период
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
              Импортировать отчет
            </Link>
          </div>
        </div>

        <div className="mb-10 grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-4">
          <div className={metricCardClassName()}>
            <div className="mb-4 text-sm text-slate-500">Выручка</div>

            <div className={metricValueClassName()}>
              {hasFinanceData ? formatCurrency(totalRevenue) : "Нет данных"}
            </div>

            <div className="mt-3 break-words text-sm text-slate-500">
              {selectedPeriod?.label ?? "Период не выбран"}
            </div>
          </div>

          <div className={metricCardClassName()}>
            <div className="mb-4 text-sm text-slate-500">Выплата WB</div>

            <div className={metricValueClassName()}>
              {hasFinanceData ? formatCurrency(totalPayout) : "Нет данных"}
            </div>

            <div className="mt-3 text-sm text-slate-500">
              До себестоимости и налогов
            </div>
          </div>

          <div className={metricCardClassName()}>
            <div className="mb-4 text-sm text-slate-500">ДРР</div>

            <div className={metricValueClassName()}>
              {drr !== null ? `${drr.toFixed(1)}%` : "Нет данных"}
            </div>

            <div className="mt-3 text-sm text-slate-500">
              {hasAdsData ? "Реклама за период" : "Нет рекламы за период"}
            </div>
          </div>

          <div className={metricCardClassName()}>
            <div className="mb-4 text-sm text-slate-500">Остатки WB</div>

            <div className={metricValueClassName()}>
              {hasStockData ? `${totalStock.toLocaleString("ru-RU")} шт` : "Нет данных"}
            </div>

            <div className="mt-3 break-words text-sm text-slate-500">
              {hasStockData ? `Срез на дату: ${stockDate}` : "WB Остатки не загружены"}
            </div>
          </div>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-8">
          <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="text-2xl font-bold">Последние отчеты</h3>

              <p className="mt-2 text-slate-500">
                Последние импортированные данные
              </p>
            </div>

            <Link
              href="/imports"
              className="rounded-xl border border-slate-300 px-5 py-3 text-center transition hover:bg-slate-100"
            >
              Смотреть все
            </Link>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[850px] border-collapse">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500">
                  <th className="py-4 pr-4 text-left font-medium">Компания</th>
                  <th className="py-4 pr-4 text-left font-medium">
                    Маркетплейс
                  </th>
                  <th className="py-4 pr-4 text-left font-medium">Период</th>
                  <th className="py-4 pr-4 text-left font-medium">Выручка</th>
                  <th className="py-4 pr-4 text-left font-medium">Выплата</th>
                </tr>
              </thead>

              <tbody>
                {companies.map((company) =>
                  company.marketplaceAccounts.map((account) => {
                    const isActive = isActiveWbAccount(
                      company.name,
                      account.marketplace.code
                    );

                    return (
                      <tr
                        key={account.id}
                        className="border-b border-slate-100 transition hover:bg-slate-50"
                      >
                        <td className="py-5 pr-4 font-medium">
                          {company.name}
                        </td>

                        <td className="py-5 pr-4">
                          {account.marketplace.name}
                        </td>

                        <td className="py-5 pr-4">
                          {isActive
                            ? selectedPeriod?.label ?? "Нет данных"
                            : "Нет данных"}
                        </td>

                        <td className="py-5 pr-4 font-semibold">
                          {isActive && hasFinanceData
                            ? formatCurrency(totalRevenue)
                            : "Нет данных"}
                        </td>

                        <td className="py-5 pr-4 font-semibold">
                          {isActive && hasFinanceData
                            ? formatCurrency(totalPayout)
                            : "Нет данных"}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </main>
  );
}