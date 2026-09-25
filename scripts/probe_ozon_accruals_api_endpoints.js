const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const DATE_FROM = process.env.DATE_FROM || '2026-06-01';
const DATE_TO = process.env.DATE_TO || '2026-06-30';
const COMPANY_NAMES = (process.env.COMPANY_NAMES || 'ИП Петров,ИП Лебедева')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const PROBE_CREATE_REPORTS = process.env.PROBE_CREATE_REPORTS === '1';
const API_SLEEP_MS = Number(process.env.API_SLEEP_MS || 400);
const MAX_TRANSACTION_PAGES = Number(process.env.MAX_TRANSACTION_PAGES || 100);
const REPORT_POLL_ATTEMPTS = Number(process.env.REPORT_POLL_ATTEMPTS || 8);
const REPORT_POLL_SLEEP_MS = Number(process.env.REPORT_POLL_SLEEP_MS || 2500);

const KEYWORDS = [
  'баллы', 'балл', 'скидк', 'выручк', 'возврат выручки', 'программы парт', 'партнер', 'партнёр',
  'discount', 'point', 'points', 'accrual', 'revenue', 'partner'
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function money(value) {
  const n = Number(value || 0);
  return n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₽';
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function safeSnippet(value, max = 2200) {
  let text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  text = String(text || '');
  text = text.replace(/https?:\/\/[^\s"']+/g, '[URL_REDACTED]');
  return text.length > max ? text.slice(0, max) + '\n...[TRUNCATED]' : text;
}

function containsKeyword(value) {
  const text = JSON.stringify(value || '').toLowerCase();
  return KEYWORDS.some((kw) => text.includes(kw.toLowerCase()));
}

function keywordHits(value) {
  const text = JSON.stringify(value || '').toLowerCase();
  return KEYWORDS.filter((kw) => text.includes(kw.toLowerCase()));
}

async function ozonRequest(connection, path, body) {
  const response = await fetch(`https://api-seller.ozon.ru${path}`, {
    method: 'POST',
    headers: {
      'Client-Id': connection.ozonClientId,
      'Api-Key': connection.ozonApiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body || {}),
  });

  const rawText = await response.text();
  let json = null;
  try {
    json = rawText ? JSON.parse(rawText) : null;
  } catch {}

  return {
    status: response.status,
    ok: response.ok,
    contentType: response.headers.get('content-type'),
    rawText,
    json,
  };
}

async function fetchTransactionsAndCheck(connection) {
  console.log('\nTransaction API check: /v3/finance/transaction/list');

  let page = 1;
  let pageCount = 1;
  let scanned = 0;
  let exactImportantRows = [];
  const typeStats = new Map();

  while (page <= pageCount && page <= MAX_TRANSACTION_PAGES) {
    const result = await ozonRequest(connection, '/v3/finance/transaction/list', {
      filter: {
        date: {
          from: `${DATE_FROM}T00:00:00.000Z`,
          to: `${DATE_TO}T23:59:59.999Z`,
        },
        operation_type: [],
        posting_number: '',
        transaction_type: 'all',
      },
      page,
      page_size: 1000,
    });

    if (!result.ok) {
      console.log(`  ERROR page=${page}, status=${result.status}`);
      console.log(safeSnippet(result.json || result.rawText, 1200));
      return;
    }

    const operations = result.json?.result?.operations || [];
    pageCount = Number(result.json?.result?.page_count || pageCount || 1);
    scanned += operations.length;

    for (const op of operations) {
      const operationTypeName = String(op.operation_type_name || '');
      const operationType = String(op.operation_type || '');
      const key = operationTypeName || operationType || 'UNKNOWN';
      const amount = toNumber(op.amount);
      const accrualsForSale = toNumber(op.accruals_for_sale);
      const saleCommission = toNumber(op.sale_commission);
      const prev = typeStats.get(key) || { rows: 0, amount: 0, accrualsForSale: 0, saleCommission: 0, operationType };
      prev.rows += 1;
      prev.amount += amount;
      prev.accrualsForSale += accrualsForSale;
      prev.saleCommission += saleCommission;
      typeStats.set(key, prev);

      const lower = JSON.stringify(op).toLowerCase();
      if (
        lower.includes('баллы за скидки') ||
        lower.includes('выручка') ||
        lower.includes('возврат выручки') ||
        lower.includes('программы парт') ||
        lower.includes('discount points') ||
        lower.includes('partner program')
      ) {
        exactImportantRows.push(op);
      }
    }

    console.log(`  page=${page}/${pageCount}, operations=${operations.length}, scanned=${scanned}, exactImportantRows=${exactImportantRows.length}`);
    page += 1;
    await sleep(API_SLEEP_MS);
  }

  console.log(`  Transaction scan finished. scanned=${scanned}`);
  console.log('  Exact rows for Баллы/Выручка/Программы партнёров found:', exactImportantRows.length);
  if (exactImportantRows.length > 0) {
    console.log('  Examples:');
    for (const row of exactImportantRows.slice(0, 8)) console.log(safeSnippet(row, 1200));
  }

  const keywordStats = [...typeStats.entries()]
    .filter(([name, stat]) => containsKeyword({ name, ...stat }))
    .sort((a, b) => Math.abs(b[1].amount) - Math.abs(a[1].amount));

  console.log('  Operation type stats with broad keywords:');
  for (const [name, stat] of keywordStats.slice(0, 20)) {
    console.log({
      operationTypeName: name,
      operationType: stat.operationType,
      rows: stat.rows,
      amount: money(stat.amount),
      accrualsForSale: money(stat.accrualsForSale),
      saleCommission: money(stat.saleCommission),
    });
  }
}

async function safeProbeNonCreatingEndpoints(connection) {
  console.log('\nSafe non-creating endpoint probe');

  const candidates = [
    {
      label: 'finance transaction totals',
      path: '/v3/finance/transaction/totals',
      body: {
        date: { from: `${DATE_FROM}T00:00:00.000Z`, to: `${DATE_TO}T23:59:59.999Z` },
        transaction_type: 'all',
      },
    },
    {
      label: 'finance cash flow statement list',
      path: '/v1/finance/cash-flow-statement/list',
      body: {
        date: { from: `${DATE_FROM}T00:00:00.000Z`, to: `${DATE_TO}T23:59:59.999Z` },
        page: 1,
        page_size: 1000,
      },
    },
    {
      label: 'finance realization v2 month/year',
      path: '/v2/finance/realization',
      body: {
        month: Number(DATE_FROM.slice(5, 7)),
        year: Number(DATE_FROM.slice(0, 4)),
      },
    },
    {
      label: 'finance realization v1 month/year',
      path: '/v1/finance/realization',
      body: {
        month: Number(DATE_FROM.slice(5, 7)),
        year: Number(DATE_FROM.slice(0, 4)),
      },
    },
    {
      label: 'report list',
      path: '/v1/report/list',
      body: {
        filter: {},
        page: 1,
        page_size: 100,
      },
    },
  ];

  for (const candidate of candidates) {
    await sleep(API_SLEEP_MS);
    const result = await ozonRequest(connection, candidate.path, candidate.body);
    console.log(`\n  ${candidate.label}: ${candidate.path}`);
    console.log(`  status=${result.status}, ok=${result.ok}, contentType=${result.contentType}`);
    console.log(`  keywordHits=${keywordHits(result.json || result.rawText).join(', ') || 'none'}`);
    console.log(safeSnippet(result.json || result.rawText, 1800));
  }
}

async function pollReportInfo(connection, code) {
  for (let attempt = 1; attempt <= REPORT_POLL_ATTEMPTS; attempt += 1) {
    await sleep(REPORT_POLL_SLEEP_MS);
    const info = await ozonRequest(connection, '/v1/report/info', { code });
    console.log(`    report/info attempt=${attempt}, status=${info.status}, ok=${info.ok}, keywordHits=${keywordHits(info.json || info.rawText).join(', ') || 'none'}`);
    console.log(safeSnippet(info.json || info.rawText, 1400));

    const text = JSON.stringify(info.json || info.rawText || '').toLowerCase();
    if (text.includes('success') || text.includes('url') || text.includes('file')) break;
  }
}

async function probeCreateReportEndpoints(connection) {
  console.log('\nCreating report endpoint probe');
  console.log('This may create async reports inside Ozon, but does not change our database.');

  const dateBodies = [
    { date_from: DATE_FROM, date_to: DATE_TO },
    { filter: { date_from: DATE_FROM, date_to: DATE_TO } },
    { filter: { date: { from: DATE_FROM, to: DATE_TO } } },
    { date: { from: `${DATE_FROM}T00:00:00.000Z`, to: `${DATE_TO}T23:59:59.999Z` } },
  ];

  const paths = [
    '/v1/report/finance/create',
    '/v1/report/finance/details/create',
    '/v1/report/accruals/create',
    '/v1/report/transactions/create',
    '/v1/report/finance/transactions/create',
    '/v1/report/finance/accruals/create',
    '/v1/report/economics/create',
    '/v1/report/accrual/create',
  ];

  for (const path of paths) {
    for (const body of dateBodies) {
      await sleep(API_SLEEP_MS);
      const result = await ozonRequest(connection, path, body);
      console.log(`\n  ${path}`);
      console.log(`  bodyShape=${Object.keys(body).join('+')}`);
      console.log(`  status=${result.status}, ok=${result.ok}, keywordHits=${keywordHits(result.json || result.rawText).join(', ') || 'none'}`);
      console.log(safeSnippet(result.json || result.rawText, 1200));

      const code = result.json?.result?.code || result.json?.code || result.json?.result?.report_code;
      if (result.ok && code) {
        console.log(`  Report code received: ${code}`);
        await pollReportInfo(connection, code);
      }
    }
  }
}

async function getConnections(client) {
  const result = await client.query(
    `
      SELECT
        c."name" AS "companyName",
        mac."ozonClientId",
        mac."ozonApiKey",
        mac."isEnabled",
        mac."status"
      FROM "MarketplaceApiConnection" mac
      JOIN "Company" c ON c."id" = mac."companyId"
      WHERE mac."marketplace" = 'OZON'
        AND c."name" = ANY($1::text[])
      ORDER BY c."name"
    `,
    [COMPANY_NAMES]
  );
  return result.rows.filter((row) => row.ozonClientId && row.ozonApiKey);
}

async function main() {
  console.log('OZON ACCRUALS API ENDPOINT PROBE');
  console.log(`Period: ${DATE_FROM} — ${DATE_TO}`);
  console.log(`Companies: ${COMPANY_NAMES.join(', ')}`);
  console.log(`PROBE_CREATE_REPORTS=${PROBE_CREATE_REPORTS}`);
  console.log('No AvoroFin database data will be changed.');

  const client = await pool.connect();
  try {
    const connections = await getConnections(client);
    console.log(`Connections found: ${connections.length}`);
    for (const c of connections) {
      console.log(`- ${c.companyName}: enabled=${c.isEnabled}, status=${c.status}, hasClientId=${Boolean(c.ozonClientId)}, hasApiKey=${Boolean(c.ozonApiKey)}`);
    }

    for (const connection of connections) {
      console.log('\n============================================================');
      console.log(`Company: ${connection.companyName}`);
      console.log('============================================================');
      await fetchTransactionsAndCheck(connection);
      await safeProbeNonCreatingEndpoints(connection);
      if (PROBE_CREATE_REPORTS) {
        await probeCreateReportEndpoints(connection);
      } else {
        console.log('\nCreating report endpoints skipped. Set PROBE_CREATE_REPORTS=1 to run them.');
      }
    }

    console.log('\nPROBE DONE. No AvoroFin database data was changed.');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error('OZON ACCRUALS API ENDPOINT PROBE FAILED');
  console.error(error);
  process.exit(1);
});
