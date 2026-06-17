import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

function formatDateOnly(date: Date | null) {
  return date ? date.toISOString().slice(0, 10) : null;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Неизвестная ошибка";
}

export async function GET() {
  try {
    const grouped = await prisma.historicalSyncJob.groupBy({
      by: ["marketplace", "dataType", "status"],
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
      _count: {
        _all: true,
      },
      orderBy: {
        status: "asc",
      },
    });

    const nextJobs = await prisma.historicalSyncJob.findMany({
      where: {
        status: {
          in: ["PENDING", "ERROR", "RATE_LIMITED", "RUNNING"],
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
      take: 20,
      select: {
        id: true,
        companyName: true,
        marketplace: true,
        dataType: true,
        status: true,
        dateFrom: true,
        dateTo: true,
        retryCount: true,
        lastAttemptAt: true,
        lastError: true,
      },
    });

    const lastSuccessJobs = await prisma.historicalSyncJob.findMany({
      where: {
        status: "SUCCESS",
      },
      orderBy: {
        finishedAt: "desc",
      },
      take: 10,
      select: {
        id: true,
        companyName: true,
        marketplace: true,
        dataType: true,
        status: true,
        dateFrom: true,
        dateTo: true,
        finishedAt: true,
      },
    });

    return NextResponse.json({
      success: true,
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
      nextJobs: nextJobs.map((job) => ({
        id: job.id,
        companyName: job.companyName,
        marketplace: job.marketplace,
        dataType: job.dataType,
        status: job.status,
        dateFrom: formatDateOnly(job.dateFrom),
        dateTo: formatDateOnly(job.dateTo),
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
        finishedAt: job.finishedAt,
      })),
      executedAt: new Date().toISOString(),
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