import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

import {
  formatDailyReportForTelegram,
  formatCompactMoney,
  formatMoney,
  type DailyReport,
} from "../../lib/telegram/dailyReport";

const MOJIBAKE_MARKERS = [
  "рџ",
  "вЂ",
  "С‚С‹СЃ",
  "РјР»РЅ",
  "в‚Ѕ",
  "РџРµСЂ",
  "Р—Р°Рє",
  "в€’",
  "пёЏ",
  "вљ ",
  "РёР·",
  "Р’РќРРњ",
  "Р­РєРѕРЅ",
  "РќР°Р»РѕРі",
  "РЎСЂР°РІ",
  "Рї.Рї",
  "РЎРµРіРѕРґ",
  "\uFFFD",
];

function baseMetrics(marketplace: "WB" | "OZON", overrides: Record<string, unknown> = {}) {
  return {
    marketplace,
    ordersQty: 9,
    ordersAmount: marketplace === "WB" ? 43734 : 67815,
    orderDataLoadedDays: 1,
    orderDataExpectedDays: 1,
    ordersDataMissing: false,
    ordersDataIncomplete: false,
    ordersDataMissingReason: null,
    salesQty: 0,
    salesAmount: 0,
    salesLabel: "Экономический оборот",
    salesQtyIsReliable: false,
    salesDataMissing: false,
    salesDataMissingReason: null,
    adSpend: 0,
    adSpendSource: "test",
    adDataMissing: false,
    adDataMissingReason: null,
    drrByOrders: 0,
    drrBySales: 0,
    drrByEconomicTurnover: 0,
    drrByTaxableRevenue: 0,
    stockQty: 282,
    netProfitAfterTax: 0,
    taxableRevenue: 0,
    economicTurnover: 0,
    netProfitStatus: "FINAL",
    taxRevenueCoverageComplete: true,
    discountPointsCoverageComplete: true,
    financialUnavailable: false,
    netProfitUnavailable: false,
    ...overrides,
  };
}

/** Fixture mirrors 2026-09-27 production nosend financial controls (encoding-only gate). */
function report20260927(): DailyReport {
  const lebedevaWb = baseMetrics("WB", {
    economicTurnover: 5039,
    taxableRevenue: 2103,
    adSpend: 0,
    netProfitAfterTax: -3205,
    drrByEconomicTurnover: 0,
    stockQty: 282,
    ordersAmount: 43734,
  });
  const lebedevaOzon = baseMetrics("OZON", {
    economicTurnover: 19824,
    taxableRevenue: 7595,
    adSpend: 2146,
    netProfitAfterTax: 2638,
    drrByEconomicTurnover: 10.8,
    stockQty: 436,
    ordersAmount: 67815,
  });
  const petrovWb = baseMetrics("WB", {
    economicTurnover: 158932,
    taxableRevenue: 89155,
    adSpend: 159374,
    netProfitAfterTax: -147817,
    drrByEconomicTurnover: 100.3,
    stockQty: 3500,
    ordersAmount: 200000,
  });
  const petrovOzon = baseMetrics("OZON", {
    economicTurnover: 876981,
    taxableRevenue: 282604,
    adSpend: 135271,
    netProfitAfterTax: 87412,
    drrByEconomicTurnover: 15.4,
    stockQty: 3530,
    ordersAmount: 900000,
  });

  const eco =
    5039 + 19824 + 158932 + 876981;
  const ads = 0 + 2146 + 159374 + 135271;
  const profit = -3205 + 2638 + -147817 + 87412;
  const owner = 10000;

  return {
    dateLabel: "2026-09-27",
    periodLabel: "Выбранный день",
    companies: [
      {
        companyName: "ИП Лебедева",
        wb: lebedevaWb as any,
        ozon: lebedevaOzon as any,
        combinedDataMode: "FINAL",
        finance: {
          cashIncome: 0,
          cashOutflow: 0,
          netCashFlow: 0,
          netProfitImpact: 0,
          ownerWithdrawals: 0,
        },
      },
      {
        companyName: "ИП Петров",
        wb: petrovWb as any,
        ozon: petrovOzon as any,
        combinedDataMode: "FINAL",
        finance: {
          cashIncome: 0,
          cashOutflow: 10000,
          netCashFlow: -10000,
          netProfitImpact: 0,
          ownerWithdrawals: owner,
        },
      },
    ],
    totals: {
      ordersQty: 36,
      ordersAmount: 43734 + 67815 + 200000 + 900000,
      orderDataLoadedDays: 4,
      orderDataExpectedDays: 4,
      salesQty: 0,
      salesAmount: 0,
      economicTurnover: eco,
      taxableRevenue: 2103 + 7595 + 89155 + 282604,
      adSpend: ads,
      drrByOrders: 0,
      drrBySales: 0,
      drrByEconomicTurnover: eco > 0 ? (ads / eco) * 100 : 0,
      drrByTaxableRevenue: 0,
      stockQty: 7748,
      cashIncome: 0,
      cashOutflow: 10000,
      netCashFlow: -10000,
      netProfitImpact: profit,
      ownerWithdrawals: owner,
    },
    warnings: [],
    dataReadiness: null,
    comparison: {
      dateLabel: "2026-09-26",
      totals: {
        economicTurnoverPercent: 1.2,
        adSpendPercent: null,
        drrByEconomicTurnoverPointDiff: 14.1,
        netCashFlowPercent: null,
        netProfitImpactPercent: null,
      },
    } as any,
    combinedFinancialUnavailable: false,
  };
}

function markerCount(text: string): number {
  return MOJIBAKE_MARKERS.reduce((n, m) => n + (text.split(m).length - 1), 0);
}

test("TELEGRAM UTF-8 render: readable Russian + emoji, zero mojibake", () => {
  const text = formatDailyReportForTelegram(report20260927());

  assert.match(text, /Сравнение: 26\.09\.2026/);
  assert.match(text, /п\.п\./);
  assert.match(text, /Реклама:/);

  assert.match(text, /📊/);
  assert.match(text, /⚠️/);
  assert.match(text, /🔴|🟢|🟠|🟡/);
  assert.match(text, /🟣 WB/);
  assert.match(text, /🔵 Ozon/);

  const mojibake = markerCount(text);
  const replacement = (text.match(/\uFFFD/g) || []).length;
  assert.equal(mojibake, 0, `TELEGRAM_MOJIBAKE_MARKER_COUNT=${mojibake}`);
  assert.equal(replacement, 0, `TELEGRAM_REPLACEMENT_CHAR_COUNT=${replacement}`);
  assert.equal(text.includes("WB WB"), false);
  assert.equal(text.includes("Ozon Ozon"), false);

  // write evidence for gate OUT folder if present
  const outDir = process.env.AVOROFIN_UTF8_OUT;
  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, "TELEGRAM_UTF8_RENDER_TEST.json"),
      JSON.stringify(
        {
          TELEGRAM_MOJIBAKE_MARKER_COUNT: mojibake,
          TELEGRAM_REPLACEMENT_CHAR_COUNT: replacement,
          DUPLICATE_MARKETPLACE_HEADER_COUNT:
            (text.includes("WB WB") ? 1 : 0) + (text.includes("Ozon Ozon") ? 1 : 0),
          sampleHead: text.split("\n").slice(0, 12),
          PASS: mojibake === 0 && replacement === 0,
        },
        null,
        2
      ) + "\n",
      "utf8"
    );
  }
});

test("TELEGRAM financial nonregression: 2026-09-27 canonical numbers unchanged by formatter", () => {
  const text = formatDailyReportForTelegram(report20260927());

  const required = [
    ["Lebedeva WB eco", "5", "039"],
    ["Lebedeva WB taxable", "2", "103"],
    ["Lebedeva WB profit", "-3", "205"],
    ["Lebedeva Ozon eco", "19", "824"],
    ["Lebedeva Ozon taxable", "7", "595"],
    ["Lebedeva Ozon ads", "2", "146"],
    ["Lebedeva Ozon profit", "+2", "638"],
    ["Petrov WB eco", "158", "932"],
    ["Petrov WB taxable", "89", "155"],
    ["Petrov WB ads", "159", "374"],
    ["Petrov WB profit", "-147", "817"],
    ["Petrov Ozon eco", "876", "981"],
    ["Petrov Ozon taxable", "282", "604"],
    ["Petrov Ozon ads", "135", "271"],
    ["Petrov Ozon profit", "+87", "412"],
    ["owner", "10", "000"],
  ];

  let changeCount = 0;
  const missing: string[] = [];
  for (const [label, a, b] of required) {
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`${esc(a)}[\\s\\u00a0]?${esc(b)}`);
    if (!re.test(text)) {
      changeCount += 1;
      missing.push(label);
    }
  }

  assert.equal(
    changeCount,
    0,
    `TELEGRAM_FINANCIAL_VALUE_CHANGE_COUNT=${changeCount} missing=${missing.join(",")}`
  );

  assert.match(formatMoney(5039), /5[\s\u00a0]039[\s\u00a0]₽/);
  assert.match(formatCompactMoney(-61000), /−61,0 тыс\.\s*₽/);

  const outDir = process.env.AVOROFIN_UTF8_OUT;
  if (outDir) {
    fs.writeFileSync(
      path.join(outDir, "TELEGRAM_FINANCIAL_NONREGRESSION.json"),
      JSON.stringify(
        {
          TELEGRAM_FINANCIAL_VALUE_CHANGE_COUNT: changeCount,
          missing,
          PASS: changeCount === 0,
        },
        null,
        2
      ) + "\n",
      "utf8"
    );
  }
});

test("source dailyReport.ts has zero committed mojibake markers", () => {
  const src = fs.readFileSync(
    path.join(process.cwd(), "lib/telegram/dailyReport.ts"),
    "utf8"
  );
  for (const m of MOJIBAKE_MARKERS) {
    assert.equal(src.includes(m), false, `source still contains marker ${JSON.stringify(m)}`);
  }
  assert.equal(src.includes("WB WB"), false);
  assert.equal(src.includes('compactMarketplaceBlock("WB", "WB"'), false);
  assert.match(src, /📊 AvoroFin — сводка собственника/);
});
