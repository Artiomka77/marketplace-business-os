const { Pool } = require('pg');

const DATE_FROM = process.env.DATE_FROM || '2026-07-06';
const DATE_TO = process.env.DATE_TO || '2026-07-07';
const COMPANIES = (process.env.COMPANIES || 'ИП Петров,ИП Лебедева')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const REQUEST_DELAY_MS = Number(process.env.WB_PROBE_DELAY_MS || 4500);
const DETAIL_LIMIT = Number(process.env.WB_PROBE_DETAIL_LIMIT || 1000);
const INCLUDE_RAW_SAMPLES = String(process.env.WB_PROBE_RAW || '').toLowerCase() === 'true';
const MAX_SAMPLE_ROWS = Number(process.env.WB_PROBE_SAMPLE_ROWS || 3);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function addDaysIso(iso, days) {
  const date = new Date(`${iso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function subDaysIso(iso, days) {
  return addDaysIso(iso, -days);
}

function round2(value) {
  const number = Number(value || 0);
  return Math.round((number + Number.EPSILON) * 100) / 100;
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const normalized = String(value).replace(/\s/g, '').replace(',', '.').replace(/[^\d.-]/g, '');
  const number = Number(normalized);
  return Number.isFinite(number) ? number : 0;
}

function safeText(text, max = 3000) {
  const value = String(text || '');
  return value.length > max ? `${value.slice(0, max)}...[truncated ${value.length - max}]` : value;
}

function maskToken(token) {
  const text = String(token || '');
  if (!text) return null;
  if (text.length <= 12) return `${text.slice(0, 3)}***`;
  return `${text.slice(0, 6)}...${text.slice(-6)} (len ${text.length})`;
}

function getField(row, names) {
  for (const name of names) {
    const value = row?.[name];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

const FIELD_GROUPS = {
  reportId: ['realizationreport_id', 'realizationReportId', 'reportId', 'report_id'],
  rrdId: ['rrd_id', 'rrdId', 'rrdid'],
  rrDate: ['rr_dt', 'rrDate'],
  saleDate: ['sale_dt', 'saleDt', 'date'],
  operation: ['supplier_oper_name', 'supplierOperName', 'sellerOperName'],
  docType: ['doc_type_name', 'docTypeName'],
  bonusType: ['bonus_type_name', 'bonusTypeName'],
  nmId: ['nm_id', 'nmId'],
  vendorCode: ['sa_name', 'vendorCode', 'supplierArticle'],
  retailAmount: ['retail_amount', 'retailAmount'],
  retailPrice: ['retail_price', 'retailPrice'],
  retailPriceWithDiscount: ['retail_price_withdisc_rub', 'retail_price_with_discount', 'retailPriceWithDiscount'],
  sellerPayout: ['ppvz_for_pay', 'forPay'],
  commissionWithoutVat: ['ppvz_vw', 'vw'],
  commissionVat: ['ppvz_vw_nds', 'ppvzVwNds'],
  commissionPercent: ['commission_percent', 'commissionPercent'],
  deliveryCount: ['delivery_amount', 'deliveryAmount'],
  returnCount: ['return_amount', 'returnAmount'],
  logistics: ['delivery_rub', 'deliveryService'],
  storage: ['storage_fee', 'paidStorage'],
  acceptance: ['acceptance', 'paidAcceptance'],
  deduction: ['deduction'],
  penalty: ['penalty'],
  acquiringFee: ['acquiring_fee', 'acquiringFee'],
  ppvzReward: ['ppvz_reward', 'ppvzReward'],
  rebillLogisticCost: ['rebill_logistic_cost', 'rebillLogisticCost'],
  loyaltyDiscountCompensation: ['loyalty_discount_compensation', 'loyaltyDiscountCompensation'],
  loyaltyParticipationCost: ['loyalty_participation_cost', 'loyaltyParticipationCost'],
  loyaltyPointsAmount: ['loyalty_points_amount', 'loyaltyPointsAmount'],
};

function dateOnly(value) {
  if (!value) return 'NO_DATE';
  const text = String(value);
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : text.slice(0, 10);
}

function increment(map, key, amount = 1) {
  const normalizedKey = key === undefined || key === null || key === '' ? 'EMPTY' : String(key);
  map[normalizedKey] = round2((map[normalizedKey] || 0) + amount);
}

function summarizeRows(rows) {
  const result = {
    rows: Array.isArray(rows) ? rows.length : 0,
    keysUnion: [],
    reportIds: [],
    firstRrdId: null,
    lastRrdId: null,
    bySaleDate: {},
    byRrDate: {},
    byOperation: {},
    byDocType: {},
    byBonusType: {},
    sums: {},
    nonZeroCounters: {},
    samples: [],
  };

  if (!Array.isArray(rows) || rows.length === 0) return result;

  const keySet = new Set();
  const reportSet = new Set();

  for (const row of rows) {
    for (const key of Object.keys(row || {})) keySet.add(key);

    const reportId = getField(row, FIELD_GROUPS.reportId);
    if (reportId !== null) reportSet.add(String(reportId));

    increment(result.bySaleDate, dateOnly(getField(row, FIELD_GROUPS.saleDate)));
    increment(result.byRrDate, dateOnly(getField(row, FIELD_GROUPS.rrDate)));
    increment(result.byOperation, getField(row, FIELD_GROUPS.operation));
    increment(result.byDocType, getField(row, FIELD_GROUPS.docType));
    increment(result.byBonusType, getField(row, FIELD_GROUPS.bonusType));

    for (const [name, aliases] of Object.entries(FIELD_GROUPS)) {
      if (['reportId', 'rrdId', 'rrDate', 'saleDate', 'operation', 'docType', 'bonusType', 'nmId', 'vendorCode'].includes(name)) {
        continue;
      }

      const value = toNumber(getField(row, aliases));
      result.sums[name] = round2((result.sums[name] || 0) + value);
      if (Math.abs(value) > 0.000001) {
        result.nonZeroCounters[name] = (result.nonZeroCounters[name] || 0) + 1;
      }
    }
  }

  result.keysUnion = Array.from(keySet).sort();
  result.reportIds = Array.from(reportSet).slice(0, 50);
  result.firstRrdId = getField(rows[0], FIELD_GROUPS.rrdId);
  result.lastRrdId = getField(rows[rows.length - 1], FIELD_GROUPS.rrdId);

  result.samples = rows.slice(0, MAX_SAMPLE_ROWS).map((row) => {
    const compact = {};
    for (const [name, aliases] of Object.entries(FIELD_GROUPS)) {
      compact[name] = getField(row, aliases);
    }
    if (INCLUDE_RAW_SAMPLES) compact.raw = row;
    return compact;
  });

  return result;
}

async function fetchJson({ method = 'GET', url, headers, body, label }) {
  const startedAt = Date.now();
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  const text = await response.text().catch(() => '');
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_) {
    json = null;
  }

  return {
    label,
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    durationMs: Date.now() - startedAt,
    textPreview: json === null ? safeText(text) : undefined,
    json,
  };
}

async function probeStatisticsReportDetail({ token, label, dateFromParam, dateToParam, rrdParamName = 'rrdid', includeRrd = true }) {
  const url = new URL('https://statistics-api.wildberries.ru/api/v5/supplier/reportDetailByPeriod');
  url.searchParams.set('dateFrom', dateFromParam);
  url.searchParams.set('dateTo', dateToParam);
  url.searchParams.set('limit', String(DETAIL_LIMIT));
  if (includeRrd) url.searchParams.set(rrdParamName, '0');

  const result = await fetchJson({
    label,
    url: url.toString(),
    headers: { Authorization: token },
  });

  const rows = Array.isArray(result.json) ? result.json : [];
  return {
    source: 'statistics.reportDetailByPeriod',
    label,
    request: {
      dateFrom: dateFromParam,
      dateTo: dateToParam,
      limit: DETAIL_LIMIT,
      rrdParamName: includeRrd ? rrdParamName : null,
    },
    ok: result.ok,
    status: result.status,
    statusText: result.statusText,
    durationMs: result.durationMs,
    errorText: result.ok ? null : result.textPreview,
    rowSummary: summarizeRows(rows),
  };
}

async function probeStatisticsSales({ token, label, dateFromParam, flag }) {
  const url = new URL('https://statistics-api.wildberries.ru/api/v1/supplier/sales');
  url.searchParams.set('dateFrom', dateFromParam);
  url.searchParams.set('flag', String(flag));

  const result = await fetchJson({
    label,
    url: url.toString(),
    headers: { Authorization: token },
  });

  const rows = Array.isArray(result.json) ? result.json : [];
  return {
    source: 'statistics.sales',
    label,
    request: { dateFrom: dateFromParam, flag },
    ok: result.ok,
    status: result.status,
    statusText: result.statusText,
    durationMs: result.durationMs,
    errorText: result.ok ? null : result.textPreview,
    rows: rows.length,
    keysUnion: rows.length ? Array.from(new Set(rows.slice(0, 5).flatMap((row) => Object.keys(row || {})))).sort() : [],
    sums: {
      totalPrice: round2(rows.reduce((sum, row) => sum + toNumber(row.totalPrice), 0)),
      priceWithDisc: round2(rows.reduce((sum, row) => sum + toNumber(row.priceWithDisc), 0)),
      finishedPrice: round2(rows.reduce((sum, row) => sum + toNumber(row.finishedPrice), 0)),
      forPay: round2(rows.reduce((sum, row) => sum + toNumber(row.forPay), 0)),
    },
    sample: rows.slice(0, MAX_SAMPLE_ROWS).map((row) => ({
      date: row.date,
      saleID: row.saleID,
      supplierArticle: row.supplierArticle,
      nmId: row.nmId,
      totalPrice: row.totalPrice,
      priceWithDisc: row.priceWithDisc,
      finishedPrice: row.finishedPrice,
      forPay: row.forPay,
      keys: Object.keys(row || {}).sort(),
    })),
  };
}

async function probeFinanceReportsList({ token, label, dateFrom, dateTo, period }) {
  const result = await fetchJson({
    label,
    method: 'POST',
    url: 'https://finance-api.wildberries.ru/api/finance/v1/sales-reports/list',
    headers: {
      Authorization: token,
      'Content-Type': 'application/json',
    },
    body: {
      dateFrom,
      dateTo,
      limit: 100,
      offset: 0,
      period,
    },
  });

  const rows = Array.isArray(result.json) ? result.json : [];
  return {
    source: 'finance.salesReports.list',
    label,
    request: { dateFrom, dateTo, period, limit: 100, offset: 0 },
    ok: result.ok,
    status: result.status,
    statusText: result.statusText,
    durationMs: result.durationMs,
    errorText: result.ok ? null : result.textPreview,
    rows: rows.length,
    reports: rows.map((row) => ({
      reportId: row.reportId,
      dateFrom: row.dateFrom,
      dateTo: row.dateTo,
      reportType: row.reportType,
      retailAmountSum: toNumber(row.retailAmountSum),
      forPaySum: toNumber(row.forPaySum),
      deliveryServiceSum: toNumber(row.deliveryServiceSum),
      paidStorageSum: toNumber(row.paidStorageSum),
      paidAcceptanceSum: toNumber(row.paidAcceptanceSum),
      deductionSum: toNumber(row.deductionSum),
      penaltySum: toNumber(row.penaltySum),
      bankPaymentSum: toNumber(row.bankPaymentSum),
    })),
  };
}

async function probeFinanceDetailedReport({ token, reportId, dateFrom, dateTo }) {
  const result = await fetchJson({
    label: `finance detailed report ${reportId}`,
    method: 'POST',
    url: `https://finance-api.wildberries.ru/api/finance/v1/sales-reports/detailed/${reportId}`,
    headers: {
      Authorization: token,
      'Content-Type': 'application/json',
    },
    body: {
      limit: DETAIL_LIMIT,
      rrdId: 0,
    },
  });

  const rows = Array.isArray(result.json) ? result.json : [];
  return {
    source: 'finance.salesReports.detailed',
    label: `finance detailed report ${reportId}`,
    request: { reportId, dateFrom, dateTo, limit: DETAIL_LIMIT, rrdId: 0 },
    ok: result.ok,
    status: result.status,
    statusText: result.statusText,
    durationMs: result.durationMs,
    errorText: result.ok ? null : result.textPreview,
    rowSummary: summarizeRows(rows),
  };
}

async function runDbAudit() {
  const dateToExclusive = addDaysIso(DATE_TO, 1);
  const companies = await pool.query(
    `
      SELECT c."id", c."name", c."isActive", api."marketplace", api."isEnabled", api."status", api."lastSyncAt", api."lastAttemptAt", api."lastError", api."wbToken"
      FROM "Company" c
      LEFT JOIN "MarketplaceApiConnection" api ON api."companyId" = c."id" AND api."marketplace" = 'WB'
      WHERE c."name" = ANY($1)
      ORDER BY c."name"
    `,
    [COMPANIES]
  );

  const sales = await pool.query(
    `
      SELECT
        "companyName",
        to_char("saleDate", 'YYYY-MM-DD') AS "saleDay",
        "reportNumber",
        "paymentReason",
        "documentType",
        COUNT(*)::int AS "rows",
        SUM(COALESCE("quantity", 0))::float AS "quantity",
        SUM(COALESCE("wbRealizedAmount", 0))::float AS "wbRealizedAmount",
        SUM(COALESCE("sellerPayout", 0))::float AS "sellerPayout",
        SUM(COALESCE("wbReward", 0))::float AS "wbReward",
        SUM(COALESCE("logisticsCost", 0))::float AS "logisticsCost",
        SUM(COALESCE("storageCost", 0))::float AS "storageCost",
        SUM(COALESCE("acceptanceCost", 0))::float AS "acceptanceCost",
        SUM(COALESCE("deductions", 0))::float AS "deductions",
        SUM(COALESCE("penaltiesAmount", 0))::float AS "penaltiesAmount",
        SUM(COALESCE("paymentServiceCost", 0))::float AS "paymentServiceCost",
        MIN("createdAt") AS "firstCreatedAt",
        MAX("createdAt") AS "lastCreatedAt"
      FROM "WbSale"
      WHERE "companyName" = ANY($1)
        AND "saleDate" >= $2::date
        AND "saleDate" < $3::date
      GROUP BY "companyName", to_char("saleDate", 'YYYY-MM-DD'), "reportNumber", "paymentReason", "documentType"
      ORDER BY "companyName", "saleDay", "reportNumber", "paymentReason", "documentType"
    `,
    [COMPANIES, DATE_FROM, dateToExclusive]
  );

  const imports = await pool.query(
    `
      SELECT "id", "companyName", "reportType", "marketplace", "fileName", "rowsCount", "status", "createdAt"
      FROM "ImportSession"
      WHERE "companyName" = ANY($1)
        AND "marketplace" = 'WILDBERRIES'
        AND "createdAt" >= ($2::date - interval '14 days')
      ORDER BY "createdAt" DESC
      LIMIT 80
    `,
    [COMPANIES, DATE_FROM]
  );

  return {
    companies: companies.rows.map((row) => ({
      id: row.id,
      name: row.name,
      isActive: row.isActive,
      isEnabled: row.isEnabled,
      status: row.status,
      lastSyncAt: row.lastSyncAt,
      lastAttemptAt: row.lastAttemptAt,
      lastError: row.lastError,
      token: maskToken(row.wbToken),
      hasToken: Boolean(row.wbToken),
    })),
    wbSaleGrouped: sales.rows.map((row) => ({
      ...row,
      wbRealizedAmount: round2(row.wbRealizedAmount),
      sellerPayout: round2(row.sellerPayout),
      wbReward: round2(row.wbReward),
      logisticsCost: round2(row.logisticsCost),
      storageCost: round2(row.storageCost),
      acceptanceCost: round2(row.acceptanceCost),
      deductions: round2(row.deductions),
      penaltiesAmount: round2(row.penaltiesAmount),
      paymentServiceCost: round2(row.paymentServiceCost),
    })),
    recentImports: imports.rows,
    tokenRows: companies.rows,
  };
}

function getPeriods() {
  const previousWeekFrom = subDaysIso(DATE_FROM, 7);
  const dateToPlusOne = addDaysIso(DATE_TO, 1);
  return [
    {
      name: 'target exact dateTo date-only',
      dateFromParam: DATE_TO,
      dateToParam: DATE_TO,
      financeDateFrom: DATE_TO,
      financeDateTo: DATE_TO,
    },
    {
      name: 'target dateTo datetime',
      dateFromParam: `${DATE_TO}T00:00:00`,
      dateToParam: `${DATE_TO}T23:59:59`,
      financeDateFrom: DATE_TO,
      financeDateTo: DATE_TO,
    },
    {
      name: 'target dateTo plus-one boundary',
      dateFromParam: `${DATE_TO}T00:00:00`,
      dateToParam: `${dateToPlusOne}T00:00:00`,
      financeDateFrom: DATE_TO,
      financeDateTo: dateToPlusOne,
    },
    {
      name: 'full selected range datetime',
      dateFromParam: `${DATE_FROM}T00:00:00`,
      dateToParam: `${DATE_TO}T23:59:59`,
      financeDateFrom: DATE_FROM,
      financeDateTo: DATE_TO,
    },
    {
      name: 'month-to-date datetime',
      dateFromParam: `${DATE_TO.slice(0, 8)}01T00:00:00`,
      dateToParam: `${DATE_TO}T23:59:59`,
      financeDateFrom: `${DATE_TO.slice(0, 8)}01`,
      financeDateTo: DATE_TO,
    },
    {
      name: 'previous 7 days control datetime',
      dateFromParam: `${previousWeekFrom}T00:00:00`,
      dateToParam: `${DATE_TO}T23:59:59`,
      financeDateFrom: previousWeekFrom,
      financeDateTo: DATE_TO,
    },
  ];
}

async function runApiProbeForCompany(companyRow) {
  const token = companyRow.wbToken;
  const companyName = companyRow.name;
  const result = {
    companyName,
    hasToken: Boolean(token),
    token: maskToken(token),
    tests: [],
  };

  if (!token) {
    result.tests.push({ ok: false, error: 'WB token missing' });
    return result;
  }

  const periods = getPeriods();

  // Контроль: что отдаёт ежедневный sales endpoint. Он обычно НЕ содержит финальные расходы,
  // но нужен, чтобы сравнить строки с текущей daily-загрузкой.
  for (const flag of [1, 0]) {
    result.tests.push(await probeStatisticsSales({ token, flag, dateFromParam: DATE_TO, label: `sales dateTo flag=${flag}` }));
    await sleep(REQUEST_DELAY_MS);
  }

  // Главное: проверить reportDetailByPeriod разными вариантами периода и rrdid.
  for (const period of periods) {
    result.tests.push(await probeStatisticsReportDetail({
      token,
      label: `${period.name} rrdid`,
      dateFromParam: period.dateFromParam,
      dateToParam: period.dateToParam,
      rrdParamName: 'rrdid',
      includeRrd: true,
    }));
    await sleep(REQUEST_DELAY_MS);
  }

  // Отдельно проверяем, не была ли проблема в имени параметра rrdId или в самом наличии rrdid.
  result.tests.push(await probeStatisticsReportDetail({
    token,
    label: 'full selected range camel rrdId',
    dateFromParam: `${DATE_FROM}T00:00:00`,
    dateToParam: `${DATE_TO}T23:59:59`,
    rrdParamName: 'rrdId',
    includeRrd: true,
  }));
  await sleep(REQUEST_DELAY_MS);

  result.tests.push(await probeStatisticsReportDetail({
    token,
    label: 'full selected range no rrd param',
    dateFromParam: `${DATE_FROM}T00:00:00`,
    dateToParam: `${DATE_TO}T23:59:59`,
    includeRrd: false,
  }));
  await sleep(REQUEST_DELAY_MS);

  // Новый Finance API: ищем сформированные отчёты и, если есть reportId, читаем детальные строки.
  const financeListResults = [];
  for (const period of [
    { name: 'selected weekly', dateFrom: DATE_FROM, dateTo: DATE_TO, period: 'weekly' },
    { name: 'month-to-date weekly', dateFrom: `${DATE_TO.slice(0, 8)}01`, dateTo: DATE_TO, period: 'weekly' },
    { name: 'previous 14 days weekly', dateFrom: subDaysIso(DATE_TO, 14), dateTo: DATE_TO, period: 'weekly' },
    { name: 'selected daily probe', dateFrom: DATE_FROM, dateTo: DATE_TO, period: 'daily' },
  ]) {
    const probe = await probeFinanceReportsList({ token, label: period.name, ...period });
    financeListResults.push(probe);
    result.tests.push(probe);
    await sleep(REQUEST_DELAY_MS);
  }

  const reportIds = [];
  for (const financeResult of financeListResults) {
    if (!financeResult.ok) continue;
    for (const report of financeResult.reports || []) {
      const reportId = report.reportId ? String(report.reportId) : '';
      if (!reportId || reportIds.some((item) => item.reportId === reportId)) continue;
      reportIds.push({ reportId, dateFrom: report.dateFrom, dateTo: report.dateTo });
    }
  }

  for (const report of reportIds.slice(0, 4)) {
    result.tests.push(await probeFinanceDetailedReport({ token, ...report }));
    await sleep(REQUEST_DELAY_MS);
  }

  return result;
}

function buildFindings(dbAudit, apiResults) {
  const findings = [];

  for (const row of dbAudit.wbSaleGrouped) {
    const reportNumber = String(row.reportNumber || '');
    const isDaily = reportNumber.startsWith('WB_DAILY_STATISTICS_');
    const costsTotal = Math.abs(Number(row.wbReward || 0)) + Math.abs(Number(row.logisticsCost || 0)) + Math.abs(Number(row.storageCost || 0)) + Math.abs(Number(row.acceptanceCost || 0)) + Math.abs(Number(row.deductions || 0)) + Math.abs(Number(row.penaltiesAmount || 0));
    if (isDaily && costsTotal === 0 && Number(row.rows || 0) > 0) {
      findings.push({
        severity: 'HIGH',
        code: 'DAILY_WB_ROWS_HAVE_ZERO_COSTS',
        companyName: row.companyName,
        saleDay: row.saleDay,
        reportNumber: row.reportNumber,
        paymentReason: row.paymentReason,
        rows: row.rows,
        message: 'В базе есть оперативные WB строки, но расходы по ним сохранены нулями. Нельзя показывать эти нули как финальную прибыль.',
      });
    }
  }

  for (const companyResult of apiResults) {
    const detailTests = companyResult.tests.filter((test) => test.source === 'statistics.reportDetailByPeriod' || test.source === 'finance.salesReports.detailed');
    const nonEmpty = detailTests.filter((test) => Number(test.rowSummary?.rows || 0) > 0);
    const nonZeroCost = nonEmpty.filter((test) => {
      const sums = test.rowSummary?.sums || {};
      return ['commissionWithoutVat', 'commissionVat', 'logistics', 'storage', 'acceptance', 'deduction', 'penalty'].some((key) => Math.abs(Number(sums[key] || 0)) > 0);
    });

    findings.push({
      severity: nonZeroCost.length > 0 ? 'INFO' : 'HIGH',
      code: nonZeroCost.length > 0 ? 'API_DETAIL_SOURCE_FOUND' : 'NO_DETAIL_COST_SOURCE_FOUND_IN_PROBE',
      companyName: companyResult.companyName,
      nonEmptyDetailTests: nonEmpty.map((test) => ({ source: test.source, label: test.label, rows: test.rowSummary?.rows, sums: test.rowSummary?.sums })),
      nonZeroCostTests: nonZeroCost.map((test) => ({ source: test.source, label: test.label, rows: test.rowSummary?.rows, sums: test.rowSummary?.sums })),
      message: nonZeroCost.length > 0
        ? 'Найден API-источник, который отдаёт строки с расходами. Нужно использовать его для загрузки/пересчёта.'
        : 'В рамках проверенных вариантов API не найден источник с расходами за период. Нужно сравнить с методом сторонней аналитики или запросить другой endpoint/права.',
    });
  }

  return findings;
}

async function main() {
  const startedAt = new Date();
  const dbAudit = await runDbAudit();
  const apiResults = [];

  for (const companyRow of dbAudit.tokenRows) {
    apiResults.push(await runApiProbeForCompany(companyRow));
  }

  const safeDbAudit = {
    ...dbAudit,
    tokenRows: undefined,
  };

  const output = {
    ok: true,
    probe: 'WB financial detail sources',
    executedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    config: {
      dateFrom: DATE_FROM,
      dateTo: DATE_TO,
      companies: COMPANIES,
      requestDelayMs: REQUEST_DELAY_MS,
      detailLimit: DETAIL_LIMIT,
      includeRawSamples: INCLUDE_RAW_SAMPLES,
      maxSampleRows: MAX_SAMPLE_ROWS,
    },
    dbAudit: safeDbAudit,
    apiResults,
    findings: buildFindings(safeDbAudit, apiResults),
    nextDecisionGuide: {
      ifApiDetailSourceFound: 'Брать source/label из findings.API_DETAIL_SOURCE_FOUND и делать загрузчик, который сохраняет эти строки в WbSale с расходами.',
      ifOnlyFinanceWeeklyFound: 'Для вчерашнего дня официальный финальный WB-отчёт ещё недоступен; нужна честная предварительная модель без нулей и автозамена после появления отчёта.',
      ifNoSourceFound: 'Нужно проверить права токена WB и метод, которым пользуется сторонняя аналитика. Нули в UI всё равно нельзя считать финальными.',
    },
  };

  console.log(JSON.stringify(output, null, 2));
}

main()
  .catch((error) => {
    console.log(JSON.stringify({
      ok: false,
      probe: 'WB financial detail sources',
      executedAt: new Date().toISOString(),
      error: error && (error.stack || error.message || String(error)),
    }, null, 2));
    process.exit(1);
  })
  .finally(async () => {
    await pool.end().catch(() => undefined);
  });
