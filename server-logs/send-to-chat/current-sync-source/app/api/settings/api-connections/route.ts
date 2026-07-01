import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";

function getString(formData: FormData, key: string) {
  const value = formData.get(key);

  if (typeof value !== "string") {
    return "";
  }

  return value.trim();
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return "Неизвестная ошибка";
}

async function checkWbConnection(token: string) {
  const response = await fetch("https://common-api.wildberries.ru/ping", {
    method: "GET",
    headers: {
      Authorization: token,
    },
    cache: "no-store",
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`WB API: ${response.status} ${text}`.trim());
  }
}

async function checkOzonConnection(clientId: string, apiKey: string) {
  const response = await fetch("https://api-seller.ozon.ru/v3/product/list", {
    method: "POST",
    headers: {
      "Client-Id": clientId,
      "Api-Key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      filter: {},
      limit: 1,
      last_id: "",
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Ozon API: ${response.status} ${text}`.trim());
  }
}

export async function POST(request: Request) {
  const formData = await request.formData();

  const companyId = getString(formData, "companyId");
  const marketplace = getString(formData, "marketplace").toUpperCase();
  const action = getString(formData, "action") || "save";

  const wbToken = getString(formData, "wbToken");

  const ozonClientId = getString(formData, "ozonClientId");
  const ozonApiKey = getString(formData, "ozonApiKey");

  const ozonPerformanceClientId = getString(
    formData,
    "ozonPerformanceClientId"
  );
  const ozonPerformanceClientSecret = getString(
    formData,
    "ozonPerformanceClientSecret"
  );

  const isEnabled = formData.get("isEnabled") === "on";

  if (!companyId || !["WB", "OZON"].includes(marketplace)) {
    redirect("/settings/api-connections");
  }

  const existing = await prisma.marketplaceApiConnection.findUnique({
    where: {
      companyId_marketplace: {
        companyId,
        marketplace,
      },
    },
  });

  if (action === "delete") {
    if (existing) {
      await prisma.marketplaceApiConnection.update({
        where: {
          id: existing.id,
        },
        data: {
          wbToken: marketplace === "WB" ? null : existing.wbToken,

          ozonClientId:
            marketplace === "OZON" ? null : existing.ozonClientId,
          ozonApiKey: marketplace === "OZON" ? null : existing.ozonApiKey,
          ozonPerformanceClientId:
            marketplace === "OZON"
              ? null
              : existing.ozonPerformanceClientId,
          ozonPerformanceClientSecret:
            marketplace === "OZON"
              ? null
              : existing.ozonPerformanceClientSecret,

          isEnabled: false,
          status: "NOT_CONNECTED",
          lastSyncAt: null,
          lastError: null,
        },
      });
    }

    redirect("/settings/api-connections");
  }

  const data = {
    isEnabled,
    status: "NOT_CONNECTED",
    lastError: null as string | null,

    ...(marketplace === "WB" && wbToken ? { wbToken } : {}),

    ...(marketplace === "OZON" && ozonClientId ? { ozonClientId } : {}),
    ...(marketplace === "OZON" && ozonApiKey ? { ozonApiKey } : {}),
    ...(marketplace === "OZON" && ozonPerformanceClientId
      ? { ozonPerformanceClientId }
      : {}),
    ...(marketplace === "OZON" && ozonPerformanceClientSecret
      ? { ozonPerformanceClientSecret }
      : {}),
  };

  let savedConnection = existing;

  if (existing) {
    savedConnection = await prisma.marketplaceApiConnection.update({
      where: {
        id: existing.id,
      },
      data,
    });
  } else {
    savedConnection = await prisma.marketplaceApiConnection.create({
      data: {
        companyId,
        marketplace,
        ...data,
      },
    });
  }

  if (action === "check") {
    try {
      if (marketplace === "WB") {
        const tokenToCheck = wbToken || savedConnection.wbToken;

        if (!tokenToCheck) {
          throw new Error("WB token не сохранён");
        }

        await checkWbConnection(tokenToCheck);
      }

      if (marketplace === "OZON") {
        const clientIdToCheck = ozonClientId || savedConnection.ozonClientId;
        const apiKeyToCheck = ozonApiKey || savedConnection.ozonApiKey;

        if (!clientIdToCheck || !apiKeyToCheck) {
          throw new Error("Ozon Client-Id или Api-Key не сохранены");
        }

        await checkOzonConnection(clientIdToCheck, apiKeyToCheck);
      }

      await prisma.marketplaceApiConnection.update({
        where: {
          id: savedConnection.id,
        },
        data: {
          status: "CONNECTED",
          lastError: null,
        },
      });
    } catch (error) {
      await prisma.marketplaceApiConnection.update({
        where: {
          id: savedConnection.id,
        },
        data: {
          status: "ERROR",
          lastError: getErrorMessage(error).slice(0, 1000),
        },
      });
    }
  }

  redirect("/settings/api-connections");
}