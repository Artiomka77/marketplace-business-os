import { prisma } from "@/lib/prisma";
import {
  buildCanonicalPositiveCostLookups,
  normalizeProductCostKey,
} from "@/lib/analytics/productCostResolver";
import { resolveCanonicalUnitCost } from "@/lib/analytics/canonicalUnitCost";
import { getProfitAnalyticsOzon } from "@/lib/analytics/profitAnalyticsOzon";
import {
  classifyCanonicalWbProductOperation,
  hasZeroWbProductFinancialImpact,
  selectCanonicalWbSaleSource,
} from "@/lib/wb/sourceOwnership";

export const OWNER_REPORT_FORMATTER_VERSION = "ownerReportV3.compact.level1";
export const OWNER_REPORT_FINANCIAL_FORMULA_VERSION = "financial-core-v6";

export type OwnerReportCogsSkuEvidence = {
  companyName: string;
  marketplace: "WB" | "OZON";
  skuKey: string;
  vendorCode: string | null;
  nmId: string | null;
  netQty: number;
  resolvedUnitCost: number | null;
  covered: boolean;
};

export type OwnerReportCogsMarketplaceEvidence = {
  companyName: string;
  marketplace: "WB" | "OZON";
  expectedQty: number;
  coveredQty: number;
  unresolvedQty: number;
  unresolvedSkuCount: number;
  coverageComplete: boolean;
  rows: OwnerReportCogsSkuEvidence[];
};

export type OwnerReportCogsCoverageEvidence = {
  businessDate: string;
  coverageComplete: boolean;
  marketplaces: OwnerReportCogsMarketplaceEvidence[];
  unresolvedSkuCount: number;
  expectedQty: number;
  coveredQty: number;
  unresolvedQty: number;
  reason: string | null;
};

const EXPECTED_COMPANIES = ["ИП Петров", "ИП Лебедева"] as const;

function toNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "object" && value && "toNumber" in value) {
    const n = Number((value as { toNumber: () => number }).toNumber());
    return Number.isFinite(n) ? n : 0;
  }
  const n = Number(String(value).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function aggregateSkuMap(
  map: Map<string, OwnerReportCogsSkuEvidence>,
  row: OwnerReportCogsSkuEvidence
) {
  const existing = map.get(row.skuKey);
  if (!existing) {
    map.set(row.skuKey, { ...row });
    return;
  }
  existing.netQty += row.netQty;
  if (existing.resolvedUnitCost == null && row.resolvedUnitCost != null) {
    existing.resolvedUnitCost = row.resolvedUnitCost;
  }
  existing.covered =
    existing.resolvedUnitCost != null ||
    Math.abs(existing.netQty) <= 0.000001;
}

async function evaluateWbCompanyCoverage(params: {
  companyName: string;
  businessDate: string;
  costByVendorCode: Map<string, number>;
  costByNmId: Map<string, number>;
  wbSupplierArticleByNmId: Map<string, string>;
}): Promise<OwnerReportCogsMarketplaceEvidence> {
  const owned = await selectCanonicalWbSaleSource({
    companyName: params.companyName,
    dateFrom: params.businessDate,
    dateTo: params.businessDate,
  });
  const dayStartMs = new Date(`${params.businessDate}T00:00:00.000Z`).getTime();
  const dayEndMs = new Date(`${params.businessDate}T23:59:59.999Z`).getTime();
  const bySku = new Map<string, OwnerReportCogsSkuEvidence>();

  for (const row of owned.rows) {
    const saleMs = row.saleDate ? new Date(row.saleDate).getTime() : NaN;
    if (!Number.isFinite(saleMs) || saleMs < dayStartMs || saleMs > dayEndMs) {
      continue;
    }
    const operation = classifyCanonicalWbProductOperation(row);
    if (operation === "OTHER" || hasZeroWbProductFinancialImpact(row)) continue;

    const vendorKey = normalizeProductCostKey(row.vendorCode);
    const nmKey = normalizeProductCostKey(row.nmId);
    const skuKey = vendorKey || nmKey;
    if (!skuKey) continue;

    const qty = Math.abs(toNumber(row.quantity)) || 1;
    const signedQty = operation === "RETURN" ? -qty : qty;
    const unitCost = resolveCanonicalUnitCost({
      costByVendorCode: params.costByVendorCode,
      costByNmId: params.costByNmId,
      vendorCodeKey: vendorKey || nmKey,
      wbSupplierArticleByNmId: params.wbSupplierArticleByNmId,
    });

    aggregateSkuMap(bySku, {
      companyName: params.companyName,
      marketplace: "WB",
      skuKey,
      vendorCode: row.vendorCode ? String(row.vendorCode) : null,
      nmId: row.nmId ? String(row.nmId) : null,
      netQty: signedQty,
      resolvedUnitCost: unitCost,
      covered: unitCost != null,
    });
  }

  const rows = [...bySku.values()].filter((r) => Math.abs(r.netQty) > 0.000001);
  for (const row of rows) {
    row.covered = row.resolvedUnitCost != null;
  }

  let expectedQty = 0;
  let coveredQty = 0;
  let unresolvedQty = 0;
  let unresolvedSkuCount = 0;
  for (const row of rows) {
    const absQty = Math.abs(row.netQty);
    expectedQty += absQty;
    if (row.covered) coveredQty += absQty;
    else {
      unresolvedQty += absQty;
      unresolvedSkuCount += 1;
    }
  }

  return {
    companyName: params.companyName,
    marketplace: "WB",
    expectedQty,
    coveredQty,
    unresolvedQty,
    unresolvedSkuCount,
    coverageComplete: unresolvedSkuCount === 0,
    rows,
  };
}

async function evaluateOzonCompanyCoverage(params: {
  companyName: string;
  businessDate: string;
}): Promise<OwnerReportCogsMarketplaceEvidence> {
  const analytics = await getProfitAnalyticsOzon({
    companyName: params.companyName,
    dateFrom: params.businessDate,
    dateTo: params.businessDate,
  });

  const rows: OwnerReportCogsSkuEvidence[] = [];
  for (const row of analytics.rows ?? []) {
    const netQty = Number(row.netSalesQty ?? 0);
    if (Math.abs(netQty) <= 0.000001) continue;
    // Ads-only / non-product rows without sales qty basis are already filtered.
    const incomplete = row.costCoverageIncomplete === true || row.costResolved === false;
    const unit =
      row.costResolved === false ? null : Number(row.costPrice ?? 0) || null;
    rows.push({
      companyName: params.companyName,
      marketplace: "OZON",
      skuKey: normalizeProductCostKey(row.vendorCode) || normalizeProductCostKey(row.nmId),
      vendorCode: row.vendorCode ? String(row.vendorCode) : null,
      nmId: row.nmId ? String(row.nmId) : null,
      netQty,
      resolvedUnitCost: incomplete ? null : unit,
      covered: !incomplete && unit != null,
    });
  }

  let expectedQty = 0;
  let coveredQty = 0;
  let unresolvedQty = 0;
  let unresolvedSkuCount = 0;
  for (const row of rows) {
    const absQty = Math.abs(row.netQty);
    expectedQty += absQty;
    if (row.covered) coveredQty += absQty;
    else {
      unresolvedQty += absQty;
      unresolvedSkuCount += 1;
    }
  }

  const totalsIncomplete =
    analytics.totals?.costCoverageIncomplete === true ||
    analytics.totals?.cogsCoverageComplete === false ||
    analytics.totals?.productCostCoverageComplete === false;

  const coverageComplete = unresolvedSkuCount === 0 && !totalsIncomplete;

  return {
    companyName: params.companyName,
    marketplace: "OZON",
    expectedQty,
    coveredQty,
    unresolvedQty,
    unresolvedSkuCount,
    coverageComplete,
    rows,
  };
}

/**
 * Exact COGS / ProductCost coverage for prior-day owner FINAL gate.
 * Uses canonical static ProductCost resolver; no inferred costs.
 */
export async function evaluateOwnerReportCogsCoverage(
  businessDate: string
): Promise<OwnerReportCogsCoverageEvidence> {
  const costs = await prisma.productCost.findMany({
    select: {
      id: true,
      vendorCode: true,
      nmId: true,
      costPrice: true,
      costDate: true,
      createdAt: true,
    },
  });
  const { costByVendorCode, costByNmId } = buildCanonicalPositiveCostLookups(costs);

  const wbCards = await prisma.wbProductCard.findMany({
    select: { nmId: true, vendorCode: true },
  });

  const wbSupplierArticleByNmId = new Map<string, string>();
  for (const card of wbCards) {
    const nmId = normalizeProductCostKey(card.nmId);
    const vendorCode = normalizeProductCostKey(card.vendorCode);
    if (!nmId || !vendorCode || wbSupplierArticleByNmId.has(nmId)) continue;
    wbSupplierArticleByNmId.set(nmId, vendorCode);
  }

  const marketplaces: OwnerReportCogsMarketplaceEvidence[] = [];
  for (const companyName of EXPECTED_COMPANIES) {
    marketplaces.push(
      await evaluateWbCompanyCoverage({
        companyName,
        businessDate,
        costByVendorCode,
        costByNmId,
        wbSupplierArticleByNmId,
      })
    );
    marketplaces.push(
      await evaluateOzonCompanyCoverage({ companyName, businessDate })
    );
  }

  const coverageComplete = marketplaces.every((m) => m.coverageComplete);
  const expectedQty = marketplaces.reduce((s, m) => s + m.expectedQty, 0);
  const coveredQty = marketplaces.reduce((s, m) => s + m.coveredQty, 0);
  const unresolvedQty = marketplaces.reduce((s, m) => s + m.unresolvedQty, 0);
  const unresolvedSkuCount = marketplaces.reduce(
    (s, m) => s + m.unresolvedSkuCount,
    0
  );

  return {
    businessDate,
    coverageComplete,
    marketplaces,
    unresolvedSkuCount,
    expectedQty,
    coveredQty,
    unresolvedQty,
    reason: coverageComplete ? null : "WAITING_PRODUCT_COST_COVERAGE",
  };
}

export function summarizeCogsCoverageForSnapshot(
  evidence: OwnerReportCogsCoverageEvidence
) {
  return {
    coverageComplete: evidence.coverageComplete,
    expectedQty: evidence.expectedQty,
    coveredQty: evidence.coveredQty,
    unresolvedQty: evidence.unresolvedQty,
    unresolvedSkuCount: evidence.unresolvedSkuCount,
    reason: evidence.reason,
    marketplaces: evidence.marketplaces.map((m) => ({
      companyName: m.companyName,
      marketplace: m.marketplace,
      expectedQty: m.expectedQty,
      coveredQty: m.coveredQty,
      unresolvedQty: m.unresolvedQty,
      unresolvedSkuCount: m.unresolvedSkuCount,
      coverageComplete: m.coverageComplete,
    })),
  };
}
