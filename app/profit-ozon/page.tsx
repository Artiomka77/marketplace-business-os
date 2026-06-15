import Link from "next/link";
import { getProfitAnalyticsOzon } from "@/lib/analytics/profitAnalyticsOzon";
import MarketplaceNav from "@/components/marketplaces/MarketplaceNav";

type SortKey =
  | "abcByProfit"
  | "netSalesQty"
  | "revenue"
  | "revenueSharePercent"
  | "sellerPayout"
  | "wbCommission"
  | "logisticsCost"
  | "penaltiesAndDeductions"
  | "adsCost"
  | "drrPercent"
  | "totalCost"
  | "taxesAmount"
  | "marginProfit"
  | "profitSharePercent"
  | "netProfitAfterTax"
  | "marginAfterTaxPercent";

type SortDir = "asc" | "desc";

function formatMoney(value: number) {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0,
  }).format(Number.isFinite(value) ? value : 0);
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: 0,
  }).format(Number.isFinite(value) ? value : 0);
}

function formatPercent(value: number) {
  return `${(Number.isFinite(value) ? value : 0).toFixed(1)}%`;
}

function formatShare(value: number, revenue: number) {
  if (!revenue || revenue <= 0) return "0% от выручки";
  return `${((value / revenue) * 100).toFixed(1)}% от выручки`;
}

function profitColor(value: number) {
  if (value < 0) return "text-red-600";
  return "text-emerald-600";
}

function deltaColor(value: number, inverse = false) {
  if (value === 0) return "text-slate-500";
  const isGood = inverse ? value < 0 : value > 0;
  return isGood ? "text-emerald-600" : "text-red-600";
}

function formatDelta(diff: number, diffPercent: number) {
  const sign = diff > 0 ? "+" : "";
  return `${sign}${formatMoney(diff)} / ${sign}${formatPercent(diffPercent)}`;
}

function cardClassName() {
  return "min-w-0 rounded-2xl bg-white p-5 shadow-sm";
}

function valueClassName() {
  return "mt-2 break-words text-lg font-bold sm:text-xl";
}

function subTextClassName() {
  return "mt-2 text-xs text-slate-500";
}

function deltaTextClassName(value: number, inverse = false) {
  return `mt-1 text-xs font-medium ${deltaColor(value, inverse)}`;
}

function getSortValue(row: any, sortKey: SortKey, totalMarginProfit: number) {
  if (sortKey === "penaltiesAndDeductions") {
    return row.penaltiesAmount + row.deductions;
  }

  if (sortKey === "profitSharePercent") {
    return totalMarginProfit !== 0
      ? (row.marginProfit / totalMarginProfit) * 100
      : 0;
  }

  if (sortKey === "abcByProfit") {
    const order = { A: 1, B: 2, C: 3 };
    return order[row.abcByProfit as "A" | "B" | "C"] ?? 99;
  }

  return Number(row[sortKey] ?? 0);
}

export default async function ProfitOzonPage({
  searchParams,
}: {
searchParams?: Promise<{
  dateFrom?: string;
  dateTo?: string;
  usnRate?: string;
  vatRate?: string;
  companyName?: string;
  sort?: string;
  dir?: string;
}>;
}) {
  const params = await searchParams;

  const usnRate = params?.usnRate ?? "1";
  const vatRate = params?.vatRate ?? "5";
const companyName = params?.companyName ?? "ALL";

  const sort = (params?.sort ?? "marginProfit") as SortKey;
  const dir = (params?.dir === "asc" ? "asc" : "desc") as SortDir;

  const { rows, totals, comparison } = await getProfitAnalyticsOzon({
  dateFrom: params?.dateFrom,
  dateTo: params?.dateTo,
  usnRate,
  vatRate,
  companyName,
});

  const otherDeductions = totals.penaltiesAmount + totals.deductions;

  const sortedRows = [...rows].sort((a, b) => {
    const aValue = getSortValue(a, sort, totals.marginProfit);
    const bValue = getSortValue(b, sort, totals.marginProfit);

    if (dir === "asc") return aValue - bValue;
    return bValue - aValue;
  });

  function sortHref(sortKey: SortKey) {
    const nextDir: SortDir = sort === sortKey && dir === "desc" ? "asc" : "desc";

    const query = new URLSearchParams();

    query.set("dateFrom", params?.dateFrom ?? "2026-05-18");
    query.set("dateTo", params?.dateTo ?? "2026-05-24");
    query.set("usnRate", usnRate);
    query.set("vatRate", vatRate);
    query.set("companyName", companyName);
    query.set("sort", sortKey);
    query.set("dir", nextDir);

    return `/profit-ozon?${query.toString()}`;
  }

  function SortHeader({
    label,
    sortKey,
  }: {
    label: string;
    sortKey: SortKey;
  }) {
    const active = sort === sortKey;

    return (
      <Link
        href={sortHref(sortKey)}
        className={`inline-flex items-center gap-1 font-semibold hover:text-slate-950 ${
          active ? "text-slate-950" : "text-slate-600"
        }`}
      >
        {label}
        {active ? (dir === "desc" ? "↓" : "↑") : ""}
      </Link>
    );
  }

  return (
    <main className="min-h-screen bg-slate-100">
  <MarketplaceNav />

  <div className="p-8">
      <div className="mx-auto max-w-[1800px] space-y-6">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">
            Прибыль Ozon по SKU
          </h1>

          <p className="mt-2 text-slate-600">
            Unit economics по Ozon с учетом начислений маркетплейса,
            себестоимости, рекламы и налогов.
          </p>
        </div>

        <form className="grid gap-4 rounded-2xl bg-white p-6 shadow-sm md:grid-cols-4">
          <input type="hidden" name="sort" value={sort} />
          <input type="hidden" name="dir" value={dir} />

          <div>
            <label className="mb-2 block text-sm font-medium text-slate-700">
              Дата от
            </label>

            <input
              type="date"
              name="dateFrom"
              defaultValue={params?.dateFrom ?? "2026-05-18"}
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
              defaultValue={params?.dateTo ?? "2026-05-24"}
              className="w-full rounded-xl border border-slate-300 px-4 py-2"
            />
          </div>

<div>
  <label className="mb-2 block text-sm font-medium text-slate-700">
    Компания
  </label>

  <select
    name="companyName"
    defaultValue={companyName}
    className="w-full rounded-xl border border-slate-300 px-4 py-2"
  >
    <option value="ALL">Все компании</option>
    <option value="ИП Петров">ИП Петров</option>
    <option value="ИП Лебедева">ИП Лебедева</option>
  </select>
</div>

          <div className="flex items-end">
            <button className="w-full rounded-xl bg-slate-900 px-4 py-2 font-medium text-white">
              Применить
            </button>
          </div>
        </form>

        <section className="grid gap-4 md:grid-cols-5 xl:grid-cols-10">
          <div className={cardClassName()}>
            <div className="text-sm text-slate-500">Выручка</div>
            <div className={valueClassName()}>{formatMoney(totals.revenue)}</div>
            <div className={deltaTextClassName(comparison.revenue.diff)}>
              {formatDelta(comparison.revenue.diff, comparison.revenue.diffPercent)}
            </div>
          </div>

          <div className={cardClassName()}>
            <div className="text-sm text-slate-500">Начислено продавцу</div>
            <div className={valueClassName()}>
              {formatMoney(totals.sellerPayout)}
            </div>
            <div className={subTextClassName()}>
              {formatShare(totals.sellerPayout, totals.revenue)}
            </div>
            <div className={deltaTextClassName(comparison.sellerPayout.diff)}>
              {formatDelta(
                comparison.sellerPayout.diff,
                comparison.sellerPayout.diffPercent
              )}
            </div>
          </div>

          <div className={cardClassName()}>
            <div className="text-sm text-slate-500">Себестоимость</div>
            <div className={valueClassName()}>{formatMoney(totals.totalCost)}</div>
            <div className={subTextClassName()}>
              {formatShare(totals.totalCost, totals.revenue)}
            </div>
            <div className={deltaTextClassName(comparison.totalCost.diff, true)}>
              {formatDelta(
                comparison.totalCost.diff,
                comparison.totalCost.diffPercent
              )}
            </div>
          </div>

          <div className={cardClassName()}>
            <div className="text-sm text-slate-500">Комиссия Ozon</div>
            <div className={valueClassName()}>
              {formatMoney(totals.wbCommission)}
            </div>
            <div className={subTextClassName()}>
              {formatShare(totals.wbCommission, totals.revenue)}
            </div>
            <div className={deltaTextClassName(comparison.wbCommission.diff, true)}>
              {formatDelta(
                comparison.wbCommission.diff,
                comparison.wbCommission.diffPercent
              )}
            </div>
          </div>

          <div className={cardClassName()}>
            <div className="text-sm text-slate-500">Логистика</div>
            <div className={valueClassName()}>
              {formatMoney(totals.logisticsCost)}
            </div>
            <div className={subTextClassName()}>
              {formatShare(totals.logisticsCost, totals.revenue)}
            </div>
            <div className={deltaTextClassName(comparison.logisticsCost.diff, true)}>
              {formatDelta(
                comparison.logisticsCost.diff,
                comparison.logisticsCost.diffPercent
              )}
            </div>
          </div>

          <div className={cardClassName()}>
            <div className="text-sm text-slate-500">
  Прочие удержания / сторно
</div>

<div
  className={`${valueClassName()} ${
    otherDeductions < 0
      ? "text-emerald-600"
      : "text-red-600"
  }`}
>
  {otherDeductions < 0
    ? `+${formatMoney(Math.abs(otherDeductions))}`
    : formatMoney(otherDeductions)}
</div>
            <div className={subTextClassName()}>
              {formatShare(otherDeductions, totals.revenue)}
            </div>
          </div>

          <div className={cardClassName()}>
            <div className="text-sm text-slate-500">Реклама Ozon</div>
            <div className={valueClassName()}>{formatMoney(totals.adsCost)}</div>
            <div className={subTextClassName()}>
              {formatShare(totals.adsCost, totals.revenue)}
            </div>
            <div className={deltaTextClassName(comparison.adsCost.diff, true)}>
              {formatDelta(comparison.adsCost.diff, comparison.adsCost.diffPercent)}
            </div>
          </div>

          <div className={cardClassName()}>
            <div className="text-sm text-slate-500">Маржинальная прибыль</div>
            <div className={`${valueClassName()} ${profitColor(totals.marginProfit)}`}>
              {formatMoney(totals.marginProfit)}
            </div>
            <div className={subTextClassName()}>
              {formatPercent(totals.marginProfitPercent)}
            </div>
            <div className={deltaTextClassName(comparison.marginProfit.diff)}>
              {formatDelta(
                comparison.marginProfit.diff,
                comparison.marginProfit.diffPercent
              )}
            </div>
          </div>

          <div className={cardClassName()}>
            <div className="text-sm text-slate-500">Налоги</div>
            <div className={valueClassName()}>{formatMoney(totals.taxesAmount)}</div>
            <div className={subTextClassName()}>
              {formatShare(totals.taxesAmount, totals.revenue)}
            </div>
            <div className={deltaTextClassName(comparison.taxesAmount.diff, true)}>
              {formatDelta(
                comparison.taxesAmount.diff,
                comparison.taxesAmount.diffPercent
              )}
            </div>
          </div>
        </section>

        <section className="grid gap-4 md:grid-cols-2">
          <div className={cardClassName()}>
            <div className="text-sm text-slate-500">Прибыль после налогов</div>
            <div
              className={`${valueClassName()} ${profitColor(
                totals.netProfitAfterTax
              )}`}
            >
              {formatMoney(totals.netProfitAfterTax)}
            </div>
            <div className={subTextClassName()}>
              {formatPercent(totals.marginAfterTaxPercent)}
            </div>
            <div className={deltaTextClassName(comparison.netProfitAfterTax.diff)}>
              {formatDelta(
                comparison.netProfitAfterTax.diff,
                comparison.netProfitAfterTax.diffPercent
              )}
            </div>
          </div>

          <div className={cardClassName()}>
            <div className="text-sm text-slate-500">Маржа после налогов</div>
            <div
              className={`${valueClassName()} ${profitColor(
                totals.marginAfterTaxPercent
              )}`}
            >
              {formatPercent(totals.marginAfterTaxPercent)}
            </div>
          </div>
        </section>

        <section className="overflow-hidden rounded-2xl bg-white shadow-sm">
          <div className="border-b border-slate-200 p-6">
            <h2 className="text-xl font-bold text-slate-900">
              Сводная таблица Ozon по артикулам
            </h2>

            <p className="mt-1 text-sm text-slate-500">
              Клик по заголовку сортирует таблицу по выбранному показателю.
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[1650px] border-collapse text-sm">
              <thead className="sticky top-0 bg-slate-100 text-left text-slate-700">
                <tr>
                  <th className="p-3">
                    <SortHeader label="ABC" sortKey="abcByProfit" />
                  </th>
                  <th className="p-3">SKU Ozon</th>
                  <th className="p-3">Артикул</th>
                  <th className="p-3 text-right">
                    <SortHeader label="Продажи" sortKey="netSalesQty" />
                  </th>
                  <th className="p-3 text-right">
                    <SortHeader label="Выручка" sortKey="revenue" />
                  </th>
                  <th className="p-3 text-right">
                    <SortHeader label="Доля выр." sortKey="revenueSharePercent" />
                  </th>
                  <th className="p-3 text-right">
                    <SortHeader label="Начислено" sortKey="sellerPayout" />
                  </th>
                  <th className="p-3 text-right">
                    <SortHeader label="Комиссия" sortKey="wbCommission" />
                  </th>
                  <th className="p-3 text-right">
                    <SortHeader label="Логистика" sortKey="logisticsCost" />
                  </th>
                  <th className="p-3 text-right">
                    <SortHeader
                      label="Удерж./сторно"
                      sortKey="penaltiesAndDeductions"
                    />
                  </th>
                  <th className="p-3 text-right">
                    <SortHeader label="Реклама" sortKey="adsCost" />
                  </th>
                  <th className="p-3 text-right">
                    <SortHeader label="ДРР" sortKey="drrPercent" />
                  </th>
                  <th className="p-3 text-right">
                    <SortHeader label="Себес." sortKey="totalCost" />
                  </th>
                  <th className="p-3 text-right">
                    <SortHeader label="Налоги" sortKey="taxesAmount" />
                  </th>
                  <th className="p-3 text-right">
                    <SortHeader label="Марж. прибыль" sortKey="marginProfit" />
                  </th>
                  <th className="p-3 text-right">
                    <SortHeader label="Доля прибыли" sortKey="profitSharePercent" />
                  </th>
                  <th className="p-3 text-right">
                    <SortHeader label="После налогов" sortKey="netProfitAfterTax" />
                  </th>
                  <th className="p-3 text-right">
                    <SortHeader label="Маржа" sortKey="marginAfterTaxPercent" />
                  </th>
                </tr>
              </thead>

              <tbody>
                {sortedRows.map((row) => {
                  const profitSharePercent =
                    totals.marginProfit !== 0
                      ? (row.marginProfit / totals.marginProfit) * 100
                      : 0;

                  return (
                    <tr
                      key={`${row.nmId}-${row.vendorCode}`}
                      className="border-t border-slate-100 hover:bg-slate-50"
                    >
                      <td className="p-3 font-bold">{row.abcByProfit}</td>
                      <td className="p-3 text-slate-600">{row.nmId || "—"}</td>
                      <td className="p-3 font-medium">{row.vendorCode || "—"}</td>
                      <td className="p-3 text-right">
                        {formatNumber(row.netSalesQty)}
                      </td>
                      <td className="p-3 text-right">
                        {formatMoney(row.revenue)}
                      </td>
                      <td className="p-3 text-right">
                        {formatPercent(row.revenueSharePercent)}
                      </td>
                      <td className="p-3 text-right">
                        {formatMoney(row.sellerPayout)}
                      </td>
                      <td className="p-3 text-right">
                        {formatMoney(row.wbCommission)}
                      </td>
                      <td className="p-3 text-right">
                        {formatMoney(row.logisticsCost)}
                      </td>
                      <td className="p-3 text-right">
                        {formatMoney(row.penaltiesAmount + row.deductions)}
                      </td>
                      <td className="p-3 text-right font-medium">
                        {formatMoney(row.adsCost)}
                      </td>
                      <td className="p-3 text-right font-medium">
                        {formatPercent(row.drrPercent)}
                      </td>
                      <td className="p-3 text-right">
                        {formatMoney(row.totalCost)}
                      </td>
                      <td className="p-3 text-right font-medium">
                        {formatMoney(row.taxesAmount)}
                      </td>
                      <td
                        className={`p-3 text-right font-bold ${profitColor(
                          row.marginProfit
                        )}`}
                      >
                        {formatMoney(row.marginProfit)}
                      </td>
                      <td
                        className={`p-3 text-right font-bold ${profitColor(
                          profitSharePercent
                        )}`}
                      >
                        {formatPercent(profitSharePercent)}
                      </td>
                      <td
                        className={`p-3 text-right font-bold ${profitColor(
                          row.netProfitAfterTax
                        )}`}
                      >
                        {formatMoney(row.netProfitAfterTax)}
                      </td>
                      <td
                        className={`p-3 text-right font-bold ${profitColor(
                          row.marginAfterTaxPercent
                        )}`}
                      >
                        {formatPercent(row.marginAfterTaxPercent)}
                      </td>
                    </tr>
                  );
                })}

                {sortedRows.length === 0 && (
                  <tr>
                    <td colSpan={18} className="p-8 text-center text-slate-500">
                      Нет данных для расчета прибыли. Загрузите Ozon Finance,
                      Ozon Ads и ProductCost.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

     </div>
    </main>
  );
}