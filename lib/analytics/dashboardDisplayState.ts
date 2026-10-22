export type DashboardSourceState = "FINAL" | "PRELIMINARY" | "NO_DATA";

export type MarketplaceMoneySlice = {
  wbRevenue: number | null;
  ozonRevenue: number | null;
  totalRevenue: number | null;
  operatingProfitAfterTax: number | null;
  netProfit: number | null;
  profitAfterOwnerWithdrawal: number | null;
  marketplaceTotalIncomplete: boolean;
  ozonCoverageComplete?: boolean;
};

const moneyFormatter = new Intl.NumberFormat("ru-RU", {
  style: "currency",
  currency: "RUB",
  maximumFractionDigits: 0,
});

export function formatKnownMoney(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "нет данных";
  return moneyFormatter.format(value);
}

export function marketplaceAmountState(
  amount: number | null | undefined
): DashboardSourceState {
  if (amount == null || !Number.isFinite(amount)) return "NO_DATA";
  return "PRELIMINARY";
}

export function isCoverageComparableForDelta(input: {
  currentIncomplete: boolean;
  previousIncomplete: boolean;
  currentMayPresentAsFinal: boolean;
  previousMayPresentAsFinal: boolean;
}): boolean {
  if (input.currentIncomplete || input.previousIncomplete) return false;
  if (!input.currentMayPresentAsFinal || !input.previousMayPresentAsFinal) {
    return false;
  }
  return true;
}

export function comparableDeltaValue(
  value: number | null,
  comparable: boolean
): number | null {
  return comparable ? value : null;
}

export function resolveOzonFinanceBadge(input: {
  ozonRevenue: number | null;
  ozonCoverageComplete?: boolean | null;
  weekReason: string | null;
  weekBadgeText: string | null;
  dataReadinessIssueKinds: string[];
  dataReadinessIsFinal: boolean;
  dataReadinessShortText: string;
  hasOrderCoverageWarning: boolean;
  mayPresentAsFinal: boolean;
  unclassifiedAdjustmentAbs?: number | null;
}): string {
  const financeMissing = input.dataReadinessIssueKinds.includes(
    "OZON_FINANCE_MISSING"
  );
  const ozonNoData = input.ozonRevenue == null;
  const unclassifiedAbs =
    input.unclassifiedAdjustmentAbs != null &&
    Number.isFinite(input.unclassifiedAdjustmentAbs) &&
    Math.abs(input.unclassifiedAdjustmentAbs) > 0.005
      ? Math.abs(input.unclassifiedAdjustmentAbs)
      : null;

  if (ozonNoData && (financeMissing || input.weekReason === "OZON_COVERAGE_INCOMPLETE")) {
    // Honest waiting-source badge — not a blank "recalculating" claim.
    return "Ozon: финансовые данные за день ещё формируются";
  }

  if (unclassifiedAbs != null && !ozonNoData) {
    const formatted = new Intl.NumberFormat("ru-RU", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(unclassifiedAbs);
    // Monetary complete + analytical gap: available, not "ещё формируются".
    return `Ozon финансы: готовы · ${formatted} ₽ без категории`;
  }

  if (input.ozonCoverageComplete === false && !ozonNoData) {
    return "Ozon финансы: PRELIMINARY";
  }

  if (input.weekReason === "OZON_QUARANTINE_ACTIVE") {
    return "Ozon финансы: PRELIMINARY";
  }

  if (input.mayPresentAsFinal && input.dataReadinessIsFinal) {
    return input.dataReadinessShortText || "Ozon финансы: FINAL";
  }

  if (input.weekBadgeText && !/ozon coverage/i.test(input.weekBadgeText)) {
    return input.weekBadgeText;
  }

  if (input.dataReadinessIsFinal) {
    return input.dataReadinessShortText;
  }

  if (input.hasOrderCoverageWarning) {
    return `${input.dataReadinessShortText} · загружены частично`;
  }

  return input.dataReadinessShortText || "PRELIMINARY";
}

export function ozonSkuMappingWarningLabel(unmappedOzonItemsCount: number): string | null {
  if (unmappedOzonItemsCount <= 0) return null;
  return "Не все Ozon SKU сопоставлены";
}

export function salesCardPresentation(
  slice: MarketplaceMoneySlice,
  options: {
    periodPreliminary: boolean;
    ozonCoverageNote?: string | null;
  }
): { value: string; subtitle: string; valueClassName: string } {
  const wbKnown = slice.wbRevenue != null && Number.isFinite(slice.wbRevenue);
  const ozonKnown = slice.ozonRevenue != null && Number.isFinite(slice.ozonRevenue);
  const combinedKnown =
    slice.totalRevenue != null &&
    Number.isFinite(slice.totalRevenue) &&
    wbKnown &&
    ozonKnown;

  const ozonText = ozonKnown
    ? formatKnownMoney(slice.ozonRevenue)
    : "нет данных";
  const wbText = wbKnown ? formatKnownMoney(slice.wbRevenue) : "нет данных";
  const preliminaryNote = options.periodPreliminary ? " · Предварительно" : "";
  const coverageNote =
    options.ozonCoverageNote && options.ozonCoverageNote.trim()
      ? ` · ${options.ozonCoverageNote.trim()}`
      : "";

  if (combinedKnown) {
    const combinedNote = options.periodPreliminary
      ? " · Предварительный итог по доступным данным"
      : "";
    return {
      value: formatKnownMoney(slice.totalRevenue),
      subtitle: `WB: ${wbText} · Ozon: ${ozonText}${combinedNote}${coverageNote}`,
      valueClassName: options.periodPreliminary ? "text-amber-700" : "text-slate-950",
    };
  }

  if (wbKnown || ozonKnown) {
    return {
      value: wbKnown ? formatKnownMoney(slice.wbRevenue) : formatKnownMoney(slice.ozonRevenue),
      subtitle: `WB: ${wbText} · Ozon: ${ozonText} · итог по бизнесу не сводится${preliminaryNote}${coverageNote}`,
      valueClassName: "text-amber-700",
    };
  }

  return {
    value: "Нет данных",
    subtitle: `WB: ${wbText} · Ozon: ${ozonText}${coverageNote}`,
    valueClassName: "text-slate-950",
  };
}

export function combinedPnlCardPresentation(input: {
  amount: number | null;
  periodPreliminary: boolean;
  marketplaceIncomplete: boolean;
  ozonRevenue: number | null;
  basisLabel: string;
  extraSubtitle?: string;
}): { value: string; subtitle: string; valueClassName: string } {
  const ozonKnown =
    input.ozonRevenue != null && Number.isFinite(input.ozonRevenue);
  const combinedKnown =
    input.amount != null &&
    Number.isFinite(input.amount) &&
    !input.marketplaceIncomplete &&
    ozonKnown;

  const preliminaryNote = input.periodPreliminary ? " · Предварительно" : "";

  if (combinedKnown) {
    return {
      value: formatKnownMoney(input.amount),
      subtitle: `${input.basisLabel}${preliminaryNote}${input.extraSubtitle ?? ""}`,
      valueClassName: optionsValueColor(input.amount, input.periodPreliminary),
    };
  }

  return {
    value: "Недоступно",
    subtitle: `${input.basisLabel} · нет полного P&L по WB+Ozon · Ozon: ${
      ozonKnown ? formatKnownMoney(input.ozonRevenue) : "нет данных"
    }${preliminaryNote}`,
    valueClassName: "text-amber-700",
  };
}

function optionsValueColor(value: number | null, preliminary: boolean) {
  if (preliminary) return "text-amber-700";
  if (value == null) return "text-slate-950";
  if (value > 0) return "text-emerald-700";
  if (value < 0) return "text-red-600";
  return "text-slate-950";
}

export function adsCardPresentation(input: {
  adsCost: number;
  drr: number | null;
  drrByOrders: number | null;
  periodPreliminary: boolean;
  ordersCoverageIncomplete?: boolean;
  formatPercent: (value: number | null) => string;
}): { value: string; subtitle: string } {
  const drrText =
    input.drr != null && Number.isFinite(input.drr)
      ? input.formatPercent(input.drr)
      : "Нет данных";
  const drrOrders =
    input.drrByOrders != null && Number.isFinite(input.drrByOrders)
      ? input.formatPercent(input.drrByOrders)
      : "—";
  const ordersDrrLabel = input.ordersCoverageIncomplete
    ? `ДРР от заказов — предварительно / неполный знаменатель: ${drrOrders}`
    : `ДРР от заказов: ${drrOrders}`;
  const preliminaryNote = input.periodPreliminary ? " · Предварительно" : "";
  return {
    value: drrText,
    subtitle: `Реклама всего: ${formatKnownMoney(input.adsCost)} · ${ordersDrrLabel}${preliminaryNote}`,
  };
}

export function shouldNullCombinedBecauseFakeOzonZero(row: {
  ozonCoverageComplete?: boolean;
  ozonRevenue: number | null;
}): boolean {
  return row.ozonCoverageComplete === false && row.ozonRevenue === 0;
}
