import Link from "next/link";
import { getProfitAnalytics } from "@/lib/analytics/profitAnalytics";
import { getProfitAnalyticsOzon } from "@/lib/analytics/profitAnalyticsOzon";
import MarketplaceNav from "@/components/marketplaces/MarketplaceNav";
import { getDefaultLast30DaysRange } from "@/lib/date/defaultPeriod";


type MarketplaceFilter = "ALL" | "WB" | "Ozon";
type CompanyFilter = "ALL" | "ИП Петров" | "ИП Лебедева";

function formatMoney(value: number) {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0,
  }).format(Number.isFinite(value) ? value : 0);
}

function formatPercent(value: number) {
  return `${(Number.isFinite(value) ? value : 0).toFixed(1)}%`;
}

function abcColor(abc: string) {
  if (abc === "A") return "text-emerald-600";
  if (abc === "B") return "text-amber-600";
  return "text-red-600";
}

function profitColor(value: number) {
  return value >= 0 ? "text-emerald-600" : "text-red-600";
}

function limitRows<T>(rows: T[], limit: number) {
  return rows.slice(0, limit);
}

function buildLimitHref({
  dateFrom,
  dateTo,
  company,
  marketplace,
  candidatesLimit,
  abcLimit,
}: {
  dateFrom: string;
  dateTo: string;
  company: string;
  marketplace: string;
  candidatesLimit: number;
  abcLimit: number;
}) {
  const query = new URLSearchParams();

  query.set("dateFrom", dateFrom);
  query.set("dateTo", dateTo);
  query.set("company", company);
  query.set("marketplace", marketplace);
    query.set("candidatesLimit", String(candidatesLimit));
  query.set("abcLimit", String(abcLimit));

  return `/abc?${query.toString()}`;
}

function LimitLinks({
  current,
  buildHref,
}: {
  current: number;
  buildHref: (limit: number) => string;
}) {
  const limits = [
    { label: "10", value: 10 },
    { label: "25", value: 25 },
    { label: "50", value: 50 },
    { label: "100", value: 100 },
    { label: "Все", value: 9999 },
  ];

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-slate-500">Показать:</span>

      {limits.map((limit) => (
        <Link
          key={limit.value}
          href={buildHref(limit.value)}
          className={`rounded-lg px-3 py-1 font-medium ${
            current === limit.value
              ? "bg-slate-900 text-white"
              : "bg-slate-100 text-slate-700 hover:bg-slate-200"
          }`}
        >
          {limit.label}
        </Link>
      ))}
    </div>
  );
}

export default async function AbcPage({
  searchParams,
}: {
  searchParams?: Promise<{
  dateFrom?: string;
  dateTo?: string;
  marketplace?: MarketplaceFilter;
  company?: CompanyFilter;
  candidatesLimit?: string;
  abcLimit?: string;
}>;
}) {
  const params = await searchParams;

  const defaultPeriod = getDefaultLast30DaysRange();
  const dateFrom = params?.dateFrom ?? defaultPeriod.dateFrom;
  const dateTo = params?.dateTo ?? defaultPeriod.dateTo;
  const marketplace = params?.marketplace ?? "ALL";
  const company = params?.company ?? "ALL";

  const candidatesLimit = Number(params?.candidatesLimit ?? 25);
  const abcLimit = Number(params?.abcLimit ?? 25);

const selectedCompanies =
  company === "ALL" ? ["ИП Петров", "ИП Лебедева"] : [company];

const analyticsByCompany = await Promise.all(
  selectedCompanies.map(async (companyName) => {
    const [wb, ozon] = await Promise.all([
      getProfitAnalytics({
  dateFrom,
  dateTo,
  companyName,
}),
      getProfitAnalyticsOzon({
  dateFrom,
  dateTo,
  companyName,
}),
    ]);

    return {
      companyName,
      wb,
      ozon,
    };
  })
);

const rawRows = analyticsByCompany.flatMap(({ companyName, wb, ozon }) => [
  ...wb.rows.map((row) => ({
    company: companyName,
    marketplace: "WB",
    sku: row.nmId,
    vendorCode: row.vendorCode,
    salesQty: row.netSalesQty,
    revenue: row.revenue,
    profit: row.netProfitAfterTax,
    abc: row.abcByProfit,
  })),
  ...ozon.rows.map((row) => ({
    company: companyName,
    marketplace: "Ozon",
    sku: row.nmId,
    vendorCode: row.vendorCode,
    salesQty: row.netSalesQty,
    revenue: row.revenue,
    profit: row.netProfitAfterTax,
    abc: row.abcByProfit,
  })),
]);
  const rows = rawRows
    .filter((row) => marketplace === "ALL" || row.marketplace === marketplace)
    .filter((row) => company === "ALL" || row.company === company)
    .sort((a, b) => b.profit - a.profit);

  const totalRevenue = rows.reduce((sum, row) => sum + row.revenue, 0);
  const totalProfit = rows.reduce((sum, row) => sum + row.profit, 0);
  const totalPositiveProfit = rows.reduce(
    (sum, row) => sum + Math.max(0, row.profit),
    0
  );

  let cumulativeProfit = 0;

  const enrichedRows = rows.map((row) => {
    const positiveProfit = Math.max(0, row.profit);
    cumulativeProfit += positiveProfit;

    return {
      ...row,
      revenueShare: totalRevenue > 0 ? (row.revenue / totalRevenue) * 100 : 0,
      profitShare:
        totalPositiveProfit > 0
          ? (positiveProfit / totalPositiveProfit) * 100
          : 0,
      cumulativeShare:
        totalPositiveProfit > 0
          ? (cumulativeProfit / totalPositiveProfit) * 100
          : 0,
    };
  });

  function groupStats(abc: "A" | "B" | "C") {
    const groupRows = enrichedRows.filter((row) => row.abc === abc);
    const groupRevenue = groupRows.reduce((sum, row) => sum + row.revenue, 0);
    const groupProfit = groupRows.reduce((sum, row) => sum + row.profit, 0);

    return {
      count: groupRows.length,
      revenue: groupRevenue,
      profit: groupProfit,
      revenueShare:
        totalRevenue !== 0 ? (groupRevenue / totalRevenue) * 100 : 0,
      profitShare: totalProfit !== 0 ? (groupProfit / totalProfit) * 100 : 0,
    };
  }

  const aStats = groupStats("A");
  const bStats = groupStats("B");
  const cStats = groupStats("C");

  const cGroupRows = enrichedRows.filter((row) => row.abc === "C");
  const lossRows = cGroupRows.filter((row) => row.profit <= 0);
  const slowRows = cGroupRows.filter((row) => row.salesQty < 3);
  const weakProfitRows = cGroupRows.filter(
    (row) => row.profit > 0 && row.profitShare < 0.2
  );

  const liquidationCandidates = cGroupRows
    .filter(
      (row) => row.profit <= 0 || row.profitShare < 0.2 || row.salesQty < 3
    )
    .sort((a, b) => a.profit - b.profit);

  const visibleCandidates = limitRows(liquidationCandidates, candidatesLimit);
  const visibleRows = limitRows(enrichedRows, abcLimit);

  const baseHrefParams = {
  dateFrom,
  dateTo,
  company,
  marketplace,
};

  return (
    <main className="min-h-screen bg-slate-100">
  <MarketplaceNav />

  <div className="p-8">
      <div className="mx-auto max-w-[1600px] space-y-6">
        <div>
          <h1 className="text-4xl font-bold text-slate-900">ABC-анализ</h1>

          <p className="mt-3 text-slate-500">
            Классификация товаров по чистой прибыли после налогов WB и Ozon.
          </p>
        </div>

        <form className="grid gap-4 rounded-2xl bg-white p-6 shadow-sm md:grid-cols-5">
          <div>
            <label className="mb-2 block text-sm font-medium text-slate-700">
              Дата от
            </label>

            <input
              type="date"
              name="dateFrom"
              defaultValue={dateFrom}
              className="w-full rounded-xl border border-slate-300 px-4 py-2"
            />
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-slate-700">
              Дата до
            </label>

            <input
              type="date"
              name="dateTo"
              defaultValue={dateTo}
              className="w-full rounded-xl border border-slate-300 px-4 py-2"
            />
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-slate-700">
              Компания
            </label>

            <select
              name="company"
              defaultValue={company}
              className="w-full rounded-xl border border-slate-300 px-4 py-2"
            >
              <option value="ALL">Все</option>
              <option value="ИП Петров">ИП Петров</option>
              <option value="ИП Лебедева">ИП Лебедева</option>
            </select>
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-slate-700">
              Маркетплейс
            </label>

            <select
              name="marketplace"
              defaultValue={marketplace}
              className="w-full rounded-xl border border-slate-300 px-4 py-2"
            >
              <option value="ALL">Все</option>
              <option value="WB">WB</option>
              <option value="Ozon">Ozon</option>
            </select>
          </div>

                 <input type="hidden" name="candidatesLimit" value={candidatesLimit} />
          <input type="hidden" name="abcLimit" value={abcLimit} />

          <div className="flex items-end">
            <button className="w-full rounded-xl bg-slate-900 px-4 py-2 font-medium text-white">
              Применить
            </button>
          </div>
        </form>

        <section className="grid gap-4 md:grid-cols-4">
          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Всего товаров</div>
            <div className="mt-2 text-3xl font-bold">{rows.length}</div>

            <div className="mt-3 text-sm text-slate-500">
              Выручка:{" "}
              <span className="font-bold text-slate-900">
                {formatMoney(totalRevenue)}
              </span>
            </div>

            <div className="mt-1 text-sm text-slate-500">
              Прибыль:{" "}
              <span className={`font-bold ${profitColor(totalProfit)}`}>
                {formatMoney(totalProfit)}
              </span>
            </div>

            <div className="mt-1 text-sm text-slate-500">
              Доля прибыли: 100%
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Группа A</div>
            <div className="mt-2 text-3xl font-bold text-emerald-600">
              {aStats.count}
            </div>

            <div className="mt-3 text-sm text-slate-500">
              Выручка:{" "}
              <span className="font-bold text-slate-900">
                {formatMoney(aStats.revenue)}
              </span>
            </div>

            <div className="mt-1 text-sm text-slate-500">
              Прибыль:{" "}
              <span className={`font-bold ${profitColor(aStats.profit)}`}>
                {formatMoney(aStats.profit)}
              </span>
            </div>

            <div className="mt-1 text-sm text-slate-500">
              Доля прибыли: {formatPercent(aStats.profitShare)}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Группа B</div>
            <div className="mt-2 text-3xl font-bold text-amber-600">
              {bStats.count}
            </div>

            <div className="mt-3 text-sm text-slate-500">
              Выручка:{" "}
              <span className="font-bold text-slate-900">
                {formatMoney(bStats.revenue)}
              </span>
            </div>

            <div className="mt-1 text-sm text-slate-500">
              Прибыль:{" "}
              <span className={`font-bold ${profitColor(bStats.profit)}`}>
                {formatMoney(bStats.profit)}
              </span>
            </div>

            <div className="mt-1 text-sm text-slate-500">
              Доля прибыли: {formatPercent(bStats.profitShare)}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Группа C</div>
            <div className="mt-2 text-3xl font-bold text-red-600">
              {cStats.count}
            </div>

            <div className="mt-3 text-sm text-slate-500">
              Выручка:{" "}
              <span className="font-bold text-slate-900">
                {formatMoney(cStats.revenue)}
              </span>
            </div>

            <div className="mt-1 text-sm text-slate-500">
              Прибыль:{" "}
              <span className={`font-bold ${profitColor(cStats.profit)}`}>
                {formatMoney(cStats.profit)}
              </span>
            </div>

            <div className="mt-1 text-sm text-slate-500">
              Доля прибыли: {formatPercent(cStats.profitShare)}
            </div>
          </div>
        </section>

        <section className="grid gap-4 md:grid-cols-3">
          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Убыточные C-SKU</div>
            <div className="mt-2 text-3xl font-bold text-red-600">
              {lossRows.length}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Малопродаваемые C-SKU</div>
            <div className="mt-2 text-3xl font-bold text-amber-600">
              {slowRows.length}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Слабая прибыль C-SKU</div>
            <div className="mt-2 text-3xl font-bold text-slate-900">
              {weakProfitRows.length}
            </div>
          </div>
        </section>

        <section className="rounded-2xl bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h2 className="text-xl font-bold text-slate-900">
                Кандидаты на вывод из ассортимента
              </h2>

              <p className="mt-2 text-slate-500">
                Группа C: отрицательная прибыль, доля прибыли меньше 0.2% или
                продажи меньше 3 шт.
              </p>
            </div>

            <div className="flex flex-col items-start gap-3 lg:items-end">
              <div className="text-4xl font-bold text-red-600">
                {liquidationCandidates.length}
              </div>

              <LimitLinks
                current={candidatesLimit}
                buildHref={(nextLimit) =>
                  buildLimitHref({
                    ...baseHrefParams,
                    candidatesLimit: nextLimit,
                    abcLimit,
                  })
                }
              />
            </div>
          </div>

          <div className="mt-6 overflow-x-auto">
            <table className="w-full min-w-[1100px] text-sm">
              <thead className="bg-slate-100">
                <tr>
                  <th className="p-3 text-left">Компания</th>
                  <th className="p-3 text-left">МП</th>
                  <th className="p-3 text-left">Артикул</th>
                  <th className="p-3 text-right">Продажи</th>
                  <th className="p-3 text-right">Выручка</th>
                  <th className="p-3 text-right">Прибыль</th>
                  <th className="p-3 text-right">Доля прибыли</th>
                </tr>
              </thead>

              <tbody>
                {visibleCandidates.map((row) => (
                  <tr
                    key={`liq-${row.marketplace}-${row.vendorCode}-${row.sku}`}
                    className="border-t border-slate-100"
                  >
                    <td className="p-3">{row.company}</td>
                    <td className="p-3">{row.marketplace}</td>
                    <td className="p-3 font-medium">
                      {row.vendorCode || "—"}
                    </td>
                    <td className="p-3 text-right">{row.salesQty}</td>
                    <td className="p-3 text-right">
                      {formatMoney(row.revenue)}
                    </td>
                    <td
                      className={`p-3 text-right font-bold ${profitColor(
                        row.profit
                      )}`}
                    >
                      {formatMoney(row.profit)}
                    </td>
                    <td className="p-3 text-right">
                      {formatPercent(row.profitShare)}
                    </td>
                  </tr>
                ))}

                {visibleCandidates.length === 0 && (
                  <tr>
                    <td colSpan={7} className="p-6 text-center text-slate-500">
                      Кандидатов на вывод не найдено.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {liquidationCandidates.length > visibleCandidates.length && (
            <div className="mt-4 text-sm text-slate-500">
              Показано {visibleCandidates.length} из{" "}
              {liquidationCandidates.length}.
            </div>
          )}
        </section>

        <section className="overflow-hidden rounded-2xl bg-white shadow-sm">
          <div className="flex flex-col gap-4 border-b border-slate-200 p-6 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h2 className="text-xl font-bold text-slate-900">
                Сводная таблица ABC
              </h2>

              <p className="mt-2 text-sm text-slate-500">
                Показано {visibleRows.length} из {enrichedRows.length} строк.
              </p>
            </div>

            <LimitLinks
              current={abcLimit}
              buildHref={(nextLimit) =>
                buildLimitHref({
                  ...baseHrefParams,
                  candidatesLimit,
                  abcLimit: nextLimit,
                })
              }
            />
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[1300px] border-collapse text-sm">
              <thead className="bg-slate-100 text-left text-slate-700">
                <tr>
                  <th className="p-3">ABC</th>
                  <th className="p-3">Компания</th>
                  <th className="p-3">Маркетплейс</th>
                  <th className="p-3">SKU</th>
                  <th className="p-3">Артикул</th>
                  <th className="p-3 text-right">Продажи</th>
                  <th className="p-3 text-right">Выручка</th>
                  <th className="p-3 text-right">Доля выручки</th>
                  <th className="p-3 text-right">Прибыль</th>
                  <th className="p-3 text-right">Доля прибыли</th>
                  <th className="p-3 text-right">Накопленная доля</th>
                </tr>
              </thead>

              <tbody>
                {visibleRows.map((row) => (
                  <tr
                    key={`${row.marketplace}-${row.vendorCode}-${row.sku}`}
                    className="border-t border-slate-100 hover:bg-slate-50"
                  >
                    <td className={`p-3 font-bold ${abcColor(row.abc)}`}>
                      {row.abc}
                    </td>
                    <td className="p-3">{row.company}</td>
                    <td className="p-3">{row.marketplace}</td>
                    <td className="p-3 text-slate-600">{row.sku || "—"}</td>
                    <td className="p-3 font-medium">
                      {row.vendorCode || "—"}
                    </td>
                    <td className="p-3 text-right">{row.salesQty}</td>
                    <td className="p-3 text-right">
                      {formatMoney(row.revenue)}
                    </td>
                    <td className="p-3 text-right">
                      {formatPercent(row.revenueShare)}
                    </td>
                    <td
                      className={`p-3 text-right font-bold ${profitColor(
                        row.profit
                      )}`}
                    >
                      {formatMoney(row.profit)}
                    </td>
                    <td className="p-3 text-right">
                      {formatPercent(row.profitShare)}
                    </td>
                    <td className="p-3 text-right">
                      {formatPercent(row.cumulativeShare)}
                    </td>
                  </tr>
                ))}

                {visibleRows.length === 0 && (
                  <tr>
                    <td colSpan={11} className="p-8 text-center text-slate-500">
                      Нет данных для ABC-анализа.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <Link
          href="/analytics"
          className="inline-block rounded-xl bg-slate-900 px-5 py-3 font-semibold text-white"
        >
          ← Назад в аналитику
        </Link>
      </div>

    </div>
    </main>
  );
}