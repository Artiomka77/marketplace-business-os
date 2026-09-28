import {
  financeAccountKey,
  runWbFinanceAccountQueue,
  WB_FINANCE_MIN_INTERVAL_MS,
} from "@/lib/wb/wbFinanceAccountQueue";

export { WB_FINANCE_MIN_INTERVAL_MS };

export const WB_FINANCE_API_BASE =
  "https://finance-api.wildberries.ru/api/finance/v1";

export const WB_FINANCE_REPORTS_LIST_URL = `${WB_FINANCE_API_BASE}/sales-reports/list`;
export const WB_FINANCE_REPORT_DETAILS_BY_ID_URL = (reportId: string) =>
  `${WB_FINANCE_API_BASE}/sales-reports/detailed/${encodeURIComponent(reportId)}`;
export const WB_FINANCE_REPORT_DETAILS_PERIOD_URL = `${WB_FINANCE_API_BASE}/sales-reports/detailed`;

export const WB_DEPRECATED_STATISTICS_DETAIL_URL =
  "https://statistics-api.wildberries.ru/api/v5/supplier/reportDetailByPeriod";

export type WbFinancePeriodKind = "weekly" | "daily";

export type WbFinanceHttpResult = {
  ok: boolean;
  status: number;
  body: unknown;
  scopeDenied: boolean;
};

export function formatWbFinanceBody(body: unknown) {
  if (typeof body === "string") return body;
  if (body == null) return "";
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

export class WbFinanceScopeError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "WbFinanceScopeError";
    this.status = status;
  }
}

const DEFAULT_BACKOFF_MS = [60_000, 90_000, 120_000, 180_000];

export function isWbFinanceScopeDenied(status: number) {
  return status === 401 || status === 403;
}

export function buildFinanceReportsListBody(params: {
  dateFrom: string;
  dateTo: string;
  period?: WbFinancePeriodKind;
  limit?: number;
  offset?: number;
}) {
  return {
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
    period: params.period ?? "weekly",
    limit: params.limit ?? 100,
    offset: params.offset ?? 0,
  };
}

export function buildFinanceDetailsByIdBody(params: {
  rrdId?: number;
  rrdid?: number;
  limit?: number;
}) {
  const rrdId = params.rrdId ?? params.rrdid ?? 0;
  return {
    limit: params.limit ?? 100_000,
    rrdId,
    rrdid: rrdId,
  };
}

export function buildFinancePeriodDetailsBody(params: {
  dateFrom: string;
  dateTo: string;
  period: WbFinancePeriodKind;
  rrdId?: number;
  rrdid?: number;
  limit?: number;
}) {
  const rrdId = params.rrdId ?? params.rrdid ?? 0;
  return {
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
    period: params.period,
    limit: params.limit ?? 100_000,
    rrdId,
    rrdid: rrdId,
  };
}

function rowRrdId(row: {
  rrdId?: number | string;
  rrdid?: number | string;
  rrd_id?: number | string;
} | null | undefined) {
  const value = row?.rrdId ?? row?.rrdid ?? row?.rrd_id;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

export function nextRrdId(
  rows: Array<{
    rrdId?: number | string;
    rrdid?: number | string;
    rrd_id?: number | string;
  }>,
) {
  return rowRrdId(rows[rows.length - 1]);
}

export function extractReportIds(listPayload: unknown): string[] {
  const rows = Array.isArray(listPayload)
    ? listPayload
    : Array.isArray((listPayload as { data?: unknown })?.data)
      ? ((listPayload as { data: unknown[] }).data)
      : [];
  const ids = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const id =
      record.id ??
      record.reportId ??
      record.reportNumber ??
      record.realizationreport_id ??
      record.realizationReportId;
    if (id == null) continue;
    const text = String(id).trim();
    if (text) ids.add(text);
  }
  return [...ids];
}

async function wbFinanceRequestUnqueued(params: {
  url: string;
  token: string;
  body: unknown;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
}): Promise<WbFinanceHttpResult> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const sleep = params.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const maxAttempts = params.maxAttempts ?? DEFAULT_BACKOFF_MS.length + 1;

  let lastStatus = 0;
  let lastBody: unknown = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const response = await fetchImpl(params.url, {
      method: "POST",
      headers: {
        Authorization: params.token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(params.body),
      cache: "no-store",
    });
    lastStatus = response.status;
    lastBody = await response.json().catch(async () => await response.text().catch(() => null));

    if (isWbFinanceScopeDenied(response.status)) {
      throw new WbFinanceScopeError(
        response.status,
        `WB Finance API token lacks Finance scope or is unauthorized (HTTP ${response.status})`,
      );
    }

    if (response.status === 429 || response.status >= 500) {
      const retryAfter = Number(response.headers.get("Retry-After") ?? "");
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : DEFAULT_BACKOFF_MS[Math.min(attempt, DEFAULT_BACKOFF_MS.length - 1)];
      if (attempt < maxAttempts - 1) {
        await sleep(waitMs);
        continue;
      }
    }

    return {
      ok: response.ok,
      status: response.status,
      body: lastBody,
      scopeDenied: false,
    };
  }

  return {
    ok: false,
    status: lastStatus,
    body: lastBody,
    scopeDenied: false,
  };
}

export async function wbFinanceRequest(params: {
  url: string;
  token: string;
  body: unknown;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  maxAttempts?: number;
}): Promise<WbFinanceHttpResult> {
  return runWbFinanceAccountQueue({
    accountKey: financeAccountKey(params.token),
    now: params.now,
    sleep: params.sleep,
    task: () => wbFinanceRequestUnqueued(params),
  });
}

export async function fetchAllDetailedPages(params: {
  token: string;
  reportId?: string;
  period?: { dateFrom: string; dateTo: string; kind: WbFinancePeriodKind };
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxPages?: number;
}) {
  const maxPages = params.maxPages ?? 40;
  const pages: unknown[][] = [];
  let rrdId = 0;

  for (let page = 0; page < maxPages; page += 1) {
    const url = params.reportId
      ? WB_FINANCE_REPORT_DETAILS_BY_ID_URL(params.reportId)
      : WB_FINANCE_REPORT_DETAILS_PERIOD_URL;
    const body = params.reportId
      ? buildFinanceDetailsByIdBody({ rrdId })
      : buildFinancePeriodDetailsBody({
          dateFrom: params.period!.dateFrom,
          dateTo: params.period!.dateTo,
          period: params.period!.kind,
          rrdId,
        });
    const result = await wbFinanceRequest({
      url,
      token: params.token,
      body,
      fetchImpl: params.fetchImpl,
      sleep: params.sleep,
    });
    if (!result.ok && result.status !== 204) {
      throw new Error(`WB Finance details HTTP ${result.status}`);
    }
    const rows = Array.isArray(result.body)
      ? result.body
      : Array.isArray((result.body as { data?: unknown })?.data)
        ? ((result.body as { data: unknown[] }).data)
        : [];
    if (rows.length === 0) break;
    pages.push(rows as unknown[]);
    const next = nextRrdId(rows as Array<{ rrdId?: number; rrdid?: number; rrd_id?: number }>);
    if (next == null || next === rrdId) break;
    rrdId = next;
  }

  return pages.flat();
}

export const WB_FINANCE_SALES_REPORTS_LIST_URL = WB_FINANCE_REPORTS_LIST_URL;
export const nextRrdid = nextRrdId;
