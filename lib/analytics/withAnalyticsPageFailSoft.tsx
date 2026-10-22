import type { ReactElement } from "react";

import { AnalyticsTemporarilyUnavailable } from "@/components/analytics/AnalyticsTemporarilyUnavailable";
import {
  classifyDatabaseError,
  isTransientDatabaseError,
} from "@/lib/db/transientDatabaseError";
import { logAnalyticsDbUnavailable } from "@/lib/db/logAnalyticsDbUnavailable";
import type { AnalyticsSurface } from "@/lib/db/logAnalyticsDbUnavailable";
import type { SafePrismaPoolSnapshot } from "@/lib/db/prismaPoolConfig";
import { runReadWithTransientDbPolicy } from "@/lib/db/runReadWithTransientDbPolicy";

export async function withAnalyticsPageFailSoft(params: {
  surface: AnalyticsSurface;
  render: () => Promise<ReactElement>;
  pool?: SafePrismaPoolSnapshot;
}): Promise<ReactElement> {
  try {
    return await runReadWithTransientDbPolicy({
      executeRead: params.render,
    });
  } catch (error) {
    if (!isTransientDatabaseError(error)) {
      throw error;
    }
    const classification = classifyDatabaseError(error, {
      consumedFullConnectBudget: true,
    });
    if (classification.kind !== "transient_database") {
      throw error;
    }
    const pool =
      params.pool ??
      (await import("@/lib/prisma")).getSafePrismaPoolSnapshot();
    logAnalyticsDbUnavailable({
      surface: params.surface,
      classification,
      retryAttempt: 1,
      pool,
    });
    return (
      <AnalyticsTemporarilyUnavailable
        surface={params.surface}
        safeCode={classification.safeCode}
      />
    );
  }
}
