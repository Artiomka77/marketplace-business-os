import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { syncOzonAll } from "@/lib/ozon/syncOzon";

export async function GET() {
  const connections = await prisma.marketplaceApiConnection.findMany({
    where: {
      marketplace: "OZON",
      isEnabled: true,
      ozonClientId: {
        not: null,
      },
      ozonApiKey: {
        not: null,
      },
    },
    select: {
      companyId: true,
    },
  });

  const results = [];

  for (const connection of connections) {
    const result = await syncOzonAll(connection.companyId);

    results.push({
      companyId: connection.companyId,
      ok: result.ok,
      results: result.results,
      error: result.ok ? null : result.error,
    });
  }

  return NextResponse.json({
    success: results.every((result) => result.ok),
    syncedCompanies: results.length,
    results,
    executedAt: new Date().toISOString(),
  });
}