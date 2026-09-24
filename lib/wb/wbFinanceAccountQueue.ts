export const WB_FINANCE_API_BASE =
  "https://finance-api.wildberries.ru/api/finance/v1";

export const WB_FINANCE_SALES_REPORTS_LIST_URL = `${WB_FINANCE_API_BASE}/sales-reports/list`;
export const WB_FINANCE_SALES_REPORT_DETAILS_PERIOD_URL = `${WB_FINANCE_API_BASE}/sales-reports/detailed`;
export const WB_FINANCE_SALES_REPORT_DETAILS_BY_ID_URL = (reportId: string) =>
  `${WB_FINANCE_API_BASE}/sales-reports/detailed/${encodeURIComponent(reportId)}`;

export const WB_DEPRECATED_STATISTICS_DETAIL_URL =
  "https://statistics-api.wildberries.ru/api/v5/supplier/reportDetailByPeriod";

export const WB_FINANCE_MIN_INTERVAL_MS = 60_000;

type QueueState = {
  tail: Promise<unknown>;
  lastFinishedAt: number;
};

const queues = new Map<string, QueueState>();

export function financeAccountKey(token: string) {
  let hash = 0;
  for (let i = 0; i < token.length; i += 1) {
    hash = (hash * 31 + token.charCodeAt(i)) >>> 0;
  }
  return `wb-finance:${hash.toString(16)}`;
}

export async function runWbFinanceAccountQueue<T>(params: {
  accountKey: string;
  task: () => Promise<T>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  minIntervalMs?: number;
}): Promise<T> {
  const now = params.now ?? Date.now;
  const sleep =
    params.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const minIntervalMs = params.minIntervalMs ?? WB_FINANCE_MIN_INTERVAL_MS;
  const current = queues.get(params.accountKey) ?? {
    tail: Promise.resolve(),
    lastFinishedAt: 0,
  };

  const run = current.tail.then(async () => {
    const wait = Math.max(0, minIntervalMs - (now() - current.lastFinishedAt));
    if (wait > 0) await sleep(wait);
    try {
      return await params.task();
    } finally {
      current.lastFinishedAt = now();
    }
  });

  current.tail = run.then(
    () => undefined,
    () => undefined,
  );
  queues.set(params.accountKey, current);

  return run;
}

export function resetWbFinanceAccountQueues() {
  queues.clear();
}
