import { createHash } from "node:crypto";

import {
  FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
  type DailyCompanyMarketplaceMetricsPayload,
  type PeriodCompanyMarketplaceMetricsPayload,
  type V6DataMode,
} from "./contract";

export function isoDateOnly(value: string): string {
  return value.slice(0, 10);
}

export function isOpenPeriod(dateTo: string, todayIso = new Date().toISOString().slice(0, 10)) {
  return isoDateOnly(dateTo) >= todayIso;
}

export function resolveDataMode(dateTo: string, todayIso?: string): V6DataMode {
  return isOpenPeriod(dateTo, todayIso) ? "PRELIMINARY" : "FINAL";
}

export function buildInvalidationKey(params: {
  companyScope: string;
  marketplace: string;
  dateFrom: string;
  dateTo: string;
  formulaVersion?: string;
}) {
  return [
    params.formulaVersion ?? FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
    params.companyScope,
    params.marketplace,
    isoDateOnly(params.dateFrom),
    isoDateOnly(params.dateTo),
  ].join("|");
}

export function checksumJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function buildSourceFingerprint(params: {
  companyScope: string;
  dateFrom: string;
  dateTo: string;
  companyRows: PeriodCompanyMarketplaceMetricsPayload[];
  dailyPoints: DailyCompanyMarketplaceMetricsPayload[];
  dataMode: V6DataMode;
}) {
  return checksumJson({
    formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
    companyScope: params.companyScope,
    dateFrom: isoDateOnly(params.dateFrom),
    dateTo: isoDateOnly(params.dateTo),
    dataMode: params.dataMode,
    companyRowCount: params.companyRows.length,
    dailyPointCount: params.dailyPoints.length,
    totals: params.companyRows.map((row) => ({
      c: row.companyName,
      r: row.totalRevenue,
      p: row.netProfit,
      a: row.adsCost,
    })),
    dailyHead: params.dailyPoints.slice(0, 3),
    dailyTail: params.dailyPoints.slice(-3),
  });
}
