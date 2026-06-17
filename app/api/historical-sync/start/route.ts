import { NextRequest, NextResponse } from "next/server";

import { createHistoricalSyncJobs } from "@/lib/historicalSync/createHistoricalSyncJobs";
import { runNextHistoricalSyncJob } from "@/lib/historicalSync/runHistoricalSyncJob";

export const dynamic = "force-dynamic";

const INITIAL_RUN_LIMIT = 2;

type MarketplaceFilter = "OZON" | "WB" | "ALL";
type HistoricalRunResult = Awaited<ReturnType<typeof runNextHistoricalSyncJob>>;

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Неизвестная ошибка";
}

function parseDateOnly(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new Error("Дата начала должна быть в формате YYYY-MM-DD");
  }

  return text;
}

function parseMarketplace(value: FormDataEntryValue | null): MarketplaceFilter {
  const text = String(value ?? "ALL").trim();

  if (text === "OZON" || text === "WB" || text === "ALL") {
    return text;
  }

  return "ALL";
}

async function runSmallInitialBatch(params: {
  companyId: string;
  marketplace: MarketplaceFilter;
}) {
  const results: HistoricalRunResult[] = [];

  if (params.marketplace === "WB") {
    return results;
  }

  for (let index = 0; index < INITIAL_RUN_LIMIT; index += 1) {
    const result = await runNextHistoricalSyncJob({
      marketplace: "OZON",
      companyId: params.companyId,
    });

    results.push(result);

    if (result.skipped || !result.ok) {
      break;
    }
  }

  return results;
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();

    const companyId = String(formData.get("companyId") ?? "").trim();
    const dateFromText = parseDateOnly(formData.get("dateFrom"));
    const marketplace = parseMarketplace(formData.get("marketplace"));

    if (!companyId) {
      throw new Error("Компания не выбрана");
    }

    const createResult = await createHistoricalSyncJobs({
      companyId,
      dateFromText,
      marketplace,
    });

    const initialRunResults = await runSmallInitialBatch({
      companyId,
      marketplace,
    });

    const redirectUrl = new URL("/settings/api-connections", request.url);
    redirectUrl.searchParams.set("historicalSync", "started");
    redirectUrl.searchParams.set("marketplace", marketplace);
    redirectUrl.searchParams.set("createdJobs", String(createResult.createdJobs));
    redirectUrl.searchParams.set(
      "skippedExistingJobs",
      String(createResult.skippedExistingJobs)
    );
    redirectUrl.searchParams.set(
      "initialCompleted",
      String(
        initialRunResults.filter((result) => result.ok && !result.skipped)
          .length
      )
    );

    return NextResponse.redirect(redirectUrl);
  } catch (error) {
    const redirectUrl = new URL("/settings/api-connections", request.url);
    redirectUrl.searchParams.set("historicalSync", "error");
    redirectUrl.searchParams.set("message", getErrorMessage(error).slice(0, 300));

    return NextResponse.redirect(redirectUrl);
  }
}