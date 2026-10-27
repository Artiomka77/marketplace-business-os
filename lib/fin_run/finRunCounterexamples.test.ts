/**
 * FIN_RUN regression cases — mirrors FIN_RUN_CHECK.mjs against live helpers.
 */
import assert from "node:assert/strict";

process.env.FIN_GATE_OFFLINE = "1";

async function main() {
  const {
    mergePreliminaryWbSaleRowsByEconomicKey,
    wbPreliminaryEconomicKey,
  } = await import("../wb/wbProductOperationClassify.ts");
  const {
    buildCanonicalPositiveCostLookups,
    resolveCanonicalOzonUnitCost,
  } = await import("../analytics/productCostResolver.ts");
  const { selectOzonAccrualDayOwners } = await import(
    "../ozon/ozonAccrualSessionOwnership.ts"
  );
  const { buildHybridOzonCogsSourceRows } = await import(
    "../analytics/ozonCogsHybridSource.ts"
  );
  const {
    extractOzonAccrualProductMovements,
    mapMovementsToCogsProductRows,
  } = await import("../ozon/ozonAccrualProductMovements.ts");

  const company = "ИП Петров";
  const day = "2026-10-19";
  const sale = {
    companyName: company,
    saleDate: new Date(day + "T00:00:00Z"),
    nmId: "123",
    vendorCode: "v1",
    quantity: 1,
    paymentReason: "Продажа",
    documentType: "Продажа",
    retailPrice: 100,
    barcode: "b",
    size: "146",
  };

  {
    const twins = [
      { ...sale, id: "sale-1" },
      { ...sale, id: "sale-2" },
    ];
    for (const source of ["daily", "operational"] as const) {
      const rows = mergePreliminaryWbSaleRowsByEconomicKey({
        dailyRows: source === "daily" ? twins : [],
        operationalRows: source === "operational" ? twins : [],
        keyOf: wbPreliminaryEconomicKey,
      });
      assert.equal(rows.length, 2, `distinct_${source}_sales`);
    }
  }

  {
    const lookups = buildCanonicalPositiveCostLookups([
      { vendorCode: "1492430240-134", costPrice: 500 },
      { vendorCode: "1492430240-164", costPrice: 1450 },
    ]);
    assert.equal(
      resolveCanonicalOzonUnitCost({
        vendorCode: "1492430240-134",
        sku: "x",
        ...lookups,
      }).unitCost,
      1450,
    );
  }

  {
    const lookups = buildCanonicalPositiveCostLookups([
      { vendorCode: "999", nmId: "999", costPrice: 10 },
    ]);
    assert.equal(
      resolveCanonicalOzonUnitCost({
        vendorCode: "missing-158",
        sku: "999",
        ...lookups,
      }).unitCost,
      null,
    );
  }

  {
    const preview = {
      dateFrom: day,
      dateTo: day,
      requestedDates: [day],
      coverageComplete: true,
    };
    const owner = [
      ...selectOzonAccrualDayOwners({
        sessions: [
          {
            id: "missing-raw",
            companyName: company,
            status: "RAW_PERSISTED",
            createdAt: "2026-10-20",
            previewJson: preview,
          },
        ],
        dateFrom: day,
        dateTo: day,
      }).values(),
    ][0];
    const financeB = {
      companyName: company,
      sku: "B",
      quantity: 2,
      salesAmount: 200,
      totalAmount: 180,
      accrualDate: new Date(day + "T00:00:00Z"),
    };
    const hybrid = buildHybridOzonCogsSourceRows({
      productRows: [],
      financeRows: [financeB],
      authorityDays: [owner],
    });
    assert.equal(owner.complete, false);
    assert.equal(hybrid.length, 1);
  }

  {
    const event = {
      accrual_id: 123,
      date: day,
      posting: {
        products: [
          {
            sku: "A",
            quantity: 1,
            commission: {
              sale_price: { amount: "100" },
              sale_amount: { amount: "100" },
            },
          },
        ],
      },
    };
    const products = mapMovementsToCogsProductRows(
      extractOzonAccrualProductMovements({
        companyName: company,
        sessionId: "partial",
        rawAccruals: [event],
        dateFrom: day,
        dateTo: day,
      }),
      new Map([["A", "variant-A"]]),
    ).map((r) => ({ ...r, authorityCompleteForDay: false }));
    const sameFinance = {
      companyName: company,
      sku: "A",
      vendorCode: "variant-A",
      quantity: 1,
      salesAmount: 100,
      totalAmount: 100,
      accrualDate: new Date(day + "T00:00:00Z"),
      eventId: products[0].eventId,
    };
    const partial = buildHybridOzonCogsSourceRows({
      productRows: products,
      financeRows: [sameFinance],
      authorityDays: [{ companyName: company, day, complete: false }],
    });
    assert.equal(
      partial.reduce((s, r) => s + Number(r.quantity || 0), 0),
      1,
    );
  }

  {
    const empty = {
      findMany: async () => [],
      groupBy: async () => [],
      findFirst: async () => null,
    };
    const costsInput = [{ vendorCode: "variant-A", costPrice: 920 }];
    const sessions = [
      {
        id: "complete-day-19",
        companyName: company,
        status: "SUCCESS",
        createdAt: new Date("2026-10-20"),
        previewJson: {
          dateFrom: day,
          dateTo: day,
          requestedDates: [day],
          coverageComplete: true,
          rawAccruals: [
            {
              accrual_id: 123,
              date: day,
              posting: {
                products: [
                  {
                    sku: "A",
                    quantity: 1,
                    commission: {
                      sale_price: { amount: "100" },
                      sale_amount: { amount: "100" },
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    ];
    const bound = {
      productCost: { findMany: async () => costsInput },
      ozonProduct: {
        findMany: async () => [
          { sku: "A", vendorCode: "variant-A" },
          { sku: "B", vendorCode: "variant-B" },
        ],
      },
      ozonStock: empty,
      wbProductCard: empty,
      wbSale: empty,
      importSession: { findMany: async () => sessions },
      ozonFinance: {
        findMany: async () => [
          {
            companyName: company,
            vendorCode: "variant-B",
            sku: "B",
            quantity: 2,
            salesAmount: 200,
            totalAmount: 180,
            accrualDate: new Date("2026-10-20T00:00:00.000Z"),
          },
        ],
      },
      ozonRealizationRow: empty,
    };
    const { bindPrismaClientForOfflineReplay } = await import("../prisma.ts");
    bindPrismaClientForOfflineReplay(bound);
    const { getCostCoverageSummary } = await import(
      "../analytics/costCoverage.ts"
    );
    const coverage = await getCostCoverageSummary({
      dateFrom: day,
      dateTo: "2026-10-20",
      companyName: company,
    });
    assert.equal(coverage.checkedItemsCount, 2);
    assert.ok(
      (coverage.examples ?? []).some(
        (r: { externalId?: string }) => r.externalId === "B",
      ),
    );
  }

  console.log("finRunCounterexamples.test.ts OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
