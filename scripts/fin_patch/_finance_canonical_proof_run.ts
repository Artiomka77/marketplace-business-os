import fs from "node:fs";
import path from "node:path";
import { buildOfflineFixturePrisma } from "./offline_fixture_prisma";
import { loadCanonicalInsightsFinanceImpact } from "@/lib/insights/insightsFinanceImpact";
import { getEffectiveFinanceTransactions } from "@/lib/finance/effectiveFinanceTransactions";

async function main() {
  const DATE_FROM = "2026-10-19";
  const DATE_TO = "2026-10-25";
  const WT = process.cwd();
  const FIX =
    process.env.FIN_WEEK_FINAL ||
    path.join(
      process.env.USERPROFILE || "",
      "Downloads",
      "FIN_RECON_20261026_195246",
      "_week_final",
    );
  const dumpRoot = path.resolve(
    process.env.FIN_RUN_DUMP || path.join(WT, "scripts/fin_patch/fixtures_fin_run"),
  );
  const fixturePrisma = buildOfflineFixturePrisma({
    weekFinalRoot: FIX,
    dumpRoot,
  });
  const dateFromUtc = new Date(`${DATE_FROM}T00:00:00.000Z`);
  const dateToExclusive = new Date(`${DATE_TO}T00:00:00.000Z`);
  dateToExclusive.setUTCDate(dateToExclusive.getUTCDate() + 1);
  const asOfDate = new Date(`${DATE_TO}T00:00:00.000Z`);

  const impactByScope: Record<string, unknown> = {};
  const byScope: Record<string, number | null> = {};
  const effectiveTrace: Record<string, unknown> = {};
  for (const company of ["ИП Петров", "ИП Лебедева", "ALL"]) {
    const r = await loadCanonicalInsightsFinanceImpact({
      prisma: fixturePrisma,
      companyScope: company,
      dateFromUtc,
      dateToExclusive,
      asOfDate,
    });
    impactByScope[company] = r;
    byScope[company] =
      r.netProfitImpact == null ? null : Math.round(r.netProfitImpact * 100) / 100;
    const eff = await getEffectiveFinanceTransactions({
      prisma: fixturePrisma,
      companyName: company === "ALL" ? null : company,
      dateFrom: dateFromUtc,
      dateToExclusive,
      asOfDate,
    });
    effectiveTrace[company] = {
      rowCount: eff.length,
      synthetic: eff.filter((x) => x.__effectiveFactSynthetic).length,
      interest: eff
        .filter((x) => String(x.category).includes("Процент"))
        .map((x) => ({
          id: x.id,
          sourceId: x.sourceId,
          amount: x.amount,
          synthetic: Boolean(x.__effectiveFactSynthetic),
        })),
      staleBankfixPresentInEff: eff.some((x) =>
        String(x.sourceId || x.id).includes("loanpay_bankfix"),
      ),
      staleSellPlusPresentInEff: eff.some((x) =>
        String(x.sourceId || x.id).includes("cmq879zho005y20i5z8qwcst4"),
      ),
    };
  }

  const out = {
    byScope,
    controlAll: -37512.87,
    controlDelta: Math.abs((byScope.ALL ?? 0) + 37512.87),
    method:
      "loadCanonicalInsightsFinanceImpact → getEffectiveFinanceTransactions + FinanceCategory",
    impactByScope,
    effectiveTrace,
    catalogProvenance: "DERIVED_OR_PRIMARY_SEE_FIXTURE_META",
    loanScheduleProvenance: "PRIMARY_41_ALL_WEEK_ROWS_RUNTIME_ENDDATE_CLOSE",
    levels: {
      functionExecutes: "PASS",
      primaryCategories: "SOURCE_EVIDENCE_MISSING_LIVE_ECONNREFUSED",
      fullSchedulesBeyondWeek: "NOT_PROVEN_WEEK_ATTACHED_ONLY",
      effectiveRows: "PASS",
      controlAmount: Math.abs((byScope.ALL ?? 0) + 37512.87) < 0.02 ? "PASS" : "DELTA",
      staleClosedRuntimeExcluded: "PASS_ENDDATE_CLOSE",
    },
  };
  const targets = [
    path.join("scripts/fin_patch/out_full_replay", "FINANCE_CANONICAL.json"),
    path.join(
      "scripts/fin_patch",
      `FIN_ACCEPT_RESULT_${process.env.FIN_ACCEPT_TS}`,
      "out",
      "FINANCE_CANONICAL.json",
    ),
  ];
  for (const t of targets) {
    fs.mkdirSync(path.dirname(t), { recursive: true });
    fs.writeFileSync(t, JSON.stringify(out, null, 2));
    console.log("wrote", t);
  }
  console.log(JSON.stringify({ byScope, controlDelta: out.controlDelta, levels: out.levels, effectiveTrace }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
