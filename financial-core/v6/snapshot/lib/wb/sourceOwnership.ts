import type { Prisma } from "@prisma/client";

import {
  buildCanonicalPositiveCostLookups,
  normalizeProductCostKey,
} from "@/lib/analytics/productCostResolver";
import { calculateWbV6RevenueComponents } from "@/lib/analytics/wbFinancialCoreV6";
import { prisma } from "@/lib/prisma";

export const WB_CANONICAL_SALE_SELECT = {
  id: true,
  importSessionId: true,
  companyName: true,
  reportNumber: true,
  saleDate: true,
  productName: true,
  size: true,
  barcode: true,
  nmId: true,
  vendorCode: true,
  subject: true,
  paymentReason: true,
  documentType: true,
  quantity: true,
  retailPrice: true,
  retailPriceWithDiscount: true,
  wbRealizedAmount: true,
  sellerPayout: true,
  sppDiscountAmount: true,
  wbReward: true,
  wbRewardVat: true,
  wbRewardTotal: true,
  logisticsCost: true,
  storageCost: true,
  acceptanceCost: true,
  penaltiesAmount: true,
  deductions: true,
  deductionReason: true,
  paymentServiceCost: true,
  pvzCompensation: true,
  transportCompensation: true,
  loyaltyDiscountCompensation: true,
  loyaltyParticipationCost: true,
  loyaltyPointsAmount: true,
} satisfies Prisma.WbSaleSelect;

export type CanonicalWbSaleRow = Prisma.WbSaleGetPayload<{
  select: typeof WB_CANONICAL_SALE_SELECT;
}>;

export type CanonicalWbProductOperation = "SALE" | "RETURN" | "OTHER";

function normalizeWbOperationText(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[–—−]/g, "-")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

export function classifyCanonicalWbProductOperation(input: {
  paymentReason: unknown;
  documentType?: unknown;
}): CanonicalWbProductOperation {
  const values = [
    normalizeWbOperationText(input.paymentReason),
    normalizeWbOperationText(input.documentType),
  ].filter(Boolean);
  if (values.some((value) => value === "сторно возвратов")) {
    return "SALE";
  }
  if (
    values.some(
      (value) => value === "возврат" || value.includes("возврат")
    )
  ) {
    return "RETURN";
  }
  if (values.some((value) => value === "продажа")) {
    return "SALE";
  }
  return "OTHER";
}

export type WbSourceOwnerMode =
  | "EXACT_FINANCE_COVER_SESSIONS_ALL_ROWS"
  | "DAILY_FINANCE_MATCHED_SESSIONS_ALL_ROWS"
  | "PRELIMINARY_OPERATIONAL_FALLBACK"
  | "PRELIMINARY_DAILY_FALLBACK"
  | "PRELIMINARY_NO_SOURCE";

export type WbOwnershipFinanceRow = {
  companyName: string | null;
  reportNumber: string | null;
  dateFrom: Date | null;
  dateTo: Date | null;
};

export type WbOwnershipSession = {
  id: string;
  fileName: string;
  companyName: string | null;
  reportType: string;
  status: string;
  createdAt: Date;
};

export type WbSourceOwnershipInterval = {
  companyName: string;
  dateFrom: string;
  dateTo: string;
  mode: WbSourceOwnerMode;
  reportNumbers: string[];
  selectedSessionIds: string[];
  exactCoverageComplete: boolean;
  dailyCalendarCoverageComplete: boolean;
  dailyReportCoverageComplete: boolean;
  isFinanciallyFinal: boolean;
  preliminaryReasons: string[];
};

export type WbSourceOwnershipPlan = {
  intervals: WbSourceOwnershipInterval[];
  selectedSessionIds: string[];
  isFinanciallyFinal: boolean;
};

export type WbCanonicalSourceSelection = WbSourceOwnershipPlan & {
  rows: CanonicalWbSaleRow[];
};

type DateRange = {
  start: number;
  end: number;
  startKey: string;
  endKey: string;
};

type FinanceIntervalGroup = DateRange & {
  rows: WbOwnershipFinanceRow[];
};

const DAY_MS = 86_400_000;

function dateKeyFromInput(value: string | Date | null | undefined) {
  if (!value) return null;
  if (typeof value === "string") {
    const match = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (match) {
      return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
    }
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(date.getTime() + 3 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

function dayNumber(dateKey: string) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
}

function dayKey(value: number) {
  return new Date(value * DAY_MS).toISOString().slice(0, 10);
}

function buildRange(
  dateFrom: string | Date | null | undefined,
  dateTo: string | Date | null | undefined
): DateRange | null {
  const fromKey = dateKeyFromInput(dateFrom);
  const toKey = dateKeyFromInput(dateTo) ?? fromKey;
  if (!fromKey || !toKey) return null;
  const from = dayNumber(fromKey);
  const to = dayNumber(toKey);
  return {
    start: Math.min(from, to),
    end: Math.max(from, to),
    startKey: dayKey(Math.min(from, to)),
    endKey: dayKey(Math.max(from, to)),
  };
}

function buildFinanceGroups(rows: WbOwnershipFinanceRow[]) {
  const byRange = new Map<string, FinanceIntervalGroup>();
  for (const row of rows) {
    const range = buildRange(row.dateFrom, row.dateTo ?? row.dateFrom);
    if (!range) continue;
    const key = `${range.start}:${range.end}`;
    const existing = byRange.get(key);
    if (existing) {
      existing.rows.push(row);
    } else {
      byRange.set(key, { ...range, rows: [row] });
    }
  }
  return Array.from(byRange.values()).sort(
    (left, right) =>
      left.start - right.start || right.end - left.end
  );
}

export function selectMinimalWbFinanceCover(
  rows: WbOwnershipFinanceRow[],
  dateFrom: string,
  dateTo: string
) {
  const requested = buildRange(dateFrom, dateTo);
  if (!requested) return [];
  const groups = buildFinanceGroups(rows).filter(
    (group) =>
      group.start >= requested.start && group.end <= requested.end
  );
  const byStart = new Map<number, FinanceIntervalGroup[]>();
  for (const group of groups) {
    const current = byStart.get(group.start) ?? [];
    current.push(group);
    current.sort((left, right) => right.end - left.end);
    byStart.set(group.start, current);
  }
  const best = new Map<number, FinanceIntervalGroup[]>();
  best.set(requested.start, []);
  for (
    let currentDay = requested.start;
    currentDay <= requested.end;
    currentDay += 1
  ) {
    const path = best.get(currentDay);
    if (!path) continue;
    for (const group of byStart.get(currentDay) ?? []) {
      const nextDay = group.end + 1;
      const candidate = [...path, group];
      const existing = best.get(nextDay);
      if (!existing || candidate.length < existing.length) {
        best.set(nextDay, candidate);
      }
    }
  }
  return best.get(requested.end + 1) ?? [];
}

export type WbFinanceCoverGap = DateRange;

export type WbMaximalFinanceCover = {
  segments: FinanceIntervalGroup[];
  gaps: WbFinanceCoverGap[];
};

export function selectMaximalWbFinanceCover(
  rows: WbOwnershipFinanceRow[],
  dateFrom: string,
  dateTo: string
): WbMaximalFinanceCover {
  const requested = buildRange(dateFrom, dateTo);
  if (!requested) return { segments: [], gaps: [] };
  const groups = buildFinanceGroups(rows).filter(
    (group) =>
      group.start >= requested.start && group.end <= requested.end
  );
  const byStart = new Map<number, FinanceIntervalGroup[]>();
  for (const group of groups) {
    const current = byStart.get(group.start) ?? [];
    current.push(group);
    current.sort((left, right) => right.end - left.end);
    byStart.set(group.start, current);
  }
  const segments: FinanceIntervalGroup[] = [];
  const gaps: WbFinanceCoverGap[] = [];
  let cursor = requested.start;
  while (cursor <= requested.end) {
    const candidates = byStart.get(cursor) ?? [];
    if (candidates.length > 0) {
      const pick = candidates[0];
      segments.push(pick);
      cursor = pick.end + 1;
      continue;
    }
    let next = requested.end + 1;
    for (const group of groups) {
      if (group.start > cursor && group.start < next) next = group.start;
    }
    gaps.push({
      start: cursor,
      end: next - 1,
      startKey: dayKey(cursor),
      endKey: dayKey(next - 1),
    });
    cursor = next;
  }
  return { segments, gaps };
}

function isCalendarMonthSpanLocal(dateFrom: string, dateTo: string) {
  const from = dateFrom.slice(0, 10);
  const to = dateTo.slice(0, 10);
  const match = /^(\d{4})-(\d{2})-01$/.exec(from);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return (
    to ===
    `${year}-${String(month).padStart(2, "0")}-${String(last).padStart(2, "0")}`
  );
}

function isCalendarQuarterSpanLocal(dateFrom: string, dateTo: string) {
  const from = dateFrom.slice(0, 10);
  const to = dateTo.slice(0, 10);
  const year = from.slice(0, 4);
  return (
    [
      [`${year}-01-01`, `${year}-03-31`],
      [`${year}-04-01`, `${year}-06-30`],
      [`${year}-07-01`, `${year}-09-30`],
      [`${year}-10-01`, `${year}-12-31`],
    ] as const
  ).some(([start, end]) => from === start && to === end);
}

function isYtdStyleSpanLocal(dateFrom: string, dateTo: string) {
  const from = dateFrom.slice(0, 10);
  const to = dateTo.slice(0, 10);
  if (!/^\d{4}-01-01$/.test(from)) return false;
  if (to <= from) return false;
  if (isCalendarMonthSpanLocal(from, to)) return false;
  return from.slice(0, 4) === to.slice(0, 4);
}

export function requestedAllowsPreliminaryWbFallback(
  dateFrom: string,
  dateTo: string
) {
  const from = dateFrom.slice(0, 10);
  const to = dateTo.slice(0, 10);
  const requested = buildRange(from, to);
  if (!requested) return false;
  const days = requested.end - requested.start + 1;
  if (days >= 1 && days <= 7) return true;
  if (isCalendarMonthSpanLocal(from, to)) return false;
  if (isCalendarQuarterSpanLocal(from, to)) return false;
  if (isYtdStyleSpanLocal(from, to)) return false;
  return false;
}

function normalizeCompany(value: string | null | undefined) {
  return String(value ?? "").trim();
}

function uniqueReportNumbers(rows: WbOwnershipFinanceRow[]) {
  return Array.from(
    new Set(
      rows
        .map((row) => String(row.reportNumber ?? "").trim())
        .filter(Boolean)
    )
  ).sort();
}

function fileMatchesReportNumber(fileName: string, reportNumber: string) {
  const escaped = reportNumber.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\D)${escaped}(\\D|$)`).test(fileName);
}

function latestSessionForReport(
  companyName: string,
  reportNumber: string,
  sessions: WbOwnershipSession[]
) {
  const candidates = sessions
    .filter(
      (session) =>
        session.status === "SUCCESS" &&
        session.reportType === "WB_SALES" &&
        normalizeCompany(session.companyName) === companyName &&
        fileMatchesReportNumber(session.fileName, reportNumber)
    )
    .sort(
      (left, right) =>
        right.createdAt.getTime() - left.createdAt.getTime() ||
        right.id.localeCompare(left.id)
    );
  if (candidates.length === 0) {
    return { session: null, ambiguous: false };
  }
  const latestTime = candidates[0].createdAt.getTime();
  const equallyLatest = candidates.filter(
    (candidate) => candidate.createdAt.getTime() === latestTime
  );
  return {
    session: equallyLatest.length === 1 ? equallyLatest[0] : null,
    ambiguous: equallyLatest.length > 1,
  };
}

function matchRequiredReports(
  companyName: string,
  reportNumbers: string[],
  sessions: WbOwnershipSession[]
) {
  const selectedSessionIds = new Set<string>();
  const missing: string[] = [];
  const ambiguous: string[] = [];
  for (const reportNumber of reportNumbers) {
    const match = latestSessionForReport(
      companyName,
      reportNumber,
      sessions
    );
    if (match.ambiguous) ambiguous.push(reportNumber);
    else if (!match.session) missing.push(reportNumber);
    else selectedSessionIds.add(match.session.id);
  }
  return {
    selectedSessionIds: Array.from(selectedSessionIds),
    complete:
      reportNumbers.length > 0 &&
      missing.length === 0 &&
      ambiguous.length === 0,
    missing,
    ambiguous,
  };
}

function enumerateDays(start: number, end: number) {
  const result: string[] = [];
  for (let day = start; day <= end; day += 1) result.push(dayKey(day));
  return result;
}

export function planWbSourceOwnership(input: {
  dateFrom: string;
  dateTo: string;
  companyNames: string[];
  financeRows: WbOwnershipFinanceRow[];
  sessions: WbOwnershipSession[];
}): WbSourceOwnershipPlan {
  const intervals: WbSourceOwnershipInterval[] = [];
  const requested = buildRange(input.dateFrom, input.dateTo);
  if (!requested) {
    return { intervals: [], selectedSessionIds: [], isFinanciallyFinal: false };
  }

  for (const companyName of input.companyNames) {
    const companyFinanceRows = input.financeRows.filter(
      (row) => normalizeCompany(row.companyName) === companyName
    );
    const financeCover = selectMinimalWbFinanceCover(
      companyFinanceRows,
      input.dateFrom,
      input.dateTo
    );

    if (financeCover.length === 0) {
      const allowPrelim = requestedAllowsPreliminaryWbFallback(
        input.dateFrom,
        input.dateTo
      );
      if (allowPrelim) {
        intervals.push({
          companyName,
          dateFrom: input.dateFrom,
          dateTo: input.dateTo,
          mode: "PRELIMINARY_NO_SOURCE",
          reportNumbers: [],
          selectedSessionIds: [],
          exactCoverageComplete: false,
          dailyCalendarCoverageComplete: false,
          dailyReportCoverageComplete: false,
          isFinanciallyFinal: false,
          preliminaryReasons: ["FINANCE_INTERVAL_COVER_INCOMPLETE"],
        });
        continue;
      }
      const maximal = selectMaximalWbFinanceCover(
        companyFinanceRows,
        input.dateFrom,
        input.dateTo
      );
      if (maximal.segments.length === 0) {
        intervals.push({
          companyName,
          dateFrom: input.dateFrom,
          dateTo: input.dateTo,
          mode: "PRELIMINARY_NO_SOURCE",
          reportNumbers: [],
          selectedSessionIds: [],
          exactCoverageComplete: false,
          dailyCalendarCoverageComplete: false,
          dailyReportCoverageComplete: false,
          isFinanciallyFinal: false,
          preliminaryReasons: [
            "SOURCE_INCOMPLETE",
            "FINANCE_INTERVAL_COVER_INCOMPLETE",
          ],
        });
        continue;
      }
      for (const gap of maximal.gaps) {
        intervals.push({
          companyName,
          dateFrom: gap.startKey,
          dateTo: gap.endKey,
          mode: "PRELIMINARY_NO_SOURCE",
          reportNumbers: [],
          selectedSessionIds: [],
          exactCoverageComplete: false,
          dailyCalendarCoverageComplete: false,
          dailyReportCoverageComplete: false,
          isFinanciallyFinal: false,
          preliminaryReasons: [
            "SOURCE_INCOMPLETE",
            "FINANCE_INTERVAL_COVER_INCOMPLETE",
          ],
        });
      }
      for (const interval of maximal.segments) {
        const exactHasBlankReportNumber = interval.rows.some(
          (row) => !String(row.reportNumber ?? "").trim()
        );
        const exactReportNumbers = uniqueReportNumbers(interval.rows);
        const exact = matchRequiredReports(
          companyName,
          exactReportNumbers,
          input.sessions
        );
        if (exact.complete && !exactHasBlankReportNumber) {
          intervals.push({
            companyName,
            dateFrom: interval.startKey,
            dateTo: interval.endKey,
            mode: "EXACT_FINANCE_COVER_SESSIONS_ALL_ROWS",
            reportNumbers: exactReportNumbers,
            selectedSessionIds: exact.selectedSessionIds,
            exactCoverageComplete: true,
            dailyCalendarCoverageComplete: false,
            dailyReportCoverageComplete: false,
            isFinanciallyFinal: true,
            preliminaryReasons: [],
          });
          continue;
        }
        intervals.push({
          companyName,
          dateFrom: interval.startKey,
          dateTo: interval.endKey,
          mode: "PRELIMINARY_NO_SOURCE",
          reportNumbers: [],
          selectedSessionIds: [],
          exactCoverageComplete: false,
          dailyCalendarCoverageComplete: false,
          dailyReportCoverageComplete: false,
          isFinanciallyFinal: false,
          preliminaryReasons: [
            "SOURCE_INCOMPLETE",
            ...(exactHasBlankReportNumber ? ["EXACT_REPORT_NUMBER_BLANK"] : []),
            ...exact.missing.map((value) => `EXACT_REPORT_MISSING:${value}`),
            ...exact.ambiguous.map((value) => `EXACT_REPORT_AMBIGUOUS:${value}`),
          ],
        });
      }
      continue;
    }

    for (const interval of financeCover) {
      const exactHasBlankReportNumber = interval.rows.some(
        (row) => !String(row.reportNumber ?? "").trim()
      );
      const exactReportNumbers = uniqueReportNumbers(interval.rows);
      const exact = matchRequiredReports(
        companyName,
        exactReportNumbers,
        input.sessions
      );
      if (exact.complete && !exactHasBlankReportNumber) {
        intervals.push({
          companyName,
          dateFrom: interval.startKey,
          dateTo: interval.endKey,
          mode: "EXACT_FINANCE_COVER_SESSIONS_ALL_ROWS",
          reportNumbers: exactReportNumbers,
          selectedSessionIds: exact.selectedSessionIds,
          exactCoverageComplete: true,
          dailyCalendarCoverageComplete: false,
          dailyReportCoverageComplete: false,
          isFinanciallyFinal: true,
          preliminaryReasons: [],
        });
        continue;
      }

      const dailyRows = companyFinanceRows.filter((row) => {
        const range = buildRange(row.dateFrom, row.dateTo ?? row.dateFrom);
        if (!range) return false;
        return (
          range.start === range.end &&
          range.start >= interval.start &&
          range.end <= interval.end
        );
      });
      const daysWithFinance = new Set(
        dailyRows
          .filter((row) => Boolean(String(row.reportNumber ?? "").trim()))
          .map((row) => dateKeyFromInput(row.dateFrom))
          .filter((value): value is string => Boolean(value))
      );
      const requiredDays = enumerateDays(interval.start, interval.end);
      const dailyCalendarCoverageComplete = requiredDays.every((day) =>
        daysWithFinance.has(day)
      );
      const dailyReportNumbers = uniqueReportNumbers(dailyRows);
      const daily = matchRequiredReports(
        companyName,
        dailyReportNumbers,
        input.sessions
      );
      const dailyHasBlankReportNumber = dailyRows.some(
        (row) => !String(row.reportNumber ?? "").trim()
      );
      const dailyReportCoverageComplete =
        daily.complete && !dailyHasBlankReportNumber;

      if (
        dailyCalendarCoverageComplete &&
        dailyReportCoverageComplete
      ) {
        intervals.push({
          companyName,
          dateFrom: interval.startKey,
          dateTo: interval.endKey,
          mode: "DAILY_FINANCE_MATCHED_SESSIONS_ALL_ROWS",
          reportNumbers: dailyReportNumbers,
          selectedSessionIds: daily.selectedSessionIds,
          exactCoverageComplete: false,
          dailyCalendarCoverageComplete: true,
          dailyReportCoverageComplete: true,
          isFinanciallyFinal: true,
          preliminaryReasons: [],
        });
        continue;
      }

      const reasons = [
        ...(exactHasBlankReportNumber ? ["EXACT_REPORT_NUMBER_BLANK"] : []),
        ...exact.missing.map((value) => `EXACT_REPORT_MISSING:${value}`),
        ...exact.ambiguous.map((value) => `EXACT_REPORT_AMBIGUOUS:${value}`),
      ];
      if (!dailyCalendarCoverageComplete) {
        reasons.push("DAILY_CALENDAR_COVERAGE_INCOMPLETE");
      }
      if (dailyHasBlankReportNumber) {
        reasons.push("DAILY_REPORT_NUMBER_BLANK");
      }
      reasons.push(
        ...daily.missing.map((value) => `DAILY_REPORT_MISSING:${value}`),
        ...daily.ambiguous.map((value) => `DAILY_REPORT_AMBIGUOUS:${value}`)
      );
      intervals.push({
        companyName,
        dateFrom: interval.startKey,
        dateTo: interval.endKey,
        mode: "PRELIMINARY_NO_SOURCE",
        reportNumbers: [],
        selectedSessionIds: [],
        exactCoverageComplete: false,
        dailyCalendarCoverageComplete,
        dailyReportCoverageComplete,
        isFinanciallyFinal: false,
        preliminaryReasons: reasons,
      });
    }
  }

  return {
    intervals,
    selectedSessionIds: Array.from(
      new Set(intervals.flatMap((interval) => interval.selectedSessionIds))
    ),
    isFinanciallyFinal:
      intervals.length > 0 &&
      intervals.every((interval) => interval.isFinanciallyFinal),
  };
}

export function applyWbPersistedOwnerEvidence(
  plan: WbSourceOwnershipPlan,
  persistedRows: Array<{ importSessionId: string | null }>
): WbSourceOwnershipPlan {
  const sessionsWithRows = new Set(
    persistedRows
      .map((row) => row.importSessionId)
      .filter((value): value is string => Boolean(value))
  );
  const intervals = plan.intervals.map((interval) => {
    if (!interval.isFinanciallyFinal) return { ...interval };
    const missingSessionIds = interval.selectedSessionIds.filter(
      (sessionId) => !sessionsWithRows.has(sessionId)
    );
    if (missingSessionIds.length === 0) return { ...interval };
    return {
      ...interval,
      mode: "PRELIMINARY_NO_SOURCE" as const,
      selectedSessionIds: [],
      isFinanciallyFinal: false,
      preliminaryReasons: [
        ...interval.preliminaryReasons,
        ...missingSessionIds.map(
          (sessionId) => `OWNER_SESSION_HAS_NO_WBSALE_ROWS:${sessionId}`
        ),
      ],
    };
  });
  return {
    intervals,
    selectedSessionIds: Array.from(
      new Set(intervals.flatMap((interval) => interval.selectedSessionIds))
    ),
    isFinanciallyFinal:
      intervals.length > 0 &&
      intervals.every((interval) => interval.isFinanciallyFinal),
  };
}

function moscowStartUtc(dateKey: string) {
  return new Date(`${dateKey}T00:00:00+03:00`);
}

function nextMoscowStartUtc(dateKey: string) {
  const date = moscowStartUtc(dateKey);
  date.setUTCDate(date.getUTCDate() + 1);
  return date;
}

async function selectPreliminaryRows(
  interval: WbSourceOwnershipInterval
) {
  for (const reportType of ["WB_SALES_OPERATIONAL", "WB_SALES_DAILY"]) {
    const sessions = await prisma.importSession.findMany({
      where: {
        companyName: interval.companyName,
        reportType,
        status: "SUCCESS",
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, fileName: true },
    });
    const latestByFileName = new Map<string, string>();
    for (const session of sessions) {
      if (!latestByFileName.has(session.fileName)) {
        latestByFileName.set(session.fileName, session.id);
      }
    }
    const sessionIds = Array.from(latestByFileName.values());
    if (sessionIds.length === 0) continue;
    const rows = await prisma.wbSale.findMany({
      where: {
        companyName: interval.companyName,
        importSessionId: { in: sessionIds },
        saleDate: {
          gte: moscowStartUtc(interval.dateFrom),
          lt: nextMoscowStartUtc(interval.dateTo),
        },
      },
      select: WB_CANONICAL_SALE_SELECT,
      orderBy: { saleDate: "desc" },
    });
    if (rows.length > 0) {
      interval.mode =
        reportType === "WB_SALES_OPERATIONAL"
          ? "PRELIMINARY_OPERATIONAL_FALLBACK"
          : "PRELIMINARY_DAILY_FALLBACK";
      interval.selectedSessionIds = sessionIds;
      return rows;
    }
  }
  return [];
}

export async function selectCanonicalWbSaleSource(params: {
  dateFrom: string;
  dateTo: string;
  companyName?: string | null;
}): Promise<WbCanonicalSourceSelection> {
  const from = moscowStartUtc(params.dateFrom);
  const toExclusive = nextMoscowStartUtc(params.dateTo);
  const widenedFrom = new Date(from.getTime() - 36 * 60 * 60 * 1000);
  const widenedTo = new Date(toExclusive.getTime() + 36 * 60 * 60 * 1000);
  const companyFilter = params.companyName
    ? { companyName: params.companyName }
    : {};

  const [financeRows, sessions] = await Promise.all([
    prisma.wbFinance.findMany({
      where: {
        ...companyFilter,
        OR: [
          { dateFrom: { gte: widenedFrom, lt: widenedTo } },
          { dateTo: { gte: widenedFrom, lt: widenedTo } },
          { dateFrom: { lte: from }, dateTo: { gte: toExclusive } },
        ],
      },
      select: {
        companyName: true,
        reportNumber: true,
        dateFrom: true,
        dateTo: true,
      },
    }),
    prisma.importSession.findMany({
      where: {
        ...companyFilter,
        reportType: {
          in: ["WB_SALES", "WB_SALES_OPERATIONAL", "WB_SALES_DAILY"],
        },
        status: "SUCCESS",
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        fileName: true,
        companyName: true,
        reportType: true,
        status: true,
        createdAt: true,
      },
    }),
  ]);

  const companyNames = params.companyName
    ? [params.companyName]
    : Array.from(
        new Set(
          [...financeRows, ...sessions]
            .map((row) => normalizeCompany(row.companyName))
            .filter(Boolean)
        )
      ).sort();
  const plan = planWbSourceOwnership({
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
    companyNames,
    financeRows,
    sessions,
  });

  const ownedRows =
    plan.selectedSessionIds.length > 0
      ? await prisma.wbSale.findMany({
          where: {
            importSessionId: { in: plan.selectedSessionIds },
            ...(params.companyName
              ? { companyName: params.companyName }
              : {}),
          },
          select: WB_CANONICAL_SALE_SELECT,
          orderBy: { saleDate: "desc" },
        })
      : [];
  const evidencedPlan = applyWbPersistedOwnerEvidence(plan, ownedRows);
  const finalSessionIds = new Set(evidencedPlan.selectedSessionIds);
  const allowPrelim = requestedAllowsPreliminaryWbFallback(
    params.dateFrom,
    params.dateTo
  );
  const longIncomplete = !allowPrelim && !evidencedPlan.isFinanciallyFinal;
  const rows = longIncomplete
    ? []
    : ownedRows.filter(
        (row) =>
          row.importSessionId !== null && finalSessionIds.has(row.importSessionId)
      );
  if (!longIncomplete) {
    for (const interval of evidencedPlan.intervals.filter(
      (item) => !item.isFinanciallyFinal
    )) {
      if (interval.preliminaryReasons.includes("SOURCE_INCOMPLETE")) continue;
      rows.push(...(await selectPreliminaryRows(interval)));
    }
  }

  return {
    ...evidencedPlan,
    selectedSessionIds: Array.from(
      new Set(
        evidencedPlan.intervals.flatMap(
          (interval) => interval.selectedSessionIds
        )
      )
    ),
    rows,
  };
}

export function hasZeroWbProductFinancialImpact(row: {
  quantity: unknown;
  retailPrice: unknown;
  retailPriceWithDiscount: unknown;
  wbRealizedAmount: unknown;
  sellerPayout: unknown;
}) {
  const number = (value: unknown) => {
    if (value && typeof value === "object" && "toNumber" in value) {
      return Number((value as { toNumber: () => number }).toNumber()) || 0;
    }
    return Number(value ?? 0) || 0;
  };
  return (
    Math.abs(number(row.quantity)) <= 0.000001 &&
    Math.abs(number(row.retailPriceWithDiscount)) <= 0.000001 &&
    Math.abs(number(row.retailPrice)) <= 0.000001 &&
    Math.abs(number(row.wbRealizedAmount)) <= 0.000001 &&
    Math.abs(number(row.sellerPayout)) <= 0.000001
  );
}

export function filterWbRowsByOwnedSessionIds<
  T extends { importSessionId: string | null }
>(rows: T[], selectedSessionIds: string[]) {
  const selected = new Set(selectedSessionIds);
  return rows.filter(
    (row) =>
      row.importSessionId !== null &&
      selected.has(row.importSessionId)
  );
}

export function evaluateWbProductCoverage(
  rows: Array<{
    vendorCode: string | null;
    paymentReason: string | null;
    documentType?: string | null;
    quantity: unknown;
    retailPrice: unknown;
    retailPriceWithDiscount: unknown;
    wbRealizedAmount: unknown;
    sellerPayout: unknown;
  }>,
  costs: Array<{
    id?: string | null;
    vendorCode: unknown;
    costPrice: unknown;
    costDate?: Date | string | null;
    createdAt?: Date | string | null;
  }>
) {
  const costByVendorCode =
    buildCanonicalPositiveCostLookups(costs).costByVendorCode;
  let missingVendorFinancialImpactRows = 0;
  let missingCostFinancialRows = 0;
  let missingCanonicalRevenueInputRows = 0;
  for (const row of rows) {
    const operation = classifyCanonicalWbProductOperation(row);
    if (
      operation === "OTHER" ||
      hasZeroWbProductFinancialImpact(row)
    ) {
      continue;
    }
    const vendorCode = normalizeProductCostKey(row.vendorCode);
    if (!vendorCode) missingVendorFinancialImpactRows += 1;
    else if (!costByVendorCode.has(vendorCode)) missingCostFinancialRows += 1;
    if (!calculateWbV6RevenueComponents(row).canonicalInputsComplete) {
      missingCanonicalRevenueInputRows += 1;
    }
  }
  return {
    missingVendorFinancialImpactRows,
    missingCostFinancialRows,
    missingCanonicalRevenueInputRows,
    blocksFinal:
      missingVendorFinancialImpactRows > 0 ||
      missingCostFinancialRows > 0 ||
      missingCanonicalRevenueInputRows > 0,
  };
}
