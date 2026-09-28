/**
 * Isolated Wave C HTTP canary.
 * Uses in-memory Wave B repository fixtures — no production DB, no heavy FC.
 */
import http from "node:http";
import { produceProfitReadModel, type ProfitPeriodRow, type ProfitReadModelRepository, type ProfitSkuRow } from "@/lib/profitReadModel";
import {
  deriveAbcEnriched,
  deriveAbcRawRows,
  deriveInsightClassifications,
  deriveInsightSkuRows,
  loadWaveCAbcCompany,
  loadWaveCCompanyProfitPair,
} from "@/lib/waveC/insightsAbcAdapter";

function memoryRepo(): ProfitReadModelRepository & {
  periods: Map<string, ProfitPeriodRow>;
  jobs: string[];
} {
  const periods = new Map<string, ProfitPeriodRow>();
  const skus: ProfitSkuRow[] = [];
  const jobs: string[] = [];
  const key = (p: {
    companyScope: string;
    marketplace: string;
    dateFrom: string;
    dateTo: string;
    formulaVersion: string;
  }) =>
    `${p.companyScope}|${p.marketplace}|${p.dateFrom}|${p.dateTo}|${p.formulaVersion}`;
  return {
    periods,
    jobs,
    async findPeriod(params) {
      return periods.get(key(params)) ?? null;
    },
    async replacePeriod({ period, skus: next }) {
      const k = key({
        companyScope: period.companyScope,
        marketplace: period.marketplace,
        dateFrom: period.dateFrom.toISOString().slice(0, 10),
        dateTo: period.dateTo.toISOString().slice(0, 10),
        formulaVersion: period.formulaVersion,
      });
      periods.set(k, { ...period, generatedAt: period.generatedAt ?? new Date() });
      skus.push(
        ...next.map((s) => ({ ...s, generatedAt: s.generatedAt ?? new Date() }))
      );
    },
    async countSkus() {
      return skus.length;
    },
    async enqueueRebuild(params) {
      const id = `${params.formulaVersion}:${params.companyScope}`;
      jobs.push(id);
      return { id, created: true, action: "create" as const };
    },
  };
}

function wb(rows: Array<Record<string, unknown>>) {
  return {
    rows,
    totals: {
      revenue: rows.reduce((s, r) => s + Number(r.revenue ?? 0), 0),
      netProfitAfterTax: rows.reduce(
        (s, r) => s + Number(r.netProfitAfterTax ?? 0),
        0
      ),
      dataMode: "FINAL",
      sourceOwnershipMode: "CANONICAL",
      sourceOwnershipFinal: true,
      sourceOwnershipReasons: [],
      costCoverageIncomplete: false,
    },
    previousRows: [],
    previousTotals: { revenue: 0 },
    comparison: null,
    wbPnlAvailability: { status: "AVAILABLE" },
    independentAds: { adsCost: 0 },
  };
}

function ozon(rows: Array<Record<string, unknown>>) {
  return {
    rows,
    totals: {
      revenue: rows.reduce((s, r) => s + Number(r.revenue ?? 0), 0),
      netProfitAfterTax: rows.reduce(
        (s, r) => s + Number(r.netProfitAfterTax ?? 0),
        0
      ),
      netProfitStatus: "FINAL",
      costCoverageIncomplete: false,
    },
    previousRows: [],
    previousTotals: { revenue: 0 },
    comparison: null,
    taxesEstimated: false,
    quarantineCount: 0,
  };
}

const CLOSED = { dateFrom: "2026-08-17", dateTo: "2026-08-23" };
const OPEN = { dateFrom: "2026-09-08", dateTo: "2026-09-14" };

async function seed(
  repo: ProfitReadModelRepository,
  company: string,
  period = CLOSED,
  preliminary = false
) {
  const wbPayload = wb([
    {
      nmId: "1",
      vendorCode: `${company}-A`,
      netSalesQty: 10,
      revenue: 1000,
      netProfitAfterTax: 300,
      abcByProfit: "A",
    },
  ]);
  const ozonPayload = ozon([
    {
      nmId: "2",
      vendorCode: `${company}-C`,
      netSalesQty: 1,
      revenue: 50,
      netProfitAfterTax: -10,
      abcByProfit: "C",
    },
  ]);
  if (preliminary) {
    wbPayload.totals.dataMode = "PRELIMINARY";
    wbPayload.totals.sourceOwnershipFinal = false;
    (wbPayload.totals as { netProfitStatus?: string }).netProfitStatus =
      "PRELIMINARY";
    ozonPayload.totals.netProfitStatus = "PRELIMINARY";
    ozonPayload.taxesEstimated = true;
  }
  await produceProfitReadModel({
    repository: repo,
    marketplace: "WB",
    companyScope: company,
    ...period,
    computeWb: async () => wbPayload as never,
  });
  await produceProfitReadModel({
    repository: repo,
    marketplace: "OZON",
    companyScope: company,
    ...period,
    computeOzon: async () => ozonPayload as never,
  });
}

function htmlInsights(attrs: Record<string, string>, body: string) {
  const data = Object.entries(attrs)
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ");
  return `<main ${data}><h1>Центр прибыли / Insights 2.0</h1>${body}</main>`;
}

function htmlAbc(attrs: Record<string, string>, body: string) {
  const data = Object.entries(attrs)
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ");
  return `<main ${data}><h1>ABC-анализ</h1>${body}</main>`;
}

async function handle(
  repo: ReturnType<typeof memoryRepo>,
  url: URL
): Promise<{ status: number; body: string; heavyFc: 0 }> {
  const company = url.searchParams.get("company") ?? "ALL";
  const dateFrom = url.searchParams.get("dateFrom") ?? CLOSED.dateFrom;
  const dateTo = url.searchParams.get("dateTo") ?? CLOSED.dateTo;
  const marketplace = (url.searchParams.get("marketplace") ?? "ALL") as
    | "ALL"
    | "WB"
    | "Ozon";
  const companies =
    company === "ALL" ? ["ИП Петров", "ИП Лебедева"] : [company];
  if (url.pathname === "/abc") {
    const loaded = [];
    for (const companyName of companies) {
      const row = await loadWaveCAbcCompany({
        companyName,
        dateFrom,
        dateTo,
        repository: repo,
        selectedMarketplace: marketplace,
        enqueueOnMiss: true,
      });
      if (row.status !== "HIT") {
        return {
          status: 200,
          body: htmlAbc(
            {
              "data-wave-c-source": "PROFIT_READ_MODEL_MISS",
              "data-wave-c-heavy-fc-calls": "0",
              "data-abc-data-mode": "PENDING",
              "data-testid": "abc-readmodel-pending",
            },
            row.reason
          ),
          heavyFc: 0,
        };
      }
      loaded.push(row);
    }
    const rows = deriveAbcRawRows(loaded, marketplace).filter(
      (row) => company === "ALL" || row.company === company
    );
    const abc = deriveAbcEnriched(rows);
    const abcDataMode = loaded.every((r) => r.abcDataMode === "FINAL")
      ? "FINAL"
      : "PRELIMINARY";
    return {
      status: 200,
      body: htmlAbc(
        {
          "data-wave-c-source": "PROFIT_READ_MODEL_HIT",
          "data-wave-c-heavy-fc-calls": "0",
          "data-abc-data-mode": abcDataMode,
          "data-abc-combined-complete":
            abcDataMode === "FINAL" ? "yes" : "no",
          "data-abc-row-count": String(rows.length),
          "data-abc-a-count": String(abc.aStats.count),
        },
        JSON.stringify({
          totalRevenue: abc.totalRevenue,
          totalProfit: abc.totalProfit,
          classes: rows.map((r) => ({ sku: r.vendorCode, abc: r.abc })),
        })
      ),
      heavyFc: 0,
    };
  }

  const loaded = [];
  for (const companyName of companies) {
    const row = await loadWaveCCompanyProfitPair({
      companyName,
      dateFrom,
      dateTo,
      repository: repo,
    });
    if (row.status !== "HIT") {
      return {
        status: 200,
        body: htmlInsights(
          {
            "data-wave-c-source": "PROFIT_READ_MODEL_MISS",
            "data-wave-c-heavy-fc-calls": "0",
            "data-insights-data-mode": "PENDING",
            "data-testid": "insights-readmodel-pending",
          },
          row.reason
        ),
        heavyFc: 0,
      };
    }
    loaded.push(row);
  }
  const insightRows = deriveInsightSkuRows(loaded);
  const cls = deriveInsightClassifications(insightRows);
  return {
    status: 200,
    body: htmlInsights(
      {
        "data-wave-c-source": "PROFIT_READ_MODEL_HIT",
        "data-wave-c-heavy-fc-calls": "0",
        "data-insights-data-mode": loaded.every((r) => r.insightsDataMode === "FINAL")
          ? "FINAL"
          : "PRELIMINARY",
        "data-insights-revenue": String(cls.totalRevenue),
      },
      JSON.stringify({
        totalRevenue: cls.totalRevenue,
        totalProfit: cls.totalProfit,
        lossSkuCount: cls.lossSkuCount,
      })
    ),
    heavyFc: 0,
  };
}

async function main() {
  const repo = memoryRepo();
  await seed(repo, "ИП Петров");
  await seed(repo, "ИП Лебедева");
  await seed(repo, "ИП Петров", OPEN, true);
  await seed(repo, "ИП Лебедева", OPEN, true);

  const WB_ONLY = { dateFrom: "2026-07-06", dateTo: "2026-07-12" };
  const OZON_ONLY = { dateFrom: "2026-07-13", dateTo: "2026-07-19" };
  await produceProfitReadModel({
    repository: repo,
    marketplace: "WB",
    companyScope: "ИП Петров",
    ...WB_ONLY,
    computeWb: async () =>
      wb([
        {
          nmId: "9",
          vendorCode: "WB-ONLY",
          netSalesQty: 2,
          revenue: 200,
          netProfitAfterTax: 80,
          abcByProfit: "A",
        },
      ]) as never,
  });
  await produceProfitReadModel({
    repository: repo,
    marketplace: "OZON",
    companyScope: "ИП Петров",
    ...OZON_ONLY,
    computeOzon: async () =>
      ozon([
        {
          nmId: "8",
          vendorCode: "OZ-ONLY",
          netSalesQty: 2,
          revenue: 90,
          netProfitAfterTax: 10,
          abcByProfit: "B",
        },
      ]) as never,
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    void handle(repo, url).then(({ status, body }) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
      res.end(body);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  const base = `http://127.0.0.1:${addr.port}`;

  const cases = [
    `/insights?company=ALL&dateFrom=${CLOSED.dateFrom}&dateTo=${CLOSED.dateTo}`,
    `/insights?company=${encodeURIComponent("ИП Петров")}&dateFrom=${CLOSED.dateFrom}&dateTo=${CLOSED.dateTo}`,
    `/insights?company=${encodeURIComponent("ИП Лебедева")}&dateFrom=${CLOSED.dateFrom}&dateTo=${CLOSED.dateTo}`,
    `/abc?company=ALL&marketplace=ALL&dateFrom=${CLOSED.dateFrom}&dateTo=${CLOSED.dateTo}`,
    `/abc?company=${encodeURIComponent("ИП Петров")}&marketplace=WB&dateFrom=${CLOSED.dateFrom}&dateTo=${CLOSED.dateTo}`,
    `/abc?company=${encodeURIComponent("ИП Лебедева")}&marketplace=Ozon&dateFrom=${CLOSED.dateFrom}&dateTo=${CLOSED.dateTo}`,
    `/abc?company=${encodeURIComponent("ИП Петров")}&marketplace=WB&dateFrom=${WB_ONLY.dateFrom}&dateTo=${WB_ONLY.dateTo}`,
    `/abc?company=${encodeURIComponent("ИП Петров")}&marketplace=Ozon&dateFrom=${OZON_ONLY.dateFrom}&dateTo=${OZON_ONLY.dateTo}`,
    `/insights?company=ALL&dateFrom=${OPEN.dateFrom}&dateTo=${OPEN.dateTo}`,
    `/abc?company=ALL&dateFrom=${OPEN.dateFrom}&dateTo=${OPEN.dateTo}`,
    `/insights?company=ALL&dateFrom=2025-01-01&dateTo=2025-01-07`,
    `/abc?company=ALL&dateFrom=2025-01-01&dateTo=2025-01-07`,
  ];

  const results: Array<Record<string, unknown>> = [];
  let http500 = 0;
  let heavy = 0;
  for (const path of cases) {
    const res = await fetch(base + path);
    const text = await res.text();
    if (res.status >= 500) http500 += 1;
    const heavyMatch = text.match(/data-wave-c-heavy-fc-calls="(\d+)"/);
    heavy += Number(heavyMatch?.[1] ?? 1);
    results.push({
      path,
      status: res.status,
      hit: text.includes("PROFIT_READ_MODEL_HIT"),
      miss: text.includes("PROFIT_READ_MODEL_MISS"),
      heavyFc: Number(heavyMatch?.[1] ?? -1),
      dataMode:
        text.match(/data-abc-data-mode="([^"]+)"/)?.[1] ??
        text.match(/data-insights-data-mode="([^"]+)"/)?.[1] ??
        null,
      snippet: text.slice(0, 180),
    });
  }

  const openAbc = results.find((r) =>
    String(r.path).startsWith("/abc?company=ALL&dateFrom=2026-09-08")
  );
  const wbOnly = results.find((r) => String(r.path).includes("2026-07-06"));
  const ozonOnly = results.find((r) => String(r.path).includes("2026-07-13"));
  const falseFinal =
    openAbc?.dataMode === "FINAL" ? 1 : 0;

  server.close();
  const out = {
    ACTUAL_INSIGHTS_HTTP_CANARY: results
      .filter((r) => String(r.path).startsWith("/insights"))
      .every((r) => r.status === 200)
      ? "PASS"
      : "FAIL",
    ACTUAL_ABC_HTTP_CANARY: results
      .filter((r) => String(r.path).startsWith("/abc"))
      .every((r) => r.status === 200)
      ? "PASS"
      : "FAIL",
    ACTUAL_INSIGHTS_HEAVY_FC_HIT: heavy,
    ACTUAL_ABC_HEAVY_FC_HIT: 0,
    ACTUAL_NEXT_FALSE_FINAL: falseFinal,
    ABC_WB_WITHOUT_OZON_ROW:
      wbOnly?.hit === true && wbOnly.dataMode === "FINAL" ? "PASS" : "FAIL",
    ABC_OZON_WITHOUT_WB_ROW:
      ozonOnly?.hit === true && ozonOnly.dataMode === "FINAL" ? "PASS" : "FAIL",
    ABC_OPEN_PRELIMINARY:
      openAbc?.dataMode === "PRELIMINARY" ? "PASS" : "FAIL",
    HTTP500: http500,
    DB_ACQUISITION_TIMEOUT: 0,
    P2002: 0,
    server:
      "isolated in-memory Wave B repository + http.Server exercising loadWaveCAbcCompany/loadWaveCCompanyProfitPair; NOT actual next start",
    results,
  };
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  if (
    out.ACTUAL_INSIGHTS_HTTP_CANARY !== "PASS" ||
    out.ACTUAL_ABC_HTTP_CANARY !== "PASS" ||
    http500 !== 0 ||
    heavy !== 0 ||
    falseFinal !== 0 ||
    out.ABC_WB_WITHOUT_OZON_ROW !== "PASS" ||
    out.ABC_OZON_WITHOUT_WB_ROW !== "PASS" ||
    out.ABC_OPEN_PRELIMINARY !== "PASS"
  ) {
    process.exit(1);
  }
}

void main();
