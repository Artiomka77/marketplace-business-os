import { prisma } from "@/lib/prisma";

const DATE_FROM = new Date("2026-06-24T00:00:00.000Z");
const DATE_TO = new Date("2026-06-25T00:00:00.000Z");

function toNumber(value: unknown) {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "object" && "toNumber" in value) {
    return (value as { toNumber: () => number }).toNumber();
  }
  const num = Number(String(value).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(num) ? num : 0;
}

function sum<T>(rows: T[], getter: (row: T) => unknown) {
  return rows.reduce((acc, row) => acc + toNumber(getter(row)), 0);
}

async function main() {
  const [
    wbSales,
    wbAds,
    ozonFinance,
    ozonAds,
    dailyOrders,
    financeTransactions,
    wbStocks,
    ozonStocks,
    ownStocks,
  ] = await Promise.all([
    prisma.wbSale.findMany({
      where: {
        saleDate: {
          gte: DATE_FROM,
          lt: DATE_TO,
        },
      },
      orderBy: [{ companyName: "asc" }, { saleDate: "asc" }],
    }),

    prisma.wbAds.findMany({
      where: {
        OR: [
          {
            dateFrom: {
              gte: DATE_FROM,
              lt: DATE_TO,
            },
          },
          {
            dateTo: {
              gte: DATE_FROM,
              lt: DATE_TO,
            },
          },
        ],
      },
      orderBy: [{ companyName: "asc" }, { dateFrom: "asc" }],
    }),

    prisma.ozonFinance.findMany({
      where: {
        accrualDate: {
          gte: DATE_FROM,
          lt: DATE_TO,
        },
      },
      orderBy: [{ companyName: "asc" }, { accrualDate: "asc" }],
    }),

    prisma.ozonAds.findMany({
      where: {
        reportDate: {
          gte: DATE_FROM,
          lt: DATE_TO,
        },
      },
      orderBy: [{ companyName: "asc" }, { reportDate: "asc" }],
    }),

    prisma.marketplaceDailyOrderStat.findMany({
      where: {
        orderDate: {
          gte: DATE_FROM,
          lt: DATE_TO,
        },
      },
      orderBy: [{ companyName: "asc" }, { marketplace: "asc" }],
    }),

    prisma.financeTransaction.findMany({
      where: {
        operationDate: {
          gte: DATE_FROM,
          lt: DATE_TO,
        },
      },
      orderBy: [{ companyName: "asc" }, { operationDate: "asc" }],
    }),

    prisma.wbStock.findMany({
      orderBy: [{ companyName: "asc" }, { createdAt: "desc" }],
    }),

    prisma.ozonStock.findMany({
      orderBy: [{ companyName: "asc" }, { createdAt: "desc" }],
    }),

    prisma.ozonWarehouseStock.findMany({
      orderBy: [{ companyName: "asc" }, { createdAt: "desc" }],
    }),
  ]);

  const result = {
    period: {
      dateFrom: DATE_FROM.toISOString(),
      dateTo: DATE_TO.toISOString(),
    },

    counts: {
      wbSalesRows: wbSales.length,
      wbAdsRows: wbAds.length,
      ozonFinanceRows: ozonFinance.length,
      ozonAdsRows: ozonAds.length,
      dailyOrdersRows: dailyOrders.length,
      financeTransactionsRows: financeTransactions.length,
      wbStockRows: wbStocks.length,
      ozonStockRows: ozonStocks.length,
      ownStockRows: ownStocks.length,
    },

    totals: {
      wbSales: {
        quantity: sum(wbSales, (row) => row.quantity),
        retailPrice: sum(wbSales, (row) => row.retailPrice),
        wbRealizedAmount: sum(wbSales, (row) => row.wbRealizedAmount),
        sellerPayout: sum(wbSales, (row) => row.sellerPayout),
        logisticsCost: sum(wbSales, (row) => row.logisticsCost),
        storageCost: sum(wbSales, (row) => row.storageCost),
        deductions: sum(wbSales, (row) => row.deductions),
        acceptanceCost: sum(wbSales, (row) => row.acceptanceCost),
        penaltiesAmount: sum(wbSales, (row) => row.penaltiesAmount),
      },

      wbAds: {
        spend: sum(wbAds, (row) => row.spend),
        impressions: sum(wbAds, (row) => row.impressions),
        clicks: sum(wbAds, (row) => row.clicks),
      },

      ozonFinance: {
        quantity: sum(ozonFinance, (row) => row.quantity),
        salesAmount: sum(ozonFinance, (row) => row.salesAmount),
        ozonCommission: sum(ozonFinance, (row) => row.ozonCommission),
        logisticsCost: sum(ozonFinance, (row) => row.logisticsCost),
        reverseLogisticsCost: sum(ozonFinance, (row) => row.reverseLogisticsCost),
        totalAmount: sum(ozonFinance, (row) => row.totalAmount),
      },

      ozonAds: {
        spend: sum(ozonAds, (row) => row.spend),
        impressions: sum(ozonAds, (row) => row.impressions),
        clicks: sum(ozonAds, (row) => row.clicks),
        orders: sum(ozonAds, (row) => row.orders),
      },

      dailyOrders: {
        ordersQty: sum(dailyOrders, (row) => row.ordersQty),
        ordersAmount: sum(dailyOrders, (row) => row.ordersAmount),
      },

      dds: {
        income: sum(
          financeTransactions.filter((row) => row.operationType === "INCOME"),
          (row) => row.amount
        ),
        expense: sum(
          financeTransactions.filter((row) => row.operationType === "EXPENSE"),
          (row) => row.amount
        ),
        transactionsNet:
          sum(
            financeTransactions.filter((row) => row.operationType === "INCOME"),
            (row) => row.amount
          ) -
          sum(
            financeTransactions.filter((row) => row.operationType === "EXPENSE"),
            (row) => row.amount
          ),
      },

      stocks: {
        wbQty: sum(wbStocks, (row) => row.warehouseQty),
        ozonQty: sum(ozonStocks, (row) => row.availableQty),
        ownWarehouseQty: sum(ownStocks, (row) => row.warehouseQty),
        ownReservedQty: sum(ownStocks, (row) => row.reservedQty),
        ownAvailableForSupplyQty: sum(ownStocks, (row) => row.availableForSupplyQty),
      },
    },

    byCompany: {
      wbSales: Object.groupBy(wbSales, (row) => row.companyName ?? "Без компании"),
      wbAds: Object.groupBy(wbAds, (row) => row.companyName ?? "Без компании"),
      ozonFinance: Object.groupBy(ozonFinance, (row) => row.companyName ?? "Без компании"),
      ozonAds: Object.groupBy(ozonAds, (row) => row.companyName ?? "Без компании"),
      dailyOrders: Object.groupBy(dailyOrders, (row) => row.companyName ?? "Без компании"),
      financeTransactions: Object.groupBy(
        financeTransactions,
        (row) => row.companyName ?? "Без компании"
      ),
    },
  };

  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });