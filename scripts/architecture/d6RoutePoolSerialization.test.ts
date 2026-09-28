import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

function readRepo(rel: string) {
  return readFileSync(join(root, rel), "utf8");
}

test("ABC: marketplace analytics are sequential per company, not Promise.all", () => {
  const src = readRepo("app/abc/page.tsx");
  assert.equal(src.includes("Promise.all"), false);
  assert.match(src, /for \(const companyName of selectedCompanies\)/);
  assert.match(src, /loadWaveCAbcCompany/);
  assert.match(src, /selectedMarketplace: marketplace/);
  assert.doesNotMatch(src, /loadWaveCCompanyProfitPair/);
  assert.doesNotMatch(src, /getProfitAnalytics\(/);
  assert.doesNotMatch(src, /getProfitAnalyticsOzon\(/);
  assert.match(src, /analyticsByCompany\.push\(\{[\s\S]*companyName,[\s\S]*wb: loaded\.wb,[\s\S]*ozon: loaded\.ozon,[\s\S]*wbUnavailable:/);
  assert.match(src, /company === "ALL" \? \["ИП Петров", "ИП Лебедева"\] : \[company\]/);
  assert.match(src, /data-testid="abc-wb-pnl-unavailable"/);
  assert.match(readRepo("lib/waveC/insightsAbcAdapter.ts"), /isProfitAnalyticsUnavailable/);
});

test("Insights: analytics then productCost then stocks are sequential", () => {
  const src = readRepo("app/insights/page.tsx");
  assert.equal(src.includes("Promise.all"), false);
  assert.match(src, /for \(const companyName of companyNames\)/);
  assert.match(src, /loadWaveCCompanyProfitPair/);
  assert.doesNotMatch(src, /getProfitAnalytics\(/);
  assert.doesNotMatch(src, /getProfitAnalyticsOzon\(/);
  assert.match(src, /const productCosts = await prisma\.productCost\.findMany/);
  assert.match(src, /const wbStocks = await prisma\.wbStock\.findMany/);
  assert.match(src, /const ozonStocks = await prisma\.ozonStock\.findMany/);
  const analyticsIdx = src.indexOf("for (const companyName of companyNames)");
  const costIdx = src.indexOf("const productCosts = await prisma.productCost.findMany");
  const wbStockIdx = src.indexOf("const wbStocks = await prisma.wbStock.findMany");
  const ozonStockIdx = src.indexOf("const ozonStocks = await prisma.ozonStock.findMany");
  assert.ok(analyticsIdx > 0 && analyticsIdx < costIdx && costIdx < wbStockIdx && wbStockIdx < ozonStockIdx);
  assert.match(src, /data-testid="insights-wb-pnl-unavailable"/);
  assert.match(readRepo("lib/waveC/insightsAbcAdapter.ts"), /isProfitAnalyticsUnavailable/);
});

test("plan-fact: getPnlFact and page-level fact/prevFact are sequential (no Promise.all)", () => {
  const src = readRepo("app/finance/plan-fact/page.tsx");
  assert.equal(
    src.includes("Promise.all"),
    false,
    "PLAN_FACT_ROUTE_DB_CONCURRENCY_PROVEN must be NO"
  );

  assert.match(src, /loadPeriodFinancePack/);
  assert.doesNotMatch(src, /await getProfitAnalytics/);
  assert.doesNotMatch(src, /await getProfitAnalyticsOzon/);
  assert.match(src, /const financeTransactions = await getFinanceTransactions/);
  assert.match(src, /const financeCategories = await prisma\.financeCategory\.findMany/);
  assert.match(src, /const companies = await prisma\.company\.findMany/);
  assert.match(src, /const plans = await prisma\.budgetPlan\.findMany/);
  assert.match(src, /const fact = await getPnlFact/);
  assert.match(src, /const prevFact = await getPnlFact/);

  const companiesIdx = src.indexOf("const companies = await prisma.company.findMany");
  const plansIdx = src.indexOf("const plans = await prisma.budgetPlan.findMany");
  const factIdx = src.indexOf("const fact = await getPnlFact");
  const prevFactIdx = src.indexOf("const prevFact = await getPnlFact");
  assert.ok(
    companiesIdx > 0 &&
      companiesIdx < plansIdx &&
      plansIdx < factIdx &&
      factIdx < prevFactIdx
  );

  assert.match(src, /isProfitAnalyticsUnavailable/);
  assert.match(src, /data-testid="plan-fact-wb-pnl-unavailable"/);
  assert.match(src, /data-plan-fact-wb-pnl-availability=/);
  assert.match(src, /calculateFinanceMetricsForRows/);
});

test("behavioral: sequential company/marketplace order and result shape", async () => {
  const companies = ["ИП Петров", "ИП Лебедева"];
  const calls: string[] = [];
  async function getProfitAnalytics(args: { companyName: string }) {
    calls.push(`WB:${args.companyName}`);
    return { marketplace: "WB", companyName: args.companyName, rows: [{ sku: "w" }] };
  }
  async function getProfitAnalyticsOzon(args: { companyName: string }) {
    calls.push(`Ozon:${args.companyName}`);
    return { marketplace: "Ozon", companyName: args.companyName, rows: [{ sku: "o" }] };
  }
  const analyticsByCompany = [];
  for (const companyName of companies) {
    const wb = await getProfitAnalytics({ companyName });
    const ozon = await getProfitAnalyticsOzon({ companyName });
    analyticsByCompany.push({ companyName, wb, ozon });
  }
  assert.deepEqual(calls, [
    "WB:ИП Петров",
    "Ozon:ИП Петров",
    "WB:ИП Лебедева",
    "Ozon:ИП Лебедева",
  ]);
  assert.deepEqual(
    analyticsByCompany.map((row) => row.companyName),
    companies
  );
  assert.equal(analyticsByCompany[0].wb.marketplace, "WB");
  assert.equal(analyticsByCompany[0].ozon.marketplace, "Ozon");
  assert.equal(analyticsByCompany[1].wb.rows[0].sku, "w");
  assert.equal(analyticsByCompany[1].ozon.rows[0].sku, "o");
});

test("behavioral: plan-fact getPnlFact inputs stay sequential and preserve return shape", async () => {
  const calls: string[] = [];
  async function getProfitAnalytics() {
    calls.push("WB");
    return { totals: { revenue: 10 }, rows: [] };
  }
  async function getProfitAnalyticsOzon() {
    calls.push("Ozon");
    return { totals: { revenue: 20 }, rows: [] };
  }
  async function getFinanceTransactions() {
    calls.push("TX");
    return [{ id: "t1" }];
  }
  async function findCategories() {
    calls.push("CAT");
    return [{ id: "c1" }];
  }
  async function getPnlFact(label: string) {
    const wb = await getProfitAnalytics();
    const ozon = await getProfitAnalyticsOzon();
    const financeTransactions = await getFinanceTransactions();
    const financeCategories = await findCategories();
    calls.push(`PNL:${label}`);
    return {
      label,
      wbRevenue: wb.totals.revenue,
      ozonRevenue: ozon.totals.revenue,
      txCount: financeTransactions.length,
      catCount: financeCategories.length,
    };
  }

  const companies = await (async () => {
    calls.push("companies");
    return [{ name: "ALL" }];
  })();
  const plans = await (async () => {
    calls.push("plans");
    return [{ revenuePlan: 1 }];
  })();
  const fact = await getPnlFact("current");
  const prevFact = await getPnlFact("prev");

  assert.deepEqual(calls, [
    "companies",
    "plans",
    "WB",
    "Ozon",
    "TX",
    "CAT",
    "PNL:current",
    "WB",
    "Ozon",
    "TX",
    "CAT",
    "PNL:prev",
  ]);
  assert.equal(companies[0].name, "ALL");
  assert.equal(plans[0].revenuePlan, 1);
  assert.equal(fact.wbRevenue, 10);
  assert.equal(fact.ozonRevenue, 20);
  assert.equal(prevFact.label, "prev");
  assert.equal(fact.txCount, 1);
  assert.equal(prevFact.catCount, 1);
});
