import {
  FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
  type PeriodCompanyMarketplaceMetricsPayload,
} from "@/lib/dashboard/v6PeriodReadModel/contract";
import { getDefaultV6PeriodReadModelRepository } from "@/lib/dashboard/v6PeriodReadModel";
import { loadDashboardV6PeriodReadModel } from "@/lib/dashboard/v6PeriodReadModel/consumer";
import {
  WaveDEConsumerUnavailableError,
  type WaveDEConsumerMeta,
} from "./types";

export async function loadPeriodFinancePack(params: {
  companyScope: string;
  dateFrom: string;
  dateTo: string;
}) {
  const repository = getDefaultV6PeriodReadModelRepository();
  const loaded = await loadDashboardV6PeriodReadModel({
    repository,
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
    companyScope: params.companyScope,
  });

  if (loaded.status !== "HIT") {
    throw new WaveDEConsumerUnavailableError(
      "READ_MODEL_MISS",
      `Period finance read model unavailable (${loaded.status})`,
      {
        status: loaded.status,
        reason: "reason" in loaded ? (loaded as any).reason : null,
        formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
        companyScope: params.companyScope,
        dateFrom: params.dateFrom,
        dateTo: params.dateTo,
      },
    );
  }

  const metaRow = loaded.bundle.meta;
  const dataMode = (metaRow.dataMode || "UNKNOWN") as WaveDEConsumerMeta["dataMode"];
  if (dataMode === "PRELIMINARY") {
    throw new WaveDEConsumerUnavailableError(
      "PRELIMINARY_NOT_TRUSTED",
      "Period finance read model is PRELIMINARY and cannot be trusted as FINAL on ordinary path",
      { dataMode, formulaVersion: metaRow.formulaVersion },
    );
  }
  if (metaRow.formulaVersion !== FINANCIAL_CORE_V6_PERIOD_READMODEL_V2) {
    throw new WaveDEConsumerUnavailableError(
      "FORMULA_VERSION_MISMATCH",
      "Period finance formulaVersion mismatch",
      { actual: metaRow.formulaVersion, expected: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2 },
    );
  }

  const payload = loaded.bundle.companyRows as PeriodCompanyMarketplaceMetricsPayload[];
  const meta: WaveDEConsumerMeta = {
    source: "READ_MODEL",
    formulaVersion: metaRow.formulaVersion,
    dataMode: dataMode === "FINAL" ? "FINAL" : "UNKNOWN",
    coverageStatus: String(metaRow.coverageStatus ?? "UNKNOWN"),
    generatedAt: metaRow.generatedAt ?? null,
    companyScope: params.companyScope,
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
    heavyFinancialCoreCalls: 0,
  };
  return { loaded, payload, meta };
}
