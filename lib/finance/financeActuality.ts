/**
 * Actual vs planned FinanceTransaction contract.
 * ACTUAL metrics must only include FACT (confirmed) rows.
 * PLAN rows belong in Operations/Calendar/Forecast visibility, not silent DDS/P&L.
 */

export function normalizeFinanceTransactionStatus(
  status: string | null | undefined,
): "FACT" | "PLAN" | "OTHER" {
  const value = String(status ?? "FACT").trim().toUpperCase();
  if (value === "PLAN") return "PLAN";
  if (value === "FACT" || value === "") return "FACT";
  return "OTHER";
}

export function isActualFinanceTransaction(row: {
  transactionStatus?: string | null;
}): boolean {
  return normalizeFinanceTransactionStatus(row.transactionStatus) === "FACT";
}

export function filterActualFinanceTransactions<
  T extends { transactionStatus?: string | null },
>(rows: T[]): T[] {
  return rows.filter((row) => isActualFinanceTransaction(row));
}

/** LoanPayment.paid drives FinanceTransaction actuality for generated loan rows. */
export function financeStatusForLoanPaymentPaid(paid: boolean): "FACT" | "PLAN" {
  return paid ? "FACT" : "PLAN";
}

export const ACTUAL_FINANCE_TRANSACTION_WHERE = {
  transactionStatus: "FACT",
} as const;
