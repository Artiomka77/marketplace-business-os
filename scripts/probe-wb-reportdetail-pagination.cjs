/*
  Safe read-only WB reportDetailByPeriod pagination probe.
  Does not mutate DB. Reads WB tokens from MarketplaceApiConnection and checks whether
  official detailed WB rows are available for the requested period when paginating by rrdid.
*/

const { Client } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is not set');
}

const DATE_FROM = process.env.DATE_FROM || '2026-07-01';
const DATE_TO = process.env.DATE_TO || '2026-07-07';
const COMPANY_FILTER = (process.env.COMPANIES || 'ИП Петров')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const LIMIT = Number(process.env.WB_DETAIL_LIMIT || 100000);
const DELAY_MS = Number(process.env.WB_DETAIL_DELAY_MS || 12000);
const MAX_PAGES = Number(process.env.WB_DETAIL_MAX_PAGES || 30);
const MAX_RETRIES = Number(process.env.WB_DETAIL_MAX_RETRIES || 5);
const TARGET_DATES = (process.env.TARGET_DATES || '2026-07-06,2026-07-07')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const API_URL = 'https://statistics-api.wildberries.ru/api/v5/supplier/reportDetailByPeriod';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return 0;
  const number = Number(String(value).replace(',', '.'));
  return Number.isFinite(number) ? number : 0;
}

function day(value) {
  if (!value) return 'EMPTY';
  return String(value).slice(0, 10);
}

function add(map, key, amount) {
  map[key] = (map[key] || 0) + amount;
}

function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function emptySums() {
  return {
    rows: 0,
    retailAmount: 0,
    retailPrice: 0,
    retailPriceWithDiscount: 0,
    sellerPayout: 0,
    commissionWithoutVat: 0,
    commissionVat: 0,
    deliveryCount: 0,
    returnCount: 0,
    logistics: 0,
    storage: 0,
    acceptance: 0,
    deduction: 0,
    penalty: 0,
    acquiringFee: 0,
    ppvzReward: 0,
    rebillLogisticCost: 0,
  };
}

function addRowToSums(sums, row) {
  sums.rows += 1;
  sums.retailAmount += toNumber(row.retail_amount);
  sums.retailPrice += toNumber(row.retail_price);
  sums.retailPriceWithDiscount += toNumber(row.retail_price_withdisc_rub);
  sums.sellerPayout += toNumber(row.ppvz_for_pay);
  sums.commissionWithoutVat += toNumber(row.ppvz_vw);
  sums.commissionVat += toNumber(row.ppvz_vw_nds);
  sums.deliveryCount += toNumber(row.delivery_amount);
  sums.returnCount += toNumber(row.return_amount);
  sums.logistics += toNumber(row.delivery_rub);
  sums.storage += toNumber(row.storage_fee);
  sums.acceptance += toNumber(row.acceptance);
  sums.deduction += toNumber(row.deduction);
  sums.penalty += toNumber(row.penalty);
  sums.acquiringFee += toNumber(row.acquiring_fee);
  sums.ppvzReward += toNumber(row.ppvz_reward);
  sums.rebillLogisticCost += toNumber(row.rebill_logistic_cost);
}

function finalizeSums(sums) {
  return Object.fromEntries(
    Object.entries(sums).map(([key, value]) => [key, typeof value === 'number' ? round2(value) : value]),
  );
}

function summarizeRows(rows) {
  const bySaleDate = {};
  const byRrDate = {};
  const byOperation = {};
  const byBonusType = {};
  const reportIds = new Set();
  const targetBySaleDate = Object.fromEntries(TARGET_DATES.map((date) => [date, emptySums()]));
  const targetByRrDate = Object.fromEntries(TARGET_DATES.map((date) => [date, emptySums()]));
  const totals = emptySums();
  let firstRrdId = null;
  let lastRrdId = null;

  for (const row of rows) {
    const rrdId = row.rrd_id === undefined || row.rrd_id === null ? null : Number(row.rrd_id);
    if (rrdId !== null && Number.isFinite(rrdId)) {
      if (firstRrdId === null || rrdId < firstRrdId) firstRrdId = rrdId;
      if (lastRrdId === null || rrdId > lastRrdId) lastRrdId = rrdId;
    }

    if (row.realizationreport_id !== undefined && row.realizationreport_id !== null) {
      reportIds.add(String(row.realizationreport_id));
    }

    const saleDay = day(row.sale_dt);
    const rrDay = day(row.rr_dt);
    add(bySaleDate, saleDay, 1);
    add(byRrDate, rrDay, 1);
    add(byOperation, row.supplier_oper_name || 'EMPTY', 1);
    add(byBonusType, row.bonus_type_name || 'EMPTY', 1);
    addRowToSums(totals, row);

    if (targetBySaleDate[saleDay]) addRowToSums(targetBySaleDate[saleDay], row);
    if (targetByRrDate[rrDay]) addRowToSums(targetByRrDate[rrDay], row);
  }

  return {
    rows: rows.length,
    reportIds: [...reportIds].sort(),
    firstRrdId,
    lastRrdId,
    bySaleDate,
    byRrDate,
    byOperation,
    byBonusType,
    totals: finalizeSums(totals),
    targetBySaleDate: Object.fromEntries(Object.entries(targetBySaleDate).map(([k, v]) => [k, finalizeSums(v)])),
    targetByRrDate: Object.fromEntries(Object.entries(targetByRrDate).map(([k, v]) => [k, finalizeSums(v)])),
  };
}

async function requestPage(token, rrdid, attempt = 1) {
  const url = new URL(API_URL);
  url.searchParams.set('dateFrom', `${DATE_FROM}T00:00:00`);
  url.searchParams.set('dateTo', `${DATE_TO}T23:59:59`);
  url.searchParams.set('limit', String(LIMIT));
  url.searchParams.set('rrdid', String(rrdid));

  const startedAt = Date.now();
  const response = await fetch(url, {
    headers: { Authorization: token },
  });
  const durationMs = Date.now() - startedAt;
  const text = await response.text();

  if (response.status === 429 && attempt <= MAX_RETRIES) {
    const waitMs = DELAY_MS * attempt;
    await sleep(waitMs);
    return requestPage(token, rrdid, attempt + 1);
  }

  let rows = [];
  let parseError = null;
  if (text.trim()) {
    try {
      const parsed = JSON.parse(text);
      rows = Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      parseError = error.message;
    }
  }

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    durationMs,
    attempt,
    url: url.toString().replace(/rrdid=\d+/, `rrdid=${rrdid}`),
    bodySize: text.length,
    parseError,
    errorText: response.ok ? '' : text.slice(0, 500),
    rows,
  };
}

async function fetchPaginated(token) {
  let rrdid = 0;
  const pages = [];
  const allRows = [];

  for (let pageIndex = 1; pageIndex <= MAX_PAGES; pageIndex += 1) {
    const page = await requestPage(token, rrdid);
    pages.push({
      pageIndex,
      rrdidRequested: rrdid,
      ok: page.ok,
      status: page.status,
      statusText: page.statusText,
      durationMs: page.durationMs,
      attempt: page.attempt,
      bodySize: page.bodySize,
      rows: page.rows.length,
      parseError: page.parseError,
      errorText: page.errorText,
      firstRrdId: page.rows[0]?.rrd_id ?? null,
      lastRrdId: page.rows[page.rows.length - 1]?.rrd_id ?? null,
      saleDateFirst: page.rows[0]?.sale_dt ?? null,
      saleDateLast: page.rows[page.rows.length - 1]?.sale_dt ?? null,
      rrDateFirst: page.rows[0]?.rr_dt ?? null,
      rrDateLast: page.rows[page.rows.length - 1]?.rr_dt ?? null,
    });

    if (!page.ok) break;
    if (page.rows.length === 0) break;

    allRows.push(...page.rows);
    const last = page.rows[page.rows.length - 1]?.rrd_id;
    if (last === undefined || last === null || Number(last) <= rrdid) break;
    rrdid = Number(last);

    if (page.rows.length < LIMIT) break;
    await sleep(DELAY_MS);
  }

  return { pages, summary: summarizeRows(allRows) };
}

async function main() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  const { rows: companies } = await client.query(
    `select c."id", c."name", mac."wbToken", mac."status", mac."lastSyncAt", mac."lastError"
     from "Company" c
     join "MarketplaceApiConnection" mac on mac."companyId" = c."id" and mac."marketplace" = 'WB'
     where c."isActive" = true and mac."isEnabled" = true and mac."wbToken" is not null
     order by c."name" asc`,
  );

  const selected = companies.filter((company) =>
    COMPANY_FILTER.length === 0 || COMPANY_FILTER.includes(company.name),
  );

  const result = {
    ok: true,
    script: 'probe-wb-reportdetail-pagination',
    executedAt: new Date().toISOString(),
    config: {
      dateFrom: DATE_FROM,
      dateTo: DATE_TO,
      companies: COMPANY_FILTER,
      limit: LIMIT,
      delayMs: DELAY_MS,
      maxPages: MAX_PAGES,
      maxRetries: MAX_RETRIES,
      targetDates: TARGET_DATES,
    },
    selectedCompanies: selected.map((company) => ({
      name: company.name,
      status: company.status,
      lastSyncAt: company.lastSyncAt,
      lastError: company.lastError,
      hasToken: Boolean(company.wbToken),
      tokenLen: company.wbToken ? company.wbToken.length : 0,
    })),
    companies: [],
  };

  for (const company of selected) {
    const startedAt = Date.now();
    const probe = await fetchPaginated(company.wbToken);
    result.companies.push({
      companyName: company.name,
      durationMs: Date.now() - startedAt,
      pages: probe.pages,
      summary: probe.summary,
      conclusion: {
        hasRowsForTargetSaleDates: TARGET_DATES.some((date) => probe.summary.targetBySaleDate[date]?.rows > 0),
        hasRowsForTargetRrDates: TARGET_DATES.some((date) => probe.summary.targetByRrDate[date]?.rows > 0),
        hasNonZeroCostsForTargetSaleDates: TARGET_DATES.some((date) => {
          const sums = probe.summary.targetBySaleDate[date];
          return sums && (Math.abs(sums.logistics) + Math.abs(sums.storage) + Math.abs(sums.deduction) + Math.abs(sums.penalty) + Math.abs(sums.commissionWithoutVat) > 0);
        }),
        hasNonZeroCostsForTargetRrDates: TARGET_DATES.some((date) => {
          const sums = probe.summary.targetByRrDate[date];
          return sums && (Math.abs(sums.logistics) + Math.abs(sums.storage) + Math.abs(sums.deduction) + Math.abs(sums.penalty) + Math.abs(sums.commissionWithoutVat) > 0);
        }),
      },
    });
  }

  await client.end();
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error.message,
    stack: error.stack,
  }, null, 2));
  process.exitCode = 1;
});
