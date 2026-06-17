import { redirect } from "next/navigation";

import { prisma } from "@/lib/prisma";

type SyncResult = {
  name: string;
  path: string;
  status: number;
  ok: boolean;
  errorText: string | null;
};

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Неизвестная ошибка";
}

async function runSync(
  baseUrl: string,
  name: string,
  path: string,
  companyId: string
): Promise<SyncResult> {
  const formData = new FormData();
  formData.set("companyId", companyId);

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      body: formData,
      redirect: "manual",
      cache: "no-store",
    });

    const isRedirectOk = response.status === 303 || response.status === 302;
    const ok = response.ok || isRedirectOk;

    let errorText: string | null = null;

    if (!ok) {
      errorText = await response.text().catch(() => null);
    }

    return {
      name,
      path,
      status: response.status,
      ok,
      errorText,
    };
  } catch (error) {
    return {
      name,
      path,
      status: 0,
      ok: false,
      errorText: getErrorMessage(error),
    };
  }
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const companyId = String(formData.get("companyId") ?? "").trim();

  if (!companyId) {
    redirect("/settings/api-connections");
  }

  const url = new URL(request.url);
  const baseUrl = `${url.protocol}//${url.host}`;

  const steps = [
    {
      name: "Ozon Finance",
      path: "/api/settings/api-connections/sync-ozon-finance",
    },
    {
      name: "Ozon Products",
      path: "/api/settings/api-connections/sync-ozon-products",
    },
    {
      name: "Ozon Stocks",
      path: "/api/settings/api-connections/sync-ozon-stocks",
    },
    {
      name: "Ozon Ads",
      path: "/api/settings/api-connections/sync-ozon-ads",
    },
  ];

  const results: SyncResult[] = [];

  for (const step of steps) {
    const result = await runSync(baseUrl, step.name, step.path, companyId);
    results.push(result);

    if (!result.ok) {
      const errorText = results
        .map((item) => {
          const statusText = item.ok ? "OK" : "ERROR";

          return `${item.name}: ${statusText} (${item.status})${
            item.errorText ? ` — ${item.errorText.slice(0, 500)}` : ""
          }`;
        })
        .join("\n");

      await prisma.marketplaceApiConnection.update({
        where: {
          companyId_marketplace: {
            companyId,
            marketplace: "OZON",
          },
        },
        data: {
          status: "ERROR",
          lastError: errorText.slice(0, 1000),
        },
      });

      redirect("/settings/api-connections");
    }
  }

  await prisma.marketplaceApiConnection.update({
    where: {
      companyId_marketplace: {
        companyId,
        marketplace: "OZON",
      },
    },
    data: {
      status: "CONNECTED",
      lastSyncAt: new Date(),
      lastError: null,
    },
  });

  redirect("/settings/api-connections");
}