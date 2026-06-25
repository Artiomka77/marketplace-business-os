import { prisma } from "@/lib/prisma";
import { getProfitAnalytics } from "@/lib/analytics/profitAnalytics";
import { getProfitAnalyticsOzon } from "@/lib/analytics/profitAnalyticsOzon";

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
              <th className="p-3 text-right">Чистая маржа</th>
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

  const dateFrom = params.dateFrom ?? toInputDate(startOfMonth(now));
  const dateTo = params.dateTo ?? toInputDate(endOfMonth(now));
  const selectedCompany = params.company ?? "ALL";

  const companies = await prisma.company.findMany({
    where: { isActive: true },
    orderBy: { name: "asc" },
  });

  const companyNames =
    selectedCompany === "ALL"
      ? companies.map((company) => company.name)
      : [selectedCompany];

  const [analyticsByCompany, productCosts, wbStocks, ozonStocks] =
    await Promise.all([
      Promise.all(
        companyNames.map(async (companyName) => {
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
      ),

      prisma.productCost.findMany({
        orderBy: [{ costDate: "desc" }, { createdAt: "desc" }],
      }),

      prisma.wbStock.findMany({
        where: selectedCompany !== "ALL" ? { companyName: selectedCompany } : {},
      }),

      prisma.ozonStock.findMany({
        where: selectedCompany !== "ALL" ? { companyName: selectedCompany } : {},
      }),
    ]);

  const costByVendorCode = new Map<string, number>();

  for (const cost of productCosts) {
    const key = normalizeVendorCode(cost.vendorCode);

    if (key && !costByVendorCode.has(key)) {
      costByVendorCode.set(key, getAmount(cost.costPrice));
    }
  }

  const rows: InsightRow[] = analyticsByCompany.flatMap(
    ({ companyName, wb, ozon }) => [
      ...wb.rows.map((row) => {
        const revenue = getAmount(row.revenue);
        const profit = getAmount(row.netProfitAfterTax);

        return {
          companyName,
          marketplace: "WB" as const,
          sku: String(row.nmId ?? ""),
          vendorCode: String(row.vendorCode ?? ""),
          salesQty: getAmount(row.netSalesQty),
          revenue,
          profit,
          marginPercent: revenue ? (profit / revenue) * 100 : 0,
        };
      }),

      ...ozon.rows.map((row) => {
        const revenue = getAmount(row.revenue);
        const profit = getAmount(row.netProfitAfterTax);

        return {
          companyName,
          marketplace: "Ozon" as const,
          sku: String(row.nmId ?? ""),
          vendorCode: String(row.vendorCode ?? ""),
          salesQty: getAmount(row.netSalesQty),
          revenue,
          profit,
          marginPercent: revenue ? (profit / revenue) * 100 : 0,
        };
      }),
    ]
  );

  const profitableRows = rows
    .filter((row) => row.profit > 0)
    .sort((a, b) => b.profit - a.profit)
    .slice(0, 20);

  const lossRows = rows
    .filter((row) => row.profit < 0)
    .sort((a, b) => a.profit - b.profit)
    .slice(0, 20);

  const lowMarginRows = rows
    .filter((row) => row.revenue > 0 && row.marginPercent < 5)
    .sort((a, b) => a.marginPercent - b.marginPercent)
    .slice(0, 20);

  const totalRevenue = rows.reduce((sum, row) => sum + row.revenue, 0);
  const totalProfit = rows.reduce((sum, row) => sum + row.profit, 0);
  const lossSkuCount = rows.filter((row) => row.profit < 0).length;

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

  const recommendations = [
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
    <main className="min-h-screen bg-slate-100 p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-[1700px] space-y-6">
        <div>
          <h1 className="text-4xl font-bold text-slate-900">
            Центр прибыли / Insights 2.0
          </h1>

          <p className="mt-3 text-slate-500">
            Быстрый управленческий обзор: где бизнес зарабатывает, где теряет
            деньги и какие товары требуют внимания.
          </p>
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

        <section className="grid gap-4 md:grid-cols-4">
          <MetricCard
            title="Выручка"
            value={formatMoney(totalRevenue)}
            subtitle="WB + Ozon"
            className="text-emerald-600"
          />

          <MetricCard
            title="Чистая прибыль"
            value={formatMoney(totalProfit)}
            subtitle={`Чистая маржа: ${formatPercent(
              totalRevenue ? (totalProfit / totalRevenue) * 100 : 0
            )}`}
            className={totalProfit >= 0 ? "text-emerald-600" : "text-red-600"}
          />

          <MetricCard
            title="Убыточные SKU"
            value={formatNumber(lossSkuCount)}
            subtitle="Товары с отрицательной прибылью"
            className={lossSkuCount > 0 ? "text-red-600" : "text-emerald-600"}
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

        <StockTable rows={topFrozenRows} />
      </div>
    </main>
  );
}