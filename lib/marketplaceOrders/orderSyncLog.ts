const KIND = "avorofin_marketplace_orders_sync";
const MAX_STRING = 80;

const SENSITIVE =
  /cron_secret|authorization|bearer\s|wbtoken|wb token|ozonapikey|api-key|client-id|ciphertext|password/i;

export type MarketplaceOrdersLogEvent = {
  runId: string;
  route: string;
  mode?: string;
  targetDate?: string;
  companyName?: string;
  marketplace?: string;
  phase: string;
  status: string;
  retryable?: boolean;
  reasonCode?: string;
  durationMs?: number;
  partialSuccess?: boolean;
  rowsWritten?: number;
  httpStatus?: number;
  recoveryPlanned?: boolean;
  recoveryNoOp?: boolean;
  incompleteCount?: number;
  attempted?: number;
};

function bound(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).slice(0, MAX_STRING);
  if (SENSITIVE.test(text)) return "[redacted]";
  return text;
}

export function createOrderSyncRunId(now = new Date()): string {
  return `mos-${now.toISOString().replace(/[^0-9]/g, "").slice(0, 14)}`;
}

export function logMarketplaceOrdersEvent(event: MarketplaceOrdersLogEvent): void {
  const payload: Record<string, unknown> = {
    at: new Date().toISOString(),
    kind: KIND,
    runId: bound(event.runId),
    route: bound(event.route),
    phase: bound(event.phase),
    status: bound(event.status),
  };
  if (event.mode) payload.mode = bound(event.mode);
  if (event.targetDate) payload.targetDate = bound(event.targetDate);
  if (event.companyName) payload.companyName = bound(event.companyName);
  if (event.marketplace) payload.marketplace = bound(event.marketplace);
  if (event.retryable !== undefined) payload.retryable = event.retryable;
  if (event.reasonCode) payload.reasonCode = bound(event.reasonCode);
  if (event.durationMs !== undefined) payload.durationMs = event.durationMs;
  if (event.partialSuccess !== undefined) payload.partialSuccess = event.partialSuccess;
  if (event.rowsWritten !== undefined) payload.rowsWritten = event.rowsWritten;
  if (event.httpStatus !== undefined) payload.httpStatus = event.httpStatus;
  if (event.recoveryPlanned !== undefined) payload.recoveryPlanned = event.recoveryPlanned;
  if (event.recoveryNoOp !== undefined) payload.recoveryNoOp = event.recoveryNoOp;
  if (event.incompleteCount !== undefined) payload.incompleteCount = event.incompleteCount;
  if (event.attempted !== undefined) payload.attempted = event.attempted;
  process.stderr.write(`${JSON.stringify(payload)}\n`);
}
