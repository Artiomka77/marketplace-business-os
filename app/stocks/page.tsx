import Link from "next/link";
import { prisma } from "@/lib/prisma";
import MarketplaceNav from "@/components/marketplaces/MarketplaceNav";

type StockSearchParams = {
  companyName?: string;
  source?: string;
  rows?: string;
};

type StockSource = "ALL" | "WB" | "OZON" | "OWN";

type ProductVisual = {
  name: string | null;
  imageUrl: string | null;
};

type CompanyStockSummary = {
  companyName: string;
  totalQty: number;
  totalCost: number;
  lastUpdate: string;
  wb: {
    stockQty: number;
    inTransitToCustomerQty: number;
    inTransitReturnsQty: number;
    totalQty: number;
    totalCost: number;
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
    totalCost: number;
    rowsCount: number;
    latestDate: string;
  };
  warehouse: {
    warehouseQty: number;
    reservedQty: number;
    availableForSupplyQty: number;
    totalCost: number;
    availableForSupplyCost: number;
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
  nmId: string | null;
  barcode: string | null;
  size: string | null;
  warehouseName: string | null;
  clusterName: string | null;
  qty: number;
  reservedQty: number;
  availableForSupplyQty: number;
  costPrice: number;
  totalCost: number;
  productName: string | null;
  imageUrl: string | null;
};

function formatNumber(value: number) {
  return Math.round(value).toLocaleString("ru-RU");
}

function formatMoney(value: number) {
  return `${Math.round(value).toLocaleString("ru-RU")} ₽`;
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

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function toNumber(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function normalizeKey(value: unknown) {
  return String(value ?? "").trim();
}

function uniqCount(values: Array<string | null | undefined>) {
  return new Set(values.map((value) => normalizeKey(value)).filter(Boolean)).size;
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
  return "Склад";
}

function getRowsLimit(value?: string) {
  const parsed = Number(value ?? 20);

  if ([20, 50, 100, 200].includes(parsed)) {
    return parsed;
  }

  return 20;
}

function getSelectedSource(value?: string): StockSource {
  if (value === "WB" || value === "OZON" || value === "OWN") {
    return value;
  }

  return "ALL";
}

function getProductVisual(params: {
  vendorCode: string;
  sku: string | null;
  nmId: string | null;
  ozonProductByVendorCode: Map<string, ProductVisual>;
  ozonProductBySku: Map<string, ProductVisual>;
  wbProductByVendorCode: Map<string, ProductVisual>;
  wbProductByNmId: Map<string, ProductVisual>;
  warehouseProductByVendorCode: Map<string, ProductVisual>;
}) {
  const vendorCode = normalizeKey(params.vendorCode);
  const sku = normalizeKey(params.sku);
  const nmId = normalizeKey(params.nmId);

  return (
    (sku ? params.ozonProductBySku.get(sku) : null) ??
    (nmId ? params.wbProductByNmId.get(nmId) : null) ??
    params.ozonProductByVendorCode.get(vendorCode) ??
    params.wbProductByVendorCode.get(vendorCode) ??
    params.warehouseProductByVendorCode.get(vendorCode) ?? {
      name: null,
      imageUrl: null,
    }
  );
}

function MetricCard({
  title,
  value,
  money,
  hint,
  tone = "slate",
  icon,
}: {
  title: string;
  value: string;
  money: string;
  hint: string;
  tone?: "slate" | "violet" | "blue" | "emerald" | "amber";
  icon: string;
}) {
  const toneClasses = {
    slate: "bg-white text-slate-950 ring-slate-200",
    violet: "bg-violet-50 text-violet-950 ring-violet-100",
    blue: "bg-blue-50 text-blue-950 ring-blue-100",
    emerald: "bg-emerald-50 text-emerald-950 ring-emerald-100",
    amber: "bg-amber-50 text-amber-950 ring-amber-100",
  };

  const iconClasses = {
    slate: "bg-slate-100 text-slate-700 ring-slate-200",
    violet: "bg-violet-100 text-violet-700 ring-violet-200",
    blue: "bg-blue-100 text-blue-700 ring-blue-200",
    emerald: "bg-emerald-100 text-emerald-700 ring-emerald-200",
    amber: "bg-amber-100 text-amber-700 ring-amber-200",
  };

  return (
    <div className={`rounded-[28px] p-5 shadow-sm ring-1 ${toneClasses[tone]}`}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-xs font-black uppercase tracking-[0.12em] text-slate-400">
            {title}
          </div>
          <div className="mt-3 text-3xl font-black tracking-tight">{value}</div>
          <div className="mt-2 text-base font-black text-slate-800">
            {money} себест.
          </div>
        </div>

        <div
          className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-lg font-black ring-1 ${iconClasses[tone]}`}
        >
          {icon}
        </div>
      </div>

      <div className="mt-3 text-sm font-semibold leading-5 text-slate-500">
        {hint}
      </div>
    </div>
  );
}

function AttentionCard({
  lowStockCount,
  noOwnWarehouseDataCount,
  highReservedQty,
  totalAvailableForSupplyQty,
}: {
  lowStockCount: number;
  noOwnWarehouseDataCount: number;
  highReservedQty: number;
  totalAvailableForSupplyQty: number;
}) {
  return (
    <aside className="rounded-[34px] border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-amber-50 text-xl ring-1 ring-amber-100">
          ⚠️
        </div>
        <div>
          <h2 className="text-xl font-black tracking-tight text-slate-950">
            Что требует внимания
          </h2>
          <p className="text-sm font-semibold text-slate-500">
            Короткие подсказки по остаткам
          </p>
        </div>
      </div>

      <div className="mt-5 space-y-3">
        <div className="rounded-2xl bg-amber-50 p-4 ring-1 ring-amber-100">
          <div className="text-sm font-black text-slate-950">
            Низкий остаток
          </div>
          <p className="mt-1 text-sm font-semibold leading-5 text-slate-600">
            {lowStockCount > 0
              ? `${formatNumber(
                  lowStockCount
                )} позиций имеют остаток менее 10 шт.`
              : "Критичных низких остатков в текущей выборке нет."}
          </p>
        </div>

        <div className="rounded-2xl bg-blue-50 p-4 ring-1 ring-blue-100">
          <div className="text-sm font-black text-slate-950">
            Собственный склад
          </div>
          <p className="mt-1 text-sm font-semibold leading-5 text-slate-600">
            {noOwnWarehouseDataCount > 0
              ? `${formatNumber(
                  noOwnWarehouseDataCount
                )} компаний пока без загруженных остатков собственного склада.`
              : `К поставке доступно ${formatNumber(
                  totalAvailableForSupplyQty
                )} шт.`}
          </p>
        </div>

        <div className="rounded-2xl bg-violet-50 p-4 ring-1 ring-violet-100">
          <div className="text-sm font-black text-slate-950">Резерв</div>
          <p className="mt-1 text-sm font-semibold leading-5 text-slate-600">
            В резерве сейчас {formatNumber(highReservedQty)} шт. Проверьте, не
            блокирует ли резерв поставки.
          </p>
        </div>
      </div>
    </aside>
  );
}

function ProductPhoto({
  imageUrl,
  title,
}: {
  imageUrl: string | null;
  title: string;
}) {
  if (imageUrl) {
    return (
      <img
        src={imageUrl}
        alt={title}
        className="h-12 w-12 rounded-2xl border border-slate-200 bg-slate-50 object-cover"
      />
    );
  }

  return (
    <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-slate-200 bg-slate-50 text-xs font-black text-slate-400">
      фото
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-[34px] border border-dashed border-slate-300 bg-white p-10 text-center shadow-sm">
      <div className="text-2xl font-black text-slate-950">
        Компании пока не найдены
      </div>
      <p className="mx-auto mt-3 max-w-xl text-sm font-semibold leading-6 text-slate-500">
        Добавьте компанию в настройках, после этого она появится в разделе
        остатков автоматически.
      </p>
    </div>
  );
}

export default async function StocksPage({
  searchParams,
}: {
  searchParams?: Promise<StockSearchParams>;
}) {
  const params = searchParams ? await searchParams : {};
  const selectedSource = getSelectedSource(params.source);
  const rowsLimit = getRowsLimit(params.rows);

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

  const [wbStocks, ozonStocks, warehouseStocks, stockImports, productCosts] =
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
      prisma.productCost.findMany({
        orderBy: [{ costDate: "desc" }, { createdAt: "desc" }],
        select: {
          vendorCode: true,
          nmId: true,
          name: true,
          costPrice: true,
        },
      }),
    ]);

  const vendorCodes = Array.from(
    new Set(
      [
        ...wbStocks.map((stock) => stock.vendorCode),
        ...ozonStocks.map((stock) => stock.vendorCode),
        ...warehouseStocks.map((stock) => stock.vendorCode),
      ]
        .map((value) => normalizeKey(value))
        .filter(Boolean)
    )
  );

  const skus = Array.from(
    new Set(
      [...ozonStocks.map((stock) => stock.sku), ...warehouseStocks.map((stock) => stock.sku)]
        .map((value) => normalizeKey(value))
        .filter(Boolean)
    )
  );

  const nmIds = Array.from(
    new Set(
      wbStocks
        .map((stock) => stock.nmId)
        .map((value) => normalizeKey(value))
        .filter(Boolean)
    )
  );

  const [ozonProducts, wbProductCards] = await Promise.all([
    prisma.ozonProduct.findMany({
      where: {
        OR: [
          vendorCodes.length > 0
            ? {
                vendorCode: {
                  in: vendorCodes,
                },
              }
            : {},
          skus.length > 0
            ? {
                sku: {
                  in: skus,
                },
              }
            : {},
        ],
      },
      orderBy: {
        createdAt: "desc",
      },
      select: {
        vendorCode: true,
        sku: true,
        productName: true,
        imageUrl: true,
        imageSmallUrl: true,
      },
    }),
    prisma.wbProductCard.findMany({
      where: {
        OR: [
          vendorCodes.length > 0
            ? {
                vendorCode: {
                  in: vendorCodes,
                },
              }
            : {},
          nmIds.length > 0
            ? {
                nmId: {
                  in: nmIds,
                },
              }
            : {},
        ],
      },
      orderBy: {
        lastSyncedAt: "desc",
      },
      select: {
        nmId: true,
        vendorCode: true,
        title: true,
        photoSmallUrl: true,
        photoBigUrl: true,
      },
    }),
  ]);

  const costByVendorCode = new Map<string, number>();
  const costNameByVendorCode = new Map<string, string>();

  for (const cost of productCosts) {
    const vendorCode = normalizeKey(cost.vendorCode);

    if (!vendorCode || costByVendorCode.has(vendorCode)) continue;

    costByVendorCode.set(vendorCode, toNumber(cost.costPrice));
    costNameByVendorCode.set(vendorCode, normalizeKey(cost.name));
  }

  const ozonProductByVendorCode = new Map<string, ProductVisual>();
  const ozonProductBySku = new Map<string, ProductVisual>();

  for (const product of ozonProducts) {
    const visual = {
      name: product.productName ?? null,
      imageUrl: product.imageSmallUrl ?? product.imageUrl ?? null,
    };

    const vendorCode = normalizeKey(product.vendorCode);
    const sku = normalizeKey(product.sku);

    if (vendorCode && !ozonProductByVendorCode.has(vendorCode)) {
      ozonProductByVendorCode.set(vendorCode, visual);
    }

    if (sku && !ozonProductBySku.has(sku)) {
      ozonProductBySku.set(sku, visual);
    }
  }

  const wbProductByVendorCode = new Map<string, ProductVisual>();
  const wbProductByNmId = new Map<string, ProductVisual>();

  for (const product of wbProductCards) {
    const visual = {
      name: product.title ?? null,
      imageUrl: product.photoSmallUrl ?? product.photoBigUrl ?? null,
    };

    const vendorCode = normalizeKey(product.vendorCode);
    const nmId = normalizeKey(product.nmId);

    if (vendorCode && !wbProductByVendorCode.has(vendorCode)) {
      wbProductByVendorCode.set(vendorCode, visual);
    }

    if (nmId && !wbProductByNmId.has(nmId)) {
      wbProductByNmId.set(nmId, visual);
    }
  }

  const warehouseProductByVendorCode = new Map<string, ProductVisual>();

  for (const stock of warehouseStocks) {
    const vendorCode = normalizeKey(stock.vendorCode);

    if (!vendorCode || warehouseProductByVendorCode.has(vendorCode)) continue;

    warehouseProductByVendorCode.set(vendorCode, {
      name: stock.productName ?? costNameByVendorCode.get(vendorCode) ?? null,
      imageUrl: null,
    });
  }

  const makeRowVisual = (params: {
    vendorCode: string;
    sku: string | null;
    nmId: string | null;
  }) =>
    getProductVisual({
      vendorCode: params.vendorCode,
      sku: params.sku,
      nmId: params.nmId,
      ozonProductByVendorCode,
      ozonProductBySku,
      wbProductByVendorCode,
      wbProductByNmId,
      warehouseProductByVendorCode,
    });

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
        companyWbStocks.map((stock) => toNumber(stock.totalStock))
      );
      const wbTransitToCustomerQty = sum(
        companyWbStocks.map((stock) => toNumber(stock.inTransitToCustomer))
      );
      const wbTransitReturnsQty = sum(
        companyWbStocks.map((stock) => toNumber(stock.inTransitReturns))
      );
      const wbTotalQty =
        wbStockQty + wbTransitToCustomerQty + wbTransitReturnsQty;
      const wbTotalCost = sum(
        companyWbStocks.map((stock) => {
          const qty =
            toNumber(stock.totalStock) +
            toNumber(stock.inTransitToCustomer) +
            toNumber(stock.inTransitReturns);

          return qty * (costByVendorCode.get(normalizeKey(stock.vendorCode)) ?? 0);
        })
      );

      const ozonAvailableQty = sum(
        companyOzonStocks.map((stock) => toNumber(stock.availableQty))
      );
      const ozonPreparingQty = sum(
        companyOzonStocks.map((stock) => toNumber(stock.preparingQty))
      );
      const ozonSupplyQty = sum(
        companyOzonStocks.map((stock) => toNumber(stock.supplyQty))
      );
      const ozonInTransitQty = sum(
        companyOzonStocks.map((stock) => toNumber(stock.inTransitQty))
      );
      const ozonReturnQty = sum(
        companyOzonStocks.map((stock) => toNumber(stock.returnQty))
      );
      const ozonTotalQty =
        ozonAvailableQty +
        ozonPreparingQty +
        ozonSupplyQty +
        ozonInTransitQty +
        ozonReturnQty;
      const ozonTotalCost = sum(
        companyOzonStocks.map((stock) => {
          const qty =
            toNumber(stock.availableQty) +
            toNumber(stock.preparingQty) +
            toNumber(stock.supplyQty) +
            toNumber(stock.inTransitQty) +
            toNumber(stock.returnQty);

          return qty * (costByVendorCode.get(normalizeKey(stock.vendorCode)) ?? 0);
        })
      );

      const warehouseQty = sum(
        companyWarehouseStocks.map((stock) => toNumber(stock.warehouseQty))
      );
      const reservedQty = sum(
        companyWarehouseStocks.map((stock) => toNumber(stock.reservedQty))
      );
      const availableForSupplyQty = sum(
        companyWarehouseStocks.map((stock) => toNumber(stock.availableForSupplyQty))
      );
      const warehouseTotalCost = sum(
        companyWarehouseStocks.map((stock) => {
          const costPrice =
            toNumber(stock.costPrice) ||
            costByVendorCode.get(normalizeKey(stock.vendorCode)) ||
            0;

          return toNumber(stock.warehouseQty) * costPrice;
        })
      );
      const availableForSupplyCost = sum(
        companyWarehouseStocks.map((stock) => {
          const costPrice =
            toNumber(stock.costPrice) ||
            costByVendorCode.get(normalizeKey(stock.vendorCode)) ||
            0;

          return toNumber(stock.availableForSupplyQty) * costPrice;
        })
      );

      const latestDates = [
        getLatestImportDateByCompany({
          companyName,
          reportType: "WB_STOCK",
          imports: stockImports,
        }),
        getLatestImportDateByCompany({
          companyName,
          reportType: "OZON_STOCK",
          imports: stockImports,
        }),
        getLatestImportDateByCompany({
          companyName,
          reportType: "OZON_WAREHOUSE_STOCK",
          imports: stockImports,
        }),
      ].filter((date) => date !== "Нет данных");

      return {
        companyName,
        totalQty: wbTotalQty + ozonTotalQty + warehouseQty,
        totalCost: wbTotalCost + ozonTotalCost + warehouseTotalCost,
        lastUpdate: latestDates[0] ?? "Нет данных",
        wb: {
          stockQty: wbStockQty,
          inTransitToCustomerQty: wbTransitToCustomerQty,
          inTransitReturnsQty: wbTransitReturnsQty,
          totalQty: wbTotalQty,
          totalCost: wbTotalCost,
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
          totalQty: ozonTotalQty,
          totalCost: ozonTotalCost,
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
          totalCost: warehouseTotalCost,
          availableForSupplyCost,
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
  const totalWbCost = sum(summaries.map((summary) => summary.wb.totalCost));
  const totalOzonQty = sum(summaries.map((summary) => summary.ozon.totalQty));
  const totalOzonCost = sum(summaries.map((summary) => summary.ozon.totalCost));
  const totalWarehouseQty = sum(
    summaries.map((summary) => summary.warehouse.warehouseQty)
  );
  const totalWarehouseCost = sum(
    summaries.map((summary) => summary.warehouse.totalCost)
  );
  const totalAvailableForSupplyQty = sum(
    summaries.map((summary) => summary.warehouse.availableForSupplyQty)
  );
  const totalAvailableForSupplyCost = sum(
    summaries.map((summary) => summary.warehouse.availableForSupplyCost)
  );
  const totalReservedQty = sum(
    summaries.map((summary) => summary.warehouse.reservedQty)
  );

  const unifiedRows: UnifiedStockRow[] = [
    ...wbStocks.map((stock) => {
      const vendorCode = stock.vendorCode ?? "—";
      const qty =
        toNumber(stock.totalStock) +
        toNumber(stock.inTransitToCustomer) +
        toNumber(stock.inTransitReturns);
      const costPrice = costByVendorCode.get(normalizeKey(vendorCode)) ?? 0;
      const visual = makeRowVisual({
        vendorCode,
        sku: null,
        nmId: stock.nmId,
      });

      return {
        key: `wb-${stock.id}`,
        companyName: stock.companyName ?? "Без компании",
        source: "WB" as const,
        vendorCode,
        sku: null,
        nmId: stock.nmId,
        barcode: stock.barcode,
        size: stock.size,
        warehouseName: "WB",
        clusterName: null,
        qty,
        reservedQty: 0,
        availableForSupplyQty: qty,
        costPrice,
        totalCost: qty * costPrice,
        productName: visual.name ?? costNameByVendorCode.get(normalizeKey(vendorCode)) ?? null,
        imageUrl: visual.imageUrl,
      };
    }),
    ...ozonStocks.map((stock) => {
      const vendorCode = stock.vendorCode ?? "—";
      const qty =
        toNumber(stock.availableQty) +
        toNumber(stock.preparingQty) +
        toNumber(stock.supplyQty) +
        toNumber(stock.inTransitQty) +
        toNumber(stock.returnQty);
      const costPrice = costByVendorCode.get(normalizeKey(vendorCode)) ?? 0;
      const visual = makeRowVisual({
        vendorCode,
        sku: stock.sku,
        nmId: null,
      });

      return {
        key: `ozon-${stock.id}`,
        companyName: stock.companyName ?? "Без компании",
        source: "OZON" as const,
        vendorCode,
        sku: stock.sku,
        nmId: null,
        barcode: null,
        size: null,
        warehouseName: stock.warehouseName,
        clusterName: stock.clusterName,
        qty,
        reservedQty: 0,
        availableForSupplyQty: toNumber(stock.availableQty),
        costPrice,
        totalCost: qty * costPrice,
        productName: visual.name ?? costNameByVendorCode.get(normalizeKey(vendorCode)) ?? null,
        imageUrl: visual.imageUrl,
      };
    }),
    ...warehouseStocks.map((stock) => {
      const vendorCode = stock.vendorCode;
      const costPrice =
        toNumber(stock.costPrice) ||
        costByVendorCode.get(normalizeKey(stock.vendorCode)) ||
        0;
      const visual = makeRowVisual({
        vendorCode,
        sku: stock.sku,
        nmId: null,
      });

      return {
        key: `warehouse-${stock.id}`,
        companyName: stock.companyName,
        source: "OWN" as const,
        vendorCode,
        sku: stock.sku,
        nmId: null,
        barcode: stock.barcode,
        size: stock.size,
        warehouseName: "Собственный склад",
        clusterName: null,
        qty: toNumber(stock.warehouseQty),
        reservedQty: toNumber(stock.reservedQty),
        availableForSupplyQty: toNumber(stock.availableForSupplyQty),
        costPrice,
        totalCost: toNumber(stock.warehouseQty) * costPrice,
        productName:
          stock.productName ??
          visual.name ??
          costNameByVendorCode.get(normalizeKey(vendorCode)) ??
          null,
        imageUrl: visual.imageUrl,
      };
    }),
  ]
    .filter((row) => {
      if (row.qty <= 0 && row.availableForSupplyQty <= 0) return false;
      if (selectedSource !== "ALL" && row.source !== selectedSource) return false;
      return true;
    })
    .sort((a, b) => {
      if (a.companyName !== b.companyName) {
        return a.companyName.localeCompare(b.companyName, "ru");
      }

      if (a.source !== b.source) {
        return a.source.localeCompare(b.source, "ru");
      }

      return a.vendorCode.localeCompare(b.vendorCode, "ru");
    });

  const visibleRows = unifiedRows.slice(0, rowsLimit);

  const lowStockCount = unifiedRows.filter((row) => row.qty > 0 && row.qty < 10).length;
  const noOwnWarehouseDataCount = summaries.filter(
    (summary) => summary.warehouse.rowsCount === 0
  ).length;

  const isCompanyDetail = Boolean(selectedCompanyName);

  return (
    <main className="min-h-screen bg-slate-100">
      <MarketplaceNav />

      <div className="p-4 sm:p-6 lg:p-8">
        <div className="mx-auto max-w-7xl space-y-5">
          <section className="rounded-[34px] border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
            <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
              <div>
                <div className="inline-flex rounded-full bg-violet-50 px-3 py-1 text-xs font-black uppercase tracking-[0.14em] text-violet-700 ring-1 ring-violet-100">
                  Складской контур
                </div>

                <h1 className="mt-4 text-4xl font-black tracking-tight text-slate-950 sm:text-5xl">
                  Остатки товаров
                </h1>

                <p className="mt-4 max-w-3xl text-sm font-semibold leading-6 text-slate-500">
                  Актуальные остатки на маркетплейсах и собственном складе с
                  оценкой в себестоимости. Выберите компанию, чтобы провалиться
                  в детализацию по складам и товарам.
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                <Link
                  href="/api/templates/ozon-warehouse-stock"
                  className="inline-flex items-center justify-center rounded-2xl bg-emerald-50 px-5 py-3 text-sm font-black text-emerald-700 ring-1 ring-emerald-100 transition hover:bg-emerald-100"
                >
                  ⇩ Скачать шаблон остатков
                </Link>

                <Link
                  href="/import?reportType=OZON_WAREHOUSE_STOCK"
                  className="inline-flex items-center justify-center rounded-2xl bg-slate-950 px-5 py-3 text-sm font-black text-white shadow-lg shadow-slate-300 transition hover:bg-slate-800"
                >
                  Загрузить остатки
                </Link>
              </div>
            </div>

            <form className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,1fr)_220px] lg:items-end">
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
            </form>
          </section>

          <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              title="Wildberries"
              value={`${formatNumber(totalWbQty)} шт`}
              money={formatMoney(totalWbCost)}
              hint="На складах WB, в пути к покупателям и возвраты"
              tone="violet"
              icon="WB"
            />
            <MetricCard
              title="Ozon"
              value={`${formatNumber(totalOzonQty)} шт`}
              money={formatMoney(totalOzonCost)}
              hint="Доступно, готовится, поставки, транзит и возвраты"
              tone="blue"
              icon="OZ"
            />
            <MetricCard
              title="Собственный склад"
              value={`${formatNumber(totalWarehouseQty)} шт`}
              money={formatMoney(totalWarehouseCost)}
              hint={`Резерв: ${formatNumber(totalReservedQty)} шт`}
              tone="emerald"
              icon="⌂"
            />
            <MetricCard
              title="Доступно к поставке"
              value={`${formatNumber(totalAvailableForSupplyQty)} шт`}
              money={formatMoney(totalAvailableForSupplyCost)}
              hint="Товар на своём складе за вычетом резерва"
              tone="amber"
              icon="⇄"
            />
          </section>

          <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
            <section className="rounded-[34px] border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
              <div>
                <h2 className="text-2xl font-black tracking-tight text-slate-950">
                  {isCompanyDetail
                    ? `Компания: ${selectedCompanyName}`
                    : "Остатки по компаниям"}
                </h2>
                <p className="mt-2 text-sm font-semibold leading-6 text-slate-500">
                  Общий остаток по всем источникам: WB + Ozon + собственный
                  склад.
                </p>
              </div>

              <div className="mt-5 space-y-3">
                {summaries.map((summary) => (
                  <div
                    key={summary.companyName}
                    className="rounded-[26px] border border-slate-200 bg-white p-4 shadow-sm"
                  >
                    <div className="grid gap-4 xl:grid-cols-[220px_1fr_150px] xl:items-center">
                      <div className="flex items-center gap-3">
                        <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-violet-600 text-base font-black text-white shadow-sm">
                          {summary.companyName.slice(0, 1)}
                        </div>
                        <div>
                          <div className="text-lg font-black text-slate-950">
                            {summary.companyName}
                          </div>
                          <div className="text-xs font-bold text-slate-400">
                            Обновление: {summary.lastUpdate}
                          </div>
                        </div>
                      </div>

                      <div className="grid gap-3 md:grid-cols-4">
                        <div className="rounded-2xl bg-slate-50 p-3 ring-1 ring-slate-100">
                          <div className="text-xs font-black uppercase text-slate-400">
                            Итого
                          </div>
                          <div className="mt-1 text-lg font-black text-slate-950">
                            {formatNumber(summary.totalQty)} шт
                          </div>
                          <div className="text-sm font-bold text-slate-500">
                            {formatMoney(summary.totalCost)}
                          </div>
                        </div>

                        <div className="rounded-2xl bg-violet-50 p-3 ring-1 ring-violet-100">
                          <div className="text-xs font-black uppercase text-violet-500">
                            WB
                          </div>
                          <div className="mt-1 text-lg font-black text-slate-950">
                            {formatNumber(summary.wb.totalQty)} шт
                          </div>
                          <div className="text-sm font-bold text-slate-500">
                            {formatMoney(summary.wb.totalCost)}
                          </div>
                        </div>

                        <div className="rounded-2xl bg-blue-50 p-3 ring-1 ring-blue-100">
                          <div className="text-xs font-black uppercase text-blue-500">
                            Ozon
                          </div>
                          <div className="mt-1 text-lg font-black text-slate-950">
                            {formatNumber(summary.ozon.totalQty)} шт
                          </div>
                          <div className="text-sm font-bold text-slate-500">
                            {formatMoney(summary.ozon.totalCost)}
                          </div>
                        </div>

                        <div className="rounded-2xl bg-emerald-50 p-3 ring-1 ring-emerald-100">
                          <div className="text-xs font-black uppercase text-emerald-500">
                            Склад
                          </div>
                          <div className="mt-1 text-lg font-black text-slate-950">
                            {formatNumber(summary.warehouse.warehouseQty)} шт
                          </div>
                          <div className="text-sm font-bold text-slate-500">
                            {formatMoney(summary.warehouse.totalCost)}
                          </div>
                        </div>
                      </div>

                      <Link
                        href={`/stocks?companyName=${encodeURIComponent(
                          summary.companyName
                        )}`}
                        className="inline-flex items-center justify-center rounded-2xl bg-slate-950 px-4 py-3 text-sm font-black text-white shadow-lg shadow-slate-300 transition hover:bg-slate-800"
                      >
                        Подробнее →
                      </Link>
                    </div>
                  </div>
                ))}

                {summaries.length === 0 ? <EmptyState /> : null}
              </div>
            </section>

            <AttentionCard
              lowStockCount={lowStockCount}
              noOwnWarehouseDataCount={noOwnWarehouseDataCount}
              highReservedQty={totalReservedQty}
              totalAvailableForSupplyQty={totalAvailableForSupplyQty}
            />
          </section>

          {isCompanyDetail ? (
            <section className="grid gap-4 xl:grid-cols-3">
              {summaries.map((summary) => (
                <>
                  <div
                    key={`${summary.companyName}-wb`}
                    className="rounded-[28px] border border-violet-100 bg-violet-50 p-5 shadow-sm"
                  >
                    <div className="text-xs font-black uppercase tracking-[0.12em] text-violet-600">
                      Wildberries
                    </div>
                    <div className="mt-3 text-3xl font-black text-slate-950">
                      {formatNumber(summary.wb.totalQty)} шт
                    </div>
                    <div className="mt-1 text-lg font-black text-slate-700">
                      {formatMoney(summary.wb.totalCost)}
                    </div>
                    <div className="mt-4 grid gap-2 text-sm font-bold text-slate-600">
                      <div>На складах: {formatNumber(summary.wb.stockQty)} шт</div>
                      <div>
                        К покупателям:{" "}
                        {formatNumber(summary.wb.inTransitToCustomerQty)} шт
                      </div>
                      <div>
                        Возвраты: {formatNumber(summary.wb.inTransitReturnsQty)} шт
                      </div>
                    </div>
                  </div>

                  <div
                    key={`${summary.companyName}-ozon`}
                    className="rounded-[28px] border border-blue-100 bg-blue-50 p-5 shadow-sm"
                  >
                    <div className="text-xs font-black uppercase tracking-[0.12em] text-blue-600">
                      Ozon
                    </div>
                    <div className="mt-3 text-3xl font-black text-slate-950">
                      {formatNumber(summary.ozon.totalQty)} шт
                    </div>
                    <div className="mt-1 text-lg font-black text-slate-700">
                      {formatMoney(summary.ozon.totalCost)}
                    </div>
                    <div className="mt-4 grid gap-2 text-sm font-bold text-slate-600">
                      <div>Доступно: {formatNumber(summary.ozon.availableQty)} шт</div>
                      <div>
                        Готовится: {formatNumber(summary.ozon.preparingQty)} шт
                      </div>
                      <div>В пути: {formatNumber(summary.ozon.inTransitQty)} шт</div>
                    </div>
                  </div>

                  <div
                    key={`${summary.companyName}-warehouse`}
                    className="rounded-[28px] border border-emerald-100 bg-emerald-50 p-5 shadow-sm"
                  >
                    <div className="text-xs font-black uppercase tracking-[0.12em] text-emerald-600">
                      Собственный склад
                    </div>
                    <div className="mt-3 text-3xl font-black text-slate-950">
                      {formatNumber(summary.warehouse.warehouseQty)} шт
                    </div>
                    <div className="mt-1 text-lg font-black text-slate-700">
                      {formatMoney(summary.warehouse.totalCost)}
                    </div>
                    <div className="mt-4 grid gap-2 text-sm font-bold text-slate-600">
                      <div>
                        Доступно к поставке:{" "}
                        {formatNumber(summary.warehouse.availableForSupplyQty)} шт
                      </div>
                      <div>Резерв: {formatNumber(summary.warehouse.reservedQty)} шт</div>
                      <div>
                        Артикулов:{" "}
                        {formatNumber(
                          uniqCount(
                            warehouseStocks
                              .filter(
                                (stock) =>
                                  stock.companyName === summary.companyName
                              )
                              .map((stock) => stock.vendorCode)
                          )
                        )}
                      </div>
                    </div>
                  </div>
                </>
              ))}
            </section>
          ) : null}

          <section className="rounded-[34px] border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
            <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
              <div>
                <h2 className="text-2xl font-black tracking-tight text-slate-950">
                  Детализация по товарам
                </h2>
                <p className="mt-2 max-w-3xl text-sm font-semibold leading-6 text-slate-500">
                  Остатки и стоимость в разрезе товаров. Для подробного анализа
                  выберите компанию и источник.
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                {isCompanyDetail ? (
                  <Link
                    href="/stocks"
                    className="inline-flex items-center justify-center rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-black text-slate-700 transition hover:bg-slate-50"
                  >
                    ← Все компании
                  </Link>
                ) : null}

                <Link
                  href={`/stocks?${new URLSearchParams({
                    ...(selectedCompanyName ? { companyName: selectedCompanyName } : {}),
                    source: selectedSource,
                    rows: String(rowsLimit),
                  }).toString()}`}
                  className="inline-flex items-center justify-center rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-black text-slate-700 transition hover:bg-slate-50"
                >
                  Экспорт в Excel
                </Link>
              </div>
            </div>

            <form className="mt-5 grid gap-3 xl:grid-cols-[minmax(260px,1fr)_180px_180px_170px_140px]">
              <input
                type="hidden"
                name="companyName"
                value={selectedCompanyName ?? "ALL"}
              />

              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-bold text-slate-500">
                Поиск по названию и артикулу добавим следующим шагом
              </div>

              <select
                name="source"
                defaultValue={selectedSource}
                className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-700 outline-none"
              >
                <option value="ALL">Источник: все</option>
                <option value="WB">WB</option>
                <option value="OZON">Ozon</option>
                <option value="OWN">Свой склад</option>
              </select>

              <select
                name="rows"
                defaultValue={String(rowsLimit)}
                className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-700 outline-none"
              >
                <option value="20">Показывать: 20</option>
                <option value="50">Показывать: 50</option>
                <option value="100">Показывать: 100</option>
                <option value="200">Показывать: 200</option>
              </select>

              <Link
                href={selectedCompanyName ? `/stocks?companyName=${encodeURIComponent(selectedCompanyName)}` : "/stocks"}
                className="inline-flex items-center justify-center rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-black text-slate-700 transition hover:bg-slate-50"
              >
                Сбросить
              </Link>

              <button className="rounded-2xl bg-slate-950 px-5 py-3 text-sm font-black text-white shadow-lg shadow-slate-300 transition hover:bg-slate-800">
                Применить
              </button>
            </form>

            <div className="mt-5 overflow-hidden rounded-[26px] border border-slate-200">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1180px] text-left">
                  <thead className="bg-slate-50 text-xs font-black uppercase tracking-[0.12em] text-slate-400">
                    <tr>
                      <th className="px-4 py-4">Фото</th>
                      <th className="px-4 py-4">Товар</th>
                      <th className="px-4 py-4">Артикул</th>
                      <th className="px-4 py-4">SKU / NM ID</th>
                      <th className="px-4 py-4">Размер</th>
                      <th className="px-4 py-4">Источник</th>
                      <th className="px-4 py-4">Склад / кластер</th>
                      <th className="px-4 py-4 text-right">Остаток</th>
                      <th className="px-4 py-4 text-right">Себест. за ед.</th>
                      <th className="px-4 py-4 text-right">Стоимость остатка</th>
                      <th className="px-4 py-4 text-right">Резерв</th>
                      <th className="px-4 py-4 text-right">К поставке</th>
                    </tr>
                  </thead>

                  <tbody className="divide-y divide-slate-100 bg-white text-sm">
                    {visibleRows.map((row) => (
                      <tr key={row.key} className="hover:bg-slate-50">
                        <td className="px-4 py-4">
                          <ProductPhoto
                            imageUrl={row.imageUrl}
                            title={row.productName ?? row.vendorCode}
                          />
                        </td>
                        <td className="px-4 py-4">
                          <div className="font-black text-slate-950">
                            {row.productName ?? "Название не загружено"}
                          </div>
                          <div className="mt-1 text-xs font-bold text-slate-400">
                            {row.companyName}
                          </div>
                        </td>
                        <td className="px-4 py-4 font-black text-slate-950">
                          {row.vendorCode}
                        </td>
                        <td className="px-4 py-4 text-slate-500">
                          {row.sku ?? row.nmId ?? "—"}
                        </td>
                        <td className="px-4 py-4 text-slate-500">
                          {row.size ?? "—"}
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
                        <td className="px-4 py-4 text-slate-500">
                          {row.clusterName ?? row.warehouseName ?? "—"}
                        </td>
                        <td className="px-4 py-4 text-right font-black text-slate-950">
                          {formatNumber(row.qty)}
                        </td>
                        <td className="px-4 py-4 text-right text-slate-500">
                          {formatMoney(row.costPrice)}
                        </td>
                        <td className="px-4 py-4 text-right font-black text-slate-950">
                          {formatMoney(row.totalCost)}
                        </td>
                        <td className="px-4 py-4 text-right text-slate-500">
                          {formatNumber(row.reservedQty)}
                        </td>
                        <td className="px-4 py-4 text-right font-black text-emerald-700">
                          {formatNumber(row.availableForSupplyQty)}
                        </td>
                      </tr>
                    ))}

                    {visibleRows.length === 0 ? (
                      <tr>
                        <td
                          colSpan={12}
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

            <div className="mt-4 flex flex-col gap-3 text-sm font-bold text-slate-500 sm:flex-row sm:items-center sm:justify-between">
              <div>
                Показано {formatNumber(visibleRows.length)} из{" "}
                {formatNumber(unifiedRows.length)} строк
              </div>

              <div className="rounded-2xl bg-slate-50 px-4 py-2 ring-1 ring-slate-200">
                Лимит строк меняется фильтром “Показывать”
              </div>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
