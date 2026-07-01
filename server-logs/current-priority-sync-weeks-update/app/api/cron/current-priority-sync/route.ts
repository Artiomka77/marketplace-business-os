import { NextResponse } from "next/server";

import { runCurrentPrioritySync } from "@/lib/currentPrioritySync/syncCurrentPriorityData";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Неизвестная ошибка";
}

function parsePositiveInteger(
  value: string | null,
  defaultValue: number,
  minValue: number,
  maxValue: number
) {
  if (!value) {
    return defaultValue;
  }

  const number = Number(value);

  if (!Number.isInteger(number)) {
    throw new Error(`Параметр должен быть целым числом: ${value}`);
  }

  return Math.min(Math.max(number, minValue), maxValue);
}

function parseBoolean(value: string | null, defaultValue: boolean) {
  if (value === null) {
    return defaultValue;
  }

  if (value === "1" || value.toLowerCase() === "true") {
    return true;
  }

  if (value === "0" || value.toLowerCase() === "false") {
    return false;
  }

  return defaultValue;
}

function parseMode(value: string | null) {
  const normalized = String(value ?? "priority").toLowerCase();

  if (normalized === "recheck" || normalized === "control") {
    return "RECHECK" as const;
  }

  return "PRIORITY" as const;
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const mode = parseMode(url.searchParams.get("mode"));
    const defaultWeeks = mode === "RECHECK" ? 12 : 8;
    const explicitWeeks = url.searchParams.get("weeks");
    const modeWeeks =
      mode === "RECHECK"
        ? url.searchParams.get("recheckWeeks")
        : url.searchParams.get("priorityWeeks");
    const weeks = parsePositiveInteger(
      explicitWeeks ?? modeWeeks,
      defaultWeeks,
      1,
      26
    );
    const maxSalesJobs = parsePositiveInteger(
      url.searchParams.get("maxSalesJobs"),
      1,
      0,
      3
    );
    const pauseHistorical = parseBoolean(
      url.searchParams.get("pauseHistorical"),
      true
    );
    const syncFinance = parseBoolean(url.searchParams.get("syncFinance"), true);
    const ensureSalesJobs = parseBoolean(
      url.searchParams.get("ensureSalesJobs"),
      true
    );

    const result = await runCurrentPrioritySync({
      mode,
      weeks,
      maxSalesJobs,
      pauseHistorical,
      syncFinance,
      ensureSalesJobs,
    });

    return NextResponse.json({
      success: result.ok,
      ...result,
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        ok: false,
        error: getErrorMessage(error),
        executedAt: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}
