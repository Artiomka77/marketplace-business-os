import { prisma } from "@/lib/prisma";
import { getDefaultLastCompletedWeekRange } from "@/lib/date/defaultPeriod";
import type { getProfitAnalytics } from "@/lib/analytics/profitAnalytics";
import type { getProfitAnalyticsOzon } from "@/lib/analytics/profitAnalyticsOzon";
import {
  createWaveCProfitRepository,
  deriveInsightClassifications,
  deriveInsightSkuRows,
  loadWaveCCompanyProfitPair,
  type OzonAnalytics,
  type WbAnalytics,
} from "@/lib/waveC/insightsAbcAdapter";

type InsightsFinancialCoreWb = typeof getProfitAnalytics;
type InsightsFinancialCoreOzon = typeof getProfitAnalyticsOzon;
export type InsightsWaveCPayload = {
  wb: Awaited<ReturnType<InsightsFinancialCoreWb>>;
  ozon: Awaited<ReturnType<InsightsFinancialCoreOzon>>;
};

function formatMoney(value: unknown) {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0,
  }).format(Number(value ?? 0));
}

function formatNumber(value: unknown) {
  return new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: 0,
  }).format(Number(value ?? 0));
}

function formatPercent(value: number) {
  if (!Number.isFinite(value)) return "—";
  return `${value.toFixed(1)}%`;
}

function getAmount(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function normalizeVendorCode(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[‐-‒–—−]/g, "-")
    .replace(/\s+/g, "")
    .trim();
}

function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function endOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

function toInputDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

type InsightRow = {
  companyName: string;
  marketplace: "WB" | "Ozon";
  sku: string;
  vendorCode: string;
  salesQty: number;
  revenue: number;
  profit: number;
  marginPercent: number;
};

type StockRow = {
  companyName: string;
  marketplace: "WB" | "Ozon";
  sku: string;
  vendorCode: string;
  quantity: number;
  unitCost: number;
  frozenMoney: number;
};

function getAnyNumber(row: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = getAmount(row[key]);

    if (value !== 0) {
      return value;
    }
  }

  return 0;
}

function getAnyString(row: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = String(row[key] ?? "").trim();

    if (value) {
      return value;
    }
  }

  return "";
}

function MetricCard({
  title,
  value,
  subtitle,
  className = "text-slate-900",
}: {
  title: string;
  value: string;
  subtitle?: string;
  className?: string;
}) {
  return (
    <div className="rounded-2xl bg-white p-5 shadow-sm">
      <div className="text-sm text-slate-500">{title}</div>
      <div className={`mt-2 text-3xl font-bold ${className}`}>{value}</div>

      {subtitle && (
        <div className="mt-2 text-sm font-semibold text-slate-500">
          {subtitle}
        </div>
      )}
    </div>
  );
}

function SkuTable({
  title,
  rows,
  emptyText,
}: {
  title: string;
  rows: InsightRow[];
  emptyText: string;
}) {
  return (
    <section className="overflow-hidden rounded-2xl bg-white shadow-sm">
      <div className="border-b border-slate-200 p-5">
        <h2 className="text-2xl font-bold text-slate-900">{title}</h2>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[1000px] text-sm">
          <thead className="bg-slate-100 text-left text-slate-700">
            <tr>
              <th className="p-3">Компания</th>
              <th className="p-3">МП</th>
              <th className="p-3">Артикул</th>
              <th className="p-3 text-right">Продажи</th>
              <th className="p-3 text-right">Выручка</th>
              <th className="p-3 text-right">Прибыль</th>
              <th className="p-3 text-right">Маржа после налогов</th>
            </tr>
          </thead>

          <tbody>
            {rows.map((row, index) => (
              <tr
                key={`${row.companyName}-${row.marketplace}-${row.sku}-${row.vendorCode}-${index}`}
                className="border-t border-slate-100"
              >
                <td className="p-3">{row.companyName}</td>
                <td className="p-3">{row.marketplace}</td>
                <td className="p-3 font-semibold">{row.vendorCode || "—"}</td>
                <td className="p-3 text-right">{formatNumber(row.salesQty)}</td>
                <td className="p-3 text-right">{formatMoney(row.revenue)}</td>
                <td
                  className={`p-3 text-right font-bold ${
                    row.profit >= 0 ? "text-emerald-600" : "text-red-600"
                  }`}
                >
                  {formatMoney(row.profit)}
                </td>
                <td
                  className={`p-3 text-right font-bold ${
                    row.marginPercent >= 0 ? "text-emerald-600" : "text-red-600"
                  }`}
                >
                  {formatPercent(row.marginPercent)}
                </td>
              </tr>
            ))}

            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="p-8 text-center text-slate-500">
                  {emptyText}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function StockTable({ rows }: { rows: StockRow[] }) {
  return (
    <section className="overflow-hidden rounded-2xl bg-white shadow-sm">
      <div className="border-b border-slate-200 p-5">
        <h2 className="text-2xl font-bold text-slate-900">
          Замороженные деньги в остатках
        </h2>

        <p className="mt-2 text-sm text-slate-500">
          Расчёт приблизительный: остаток × себестоимость из ProductCost.
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[1000px] text-sm">
          <thead className="bg-slate-100 text-left text-slate-700">
            <tr>
              <th className="p-3">Компания</th>
              <th className="p-3">МП</th>
              <th className="p-3">Артикул</th>
              <th className="p-3 text-right">Остаток</th>
              <th className="p-3 text-right">Себестоимость</th>
              <th className="p-3 text-right">Заморожено</th>
            </tr>
          </thead>

          <tbody>
            {rows.map((row, index) => (
              <tr
                key={`${row.companyName}-${row.marketplace}-${row.sku}-${row.vendorCode}-${index}`}
                className="border-t border-slate-100"
              >
                <td className="p-3">{row.companyName}</td>
                <td className="p-3">{row.marketplace}</td>
                <td className="p-3 font-semibold">{row.vendorCode || "—"}</td>
                <td className="p-3 text-right">{formatNumber(row.quantity)}</td>
                <td className="p-3 text-right">{formatMoney(row.unitCost)}</td>
                <td className="p-3 text-right font-bold text-red-600">
                  {formatMoney(row.frozenMoney)}
                </td>
              </tr>
            ))}

            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="p-8 text-center text-slate-500">
                  Нет данных по остаткам или себестоимости.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function InsightsReadModelPending({
  reason,
  dateFrom,
  dateTo,
}: {
  reason: string;
  dateFrom: string;
  dateTo: string;
}) {
  return (
    <main
      className="min-h-screen bg-slate-100 p-4 sm:p-6 lg:p-8"
      data-wave-c-source="PROFIT_READ_MODEL_MISS"
      data-wave-c-heavy-fc-calls="0"
      data-insights-data-mode="PENDING"
      data-testid="insights-readmodel-pending"
    >
      <div className="mx-auto max-w-[1700px] space-y-6">
        <div>
          <h1 className="text-4xl font-bold text-slate-900">
            Центр прибыли / Insights 2.0
          </h1>
          <p className="mt-3 text-slate-500">
            Обычный запрос не запускает тяжёлый Financial Core. Период {dateFrom}{" "}
            — {dateTo} сейчас в статусе PENDING/UNAVAILABLE ({reason}).
          </p>
        </div>
      </div>
    </main>
  );
}

export default async function InsightsPage({
  searchParams,
}: {
  searchParams?: Promise<{
    company?: string;
    dateFrom?: string;
    dateTo?: string;
  }>;
}) {
  const params = searchParams ? await searchParams : {};
  const now = new Date();

  const defaultPeriod = getDefaultLastCompletedWeekRange();
  const dateFrom = params.dateFrom ?? defaultPeriod.dateFrom;
  const dateTo = params.dateTo ?? defaultPeriod.dateTo;
  const selectedCompany = params.company ?? "ALL";

  const companies = await prisma.company.findMany({
    where: { isActive: true },
    orderBy: { name: "asc" },
  });

  const companyNames =
    selectedCompany === "ALL"
      ? companies.map((company) => company.name)
      : [selectedCompany];

  const repository = createWaveCProfitRepository();
  const analyticsByCompany: Array<{
    companyName: string;
    wb: WbAnalytics;
    ozon: OzonAnalytics;
    wbUnavailable: boolean;
    dataMode: string;
    costIncomplete: boolean;
  }> = [];
  for (const companyName of companyNames) {
    const loaded = await loadWaveCCompanyProfitPair({
      companyName,
      dateFrom,
      dateTo,
      repository,
    });
    if (loaded.status !== "HIT") {
      return (
        <InsightsReadModelPending
          reason={loaded.reason}
          dateFrom={dateFrom}
          dateTo={dateTo}
        />
      );
    }
    analyticsByCompany.push({
      companyName,
      wb: loaded.wb,
      ozon: loaded.ozon,
      wbUnavailable: loaded.wbUnavailable,
      dataMode: loaded.insightsCostIncomplete
        ? "PRELIMINARY"
        : loaded.insightsDataMode,
      costIncomplete: loaded.insightsCostIncomplete,
    });
  }

  const productCosts = await prisma.productCost.findMany({
    orderBy: [{ costDate: "desc" }, { createdAt: "desc" }],
  });

  const wbStocks = await prisma.wbStock.findMany({
    where: selectedCompany !== "ALL" ? { companyName: selectedCompany } : {},
  });

  const ozonStocks = await prisma.ozonStock.findMany({
    where: selectedCompany !== "ALL" ? { companyName: selectedCompany } : {},
  });

  const costByVendorCode = new Map<string, number>();

  for (const cost of productCosts) {
    const key = normalizeVendorCode(cost.vendorCode);

    if (key && !costByVendorCode.has(key)) {
      costByVendorCode.set(key, getAmount(cost.costPrice));
    }
  }

  const wbUnavailable = analyticsByCompany.some((item) => item.wbUnavailable);
  const costIncomplete = analyticsByCompany.some((item) => item.costIncomplete);

  const rows: InsightRow[] = deriveInsightSkuRows(analyticsByCompany);
  const {
    profitableRows,
    lossRows,
    lowMarginRows,
    totalRevenue,
    totalProfit,
    lossSkuCount,
  } = deriveInsightClassifications(rows);

  const stockRows: StockRow[] = [
    ...wbStocks.map((stock) => {
      const row = stock as unknown as Record<string, unknown>;

      const vendorCode = getAnyString(row, [
        "vendorCode",
        "supplierArticle",
        "article",
        "sku",
      ]);

      const quantity = getAnyNumber(row, [
        "quantity",
        "qty",
        "stockQty",
        "availableQty",
        "available",
        "quantityFull",
      ]);

      const unitCost = costByVendorCode.get(normalizeVendorCode(vendorCode)) ?? 0;

      return {
        companyName: getAnyString(row, ["companyName"]) || "—",
        marketplace: "WB" as const,
        sku: getAnyString(row, ["nmId", "sku", "barcode"]),
        vendorCode,
        quantity,
        unitCost,
        frozenMoney: quantity * unitCost,
      };
    }),

    ...ozonStocks.map((stock) => {
      const row = stock as unknown as Record<string, unknown>;

      const vendorCode = getAnyString(row, [
        "vendorCode",
        "offerId",
        "article",
        "sku",
      ]);

      const quantity = getAnyNumber(row, [
        "quantity",
        "qty",
        "stockQty",
        "availableQty",
        "available",
        "availableToSell",
      ]);

      const unitCost = costByVendorCode.get(normalizeVendorCode(vendorCode)) ?? 0;

      return {
        companyName: getAnyString(row, ["companyName"]) || "—",
        marketplace: "Ozon" as const,
        sku: getAnyString(row, ["sku", "productId", "barcode"]),
        vendorCode,
        quantity,
        unitCost,
        frozenMoney: quantity * unitCost,
      };
    }),
  ]
    .filter((row) => row.quantity > 0 && row.unitCost > 0)
    .sort((a, b) => b.frozenMoney - a.frozenMoney);

  const frozenMoney = stockRows.reduce((sum, row) => sum + row.frozenMoney, 0);
  const topFrozenRows = stockRows.slice(0, 20);
  const insightsDataMode = wbUnavailable
    ? "UNAVAILABLE"
    : costIncomplete
      ? "PRELIMINARY"
      : analyticsByCompany.length > 0 &&
          analyticsByCompany.every((row) => row.dataMode === "FINAL")
        ? "FINAL"
        : "PRELIMINARY";

  const recommendations = wbUnavailable
    ? [
        "Финансовые данные WB за выбранный период неполны. Рекомендации по прибыли WB не формируются из нулей.",
        frozenMoney > 0
          ? `В остатках заморожено примерно ${formatMoney(
              frozenMoney
            )}. Это оценка запасов, не финансовый результат периода.`
          : "По остаткам пока нет расчёта замороженных денег.",
      ]
    : [
    lossSkuCount > 0
      ? `Проверить ${lossSkuCount} убыточных SKU: отключить рекламу, поднять цену или вывести из ассортимента.`
      : "Убыточных SKU в выбранном периоде не найдено.",

    lowMarginRows.length > 0
      ? `${lowMarginRows.length} SKU имеют маржу ниже 5%. Это зона риска.`
      : "SKU с критически низкой маржой не найдено.",

    frozenMoney > 0
      ? `В остатках заморожено примерно ${formatMoney(
          frozenMoney
        )}. Проверь товары с максимальной суммой зависших денег.`
      : "По остаткам пока нет расчёта замороженных денег.",

    profitableRows.length > 0
      ? `ТОП-${profitableRows.length} прибыльных SKU стоит рассмотреть для масштабирования.`
      : "Прибыльных SKU в выбранном периоде не найдено.",
  ];

  return (
    <main
      className="min-h-screen bg-slate-100 p-4 sm:p-6 lg:p-8"
      data-insights-wb-pnl-availability={wbUnavailable ? "unavailable" : "available"}
      data-insights-combined-complete={
        wbUnavailable || costIncomplete ? "no" : "yes"
      }
      data-wave-c-source="PROFIT_READ_MODEL_HIT"
      data-wave-c-heavy-fc-calls="0"
      data-insights-data-mode={insightsDataMode}
    >
      <div className="mx-auto max-w-[1700px] space-y-6">
        <div>
          <h1 className="text-4xl font-bold text-slate-900">
            Центр прибыли / Insights 2.0
          </h1>

          <p className="mt-3 text-slate-500">
            Быстрый управленческий обзор: где бизнес зарабатывает, где теряет
            деньги и какие товары требуют внимания.
          </p>
          <div
            className={`mt-3 inline-flex rounded-2xl border px-3 py-2 text-xs font-black ${
              insightsDataMode === "FINAL"
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border-amber-200 bg-amber-50 text-amber-800"
            }`}
          >
            {insightsDataMode === "FINAL"
              ? "Период FINAL"
              : insightsDataMode === "UNAVAILABLE"
                ? "WB финансовые данные неполны"
                : "Период PRELIMINARY"}
          </div>
        </div>

        <form className="rounded-2xl bg-white p-5 shadow-sm">
          <div className="grid gap-4 md:grid-cols-4">
            <div>
              <label className="mb-1 block text-sm text-slate-500">
                Компания
              </label>

              <select
                name="company"
                defaultValue={selectedCompany}
                className="w-full rounded-xl border border-slate-300 px-4 py-2"
              >
                <option value="ALL">Все компании</option>

                {companies.map((company) => (
                  <option key={company.id} value={company.name}>
                    {company.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-1 block text-sm text-slate-500">
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
              <label className="mb-1 block text-sm text-slate-500">
                Дата до
              </label>

              <input
                type="date"
                name="dateTo"
                defaultValue={dateTo}
                className="w-full rounded-xl border border-slate-300 px-4 py-2"
              />
            </div>

            <div className="flex items-end">
              <button className="w-full rounded-xl bg-slate-900 px-4 py-2 font-semibold text-white">
                Применить
              </button>
            </div>
          </div>
        </form>

        {wbUnavailable ? (
          <section
            data-testid="insights-wb-pnl-unavailable"
            data-wb-pnl-availability="unavailable"
            className="rounded-2xl border border-amber-300 bg-amber-50 p-5 text-sm text-amber-950"
          >
            <div className="font-bold">
              Финансовые данные WB за выбранный период неполны.
            </div>
            <div className="mt-2 leading-6">
              Сводная выручка и прибыль WB+Ozon недоступны. Ozon ниже показан отдельно
              и не заменяет полный финансовый результат периода.
            </div>
          </section>
        ) : null}

        {costIncomplete ? (
          <section
            data-testid="insights-cost-incomplete"
            className="rounded-2xl border border-amber-300 bg-amber-50 p-5 text-sm text-amber-950"
          >
            <div className="font-bold">
              Себестоимость неполная — прибыль предварительная/неполная
            </div>
            <div className="mt-2 leading-6">
              Прибыль и маржа маркетплейсов после налогов не считаются финальными,
              пока покрытие себестоимости неполное.
            </div>
          </section>
        ) : null}

        <section className="grid gap-4 md:grid-cols-4">
          <MetricCard
            title="Выручка"
            value={wbUnavailable ? "недоступно" : formatMoney(totalRevenue)}
            subtitle={wbUnavailable ? "WB неполны, combined недоступен" : "WB + Ozon"}
            className="text-emerald-600"
          />

          <MetricCard
            title="Прибыль маркетплейсов после налогов"
            value={wbUnavailable ? "недоступно" : formatMoney(totalProfit)}
            subtitle={
              wbUnavailable
                ? "WB неполны — combined прибыль недоступна"
                : costIncomplete
                  ? `Маржа после налогов (предварительно): ${formatPercent(
                      totalRevenue ? (totalProfit / totalRevenue) * 100 : 0
                    )}`
                  : `Маржа после налогов: ${formatPercent(
                      totalRevenue ? (totalProfit / totalRevenue) * 100 : 0
                    )}`
            }
            className={
              wbUnavailable
                ? "text-amber-700"
                : totalProfit >= 0
                  ? "text-emerald-600"
                  : "text-red-600"
            }
          />

          <MetricCard
            title="Убыточные SKU"
            value={wbUnavailable ? "недоступно" : formatNumber(lossSkuCount)}
            subtitle={
              wbUnavailable
                ? "WB P&L недоступен"
                : "Товары с отрицательной прибылью"
            }
            className={
              wbUnavailable
                ? "text-amber-700"
                : lossSkuCount > 0
                  ? "text-red-600"
                  : "text-emerald-600"
            }
          />

          <MetricCard
            title="Заморожено в остатках"
            value={formatMoney(frozenMoney)}
            subtitle="Остаток × себестоимость"
            className={frozenMoney > 0 ? "text-red-600" : "text-slate-900"}
          />
        </section>

        <section className="rounded-2xl bg-white p-5 shadow-sm">
          <h2 className="text-2xl font-bold text-slate-900">
            Рекомендации руководителю
          </h2>

          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {recommendations.map((recommendation) => (
              <div
                key={recommendation}
                className="rounded-xl border border-slate-200 p-4 text-sm font-semibold text-slate-700"
              >
                {recommendation}
              </div>
            ))}
          </div>
        </section>

        {wbUnavailable ? null : (
          <>
        <SkuTable
          title="ТОП-20 прибыльных SKU"
          rows={profitableRows}
          emptyText="Прибыльных SKU не найдено."
        />

        <SkuTable
          title="ТОП-20 убыточных SKU"
          rows={lossRows}
          emptyText="Убыточных SKU не найдено."
        />

        <SkuTable
          title="Зона риска: маржа ниже 5%"
          rows={lowMarginRows}
          emptyText="SKU с низкой маржой не найдено."
        />
          </>
        )}

        <StockTable rows={topFrozenRows} />
      </div>
    </main>
  );
}
