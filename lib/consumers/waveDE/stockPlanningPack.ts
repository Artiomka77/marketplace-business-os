import {
  readStockAbcSnapshots,
  STOCK_PLANNING_SNAPSHOT_FORMULA_VERSION,
} from "@/lib/stocks/stockAbcSnapshots";
import {
  WaveDEConsumerUnavailableError,
  type WaveDEConsumerMeta,
} from "./types";

export async function loadStockPlanningAbcPack(params: {
  companyScope: string;
  dateFrom: string;
  dateTo: string;
  requireExact?: boolean;
}) {
  const requireExact = params.requireExact !== false;
  const pack = await readStockAbcSnapshots({
    companyScope: params.companyScope,
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
  });

  if (requireExact && !pack.isExact) {
    throw new WaveDEConsumerUnavailableError(
      "READ_MODEL_MISS",
      "Stock planning ABC snapshot is not exact for requested period/company",
      {
        companyScope: params.companyScope,
        dateFrom: params.dateFrom,
        dateTo: params.dateTo,
        metadata: pack.metadata,
        formulaVersion: STOCK_PLANNING_SNAPSHOT_FORMULA_VERSION,
      },
    );
  }

  const meta: WaveDEConsumerMeta = {
    source: "READ_MODEL",
    formulaVersion: STOCK_PLANNING_SNAPSHOT_FORMULA_VERSION,
    dataMode: pack.isExact ? "FINAL" : "UNKNOWN",
    coverageStatus: pack.isExact ? "COMPLETE" : "PARTIAL",
    generatedAt: pack.metadata.map((m) => m.generatedAt).filter(Boolean)[0] ?? null,
    companyScope: params.companyScope,
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
    heavyFinancialCoreCalls: 0,
  };

  return { pack, meta };
}
