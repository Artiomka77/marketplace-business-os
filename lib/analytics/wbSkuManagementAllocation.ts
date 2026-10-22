export type WbSkuAllocatableRow = {
  nmId: string;
  vendorCode: string;
  sellerRetailAmount: number;
  revenue: number;
  netSalesQty: number;
  adsCost: number;
  storageCost: number;
  netProfitAfterTax: number;
  marginProfit: number;
  marginAfterTaxPercent: number;
  marginProfitPercent: number;
  drrPercent: number;
  abcByProfit: "A" | "B" | "C";
};

export type WbSkuAllocationMeta = {
  exactAds: number;
  allocatedCampaignAds: number;
  allocatedUnmappedAds: number;
  allocatedReconAds: number;
  allocatedAds: number;
  exactStorage: number;
  allocatedStorage: number;
  exactContributionProfit: number;
  allocatedExpense: number;
  managementProfitAfterAllocation: number;
  attributionStatus: "EXACT" | "ALLOCATED" | "MIXED" | "SOURCE_GAP";
};

export const WB_SKU_ALLOCATION_COMPANIES = ["ИП Петров", "ИП Лебедева"] as const;

export type WbSkuAllocationBridge = {
  sumManagementProfit: number;
  topNetProfitAfterTax: number;
  delta: number;
  exactAds: number;
  allocatedCampaignAds: number;
  unmappedAds: number;
  reconAds: number;
  allocatedStorage: number;
  unallocatedRemainder: number;
  unexplainedBridge: boolean;
  storageDriver: "netSalesQty" | "economicTurnover";
  reconDriver: "attributedAds" | "economicTurnover";
};

export type WbAdsCampaignClass =
  | "EXACT_ONE_ARTICLE"
  | "ALLOCATED_MULTI_ARTICLE"
  | "UNMAPPED_ACCOUNT_LEVEL";

export type WbAdsCampaignAttribution = {
  campaignName: string;
  spend: number;
  vendorCodes: string[];
  cls: WbAdsCampaignClass;
};

type AdMapInput = { campaignName: string | null; vendorCode: string | null };
type AdsRowInput = { campaignName: string | null; spend: unknown };

function toNumber(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "object" && "toNumber" in (value as object)) {
    return (value as { toNumber: () => number }).toNumber();
  }
  const n = Number(String(value).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function normalizeText(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[–—−]/g, "-")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function economicTurnover(row: {
  sellerRetailAmount: number;
  revenue: number;
}) {
  return row.sellerRetailAmount > 0 ? row.sellerRetailAmount : row.revenue;
}

function allocateRounded(
  amount: number,
  weights: Array<{ key: string; weight: number }>
): Map<string, number> {
  const result = new Map<string, number>();
  for (const item of weights) result.set(item.key, 0);
  if (!Number.isFinite(amount) || Math.abs(amount) < 0.0001) return result;

  const positive = weights.map((item) => ({
    key: item.key,
    weight: Math.max(0, item.weight),
  }));
  const totalWeight = positive.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight <= 0) return result;

  const cents = Math.round(amount * 100);
  const raw = positive.map((item) => {
    const exact = (cents * item.weight) / totalWeight;
    const floored = Math.trunc(exact);
    return { key: item.key, floored, frac: exact - floored };
  });
  let assigned = raw.reduce((sum, item) => sum + item.floored, 0);
  let leftover = cents - assigned;
  raw
    .slice()
    .sort((a, b) => b.frac - a.frac)
    .forEach((item) => {
      if (leftover === 0) return;
      const step = leftover > 0 ? 1 : -1;
      item.floored += step;
      leftover -= step;
    });
  for (const item of raw) result.set(item.key, item.floored / 100);
  return result;
}

export function classifyWbAdsCampaigns(
  adsRows: AdsRowInput[],
  adMaps: AdMapInput[]
): WbAdsCampaignAttribution[] {
  const vendorsByCampaign = new Map<string, Set<string>>();
  for (const map of adMaps) {
    const campaign = normalizeText(map.campaignName);
    const vendor = normalizeText(map.vendorCode);
    if (!campaign || !vendor) continue;
    const set = vendorsByCampaign.get(campaign) ?? new Set<string>();
    set.add(vendor);
    vendorsByCampaign.set(campaign, set);
  }

  const spendByCampaign = new Map<string, { name: string; spend: number }>();
  for (const ad of adsRows) {
    const campaign = normalizeText(ad.campaignName);
    const spend = toNumber(ad.spend);
    if (!campaign || spend === 0) continue;
    const current = spendByCampaign.get(campaign) ?? {
      name: String(ad.campaignName ?? ""),
      spend: 0,
    };
    current.spend += spend;
    spendByCampaign.set(campaign, current);
  }

  return Array.from(spendByCampaign.entries())
    .map(([key, value]) => {
      const vendorCodes = Array.from(vendorsByCampaign.get(key) ?? []);
      const cls: WbAdsCampaignClass =
        vendorCodes.length === 1
          ? "EXACT_ONE_ARTICLE"
          : vendorCodes.length > 1
            ? "ALLOCATED_MULTI_ARTICLE"
            : "UNMAPPED_ACCOUNT_LEVEL";
      return {
        campaignName: value.name,
        spend: value.spend,
        vendorCodes,
        cls,
      };
    })
    .sort((a, b) => b.spend - a.spend);
}

function abcByFinalProfit<T extends { netProfitAfterTax: number; abcByProfit: "A" | "B" | "C" }>(
  rows: T[]
) {
  const sorted = [...rows].sort(
    (a, b) => Math.max(0, b.netProfitAfterTax) - Math.max(0, a.netProfitAfterTax)
  );
  const totalPositive = sorted.reduce(
    (sum, row) => sum + Math.max(0, row.netProfitAfterTax),
    0
  );
  if (totalPositive <= 0) {
    for (const row of rows) row.abcByProfit = "C";
    return;
  }
  let cumulative = 0;
  for (const row of sorted) {
    const positive = Math.max(0, row.netProfitAfterTax);
    if (positive <= 0) {
      row.abcByProfit = "C";
      continue;
    }
    const shareBefore = cumulative / totalPositive;
    cumulative += positive;
    row.abcByProfit = shareBefore < 0.8 ? "A" : shareBefore < 0.95 ? "B" : "C";
  }
}

export function applyWbSkuManagementAllocation<T extends WbSkuAllocatableRow>(params: {
  rows: T[];
  topNetProfitAfterTax: number;
  adsRows: AdsRowInput[];
  adMaps: AdMapInput[];
  undistributedAdsCost: number;
  adsReconciliationAmount: number;
  unallocatedStorageCost: number;
}): {
  rows: Array<T & WbSkuAllocationMeta>;
  campaigns: WbAdsCampaignAttribution[];
  bridge: WbSkuAllocationBridge;
} {
  const campaigns = classifyWbAdsCampaigns(params.adsRows, params.adMaps);
  const multiVendors = new Set(
    campaigns
      .filter((campaign) => campaign.cls === "ALLOCATED_MULTI_ARTICLE")
      .flatMap((campaign) => campaign.vendorCodes)
  );
  const rowKeys = params.rows.map((row, index) => ({
    index,
    key: normalizeText(row.vendorCode) || `__row_${index}`,
    et: Math.max(0, economicTurnover(row)),
    qty: Math.max(0, row.netSalesQty),
    row,
  }));
  const etWeights = rowKeys.map((item) => ({ key: item.key, weight: item.et }));

  // Mapped one-article spend is already on the SKU row from Financial Core.
  // Equal-split multi-article spend is also already on the row; it is classified
  // allocated, not exact, but the source amount is not rebuilt here so top-level
  // mapped ads stay unchanged.
  const exactAds = new Map<string, number>();
  const campaignAds = new Map<string, number>();
  for (const item of rowKeys) {
    if (multiVendors.has(item.key) && item.row.adsCost > 0) {
      exactAds.set(item.key, 0);
      campaignAds.set(item.key, item.row.adsCost);
    } else {
      exactAds.set(item.key, item.row.adsCost);
      campaignAds.set(item.key, 0);
    }
  }

  const unmappedPool = Math.max(0, params.undistributedAdsCost);
  const unmappedParts = allocateRounded(unmappedPool, etWeights);

  const attributedWeights = rowKeys.map((item) => ({
    key: item.key,
    weight:
      (exactAds.get(item.key) ?? 0) + (campaignAds.get(item.key) ?? 0),
  }));
  const attributedSum = attributedWeights.reduce((sum, item) => sum + item.weight, 0);
  const reconDriver: "attributedAds" | "economicTurnover" =
    attributedSum > 0.5 ? "attributedAds" : "economicTurnover";
  const reconParts = allocateRounded(
    Math.max(0, params.adsReconciliationAmount),
    reconDriver === "attributedAds" ? attributedWeights : etWeights
  );

  const qtySum = rowKeys.reduce((sum, item) => sum + item.qty, 0);
  const storageDriver: "netSalesQty" | "economicTurnover" =
    qtySum > 0 ? "netSalesQty" : "economicTurnover";
  const storageParts = allocateRounded(
    Math.max(0, params.unallocatedStorageCost),
    storageDriver === "netSalesQty"
      ? rowKeys.map((item) => ({ key: item.key, weight: item.qty }))
      : etWeights
  );

  const nextRows = rowKeys.map((item) => {
    const exactAd = exactAds.get(item.key) ?? 0;
    const allocatedCampaign = campaignAds.get(item.key) ?? 0;
    const allocatedUnmapped = unmappedParts.get(item.key) ?? 0;
    const allocatedRecon = reconParts.get(item.key) ?? 0;
    const allocatedAds = allocatedCampaign + allocatedUnmapped + allocatedRecon;
    const exactStorage = item.row.storageCost;
    const allocatedStorage = storageParts.get(item.key) ?? 0;
    const previousAds = item.row.adsCost;
    const adsDelta = exactAd + allocatedAds - previousAds;
    const storageDelta = allocatedStorage;
    const allocatedExpense = adsDelta + storageDelta;
    const managementProfit = item.row.netProfitAfterTax - allocatedExpense;
    const et = economicTurnover(item.row);
    const nextAds = exactAd + allocatedAds;
    const attributionStatus: WbSkuAllocationMeta["attributionStatus"] =
      allocatedExpense > 0.5 && exactAd + exactStorage > 0.5
        ? "MIXED"
        : allocatedExpense > 0.5
          ? "ALLOCATED"
          : "EXACT";

    return {
      ...item.row,
      adsCost: nextAds,
      storageCost: exactStorage + allocatedStorage,
      netProfitAfterTax: managementProfit,
      marginProfit: item.row.marginProfit - allocatedExpense,
      marginAfterTaxPercent: et > 0 ? (managementProfit / et) * 100 : 0,
      marginProfitPercent:
        et > 0 ? ((item.row.marginProfit - allocatedExpense) / et) * 100 : 0,
      drrPercent: et > 0 ? (nextAds / et) * 100 : 0,
      exactAds: exactAd,
      allocatedCampaignAds: allocatedCampaign,
      allocatedUnmappedAds: allocatedUnmapped,
      allocatedReconAds: allocatedRecon,
      allocatedAds,
      exactStorage,
      allocatedStorage,
      exactContributionProfit: item.row.netProfitAfterTax,
      allocatedExpense,
      managementProfitAfterAllocation: managementProfit,
      attributionStatus,
    };
  });

  abcByFinalProfit(nextRows);

  const sumProfit = nextRows.reduce(
    (sum, row) => sum + row.netProfitAfterTax,
    0
  );
  const delta = Math.round((params.topNetProfitAfterTax - sumProfit) * 100) / 100;
  let unallocatedRemainder = 0;
  let unexplainedBridge = false;
  if (Math.abs(delta) <= 0.01 && Math.abs(delta) >= 0.005 && nextRows.length > 0) {
    const target = [...nextRows].sort(
      (a, b) => economicTurnover(b) - economicTurnover(a)
    )[0];
    target.netProfitAfterTax += delta;
    target.managementProfitAfterAllocation += delta;
    const et = economicTurnover(target);
    target.marginAfterTaxPercent =
      et > 0 ? (target.netProfitAfterTax / et) * 100 : 0;
  } else if (Math.abs(delta) > 1) {
    unexplainedBridge = true;
    unallocatedRemainder = delta;
  } else if (Math.abs(delta) > 0.01) {
    unallocatedRemainder = delta;
  }

  const sumManagementProfit = nextRows.reduce(
    (sum, row) => sum + row.netProfitAfterTax,
    0
  );

  return {
    rows: nextRows,
    campaigns,
    bridge: {
      sumManagementProfit,
      topNetProfitAfterTax: params.topNetProfitAfterTax,
      delta: Math.round((params.topNetProfitAfterTax - sumManagementProfit) * 100) / 100,
      exactAds: nextRows.reduce((sum, row) => sum + row.exactAds, 0),
      allocatedCampaignAds: nextRows.reduce(
        (sum, row) => sum + row.allocatedCampaignAds,
        0
      ),
      unmappedAds: nextRows.reduce((sum, row) => sum + row.allocatedUnmappedAds, 0),
      reconAds: nextRows.reduce((sum, row) => sum + row.allocatedReconAds, 0),
      allocatedStorage: nextRows.reduce((sum, row) => sum + row.allocatedStorage, 0),
      unallocatedRemainder,
      unexplainedBridge,
      storageDriver,
      reconDriver,
    },
  };
}

const MERGE_SKIP_KEYS = new Set([
  "nmId",
  "vendorCode",
  "subject",
  "abcByProfit",
  "attributionStatus",
  "revenueSharePercent",
  "drrPercent",
  "marginProfitPercent",
  "marginAfterTaxPercent",
]);

function mergeAttributionStatus(
  statuses: Array<WbSkuAllocationMeta["attributionStatus"]>
): WbSkuAllocationMeta["attributionStatus"] {
  if (statuses.includes("SOURCE_GAP")) return "SOURCE_GAP";
  const unique = new Set(statuses);
  if (unique.size === 1) return statuses[0] ?? "EXACT";
  if (unique.has("EXACT") && (unique.has("ALLOCATED") || unique.has("MIXED"))) {
    return "MIXED";
  }
  if (unique.has("MIXED")) return "MIXED";
  if (unique.has("ALLOCATED")) return "ALLOCATED";
  return "MIXED";
}

function productMergeKey(row: { vendorCode: string; nmId: string }) {
  return normalizeText(row.vendorCode) || normalizeText(row.nmId);
}

export function mergeWbSkuCompanyAllocations<T extends WbSkuAllocatableRow>(
  companies: Array<{
    companyName: string;
    rows: Array<T & WbSkuAllocationMeta>;
    sourceFinal: boolean;
  }>
): Array<T & WbSkuAllocationMeta> {
  const byKey = new Map<
    string,
    { row: T & WbSkuAllocationMeta; statuses: Array<WbSkuAllocationMeta["attributionStatus"]> }
  >();

  for (const company of companies) {
    for (const row of company.rows) {
      const key = productMergeKey(row) || `__empty_${byKey.size}`;
      const status: WbSkuAllocationMeta["attributionStatus"] = company.sourceFinal
        ? row.attributionStatus
        : "SOURCE_GAP";
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, {
          row: { ...row, attributionStatus: status },
          statuses: [status],
        });
        continue;
      }
      const merged = { ...existing.row } as T & WbSkuAllocationMeta;
      for (const [field, value] of Object.entries(row) as Array<[string, unknown]>) {
        if (MERGE_SKIP_KEYS.has(field)) continue;
        if (typeof value === "number") {
          const current = (merged as unknown as Record<string, unknown>)[field];
          if (typeof current === "number") {
            (merged as unknown as Record<string, number>)[field] = current + value;
          }
        }
      }
      if (!merged.vendorCode && row.vendorCode) merged.vendorCode = row.vendorCode;
      if (!merged.nmId && row.nmId) merged.nmId = row.nmId;
      existing.row = merged;
      existing.statuses.push(status);
    }
  }

  const mergedRows = Array.from(byKey.values()).map((item) => {
    const et = economicTurnover(item.row);
    const profit = item.row.netProfitAfterTax;
    const ads = item.row.adsCost;
    const marginProfit = item.row.marginProfit;
    return {
      ...item.row,
      attributionStatus: mergeAttributionStatus(item.statuses),
      managementProfitAfterAllocation: profit,
      marginAfterTaxPercent: et > 0 ? (profit / et) * 100 : 0,
      marginProfitPercent: et > 0 ? (marginProfit / et) * 100 : 0,
      drrPercent: et > 0 ? (ads / et) * 100 : 0,
    };
  });

  const totalEt = mergedRows.reduce((sum, row) => sum + economicTurnover(row), 0);
  for (const row of mergedRows) {
    const et = economicTurnover(row);
    (row as { revenueSharePercent?: number }).revenueSharePercent =
      totalEt > 0 ? (et / totalEt) * 100 : 0;
  }
  abcByFinalProfit(mergedRows);
  return mergedRows;
}
