import { NextResponse } from "next/server";
import { rejectUnauthorizedCron } from "@/lib/security/cronAuth";

import { prisma } from "@/lib/prisma";
import { syncWbAll } from "@/lib/wb/syncWb";

export async function GET(request: Request) {
  const cronDenied = rejectUnauthorizedCron(request);
  if (cronDenied) return cronDenied;
  const connections = await prisma.marketplaceApiConnection.findMany({
    where: {
      marketplace: "WB",
      isEnabled: true,
      wbToken: {
        not: null,
      },
    },
    select: {
      companyId: true,
    },
  });

  const results = [];

  for (const connection of connections) {
    const result = await syncWbAll(connection.companyId);

    results.push({
      companyId: connection.companyId,
      ok: result.ok,
      results: result.results,
      error: result.ok ? null : result.error,
      isRateLimit: result.ok ? false : result.isRateLimit,
    });
  }

  return NextResponse.json({
    success: results.every((result) => result.ok || result.isRateLimit),
    syncedCompanies: results.length,
    results,
    executedAt: new Date().toISOString(),
  });
}