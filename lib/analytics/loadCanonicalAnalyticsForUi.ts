import {
  classifyDatabaseError,
  isTransientDatabaseError,
  type TransientDatabaseClassification,
} from "@/lib/db/transientDatabaseError";
import { logAnalyticsDbUnavailable } from "@/lib/db/logAnalyticsDbUnavailable";
import type { AnalyticsSurface } from "@/lib/db/logAnalyticsDbUnavailable";
import { runReadWithTransientDbPolicy } from "@/lib/db/runReadWithTransientDbPolicy";

export type CanonicalAnalyticsLoad<T> =
  | { status: "OK"; data: T }
  | {
      status: "UNAVAILABLE";
      reason: TransientDatabaseClassification;
      fabricatedNumericFinal: false;
    };

export async function loadCanonicalAnalyticsForUi<T>(params: {
  surface: AnalyticsSurface;
  executeRead: () => Promise<T>;
  log?: boolean;
}): Promise<CanonicalAnalyticsLoad<T>> {
  try {
    const data = await runReadWithTransientDbPolicy({
      executeRead: params.executeRead,
    });
    return { status: "OK", data };
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
    if (params.log !== false) {
      const { getSafePrismaPoolSnapshot } = await import("@/lib/prisma");
      logAnalyticsDbUnavailable({
        surface: params.surface,
        classification,
        retryAttempt: 1,
        pool: getSafePrismaPoolSnapshot(),
      });
    }
    return {
      status: "UNAVAILABLE",
      reason: classification,
      fabricatedNumericFinal: false,
    };
  }
}
