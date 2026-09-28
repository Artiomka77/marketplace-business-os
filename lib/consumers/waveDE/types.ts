export type WaveDEUnavailableReason =
  | "READ_MODEL_MISS"
  | "FORMULA_VERSION_MISMATCH"
  | "STALE_SOURCE"
  | "PRELIMINARY_NOT_TRUSTED"
  | "CROSS_COMPANY_REJECTED"
  | "PARTIAL_RANGE_NOT_COMPLETE"
  | "OPEN_PERIOD_NOT_TRUSTED_PLANNING";

export class WaveDEConsumerUnavailableError extends Error {
  readonly code = "WAVE_DE_CONSUMER_UNAVAILABLE" as const;
  constructor(
    readonly reason: WaveDEUnavailableReason,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "WaveDEConsumerUnavailableError";
  }
}

export type WaveDEConsumerMeta = {
  source: "READ_MODEL";
  formulaVersion: string;
  dataMode: "FINAL" | "PRELIMINARY" | "UNKNOWN";
  coverageStatus: string;
  generatedAt: string | null;
  companyScope: string;
  dateFrom: string;
  dateTo: string;
  heavyFinancialCoreCalls: 0;
};
