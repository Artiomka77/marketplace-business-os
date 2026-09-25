import { redirect } from "next/navigation";

import { prisma } from "@/lib/prisma";
import { syncWbAll } from "@/lib/wb/syncWb";

const WB_COOLDOWN_MS = 60 * 60 * 1000;

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Неизвестная ошибка";
}

function isWbRateLimitText(value: unknown) {
  const text = getErrorMessage(value).toLowerCase();

  return (
    text.includes("429") ||
    text.includes("too many requests") ||
    text.includes("rate limit") ||
    text.includes("limited by global limiter")
  );
}

function getWbHistoricalMessage(activeJobsCount: number) {
  return `Ручная синхронизация Wildberries временно не запущена: сейчас идёт историческая загрузка WB. Осталось задач: ${activeJobsCount}. Система догрузит данные автоматически, чтобы не получить лимит API.`;
}

function getWbRateLimitMessage() {
  return "Wildberries временно ограничил запросы. Система подождёт и продолжит загрузку автоматически. Не запускай ручную синхронизацию, пока идёт историческая загрузка.";
}

function getReturnedSyncError(result: Awaited<ReturnType<typeof syncWbAll>>) {
  if (!result || result.ok) {
    return null;
  }

  if ("error" in result && typeof result.error === "string") {
    return result.error;
  }

  if ("results" in result && Array.isArray(result.results)) {
    const errors = result.results
      .map((item) => {
        if (
          item &&
          typeof item === "object" &&
          "error" in item &&
          typeof item.error === "string"
        ) {
          return item.error;
        }

        return null;
      })
      .filter(Boolean);

    if (errors.length > 0) {
      return errors.join(" | ");
    }
  }

  return "WB синхронизация завершилась с ошибкой.";
}

async function setWbConnectionWarning(companyId: string, message: string) {
  const connection = await prisma.marketplaceApiConnection.findUnique({
    where: {
      companyId_marketplace: {
        companyId,
        marketplace: "WB",
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
        marketplace: "WB",
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

async function setWbConnectionError(companyId: string, error: unknown) {
  const connection = await prisma.marketplaceApiConnection.findUnique({
    where: {
      companyId_marketplace: {
        companyId,
        marketplace: "WB",
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
        marketplace: "WB",
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

async function getActiveWbHistoricalJobsCount(companyId: string) {
  return prisma.historicalSyncJob.count({
    where: {
      companyId,
      marketplace: "WB",
      status: {
        in: ["PENDING", "RUNNING", "RATE_LIMITED"],
      },
    },
  });
}

async function isWbInCooldown(companyId: string) {
  const connection = await prisma.marketplaceApiConnection.findUnique({
    where: {
      companyId_marketplace: {
        companyId,
        marketplace: "WB",
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

  if (!isWbRateLimitText(connection.lastError)) {
    return false;
  }

  return Date.now() - connection.lastAttemptAt.getTime() < WB_COOLDOWN_MS;
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const companyId = getString(formData, "companyId");

  if (!companyId) {
    redirect("/settings/api-connections");
  }

  const activeHistoricalJobs = await getActiveWbHistoricalJobsCount(companyId);

  if (activeHistoricalJobs > 0) {
    await setWbConnectionWarning(
      companyId,
      getWbHistoricalMessage(activeHistoricalJobs)
    );

    redirect("/settings/api-connections");
  }

  const isCooldown = await isWbInCooldown(companyId);

  if (isCooldown) {
    await setWbConnectionWarning(companyId, getWbRateLimitMessage());

    redirect("/settings/api-connections");
  }

  try {
    const result = await syncWbAll(companyId);
    const returnedError = getReturnedSyncError(result);

    if (returnedError) {
      if (isWbRateLimitText(returnedError)) {
        await setWbConnectionWarning(companyId, getWbRateLimitMessage());
      } else {
        await setWbConnectionError(companyId, returnedError);
      }
    }
  } catch (error) {
    if (isWbRateLimitText(error)) {
      await setWbConnectionWarning(companyId, getWbRateLimitMessage());
    } else {
      await setWbConnectionError(companyId, error);
    }
  }

  redirect("/settings/api-connections");
}