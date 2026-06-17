import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";

type ConnectionRow = {
  companyId: string;
};

async function runSync(baseUrl: string, companyId: string) {
  const formData = new FormData();
  formData.set("companyId", companyId);

  const response = await fetch(
    `${baseUrl}/api/settings/api-connections/sync-ozon-all`,
    {
      method: "POST",
      body: formData,
      redirect: "manual",
      cache: "no-store",
    }
  );

  return {
    companyId,
    status: response.status,
    ok: response.ok || response.status === 303,
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);

  const baseUrl = `${url.protocol}//${url.host}`;

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
    const result = await runSync(baseUrl, connection.companyId);

    results.push(result);
  }

  return NextResponse.json({
    success: true,
    syncedCompanies: results.length,
    results,
    executedAt: new Date().toISOString(),
  });
}