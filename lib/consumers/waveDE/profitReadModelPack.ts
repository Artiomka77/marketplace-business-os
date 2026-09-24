import { prisma } from "@/lib/prisma";
import {
  WaveDEConsumerUnavailableError,
  type WaveDEConsumerMeta,
} from "./types";

export const FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1 =
  "FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1" as const;
export const FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1 =
  "FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1" as const;

export type ProfitMarketplace = "WB" | "OZON";

export function formulaForMarketplace(marketplace: ProfitMarketplace) {
  return marketplace === "WB"
    ? FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1
    : FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1;
}

function toDateOnly(value: string) {
  return new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
}

export async function loadProfitReadModelPack(params: {
  marketplace: ProfitMarketplace;
  companyScope: string;
  dateFrom: string;
  dateTo: string;
}) {
  const formulaVersion = formulaForMarketplace(params.marketplace);
  const dateFrom = toDateOnly(params.dateFrom);
  const dateTo = toDateOnly(params.dateTo);
  const companyScope = params.companyScope || "ALL";

  const row = await prisma.profitPeriodMetric.findUnique({
    where: {
      companyScope_marketplace_dateFrom_dateTo_formulaVersion: {
        companyScope,
        marketplace: params.marketplace,
        dateFrom,
        dateTo,
        formulaVersion,
      },
    },
  });

  if (!row) {
    throw new WaveDEConsumerUnavailableError(
      "READ_MODEL_MISS",
      "Profit read model row missing",
      { companyScope, marketplace: params.marketplace, dateFrom: params.dateFrom, dateTo: params.dateTo, formulaVersion },
    );
  }
  if (row.formulaVersion !== formulaVersion) {
    throw new WaveDEConsumerUnavailableError(
      "FORMULA_VERSION_MISMATCH",
      "Profit formulaVersion mismatch",
      { actual: row.formulaVersion, expected: formulaVersion },
    );
  }
  if (row.dataMode === "PRELIMINARY") {
    throw new WaveDEConsumerUnavailableError(
      "PRELIMINARY_NOT_TRUSTED",
      "Profit read model is PRELIMINARY",
      { dataMode: row.dataMode, formulaVersion },
    );
  }
  if (row.dataMode !== "FINAL" || row.coverageStatus !== "COMPLETE") {
    throw new WaveDEConsumerUnavailableError(
      "READ_MODEL_MISS",
      "Profit read model is not FINAL/COMPLETE",
      { dataMode: row.dataMode, coverageStatus: row.coverageStatus, formulaVersion },
    );
  }

  const skuRows = await prisma.profitSkuPeriodMetric.findMany({
    where: {
      companyScope,
      marketplace: params.marketplace,
      dateFrom,
      dateTo,
      formulaVersion,
    },
    orderBy: { productKey: "asc" },
  });

  const meta: WaveDEConsumerMeta = {
    source: "READ_MODEL",
    formulaVersion,
    dataMode: "FINAL",
    coverageStatus: row.coverageStatus,
    generatedAt: row.generatedAt ? new Date(row.generatedAt).toISOString() : null,
    companyScope,
    dateFrom: params.dateFrom.slice(0, 10),
    dateTo: params.dateTo.slice(0, 10),
    heavyFinancialCoreCalls: 0,
  };

  return {
    row,
    skuRows,
    analytics: row.analyticsPayload,
    totals: row.totals,
    comparison: row.comparison,
    meta,
  };
}
