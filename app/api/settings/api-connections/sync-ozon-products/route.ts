import { redirect } from "next/navigation";

import { prisma } from "@/lib/prisma";
import { syncOzonProducts } from "@/lib/ozon/syncOzon";

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Неизвестная ошибка";
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const companyId = getString(formData, "companyId");

  if (!companyId) {
    redirect("/settings/api-connections");
  }

  try {
    await syncOzonProducts(companyId);

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
  } catch (error) {
    await prisma.marketplaceApiConnection.upsert({
      where: {
        companyId_marketplace: {
          companyId,
          marketplace: "OZON",
        },
      },
      create: {
        companyId,
        marketplace: "OZON",
        status: "ERROR",
        lastError: getErrorMessage(error).slice(0, 1000),
      },
      update: {
        status: "ERROR",
        lastError: getErrorMessage(error).slice(0, 1000),
      },
    });
  }

  redirect("/settings/api-connections");
}
