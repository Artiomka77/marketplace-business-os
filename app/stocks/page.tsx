import Link from "next/link";
import { prisma } from "@/lib/prisma";
import MarketplaceNav from "@/components/marketplaces/MarketplaceNav";

type StockSearchParams = {
  companyName?: string;
};

type CompanyStockSummary = {
  companyName: string;
  wb: {
    stockQty: number;
    inTransitToCustomerQty: number;
    inTransitReturnsQty: number;
    totalQty: number;
    rowsCount: number;
    latestDate: string;
  };
  ozon: {
    availableQty: number;
    preparingQty: number;
    supplyQty: number;
    inTransitQty: number;
    returnQty: number;
    totalQty: number;
    rowsCount: number;
    latestDate: string;
  };
  warehouse: {
    warehouseQty: number;
    reservedQty: number;
    availableForSupplyQty: number;
    rowsCount: number;
    latestDate: string;
  };
};

type UnifiedStockRow = {
  key: string;
  companyName: string;
  source: "WB" | "OZON" | "OWN";
  vendorCode: string;
  sku: string | null;
  barcode: string | null;
  size: string | null;
  warehouseName: string | null;
  clusterName: string | null;
  qty: number;
  reservedQty: number;
  availableForSupplyQty: number;
};

function formatNumber(value: number) {
  return Math.round(value).toLocaleString("ru-RU");
}

function formatDate(value?: Date | null) {
  return value ? value.toLocaleDateString("ru-RU") : "Нет данных";
}

function extractStockDate(fileName?: string | null, fallback?: Date | null) {
  const match = fileName?.match(/\d{4}_\d{1,2}_\d{1,2}/)?.[0];

  if (match) {
    const [year, month, day] = match.split("_");
    return `${day.padStart(2, "0")}.${month.padStart(2, "0")}.${year}`;
  }

  return formatDate(fallback);
}

function getLatestImportDateByCompany(params: {
  companyName: string;
  reportType: string;
  imports: Array<{
    companyName: string | null;
    reportType: string;
    fileName: string;
    createdAt: Date;
  }>;
}) {
  const latest = params.imports.find((item) => {
    return (
      item.companyName === params.companyName &&
      item.reportType === params.reportType
    );
  });

  if (!latest) return "Нет данных";

  return params.reportType === "WB_STOCK"
    ? extractStockDate(latest.fileName, latest.createdAt)
    : formatDate(latest.createdAt);
}

function getInventoryDateLabel(
  rows: Array<{
    companyName: string;
    inventoryDate: Date | null;
    createdAt: Date;
  }>,
  companyName: string
) {
  const companyRows = rows.filter((row) => row.companyName === companyName);

  const latestInventoryDate = companyRows
    .map((row) => row.inventoryDate)
    .filter((date): date is Date => Boolean(date))
    .sort((a, b) => b.getTime() - a.getTime())[0];

  if (latestInventoryDate) return formatDate(latestInventoryDate);

  const latestCreatedAt = companyRows
    .map((row) => row.createdAt)
    .filter(Boolean)
    .sort((a, b) => b.getTime() - a.getTime())[0];

  return formatDate(latestCreatedAt);
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function uniqCount(values: Array<string | null | undefined>) {
  return new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))
    .size;
}

function getSourceBadgeClass(source: UnifiedStockRow["source"]) {
  if (source === "WB") {
    return "bg-violet-50 text-violet-700 ring-violet-100";
  }

  if (source === "OZON") {
    return "bg-blue-50 text-blue-700 ring-blue-100";
  }

  return "bg-emerald-50 text-emerald-700 ring-emerald-100";
}

function getSourceLabel(source: UnifiedStockRow["source"]) {
  if (source === "WB") return "WB";
  if (source === "OZON") return "Ozon";
  return "Свой склад";
}

function MetricCard({
  title,
  value,
  hint,
  tone = "slate",
}: {
  title: string;
  value: string;
  hint: string;
  tone?: "slate" | "violet" | "blue" | "emerald" | "amber";
}) {
  const toneClasses = {
    slate: "bg-white text-slate-950 ring-slate-200",
    violet: "bg-violet-50 text-violet-950 ring-violet-100",
    blue: "bg-blue-50 text-blue-950 ring-blue-100",
    emerald: "bg-emerald-50 text-emerald-950 ring-emerald-100",
    amber: "bg-amber-50 text-amber-950 ring-amber-100",
  };

  return (
    <div className={`rounded-[28px] p-5 shadow-sm ring-1 ${toneClasses[tone]}`}>
      <div className="text-xs font-black uppercase tracking-[0.12em] text-slate-400">
        {title}
      </div>
      <div className="mt-3 text-3xl font-black tracking-tight">{value}</div>
      <div className="mt-2 text-sm font-semibold leading-5 text-slate-500">
        {hint}
      </div>
    </div>
  );
}

function SourceCard({
  title,
  subtitle,
  totalLabel,
  totalValue,
  secondaryItems,
  action,
}: {
  title: string;
  subtitle: string;
  totalLabel: string;
  totalValue: string;
  secondaryItems: Array<{
    label: string;
    value: string;
  }>;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-black tracking-tight text-slate-950">
            {title}
          </h3>
          <p className="mt-1 text-sm font-semibold leading-5 text-slate-500">
            {subtitle}
          </p>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>

      <div className="mt-5 rounded-3xl bg-slate-50 p-4 ring-1 ring-slate-100">
        <div className="text-xs font-black uppercase tracking-[0.12em] text-slate-400">
          {totalLabel}
        </div>
        <div className="mt-2 text-3xl font-black text-slate-950">
          {totalValue}
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {secondaryItems.map((item) => (
          <div
            key={item.label}
            className="rounded-2xl bg-white p-3 ring-1 ring-slate-200"
          >
            <div className="text-xs font-bold text-slate-400">{item.label}</div>
            <div className="mt-1 text-base font-black text-slate-900">
              {item.value}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default async function StocksPage({
  searchParams,
}: {
  searchParams?: Promise<StockSearchParams>;
}) {
  const params = searchParams ? await searchParams : {};

  const companies = await prisma.company.findMany({
    where: {
      isActive: true,
    },
    orderBy: {
      name: "asc",
    },
    select: {
      name: true,
    },
  });

  const companyNames = companies.map((company) => company.name);
  const selectedCompanyName =
    params.companyName && params.companyName !== "ALL"
      ? params.companyName
      : null;

  const visibleCompanyNames = selectedCompanyName
    ? companyNames.filter((companyName) => companyName === selectedCompanyName)
    : companyNames;

  const companyWhere =
    visibleCompanyNames.length > 0
      ? {
          in: visibleCompanyNames,
        }
      : undefined;

  const [wbStocks, ozonStocks, warehouseStocks, stockImports] =
    await Promise.all([
      prisma.wbStock.findMany({
        where: {
          companyName: companyWhere,
          warehouseName: "__TOTAL__",
        },
        orderBy: [{ companyName: "asc" }, { vendorCode: "asc" }, { size: "asc" }],
      }),
      prisma.ozonStock.findMany({
        where: {
          companyName: companyWhere,
        },
        orderBy: [
          { companyName: "asc" },
          { vendorCode: "asc" },
          { warehouseName: "asc" },
        ],
      }),
      prisma.ozonWarehouseStock.findMany({
        where: {
          companyName: companyWhere,
        },
        orderBy: [{ companyName: "asc" }, { vendorCode: "asc" }, { size: "asc" }],
      }),
      prisma.importSession.findMany({
        where: {
          reportType: {
            in: ["WB_STOCK", "OZON_STOCK", "OZON_WAREHOUSE_STOCK"],
          },
          ...(visibleCompanyNames.length > 0
            ? {
                companyName: {
                  in: visibleCompanyNames,
                },
              }
            : {}),
        },
        orderBy: {
          createdAt: "desc",
        },
        select: {
          companyName: true,
          reportType: true,
          fileName: true,
          createdAt: true,
        },
      }),
    ]);

  const summaries: CompanyStockSummary[] = visibleCompanyNames.map(
    (companyName) => {
      const companyWbStocks = wbStocks.filter(
        (stock) => stock.companyName === companyName
      );
      const companyOzonStocks = ozonStocks.filter(
        (stock) => stock.companyName === companyName
      );
      const companyWarehouseStocks = warehouseStocks.filter(
        (stock) => stock.companyName === companyName
      );

      const wbStockQty = sum(
        companyWbStocks.map((stock) => Number(stock.totalStock ?? 0))
      );
      const wbTransitToCustomerQty = sum(
        companyWbStocks.map((stock) => Number(stock.inTransitToCustomer ?? 0))
      );
      const wbTransitReturnsQty = sum(
        companyWbStocks.map((stock) => Number(stock.inTransitReturns ?? 0))
      );

      const ozonAvailableQty = sum(
        companyOzonStocks.map((stock) => Number(stock.availableQty ?? 0))
      );
      const ozonPreparingQty = sum(
        companyOzonStocks.map((stock) => Number(stock.preparingQty ?? 0))
      );
      const ozonSupplyQty = sum(
        companyOzonStocks.map((stock) => Number(stock.supplyQty ?? 0))
      );
      const ozonInTransitQty = sum(
        companyOzonStocks.map((stock) => Number(stock.inTransitQty ?? 0))
      );
      const ozonReturnQty = sum(
        companyOzonStocks.map((stock) => Number(stock.returnQty ?? 0))
      );

      const warehouseQty = sum(
        companyWarehouseStocks.map((stock) => Number(stock.warehouseQty ?? 0))
      );
      const reservedQty = sum(
        companyWarehouseStocks.map((stock) => Number(stock.reservedQty ?? 0))
      );
      const availableForSupplyQty = sum(
        companyWarehouseStocks.map((stock) =>
          Number(stock.availableForSupplyQty ?? 0)
        )
      );

      return {
        companyName,
        wb: {
          stockQty: wbStockQty,
          inTransitToCustomerQty: wbTransitToCustomerQty,
          inTransitReturnsQty: wbTransitReturnsQty,
          totalQty:
            wbStockQty + wbTransitToCustomerQty + wbTransitReturnsQty,
          rowsCount: companyWbStocks.length,
          latestDate: getLatestImportDateByCompany({
            companyName,
            reportType: "WB_STOCK",
            imports: stockImports,
          }),
        },
        ozon: {
          availableQty: ozonAvailableQty,
          preparingQty: ozonPreparingQty,
          supplyQty: ozonSupplyQty,
          inTransitQty: ozonInTransitQty,
          returnQty: ozonReturnQty,
          totalQty:
            ozonAvailableQty +
            ozonPreparingQty +
            ozonSupplyQty +
            ozonInTransitQty +
            ozonReturnQty,
          rowsCount: companyOzonStocks.length,
          latestDate: getLatestImportDateByCompany({
            companyName,
            reportType: "OZON_STOCK",
            imports: stockImports,
          }),
        },
        warehouse: {
          warehouseQty,
          reservedQty,
          availableForSupplyQty,
          rowsCount: companyWarehouseStocks.length,
          latestDate:
            getLatestImportDateByCompany({
              companyName,
              reportType: "OZON_WAREHOUSE_STOCK",
              imports: stockImports,
            }) !== "Нет данных"
              ? getLatestImportDateByCompany({
                  companyName,
                  reportType: "OZON_WAREHOUSE_STOCK",
                  imports: stockImports,
                })
              : getInventoryDateLabel(warehouseStocks, companyName),
        },
      };
    }
  );

  const totalWbQty = sum(summaries.map((summary) => summary.wb.totalQty));
  const totalOzonQty = sum(summaries.map((summary) => summary.ozon.totalQty));
  const totalWarehouseQty = sum(
    summaries.map((summary) => summary.warehouse.warehouseQty)
  );
  const totalAvailableForSupplyQty = sum(
    summaries.map((summary) => summary.warehouse.availableForSupplyQty)
  );
  const totalReservedQty = sum(
    summaries.map((summary) => summary.warehouse.reservedQty)
  );

  const unifiedRows: UnifiedStockRow[] = [
    ...wbStocks.slice(0, 80).map((stock) => {
      const qty =
        Number(stock.totalStock ?? 0) +
        Number(stock.inTransitToCustomer ?? 0) +
        Number(stock.inTransitReturns ?? 0);

      return {
        key: `wb-${stock.id}`,
        companyName: stock.companyName ?? "Без компании",
        source: "WB" as const,
        vendorCode: stock.vendorCode ?? "—",
        sku: stock.nmId ?? null,
        barcode: stock.barcode ?? null,
        size: stock.size ?? null,
        warehouseName: stock.warehouseName,
        clusterName: null,
        qty,
        reservedQty: 0,
        availableForSupplyQty: qty,
      };
    }),
    ...ozonStocks.slice(0, 80).map((stock) => {
      const qty =
        Number(stock.availableQty ?? 0) +
        Number(stock.preparingQty ?? 0) +
        Number(stock.supplyQty ?? 0) +
        Number(stock.inTransitQty ?? 0) +
        Number(stock.returnQty ?? 0);

      return {
        key: `ozon-${stock.id}`,
        companyName: stock.companyName ?? "Без компании",
        source: "OZON" as const,
        vendorCode: stock.vendorCode ?? "—",
        sku: stock.sku ?? null,
        barcode: null,
        size: null,
        warehouseName: stock.warehouseName,
        clusterName: stock.clusterName,
        qty,
        reservedQty: 0,
        availableForSupplyQty: Number(stock.availableQty ?? 0),
      };
    }),
    ...warehouseStocks.slice(0, 80).map((stock) => {
      return {
        key: `warehouse-${stock.id}`,
        companyName: stock.companyName,
        source: "OWN" as const,
        vendorCode: stock.vendorCode,
        sku: stock.sku,
        barcode: stock.barcode,
        size: stock.size,
        warehouseName: "Собственный склад",
        clusterName: null,
        qty: Number(stock.warehouseQty ?? 0),
        reservedQty: Number(stock.reservedQty ?? 0),
        availableForSupplyQty: Number(stock.availableForSupplyQty ?? 0),
      };
    }),
  ]
    .filter((row) => row.qty > 0 || row.availableForSupplyQty > 0)
    .sort((a, b) => {
      if (a.companyName !== b.companyName) {
        return a.companyName.localeCompare(b.companyName, "ru");
      }

      if (a.source !== b.source) {
        return a.source.localeCompare(b.source, "ru");
      }

      return a.vendorCode.localeCompare(b.vendorCode, "ru");
    })
    .slice(0, 120);

  return (
    <main className="min-h-screen bg-slate-100">
      <MarketplaceNav />

      <div className="p-4 sm:p-6 lg:p-8">
        <div className="mx-auto max-w-7xl space-y-6">
          <section className="overflow-hidden rounded-[34px] border border-slate-200 bg-white shadow-sm">
            <div className="relative p-6 sm:p-8">
              <div className="absolute right-0 top-0 h-36 w-36 rounded-bl-[70px] bg-violet-50" />

              <div className="relative flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
                <div>
                  <div className="inline-flex rounded-full bg-violet-50 px-3 py-1 text-xs font-black uppercase tracking-[0.14em] text-violet-700 ring-1 ring-violet-100">
                    Складской контур
                  </div>

                  <h1 className="mt-4 text-4xl font-black tracking-tight text-slate-950 sm:text-5xl">
                    Остатки товаров
                  </h1>

                  <p className="mt-4 max-w-3xl text-sm font-semibold leading-6 text-slate-500">
                    Общая картина по остаткам Wildberries, Ozon и собственного
                    склада. Раздел нужен, чтобы видеть наличие товара и готовить
                    поставки без ручных сводных таблиц.
                  </p>
                </div>

                <div className="relative flex flex-wrap gap-2">
                  <Link
                    href="/api/templates/ozon-warehouse-stock"
                    className="inline-flex items-center justify-center rounded-2xl bg-emerald-50 px-5 py-3 text-sm font-black text-emerald-700 ring-1 ring-emerald-100 transition hover:bg-emerald-100"
                  >
                    ⇩ Скачать шаблон склада
                  </Link>

                  <Link
                    href="/import?reportType=OZON_WAREHOUSE_STOCK"
                    className="inline-flex items-center justify-center rounded-2xl bg-slate-950 px-5 py-3 text-sm font-black text-white shadow-lg shadow-slate-300 transition hover:bg-slate-800"
                  >
                    Загрузить остатки
                  </Link>
                </div>
              </div>
            </div>
          </section>

          <form className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_220px] lg:items-end">
              <label className="block">
                <span className="text-xs font-black uppercase tracking-[0.12em] text-slate-400">
                  Компания
                </span>

                <select
                  name="companyName"
                  defaultValue={selectedCompanyName ?? "ALL"}
                  className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-700 outline-none transition focus:border-violet-200 focus:ring-4 focus:ring-violet-50"
                >
                  <option value="ALL">Все компании</option>
                  {companyNames.map((companyName) => (
                    <option key={companyName} value={companyName}>
                      {companyName}
                    </option>
                  ))}
                </select>
              </label>

              <button className="rounded-2xl bg-slate-950 px-5 py-3 text-sm font-black text-white shadow-lg shadow-slate-300 transition hover:bg-slate-800">
                Применить
              </button>
            </div>
          </form>

          <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              title="Wildberries"
              value={`${formatNumber(totalWbQty)} шт`}
              hint="На складах WB, в пути к покупателям и возвраты"
              tone="violet"
            />
            <MetricCard
              title="Ozon"
              value={`${formatNumber(totalOzonQty)} шт`}
              hint="Доступно, готовится, поставки, транзит и возвраты"
              tone="blue"
            />
            <MetricCard
              title="Собственный склад"
              value={`${formatNumber(totalWarehouseQty)} шт`}
              hint={`Резерв: ${formatNumber(totalReservedQty)} шт`}
              tone="emerald"
            />
            <MetricCard
              title="Доступно к поставке"
              value={`${formatNumber(totalAvailableForSupplyQty)} шт`}
              hint="Товар на своём складе за вычетом резерва"
              tone="amber"
            />
          </section>

          <section className="grid gap-5">
            {summaries.map((summary) => (
              <article
                key={summary.companyName}
                className="rounded-[34px] border border-slate-200 bg-white p-5 shadow-sm sm:p-6"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <div className="text-xs font-black uppercase tracking-[0.14em] text-slate-400">
                      Компания
                    </div>
                    <h2 className="mt-2 text-3xl font-black tracking-tight text-slate-950">
                      {summary.companyName}
                    </h2>
                  </div>

                  <div className="rounded-2xl bg-slate-50 px-4 py-3 text-sm font-black text-slate-600 ring-1 ring-slate-200">
                    Всего:{" "}
                    {formatNumber(
                      summary.wb.totalQty +
                        summary.ozon.totalQty +
                        summary.warehouse.warehouseQty
                    )}{" "}
                    шт
                  </div>
                </div>

                <div className="mt-5 grid gap-4 xl:grid-cols-3">
                  <SourceCard
                    title="Wildberries"
                    subtitle={`Последняя загрузка: ${summary.wb.latestDate}`}
                    totalLabel="Всего WB"
                    totalValue={`${formatNumber(summary.wb.totalQty)} шт`}
                    secondaryItems={[
                      {
                        label: "На складах",
                        value: `${formatNumber(summary.wb.stockQty)} шт`,
                      },
                      {
                        label: "К покупателям",
                        value: `${formatNumber(
                          summary.wb.inTransitToCustomerQty
                        )} шт`,
                      },
                      {
                        label: "Возвраты",
                        value: `${formatNumber(
                          summary.wb.inTransitReturnsQty
                        )} шт`,
                      },
                      {
                        label: "Строк",
                        value: formatNumber(summary.wb.rowsCount),
                      },
                    ]}
                  />

                  <SourceCard
                    title="Ozon"
                    subtitle={`Последняя загрузка: ${summary.ozon.latestDate}`}
                    totalLabel="Всего Ozon"
                    totalValue={`${formatNumber(summary.ozon.totalQty)} шт`}
                    secondaryItems={[
                      {
                        label: "Доступно",
                        value: `${formatNumber(summary.ozon.availableQty)} шт`,
                      },
                      {
                        label: "Готовится",
                        value: `${formatNumber(summary.ozon.preparingQty)} шт`,
                      },
                      {
                        label: "В поставках",
                        value: `${formatNumber(summary.ozon.supplyQty)} шт`,
                      },
                      {
                        label: "Строк",
                        value: formatNumber(summary.ozon.rowsCount),
                      },
                    ]}
                  />

                  <SourceCard
                    title="Собственный склад"
                    subtitle={`Последняя загрузка: ${summary.warehouse.latestDate}`}
                    totalLabel="Всего на своём складе"
                    totalValue={`${formatNumber(
                      summary.warehouse.warehouseQty
                    )} шт`}
                    secondaryItems={[
                      {
                        label: "Доступно к поставке",
                        value: `${formatNumber(
                          summary.warehouse.availableForSupplyQty
                        )} шт`,
                      },
                      {
                        label: "Резерв",
                        value: `${formatNumber(
                          summary.warehouse.reservedQty
                        )} шт`,
                      },
                      {
                        label: "Артикулов",
                        value: formatNumber(
                          uniqCount(
                            warehouseStocks
                              .filter(
                                (stock) =>
                                  stock.companyName === summary.companyName
                              )
                              .map((stock) => stock.vendorCode)
                          )
                        ),
                      },
                      {
                        label: "Строк",
                        value: formatNumber(summary.warehouse.rowsCount),
                      },
                    ]}
                    action={
                      <Link
                        href="/import?reportType=OZON_WAREHOUSE_STOCK"
                        className="rounded-2xl bg-emerald-50 px-3 py-2 text-xs font-black text-emerald-700 ring-1 ring-emerald-100 transition hover:bg-emerald-100"
                      >
                        Обновить
                      </Link>
                    }
                  />
                </div>
              </article>
            ))}

            {summaries.length === 0 ? (
              <div className="rounded-[34px] border border-dashed border-slate-300 bg-white p-10 text-center shadow-sm">
                <div className="text-2xl font-black text-slate-950">
                  Компании пока не найдены
                </div>
                <p className="mx-auto mt-3 max-w-xl text-sm font-semibold leading-6 text-slate-500">
                  Добавьте компанию в настройках, после этого она появится в
                  этом разделе автоматически.
                </p>
              </div>
            ) : null}
          </section>

          <section className="rounded-[34px] border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
            <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
              <div>
                <h2 className="text-2xl font-black tracking-tight text-slate-950">
                  Детализация остатков
                </h2>
                <p className="mt-2 max-w-3xl text-sm font-semibold leading-6 text-slate-500">
                  Ниже показаны первые строки по WB, Ozon и собственному складу.
                  Для планирования поставок следующим этапом добавим отдельную
                  таблицу с приоритетами и распределением по кластерам.
                </p>
              </div>

              <div className="rounded-2xl bg-slate-50 px-4 py-3 text-sm font-black text-slate-600 ring-1 ring-slate-200">
                Строк в таблице: {formatNumber(unifiedRows.length)}
              </div>
            </div>

            <div className="mt-5 overflow-hidden rounded-[26px] border border-slate-200">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1050px] text-left">
                  <thead className="bg-slate-50 text-xs font-black uppercase tracking-[0.12em] text-slate-400">
                    <tr>
                      <th className="px-4 py-4">Компания</th>
                      <th className="px-4 py-4">Источник</th>
                      <th className="px-4 py-4">Артикул</th>
                      <th className="px-4 py-4">SKU / NM ID</th>
                      <th className="px-4 py-4">Размер</th>
                      <th className="px-4 py-4">Склад / кластер</th>
                      <th className="px-4 py-4 text-right">Всего</th>
                      <th className="px-4 py-4 text-right">Резерв</th>
                      <th className="px-4 py-4 text-right">
                        Доступно к поставке
                      </th>
                    </tr>
                  </thead>

                  <tbody className="divide-y divide-slate-100 bg-white text-sm">
                    {unifiedRows.map((row) => (
                      <tr key={row.key} className="hover:bg-slate-50">
                        <td className="px-4 py-4 font-bold text-slate-800">
                          {row.companyName}
                        </td>
                        <td className="px-4 py-4">
                          <span
                            className={`inline-flex rounded-full px-3 py-1 text-xs font-black ring-1 ${getSourceBadgeClass(
                              row.source
                            )}`}
                          >
                            {getSourceLabel(row.source)}
                          </span>
                        </td>
                        <td className="px-4 py-4 font-black text-slate-950">
                          {row.vendorCode}
                        </td>
                        <td className="px-4 py-4 text-slate-500">
                          {row.sku ?? "—"}
                        </td>
                        <td className="px-4 py-4 text-slate-500">
                          {row.size ?? "—"}
                        </td>
                        <td className="px-4 py-4 text-slate-500">
                          {row.clusterName ?? row.warehouseName ?? "—"}
                        </td>
                        <td className="px-4 py-4 text-right font-black text-slate-950">
                          {formatNumber(row.qty)}
                        </td>
                        <td className="px-4 py-4 text-right text-slate-500">
                          {formatNumber(row.reservedQty)}
                        </td>
                        <td className="px-4 py-4 text-right font-black text-emerald-700">
                          {formatNumber(row.availableForSupplyQty)}
                        </td>
                      </tr>
                    ))}

                    {unifiedRows.length === 0 ? (
                      <tr>
                        <td
                          colSpan={9}
                          className="px-4 py-12 text-center text-sm font-bold text-slate-500"
                        >
                          Остатки пока не загружены.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
