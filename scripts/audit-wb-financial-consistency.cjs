const { Client } = require('pg');

const DATE_FROM = process.env.DATE_FROM || '2026-07-07';
const DATE_TO = process.env.DATE_TO || DATE_FROM;
const COMPANY_NAME = process.env.COMPANY_NAME || 'ИП Петров';
const BASE_URL = (process.env.BASE_URL || 'https://ardelo.su').replace(/\/$/, '');
const TELEGRAM_SECRET = process.env.TELEGRAM_DAILY_REPORT_SECRET || '';
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 45000);
const EPS = Number(process.env.EPS || 1);

function toNumber(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'object' && typeof value.toNumber === 'function') return value.toNumber();
  const normalized = String(value).replace(/\s/g, '').replace(',', '.').replace(/[^\d.-]/g, '');
  const n = Number(normalized);
  return Number.isFinite(n) ? n : 0;
}

function round2(value) {
  return Math.round((toNumber(value) + Number.EPSILON) * 100) / 100;
}

function pct(value, base) {
  const v = toNumber(value);
  const b = toNumber(base);
  return b ? round2((v / b) * 100) : 0;
}

function dateStart(dateText) {
  return new Date(`${dateText}T00:00:00.000Z`);
}

function dateEndExclusive(dateText) {
  const d = dateStart(dateText);
  d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

function moscowDateKey(value) {
  if (!value) return 'unknown';
  const d = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(d.getTime())) return 'unknown';
  return new Date(d.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(/[–—−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function isSale(reason) {
  const text = normalizeText(reason);
  return text === 'продажа' || text === 'сторно возвратов';
}

function isReturn(reason) {
  const text = normalizeText(reason);
  return text === 'возврат' || text.includes('возврат');
}

function isDailyStatistics(row) {
  return String(row.reportNumber || '').startsWith('WB_DAILY_STATISTICS_');
}

function preferRowsByDay(rows) {
  const byDay = new Map();
  for (const row of rows) {
    const day = moscowDateKey(row.saleDate);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(row);
  }

  const result = [];
  for (const [day, dayRows] of byDay.entries()) {
    const financialRows = dayRows.filter((row) => !isDailyStatistics(row));
    const dailyRows = dayRows.filter((row) => isDailyStatistics(row));
    result.push(...(financialRows.length ? financialRows : dailyRows));
  }
  return result;
}

function latestCostMap(costRows) {
  const byVendorCode = new Map();
  const byNmId = new Map();

  for (const row of costRows) {
    if (row.vendorCode && !byVendorCode.has(row.vendorCode)) byVendorCode.set(row.vendorCode, toNumber(row.costPrice));
    if (row.nmId && !byNmId.has(String(row.nmId))) byNmId.set(String(row.nmId), toNumber(row.costPrice));
  }

  return { byVendorCode, byNmId };
}

function calcVatTax(revenue, vatRate) {
  const rate = toNumber(vatRate);
  if (rate <= 0) return 0;
  return revenue * (rate / (100 + rate));
}

function summarizeSales(rows, costRows) {
  const effectiveRows = preferRowsByDay(rows);
  const { byVendorCode, byNmId } = latestCostMap(costRows);

  const byDay = {};
  const totals = {
    rows: effectiveRows.length,
    salesQty: 0,
    returnsQty: 0,
    netSalesQty: 0,
    sellerRetailAmount: 0,
    revenue: 0,
    sppDiscountAmount: 0,
    sellerPayoutFromRows: 0,
    costOfGoods: 0,
    logisticsFromRows: 0,
    storageFromRows: 0,
    acceptanceFromRows: 0,
    penaltiesFromRows: 0,
    deductionsFromRows: 0,
    wbRewardFromRows: 0,
    wbRewardVatFromRows: 0,
    paymentServiceFromRows: 0,
    pvzCompensationFromRows: 0,
    transportCompensationFromRows: 0,
    missingCostRows: 0,
  };

  for (const row of effectiveRows) {
    const sign = isReturn(row.paymentReason) ? -1 : 1;
    const qty = Math.abs(Number(row.quantity || 0)) || 1;
    const day = moscowDateKey(row.saleDate);
    if (!byDay[day]) {
      byDay[day] = {
        rows: 0,
        sellerRetailAmount: 0,
        revenue: 0,
        sellerPayoutFromRows: 0,
        logisticsFromRows: 0,
        storageFromRows: 0,
        penaltiesFromRows: 0,
      };
    }

    if (isSale(row.paymentReason)) totals.salesQty += qty;
    if (isReturn(row.paymentReason)) totals.returnsQty += qty;
    totals.netSalesQty += sign * qty;

    const retail = sign * Math.abs(toNumber(row.retailPrice));
    const revenue = sign * Math.abs(toNumber(row.wbRealizedAmount));
    const payout = sign * Math.abs(toNumber(row.sellerPayout));
    const logistics = Math.abs(toNumber(row.logisticsCost));
    const storage = Math.abs(toNumber(row.storageCost));
    const acceptance = Math.abs(toNumber(row.acceptanceCost));
    const penalties = Math.abs(toNumber(row.penaltiesAmount));
    const deductions = Math.abs(toNumber(row.deductions));

    totals.sellerRetailAmount += retail;
    totals.revenue += revenue;
    totals.sppDiscountAmount += sign * Math.abs(toNumber(row.sppDiscountAmount || (Math.abs(toNumber(row.retailPrice)) - Math.abs(toNumber(row.wbRealizedAmount)))));
    totals.sellerPayoutFromRows += payout;
    totals.logisticsFromRows += logistics;
    totals.storageFromRows += storage;
    totals.acceptanceFromRows += acceptance;
    totals.penaltiesFromRows += penalties;
    totals.deductionsFromRows += deductions;
    totals.wbRewardFromRows += toNumber(row.wbReward);
    totals.wbRewardVatFromRows += toNumber(row.wbRewardVat);
    totals.paymentServiceFromRows += toNumber(row.paymentServiceCost);
    totals.pvzCompensationFromRows += toNumber(row.pvzCompensation);
    totals.transportCompensationFromRows += toNumber(row.transportCompensation);

    const cost = byVendorCode.get(row.vendorCode || '') ?? byNmId.get(String(row.nmId || '')) ?? 0;
    if (cost === 0 && (isSale(row.paymentReason) || isReturn(row.paymentReason))) totals.missingCostRows += 1;
    totals.costOfGoods += sign * qty * cost;

    byDay[day].rows += 1;
    byDay[day].sellerRetailAmount += retail;
    byDay[day].revenue += revenue;
    byDay[day].sellerPayoutFromRows += payout;
    byDay[day].logisticsFromRows += logistics;
    byDay[day].storageFromRows += storage;
    byDay[day].penaltiesFromRows += penalties;
  }

  return { totals: roundObject(totals), byDay: roundObjectDeep(byDay), effectiveRowsCount: effectiveRows.length, rawRowsCount: rows.length };
}

function summarizeFinance(rows) {
  const totals = {
    rows: rows.length,
    salesAmount: 0,
    payoutAmount: 0,
    logisticsCost: 0,
    storageCost: 0,
    acceptanceCost: 0,
    otherDeductions: 0,
    penaltiesAmount: 0,
    totalToPay: 0,
  };
  const byDay = {};

  for (const row of rows) {
    const day = moscowDateKey(row.dateFrom || row.dateTo);
    if (!byDay[day]) byDay[day] = { rows: 0, salesAmount: 0, payoutAmount: 0, logisticsCost: 0, storageCost: 0, otherDeductions: 0, penaltiesAmount: 0, totalToPay: 0 };

    const fields = ['salesAmount', 'payoutAmount', 'logisticsCost', 'storageCost', 'acceptanceCost', 'otherDeductions', 'penaltiesAmount', 'totalToPay'];
    totals.rows = rows.length;
    byDay[day].rows += 1;
    for (const field of fields) {
      const value = toNumber(row[field]);
      totals[field] += value;
      if (field in byDay[day]) byDay[day][field] += value;
    }
  }

  return { totals: roundObject(totals), byDay: roundObjectDeep(byDay), rows: rows.map((row) => ({
    reportNumber: row.reportNumber,
    reportTypeName: row.reportTypeName,
    dateFrom: row.dateFrom ? row.dateFrom.toISOString().slice(0, 10) : null,
    dateTo: row.dateTo ? row.dateTo.toISOString().slice(0, 10) : null,
    salesAmount: round2(row.salesAmount),
    payoutAmount: round2(row.payoutAmount),
    logisticsCost: round2(row.logisticsCost),
    storageCost: round2(row.storageCost),
    acceptanceCost: round2(row.acceptanceCost),
    otherDeductions: round2(row.otherDeductions),
    penaltiesAmount: round2(row.penaltiesAmount),
    totalToPay: round2(row.totalToPay),
  })) };
}

function summarizeAds(rows) {
  const totals = { rows: rows.length, spend: 0 };
  const byDay = {};
  for (const row of rows) {
    const day = moscowDateKey(row.dateFrom || row.dateTo);
    if (!byDay[day]) byDay[day] = { rows: 0, spend: 0 };
    const spend = toNumber(row.spend);
    totals.spend += spend;
    byDay[day].rows += 1;
    byDay[day].spend += spend;
  }
  return { totals: roundObject(totals), byDay: roundObjectDeep(byDay) };
}

function buildCanonical({ finance, sales, ads, company }) {
  const sellerRetailAmount = sales.totals.sellerRetailAmount;
  const revenue = sales.totals.revenue;
  const sppDiscountAmount = sellerRetailAmount - revenue;
  const payoutAmount = finance.totals.payoutAmount || sales.totals.sellerPayoutFromRows;
  const heldByWbBeforePayout = revenue - payoutAmount;
  const logisticsCost = finance.totals.logisticsCost || sales.totals.logisticsFromRows;
  const storageCost = finance.totals.storageCost || sales.totals.storageFromRows;
  const acceptanceCost = finance.totals.acceptanceCost || sales.totals.acceptanceFromRows;
  const penaltiesAmount = finance.totals.penaltiesAmount || sales.totals.penaltiesFromRows;
  const otherDeductionsRaw = finance.totals.otherDeductions;
  const totalToPay = finance.totals.totalToPay || (payoutAmount - logisticsCost - storageCost - acceptanceCost - penaltiesAmount - otherDeductionsRaw);
  const adsCost = ads.totals.spend;
  const costOfGoods = sales.totals.costOfGoods;
  const usnRate = toNumber(company?.usnRate ?? 1);
  const vatRate = toNumber(company?.vatRate ?? 5);
  const vatTax = calcVatTax(revenue, vatRate);
  const usnTax = revenue * (usnRate / 100);
  const tax = vatTax + usnTax;
  const netProfitAfterTax = totalToPay - costOfGoods - adsCost - tax;
  const wbExpensesWithoutAds = heldByWbBeforePayout + logisticsCost + storageCost + acceptanceCost + penaltiesAmount + otherDeductionsRaw;
  const wbExpensesWithAds = wbExpensesWithoutAds + adsCost;
  const allPnlExpenses = revenue - netProfitAfterTax;
  const economicTurnover = sellerRetailAmount || revenue;

  return roundObject({
    economicTurnover,
    sellerRetailAmount,
    taxableRevenue: revenue,
    revenue,
    sppDiscountAmount,
    sellerPayout: payoutAmount,
    heldByWbBeforePayout,
    logisticsCost,
    storageCost,
    acceptanceCost,
    penaltiesAmount,
    otherDeductionsRaw,
    totalToPay,
    costOfGoods,
    adsCost,
    tax,
    vatTax,
    usnTax,
    netProfitAfterTax,
    wbExpensesWithoutAds,
    wbExpensesWithAds,
    allPnlExpenses,
    sharesFromEconomicTurnover: {
      taxableRevenue: pct(revenue, economicTurnover),
      sppDiscountAmount: pct(sppDiscountAmount, economicTurnover),
      sellerPayout: pct(payoutAmount, economicTurnover),
      totalToPay: pct(totalToPay, economicTurnover),
      heldByWbBeforePayout: pct(heldByWbBeforePayout, economicTurnover),
      wbExpensesWithoutAds: pct(wbExpensesWithoutAds, economicTurnover),
      wbExpensesWithAds: pct(wbExpensesWithAds, economicTurnover),
      allPnlExpenses: pct(allPnlExpenses, economicTurnover),
      netProfitAfterTax: pct(netProfitAfterTax, economicTurnover),
      adsCost: pct(adsCost, economicTurnover),
    },
  });
}

function roundObject(obj) {
  const out = Array.isArray(obj) ? [] : {};
  for (const [key, value] of Object.entries(obj || {})) {
    if (typeof value === 'number') out[key] = round2(value);
    else if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) out[key] = roundObject(value);
    else out[key] = value;
  }
  return out;
}

function roundObjectDeep(obj) {
  return roundObject(obj);
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    return { ok: res.ok, status: res.status, statusText: res.statusText, json, textPreview: text.slice(0, 1000) };
  } catch (error) {
    return { ok: false, error: error && (error.stack || error.message || String(error)) };
  } finally {
    clearTimeout(timer);
  }
}

function pick(obj, path) {
  let current = obj;
  for (const key of path.split('.')) {
    if (current == null) return undefined;
    current = current[key];
  }
  return current;
}

function compareValue(label, canonical, candidate, findings) {
  if (candidate === undefined || candidate === null || Number.isNaN(Number(candidate))) {
    findings.push({ level: 'warn', label, message: 'нет значения для сравнения', canonical: round2(canonical), candidate });
    return;
  }
  const diff = round2(toNumber(candidate) - toNumber(canonical));
  if (Math.abs(diff) > EPS) {
    findings.push({ level: 'error', label, canonical: round2(canonical), candidate: round2(candidate), diff });
  }
}

function extractProfitApiTotals(response) {
  const totals = response?.json?.totals;
  if (!totals) return null;
  return {
    economicTurnover: totals.sellerRetailAmount ?? totals.economicTurnover,
    taxableRevenue: totals.revenue,
    revenue: totals.revenue,
    sellerPayout: totals.sellerPayout,
    heldByWbBeforePayout: totals.heldByWbBeforePayout ?? totals.commissionCompensationAmount,
    logisticsCost: totals.logisticsCost,
    storageCost: (toNumber(totals.storageCost) + toNumber(totals.acceptanceCost)),
    penaltiesAmount: totals.penaltiesAmount,
    totalToPay: totals.totalToPay,
    costOfGoods: totals.costOfGoods,
    adsCost: totals.adsCost,
    tax: totals.taxAmount ?? totals.totalTax,
    netProfitAfterTax: totals.netProfitAfterTax,
    wbExpensesWithoutAds: totals.wbExpensesWithoutAds,
    wbExpensesWithAds: totals.wbExpensesWithAds,
    allPnlExpenses: totals.allPnlExpenses,
  };
}

function extractTelegramWb(response, companyName) {
  const companies = response?.json?.report?.companies || [];
  const company = companies.find((row) => row.companyName === companyName);
  const wb = company?.wb;
  if (!wb) return null;
  return {
    taxableRevenue: wb.salesAmount,
    revenue: wb.salesAmount,
    economicTurnover: wb.economicTurnover,
    adsCost: wb.adSpend,
    netProfitAfterTax: wb.netProfitAfterTax,
  };
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const from = dateStart(DATE_FROM);
  const to = dateEndExclusive(DATE_TO);

  const [companyRes, financeRes, saleRes, adsRes, costRes] = await Promise.all([
    client.query('select "name", "usnRate", "vatRate" from "Company" where "name" = $1 limit 1', [COMPANY_NAME]),
    client.query(`
      select "reportNumber", "reportTypeName", "dateFrom", "dateTo", "salesAmount", "payoutAmount",
             "logisticsCost", "storageCost", "acceptanceCost", "otherDeductions", "penaltiesAmount", "totalToPay"
      from "WbFinance"
      where "companyName" = $1
        and (("dateFrom" >= $2 and "dateFrom" < $3) or ("dateTo" >= $2 and "dateTo" < $3))
      order by "dateFrom" asc, "reportNumber" asc
    `, [COMPANY_NAME, from, to]),
    client.query(`
      select "reportNumber", "saleDate", "paymentReason", "quantity", "retailPrice", "wbRealizedAmount",
             "sellerPayout", "sppDiscountAmount", "vendorCode", "nmId", "logisticsCost", "storageCost",
             "acceptanceCost", "penaltiesAmount", "deductions", "wbReward", "wbRewardVat", "paymentServiceCost",
             "pvzCompensation", "transportCompensation"
      from "WbSale"
      where "companyName" = $1 and "saleDate" >= $2 and "saleDate" < $3
    `, [COMPANY_NAME, from, to]),
    client.query(`
      select "dateFrom", "dateTo", "spend"
      from "WbAds"
      where "companyName" = $1
        and (("dateFrom" >= $2 and "dateFrom" < $3) or ("dateTo" >= $2 and "dateTo" < $3))
    `, [COMPANY_NAME, from, to]),
    client.query(`
      select distinct on (coalesce("vendorCode", ''), coalesce("nmId", '')) "vendorCode", "nmId", "costPrice", "costDate", "createdAt"
      from "ProductCost"
      order by coalesce("vendorCode", ''), coalesce("nmId", ''), "costDate" desc nulls last, "createdAt" desc
    `),
  ]);

  const finance = summarizeFinance(financeRes.rows);
  const sales = summarizeSales(saleRes.rows, costRes.rows);
  const ads = summarizeAds(adsRes.rows);
  const company = companyRes.rows[0] || null;
  const canonical = buildCanonical({ finance, sales, ads, company });

  const qs = `dateFrom=${encodeURIComponent(DATE_FROM)}&dateTo=${encodeURIComponent(DATE_TO)}&companyName=${encodeURIComponent(COMPANY_NAME)}`;
  const profitApi = await fetchJson(`${BASE_URL}/api/analytics/profit?${qs}`);
  const telegramUrl = `${BASE_URL}/api/telegram/daily-report?from=${encodeURIComponent(DATE_FROM)}&to=${encodeURIComponent(DATE_TO)}&send=false${TELEGRAM_SECRET ? `&secret=${encodeURIComponent(TELEGRAM_SECRET)}` : ''}`;
  const telegram = await fetchJson(telegramUrl);
  const profitPage = await fetchJson(`${BASE_URL}/profit-wb?sort=netProfitAfterTax&dir=desc&abc=ALL&q=&pageSize=15&${qs}`);
  const dashboardPage = await fetchJson(`${BASE_URL}/`);

  const findings = [];
  if (finance.totals.rows === 0) findings.push({ level: 'error', label: 'WbFinance', message: 'нет ежедневных финансовых отчетов WB за период' });
  if (sales.totals.rows === 0) findings.push({ level: 'error', label: 'WbSale', message: 'нет строк продаж/детализации WB за период' });
  if (canonical.revenue > 50000 && canonical.heldByWbBeforePayout === 0) findings.push({ level: 'error', label: 'qualityGate', message: 'выручка WB есть, но удержано WB до выплат = 0' });
  if (canonical.revenue > 50000 && canonical.logisticsCost === 0) findings.push({ level: 'error', label: 'qualityGate', message: 'выручка WB есть, но логистика = 0' });
  if (canonical.revenue > 50000 && canonical.totalToPay === 0) findings.push({ level: 'error', label: 'qualityGate', message: 'выручка WB есть, но итого к оплате WB = 0' });

  const profitTotals = extractProfitApiTotals(profitApi);
  if (profitApi.ok && profitTotals) {
    compareValue('profitApi.revenue', canonical.revenue, profitTotals.revenue, findings);
    compareValue('profitApi.sellerPayout', canonical.sellerPayout, profitTotals.sellerPayout, findings);
    compareValue('profitApi.logisticsCost', canonical.logisticsCost, profitTotals.logisticsCost, findings);
    compareValue('profitApi.adsCost', canonical.adsCost, profitTotals.adsCost, findings);
    compareValue('profitApi.netProfitAfterTax', canonical.netProfitAfterTax, profitTotals.netProfitAfterTax, findings);
  } else {
    findings.push({ level: 'warn', label: 'profitApi', message: 'не удалось получить/распознать /api/analytics/profit', response: profitApi });
  }

  const telegramWb = extractTelegramWb(telegram, COMPANY_NAME);
  if (telegram.ok && telegramWb) {
    compareValue('telegram.wb.salesAmount', canonical.revenue, telegramWb.revenue, findings);
    compareValue('telegram.wb.adsCost', canonical.adsCost, telegramWb.adsCost, findings);
    compareValue('telegram.wb.netProfitAfterTax', canonical.netProfitAfterTax, telegramWb.netProfitAfterTax, findings);
  } else {
    findings.push({ level: 'warn', label: 'telegram', message: 'не удалось получить/распознать Telegram daily-report', response: telegram });
  }

  const importantValues = [
    canonical.economicTurnover,
    canonical.revenue,
    canonical.totalToPay,
    canonical.netProfitAfterTax,
    canonical.logisticsCost,
    canonical.heldByWbBeforePayout,
  ].map((v) => Math.round(v).toLocaleString('ru-RU').replace(/\u00A0/g, ' '));

  const pageText = String(profitPage.textPreview || '');
  const pagePresence = importantValues.map((value) => ({ value, foundInPreview: pageText.includes(value) }));

  const result = {
    ok: !findings.some((f) => f.level === 'error'),
    audit: {
      dateFrom: DATE_FROM,
      dateTo: DATE_TO,
      companyName: COMPANY_NAME,
      baseUrl: BASE_URL,
      generatedAt: new Date().toISOString(),
    },
    canonical,
    rawSources: { finance, sales, ads },
    surfaces: {
      profitApi: { status: profitApi.status, ok: profitApi.ok, totals: profitTotals, error: profitApi.error || null },
      telegram: { status: telegram.status, ok: telegram.ok, wb: telegramWb, error: telegram.error || null },
      profitPage: { status: profitPage.status, ok: profitPage.ok, previewPresence: pagePresence, error: profitPage.error || null },
      dashboardPage: { status: dashboardPage.status, ok: dashboardPage.ok, error: dashboardPage.error || null },
    },
    findings,
    nextActions: findings.length === 0
      ? ['WB финпоказатели согласованы по проверенным источникам. Следующий шаг: закрепить этот аудит в ежедневном контроле перед Telegram-отчетом.']
      : ['Исправить источники из findings.', 'После исправления повторить аудит для обеих компаний и для диапазонов 07.07 и 06–07.07.', 'Добавить quality gate перед отправкой Telegram-отчета.'],
  };

  console.log(JSON.stringify(result, null, 2));
  await client.end();
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error && (error.stack || error.message || String(error)) }, null, 2));
  process.exit(1);
});
