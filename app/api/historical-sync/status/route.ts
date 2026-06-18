import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const STUCK_RUNNING_MINUTES = 60;

const ACTIVE_JOB_STATUSES = ["PENDING", "ERROR", "RATE_LIMITED", "RUNNING"];

const visibleJobsWhere: Prisma.HistoricalSyncJobWhereInput = {
  NOT: [
    {
      marketplace: "WB",
      dataType: "SALES",
      cursorReportNumber: null,
    },
  ],
};

function formatDateOnly(date: Date | null) {
  return date ? date.toISOString().slice(0, 10) : null;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Неизвестная ошибка";
}

function roundNumber(value: number, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function getCountByStatus(
  rows: {
    status: string;
    _count: {
      _all: number;
    };
  }[],
  status: string
) {
  return rows.find((row) => row.status === status)?._count._all ?? 0;
}

function getProgressPercent(successCount: number, totalCount: number) {
  if (totalCount <= 0) {
    return 0;
  }

  return roundNumber((successCount / totalCount) * 100, 1);
}

function getEstimatedDurationText(hours: number | null) {
  if (hours === null) {
    return null;
  }

  if (hours <= 1) {
    return "меньше 1 часа";
  }

  if (hours < 24) {
    return `${Math.ceil(hours)} ч`;
  }

  const days = Math.ceil(hours / 24);
  return `${days} дн`;
}

function getStuckRunningBeforeDate() {
  return new Date(Date.now() - STUCK_RUNNING_MINUTES * 60 * 1000);
}

function getGroupKey(marketplace: string, dataType: string) {
  return `${marketplace}:${dataType}`;
}

function buildGroupedSummary(
  grouped: {
    marketplace: string;
    dataType: string;
    status: string;
    _count: {
      _all: number;
    };
  }[]
) {
  const groupMap = new Map<
    string,
    {
      marketplace: string;
      dataType: string;
      statuses: Record<string, number>;
    }
  >();

  for (const row of grouped) {
    const key = getGroupKey(row.marketplace, row.dataType);

    if (!groupMap.has(key)) {
      groupMap.set(key, {
        marketplace: row.marketplace,
        dataType: row.dataType,
        statuses: {},
      });
    }

    const group = groupMap.get(key);

    if (group) {
      group.statuses[row.status] = row._count._all;
    }
  }

  return Array.from(groupMap.values())
    .map((group) => {
      const pending = group.statuses.PENDING ?? 0;
      const running = group.statuses.RUNNING ?? 0;
      const success = group.statuses.SUCCESS ?? 0;
      const error = group.statuses.ERROR ?? 0;
      const rateLimited = group.statuses.RATE_LIMITED ?? 0;
      const total = pending + running + success + error + rateLimited;
      const remaining = pending + running + error + rateLimited;

      return {
        marketplace: group.marketplace,
        dataType: group.dataType,
        total,
        remaining,
        progressPercent: getProgressPercent(success, total),
        statuses: {
          PENDING: pending,
          RUNNING: running,
          SUCCESS: success,
          ERROR: error,
          RATE_LIMITED: rateLimited,
        },
      };
    })
    .sort((a, b) => {
      if (a.marketplace !== b.marketplace) {
        return a.marketplace.localeCompare(b.marketplace);
      }

      return a.dataType.localeCompare(b.dataType);
    });
}

export async function GET() {
  try {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60 * 1000);
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const stuckRunningBefore = getStuckRunningBeforeDate();

    const grouped = await prisma.historicalSyncJob.groupBy({
      by: ["marketplace", "dataType", "status"],
      where: visibleJobsWhere,
      _count: {
        _all: true,
      },
      orderBy: [
        {
          marketplace: "asc",
        },
        {
          dataType: "asc",
        },
        {
          status: "asc",
        },
      ],
    });

    const totals = await prisma.historicalSyncJob.groupBy({
      by: ["status"],
      where: visibleJobsWhere,
      _count: {
        _all: true,
      },
      orderBy: {
        status: "asc",
      },
    });

    const totalJobs = totals.reduce((sum, row) => sum + row._count._all, 0);
    const successJobs = getCountByStatus(totals, "SUCCESS");
    const pendingJobs = getCountByStatus(totals, "PENDING");
    const runningJobs = getCountByStatus(totals, "RUNNING");
    const errorJobs = getCountByStatus(totals, "ERROR");
    const rateLimitedJobs = getCountByStatus(totals, "RATE_LIMITED");
    const remainingJobs =
      pendingJobs + runningJobs + errorJobs + rateLimitedJobs;

    const [
      completedLastHour,
      completedLast6Hours,
      completedLast24Hours,
      nextJobs,
      lastSuccessJobs,
      lastIssueJobs,
      stuckRunningJobs,
    ] = await Promise.all([
      prisma.historicalSyncJob.count({
        where: {
          ...visibleJobsWhere,
          status: "SUCCESS",
          finishedAt: {
            gte: oneHourAgo,
          },
        },
      }),
      prisma.historicalSyncJob.count({
        where: {
          ...visibleJobsWhere,
          status: "SUCCESS",
          finishedAt: {
            gte: sixHoursAgo,
          },
        },
      }),
      prisma.historicalSyncJob.count({
        where: {
          ...visibleJobsWhere,
          status: "SUCCESS",
          finishedAt: {
            gte: twentyFourHoursAgo,
          },
        },
      }),
      prisma.historicalSyncJob.findMany({
        where: {
          ...visibleJobsWhere,
          status: {
            in: ACTIVE_JOB_STATUSES,
          },
        },
        orderBy: [
          {
            marketplace: "asc",
          },
          {
            createdAt: "asc",
          },
        ],
        take: 30,
        select: {
          id: true,
          companyName: true,
          marketplace: true,
          dataType: true,
          status: true,
          dateFrom: true,
          dateTo: true,
          cursorReportNumber: true,
          cursorOffset: true,
          retryCount: true,
          lastAttemptAt: true,
          lastError: true,
        },
      }),
      prisma.historicalSyncJob.findMany({
        where: {
          ...visibleJobsWhere,
          status: "SUCCESS",
        },
        orderBy: {
          finishedAt: "desc",
        },
        take: 15,
        select: {
          id: true,
          companyName: true,
          marketplace: true,
          dataType: true,
          status: true,
          dateFrom: true,
          dateTo: true,
          cursorReportNumber: true,
          cursorOffset: true,
          finishedAt: true,
        },
      }),
      prisma.historicalSyncJob.findMany({
        where: {
          ...visibleJobsWhere,
          status: {
            in: ["ERROR", "RATE_LIMITED"],
          },
        },
        orderBy: {
          updatedAt: "desc",
        },
        take: 15,
        select: {
          id: true,
          companyName: true,
          marketplace: true,
          dataType: true,
          status: true,
          dateFrom: true,
          dateTo: true,
          cursorReportNumber: true,
          cursorOffset: true,
          retryCount: true,
          lastAttemptAt: true,
          lastError: true,
          updatedAt: true,
        },
      }),
      prisma.historicalSyncJob.findMany({
        where: {
          ...visibleJobsWhere,
          status: "RUNNING",
          OR: [
            {
              lastAttemptAt: {
                lte: stuckRunningBefore,
              },
            },
            {
              lastAttemptAt: null,
              updatedAt: {
                lte: stuckRunningBefore,
              },
            },
          ],
        },
        orderBy: {
          updatedAt: "asc",
        },
        take: 15,
        select: {
          id: true,
          companyName: true,
          marketplace: true,
          dataType: true,
          status: true,
          dateFrom: true,
          dateTo: true,
          cursorReportNumber: true,
          cursorOffset: true,
          retryCount: true,
          lastAttemptAt: true,
          lastError: true,
          updatedAt: true,
        },
      }),
    ]);

    const averageJobsPerHourBy6Hours =
      completedLast6Hours > 0 ? completedLast6Hours / 6 : 0;

    const averageJobsPerHourBy24Hours =
      completedLast24Hours > 0 ? completedLast24Hours / 24 : 0;

    const averageJobsPerHour =
      averageJobsPerHourBy6Hours > 0
        ? averageJobsPerHourBy6Hours
        : averageJobsPerHourBy24Hours;

    const estimatedHoursRemaining =
      averageJobsPerHour > 0
        ? roundNumber(remainingJobs / averageJobsPerHour, 1)
        : null;

    const groupedSummary = buildGroupedSummary(grouped);

    return NextResponse.json({
      success: true,
      summary: {
        totalJobs,
        successJobs,
        remainingJobs,
        progressPercent: getProgressPercent(successJobs, totalJobs),
        health: {
          ok:
            errorJobs === 0 &&
            rateLimitedJobs === 0 &&
            stuckRunningJobs.length === 0,
          pendingJobs,
          runningJobs,
          errorJobs,
          rateLimitedJobs,
          stuckRunningJobs: stuckRunningJobs.length,
        },
        speed: {
          completedLastHour,
          completedLast6Hours,
          completedLast24Hours,
          averageJobsPerHour: roundNumber(averageJobsPerHour, 2),
          estimatedHoursRemaining,
          estimatedDurationText:
            getEstimatedDurationText(estimatedHoursRemaining),
        },
      },
      totals: totals.map((row) => ({
        status: row.status,
        count: row._count._all,
      })),
      grouped: grouped.map((row) => ({
        marketplace: row.marketplace,
        dataType: row.dataType,
        status: row.status,
        count: row._count._all,
      })),
      groupedSummary,
      nextJobs: nextJobs.map((job) => ({
        id: job.id,
        companyName: job.companyName,
        marketplace: job.marketplace,
        dataType: job.dataType,
        status: job.status,
        dateFrom: formatDateOnly(job.dateFrom),
        dateTo: formatDateOnly(job.dateTo),
        cursorReportNumber: job.cursorReportNumber,
        cursorOffset: job.cursorOffset,
        retryCount: job.retryCount,
        lastAttemptAt: job.lastAttemptAt,
        lastError: job.lastError,
      })),
      lastSuccessJobs: lastSuccessJobs.map((job) => ({
        id: job.id,
        companyName: job.companyName,
        marketplace: job.marketplace,
        dataType: job.dataType,
        status: job.status,
        dateFrom: formatDateOnly(job.dateFrom),
        dateTo: formatDateOnly(job.dateTo),
        cursorReportNumber: job.cursorReportNumber,
        cursorOffset: job.cursorOffset,
        finishedAt: job.finishedAt,
      })),
      lastIssueJobs: lastIssueJobs.map((job) => ({
        id: job.id,
        companyName: job.companyName,
        marketplace: job.marketplace,
        dataType: job.dataType,
        status: job.status,
        dateFrom: formatDateOnly(job.dateFrom),
        dateTo: formatDateOnly(job.dateTo),
        cursorReportNumber: job.cursorReportNumber,
        cursorOffset: job.cursorOffset,
        retryCount: job.retryCount,
        lastAttemptAt: job.lastAttemptAt,
        lastError: job.lastError,
        updatedAt: job.updatedAt,
      })),
      stuckRunningJobs: stuckRunningJobs.map((job) => ({
        id: job.id,
        companyName: job.companyName,
        marketplace: job.marketplace,
        dataType: job.dataType,
        status: job.status,
        dateFrom: formatDateOnly(job.dateFrom),
        dateTo: formatDateOnly(job.dateTo),
        cursorReportNumber: job.cursorReportNumber,
        cursorOffset: job.cursorOffset,
        retryCount: job.retryCount,
        lastAttemptAt: job.lastAttemptAt,
        lastError: job.lastError,
        updatedAt: job.updatedAt,
      })),
      settings: {
        stuckRunningMinutes: STUCK_RUNNING_MINUTES,
        excludedFromStatus:
          "WB SALES задачи без cursorReportNumber скрыты как старый технический формат.",
      },
      executedAt: now.toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: getErrorMessage(error),
        executedAt: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}