import { createHash } from "node:crypto";
import type { ProfitMarketplace, WaveBProfitFormulaVersion } from "./contract";

export function isoDateOnly(value: Date | string): string {
  return new Date(value).toISOString().slice(0, 10);
}

export function sha256Json(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

export function buildSourceFingerprint(params: {
  marketplace: ProfitMarketplace;
  companyScope: string;
  dateFrom: string;
  dateTo: string;
  formulaVersion: WaveBProfitFormulaVersion;
  analyticsHint: unknown;
}): string {
  return sha256Json({
    marketplace: params.marketplace,
    companyScope: params.companyScope,
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
    formulaVersion: params.formulaVersion,
    hint: params.analyticsHint,
  });
}

export function productKeyFromRow(
  marketplace: ProfitMarketplace,
  row: Record<string, unknown>
): string {
  if (marketplace === "WB") {
    const nmId = String(row.nmId ?? row.nmid ?? "");
    const vendor = String(row.vendorCode ?? row.supplierArticle ?? "");
    return `WB:${nmId}|${vendor}`;
  }
  const nmId = String(row.nmId ?? row.sku ?? row.offerId ?? row.productId ?? "");
  const vendor = String(row.vendorCode ?? row.offerId ?? "");
  return `OZON:${nmId}|${vendor}`;
}
