import assert from "node:assert/strict";
import test from "node:test";

import {
  aliasWbDailyReportSalesAmount,
  combinedManagementRevenue,
  drrPercent,
  financialDynamicsMayShowNumericClaim,
  marketplaceManagementRevenue,
  marketplaceSharePercent,
} from "../../lib/dashboard/managementRevenue";

const WB_ECO = 7_484_757.33;
const WB_TAXABLE = 690_649;
const OZON_ECO = 16_874_603.69;
const ADS = 2_014_983;

test("Dashboard WB revenue prefers economicTurnover when it differs from taxable salesAmount", () => {
  const wb = { economicTurnover: WB_ECO, salesAmount: WB_TAXABLE, taxableRevenue: WB_TAXABLE };
  assert.equal(marketplaceManagementRevenue(wb), WB_ECO);
  assert.notEqual(marketplaceManagementRevenue(wb), WB_TAXABLE);
});

test("Combined Dashboard revenue is WB eco + Ozon eco", () => {
  const combined = combinedManagementRevenue(
    { economicTurnover: WB_ECO, salesAmount: WB_TAXABLE, taxableRevenue: WB_TAXABLE },
    { economicTurnover: OZON_ECO, salesAmount: OZON_ECO, taxableRevenue: 9_000_000 }
  );
  assert.ok(combined != null && Math.abs(combined - 24_359_361.02) < 0.011);
});

test("Marketplace share is computed from eco on both sides", () => {
  const wb = marketplaceManagementRevenue({
    economicTurnover: WB_ECO,
    salesAmount: WB_TAXABLE,
  });
  const ozon = marketplaceManagementRevenue({
    economicTurnover: OZON_ECO,
    salesAmount: OZON_ECO,
  });
  assert.ok(wb != null && ozon != null);
  const total = wb + ozon;
  const wbShare = marketplaceSharePercent(wb, total);
  const ozonShare = marketplaceSharePercent(ozon, total);
  assert.ok(wbShare !== null && ozonShare !== null);
  assert.ok(Math.abs(wbShare + ozonShare - 100) < 1e-9);
  assert.ok(wbShare < 40);
  assert.ok(ozonShare > 60);
});

test("DRR denominator is combined eco, not WB taxable + Ozon eco", () => {
  const combinedEco = combinedManagementRevenue(
    { economicTurnover: WB_ECO, salesAmount: WB_TAXABLE },
    { economicTurnover: OZON_ECO, salesAmount: OZON_ECO }
  );
  const wrongMix = WB_TAXABLE + OZON_ECO;
  const drr = drrPercent(ADS, combinedEco ?? 0);
  const wrongDrr = drrPercent(ADS, wrongMix);
  assert.ok(drr !== null && wrongDrr !== null);
  assert.ok(Math.abs(drr - 8.27) < 0.01);
  assert.ok(Math.abs(wrongDrr - 11.5) < 0.1);
  assert.notEqual(Math.round(drr * 10) / 10, 11.5);
});

test("taxableRevenue remains available separately after salesAmount alias", () => {
  const aliased = aliasWbDailyReportSalesAmount({
    economicTurnover: WB_ECO,
    taxableRevenue: WB_TAXABLE,
  });
  assert.equal(aliased.salesAmount, WB_ECO);
  assert.equal(aliased.economicTurnover, WB_ECO);
  assert.equal(aliased.taxableRevenue, WB_TAXABLE);
  assert.equal(aliased.taxBase, WB_TAXABLE);
  assert.equal(aliased.drrTaxableBase, WB_TAXABLE);
  assert.notEqual(aliased.salesAmount, aliased.taxableRevenue);
});

test("unavailable marketplace is not a numeric zero and does not become the combined total", () => {
  const ozon = marketplaceManagementRevenue({
    financialUnavailable: true,
    economicTurnover: undefined,
    salesAmount: 0,
  });
  assert.equal(ozon, null);
  const combined = combinedManagementRevenue(
    { economicTurnover: 27_671_470.17, salesAmount: 27_671_470.17 },
    { financialUnavailable: true, salesAmount: 0, economicTurnover: undefined }
  );
  assert.equal(combined, null);
  const august = marketplaceManagementRevenue({
    economicTurnover: 64_190_278.77,
    salesAmount: 64_190_278.77,
  });
  assert.equal(august, 64_190_278.77);
});

test("financial dynamics stay hidden when marketplace total is incomplete", () => {
  assert.equal(
    financialDynamicsMayShowNumericClaim({
      marketplaceTotalIncomplete: true,
      totalRevenue: null,
    }),
    false
  );
  assert.equal(
    financialDynamicsMayShowNumericClaim({
      marketplaceTotalIncomplete: false,
      totalRevenue: 91_861_748.94,
    }),
    true
  );
});

test("periodSnapshot/dashboard helper cannot silently fall back to taxable when eco is present", () => {
  const snapshotWbRevenue = marketplaceManagementRevenue({
    economicTurnover: WB_ECO,
    salesAmount: WB_TAXABLE,
  });
  assert.equal(snapshotWbRevenue, WB_ECO);
});
