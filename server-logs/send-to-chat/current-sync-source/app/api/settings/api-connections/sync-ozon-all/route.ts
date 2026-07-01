import { redirect } from "next/navigation";

import { prisma } from "@/lib/prisma";
import { syncOzonAll } from "@/lib/ozon/syncOzon";

const OZON_COOLDOWN_MS = 60 * 60 * 1000;

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Неизвестная ошибка";
}

function isOzonRateLimitError(value: unknown) {
  const text = getErrorMessage(value).toLowerCase();

  return (
    text.includes("429") ||
    text.includes("rate limit") ||
    text.includes("rate exceeded") ||
    text.includes("too many requests")
  );
}

function getOzonHistoricalMessage(activeJobsCount: number) {
  return `Ручная синхронизация Ozon временно не запущена: сейчас идёт историческая загрузка Ozon. Осталось задач: ${activeJobsCount}. Система догрузит данные автоматически, чтобы не получить лимит API.`;
}

function getOzonRateLimitMessage() {
  return "Ozon временно ограничил запросы. Система повторит загрузку позже. Не запускай ручную синхронизацию, пока идёт историческая загрузка.";
}

async function setOzonConnectionWarning(companyId: string, message: string) {
  const connection = await prisma.marketplaceApiConnection.findUnique({
    where: {
      companyId_marketplace: {
        companyId,
        marketplace: "OZON",
      },
    },
    select: {
      id: true,
    },
  });

  if (!connection) {
    return;
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
      lastAttemptAt: new Date(),
      lastError: message.slice(0, 1000),
      retryCount: {
        increment: 1,
      },
    },
  });
}

async function setOzonConnectionError(companyId: string, error: unknown) {
  const connection = await prisma.marketplaceApiConnection.findUnique({
    where: {
      companyId_marketplace: {
        companyId,
        marketplace: "OZON",
      },
    },
    select: {
      id: true,
    },
  });

  if (!connection) {
    return;
  }

  await prisma.marketplaceApiConnection.update({
    where: {
      companyId_marketplace: {
        companyId,
        marketplace: "OZON",
      },
    },
    data: {
      status: "ERROR",
      lastAttemptAt: new Date(),
      lastError: getErrorMessage(error).slice(0, 1000),
      retryCount: {
        increment: 1,
      },
    },
  });
}

async function getActiveOzonHistoricalJobsCount(companyId: string) {
  return prisma.historicalSyncJob.count({
    where: {
      companyId,
      marketplace: "OZON",
      status: {
        in: ["PENDING", "RUNNING", "RATE_LIMITED"],
      },
    },
  });
}

async function isOzonInCooldown(companyId: string) {
  const connection = await prisma.marketplaceApiConnection.findUnique({
    where: {
      companyId_marketplace: {
        companyId,
        marketplace: "OZON",
      },
    },
    select: {
      lastError: true,
      lastAttemptAt: true,
    },
  });

  if (!connection?.lastError || !connection.lastAttemptAt) {
    return false;
  }

  if (!isOzonRateLimitError(connection.lastError)) {
    return false;
  }

  return Date.now() - connection.lastAttemptAt.getTime() < OZON_COOLDOWN_MS;
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const companyId = getString(formData, "companyId");

  if (!companyId) {
    redirect("/settings/api-connections");
  }

  const activeHistoricalJobs = await getActiveOzonHistoricalJobsCount(companyId);

  if (activeHistoricalJobs > 0) {
    await setOzonConnectionWarning(
      companyId,
      getOzonHistoricalMessage(activeHistoricalJobs)
    );

    redirect("/settings/api-connections");
  }

  const isCooldown = await isOzonInCooldown(companyId);

  if (isCooldown) {
    await setOzonConnectionWarning(companyId, getOzonRateLimitMessage());

    redirect("/settings/api-connections");
  }

  try {
    await syncOzonAll(companyId);
  } catch (error) {
    if (isOzonRateLimitError(error)) {
      await setOzonConnectionWarning(companyId, getOzonRateLimitMessage());
    } else {
      await setOzonConnectionError(companyId, error);
    }
  }

  redirect("/settings/api-connections");
}