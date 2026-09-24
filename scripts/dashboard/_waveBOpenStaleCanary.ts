import { writeFileSync } from "node:fs";
import {
  createPrismaProfitReadModelRepository,
  createWaveBProfitTargetPrismaClient,
  disconnectWaveBProfitTargetPrismaClient,
  formulaForMarketplace,
  loadProfitReadModel,
} from "@/lib/profitReadModel";

async function main() {
  const out = process.env.WAVE_B_STALE_OUT;
  if (!out) throw new Error("WAVE_B_STALE_OUT required");
  const prisma = createWaveBProfitTargetPrismaClient();
  const repository = createPrismaProfitReadModelRepository(prisma);
  const marketplace = "WB" as const;
  const companyScope = "ALL";
  const dateFrom = "2026-09-01";
  const dateTo = process.env.WAVE_B_OPEN_DATE_TO || new Date().toISOString().slice(0, 10);
  const formulaVersion = formulaForMarketplace(marketplace);
  try {
    const existing = await prisma.profitPeriodMetric.findFirst({
      where: { companyScope, marketplace, dateFrom: new Date(dateFrom), dateTo: new Date(dateTo), formulaVersion },
    });
    if (!existing) {
      writeFileSync(out, JSON.stringify({ OVERALL: "FAIL", reason: "NO_PRELIM_ROW_FOR_STALE" }, null, 2));
      process.exit(1);
    }
    await prisma.profitPeriodMetric.update({
      where: { id: existing.id },
      data: {
        dataMode: "PRELIMINARY",
        coverageStatus: "PARTIAL",
        generatedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
        staleAfterMs: 1000,
        updatedAt: new Date(),
      },
    });
    const loaded = await loadProfitReadModel({
      repository,
      marketplace,
      companyScope,
      dateFrom,
      dateTo,
      enqueueOnMiss: true,
    });
    const pass =
      loaded.status === "HIT" &&
      loaded.dataMode === "PRELIMINARY" &&
      loaded.preliminaryStale === true &&
      loaded.heavyFcCalls === 0;
    const result = {
      dateFrom,
      dateTo,
      loadedStatus: loaded.status,
      loadedDataMode: loaded.status === "HIT" ? loaded.dataMode : null,
      preliminaryStale: loaded.status === "HIT" ? loaded.preliminaryStale : null,
      heavyFcCalls: loaded.heavyFcCalls,
      rebuildEnqueued: "rebuildEnqueued" in loaded ? loaded.rebuildEnqueued : null,
      STALE_PRELIMINARY_STILL_SERVED: pass ? "PASS" : "FAIL",
      NO_FALSE_FINAL: loaded.status === "HIT" && loaded.dataMode !== "FINAL" ? "PASS" : "FAIL",
      HEAVY_FC: loaded.heavyFcCalls === 0 ? "PASS" : "FAIL",
      PRELIMINARY_STALE_REFRESH_JOB_EFFECT: pass ? "PASS" : "FAIL",
      OVERALL: pass ? "PASS" : "FAIL",
    };
    writeFileSync(out, JSON.stringify(result, null, 2), "utf8");
    console.log(JSON.stringify(result));
    if (!pass) process.exit(1);
  } finally {
    await disconnectWaveBProfitTargetPrismaClient();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
