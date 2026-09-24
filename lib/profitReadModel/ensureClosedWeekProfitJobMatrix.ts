import type { PrismaClient } from "@prisma/client";
import { CANONICAL_PROFIT_COMPANY_SCOPES } from "./canonicalScopes";
import { formulaForMarketplace, type ProfitMarketplace } from "./contract";
import { createPrismaProfitReadModelRepository } from "./repository";

const MARKETPLACES: ProfitMarketplace[] = ["WB", "OZON"];

/**
 * Ensures closed-week Profit RM job matrix covers ALL + each company × WB/OZON.
 * Idempotent via repository.enqueueRebuild / decideV6JobRebuild.
 */
export async function ensureClosedWeekProfitJobMatrix(params: {
  prisma: PrismaClient;
  dateFrom: string;
  dateTo: string;
  priority?: number;
}): Promise<{
  ok: true;
  dateFrom: string;
  dateTo: string;
  enqueued: Array<{
    marketplace: ProfitMarketplace;
    companyScope: string;
    formulaVersion: string;
    jobId: string;
    created: boolean;
    action: string;
  }>;
}> {
  const repository = createPrismaProfitReadModelRepository(params.prisma);
  const enqueued: Array<{
    marketplace: ProfitMarketplace;
    companyScope: string;
    formulaVersion: string;
    jobId: string;
    created: boolean;
    action: string;
  }> = [];

  for (const marketplace of MARKETPLACES) {
    const formulaVersion = formulaForMarketplace(marketplace);
    for (const companyScope of CANONICAL_PROFIT_COMPANY_SCOPES) {
      const result = await repository.enqueueRebuild({
        companyScope,
        dateFrom: params.dateFrom,
        dateTo: params.dateTo,
        formulaVersion,
        priority: params.priority ?? 40,
      });
      enqueued.push({
        marketplace,
        companyScope,
        formulaVersion,
        jobId: result.id,
        created: result.created,
        action: result.action,
      });
    }
  }

  return {
    ok: true,
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
    enqueued,
  };
}
