/* eslint-disable no-console */
/**
 * Cost coverage audit.
 *
 * Safe diagnostic script:
 * - Reads DB via pg directly (no PrismaClient, so it works with Prisma 7 projects in temporary Node containers).
 * - Does not change any DB data.
 * - Checks sold WB/Ozon items for missing or zero ProductCost.
 */

const { Client } = require('pg');

function argValue(name, fallback) {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function toNumber(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const number = Number(String(value).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(number) ? number : 0;
}

function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function mustGetDatabaseUrl() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is missing');
  return url;
}

async function query(client, text, params = []) {
  const result = await client.query(text, params);
  return result.rows;
}

function buildCostLookups(costs) {
  const costByVendorCode = new Map();
  const costByNmId = new Map();

  for (const cost of costs) {
    const vendorCode = normalizeText(cost.vendorCode);
    const nmId = normalizeText(cost.nmId);
    const costPrice = toNumber(cost.costPrice);

    if (costPrice <= 0) continue;
    if (vendorCode && !costByVendorCode.has(vendorCode)) {
      costByVendorCode.set(vendorCode, costPrice);
    }
    if (nmId && !costByNmId.has(nmId)) {
      costByNmId.set(nmId, costPrice);
    }
  }

  return { costByVendorCode, costByNmId };
}

function getOzonBaseArticle(value) {
  const vendorCode = cleanText(value);
  if (!vendorCode) return '';
  return cleanText(vendorCode.split('-')[0]);
}

function buildWbSupplierArticleByNmId(cards) {
  const result = new Map();

  for (const card of cards) {
    const nmId = normalizeText(card.nmId);
    const vendorCode = normalizeText(card.vendorCode);

    if (!nmId || !vendorCode || result.has(nmId)) continue;
    result.set(nmId, vendorCode);
  }

  return result;
}

function buildOzonVendorCodeBySku(products) {
  const result = new Map();

  for (const product of products) {
    const sku = normalizeText(product.sku);
    const vendorCode = normalizeText(product.vendorCode);

    if (!sku || !vendorCode || result.has(sku)) continue;
    result.set(sku, vendorCode);
  }

  return result;
}

function uniquePush(map, item) {
  const key = [
    item.marketplace,
    item.companyName,
    normalizeText(item.vendorCode),
    normalizeText(item.externalId),
  ].join('|');

  const current = map.get(key);

  if (!current) {
    map.set(key, item);
    return;
  }

  current.quantity += item.quantity;
  current.amount += item.amount;
}

function money(value) {
  return new Intl.NumberFormat('ru-RU', {
    maximumFractionDigits: 0,
  }).format(toNumber(value)) + ' ₽';
}

async function main() {
  const dateFromText = argValue('dateFrom', process.env.DATE_FROM || null);
  const dateToText = argValue('dateTo', process.env.DATE_TO || null);
  const companyName = argValue('companyName', process.env.COMPANY_NAME || 'ALL');

  if (!dateFromText || !dateToText) {
    throw new Error('Use --dateFrom=YYYY-MM-DD --dateTo=YYYY-MM-DD [--companyName=ALL|ИП Петров]');
  }

  const dateFrom = `${dateFromText}T00:00:00.000Z`;
  const dateToExclusive = `${addDays(dateToText, 1)}T00:00:00.000Z`;

  const client = new Client({ connectionString: mustGetDatabaseUrl() });
  await client.connect();

  try {
    console.log('[cost-coverage] start', { dateFrom: dateFromText, dateTo: dateToText, companyName });

    const [costs, wbProductCards, ozonProducts, wbRows, ozonRows] = await Promise.all([
      query(
        client,
        `
          SELECT "vendorCode", "nmId", "costPrice"
          FROM "ProductCost"
          ORDER BY "costDate" DESC NULLS LAST, "createdAt" DESC
        `
      ),
      query(
        client,
        `
          SELECT "nmId", "vendorCode"
          FROM "WbProductCard"
          WHERE ($1::text = 'ALL' OR "companyName" = $1::text)
        `,
        [companyName]
      ),
      query(
        client,
        `
          SELECT "sku", "vendorCode"
          FROM "OzonProduct"
          WHERE ($1::text = 'ALL' OR "companyName" = $1::text)
        `,
        [companyName]
      ),
      query(
        client,
        `
          SELECT
            COALESCE("companyName", '') AS "companyName",
            COALESCE("vendorCode", '') AS "vendorCode",
            COALESCE("nmId", '') AS "nmId",
            COALESCE("productName", '') AS "productName",
            SUM(COALESCE("quantity", 0)) AS "quantity",
            SUM(COALESCE("wbRealizedAmount", 0)) AS "wbRealizedAmount",
            SUM(COALESCE("sellerPayout", 0)) AS "sellerPayout"
          FROM "WbSale"
          WHERE "saleDate" >= $1::timestamptz
            AND "saleDate" < $2::timestamptz
            AND ($3::text = 'ALL' OR "companyName" = $3::text)
          GROUP BY "companyName", "vendorCode", "nmId", "productName"
        `,
        [dateFrom, dateToExclusive, companyName]
      ),
      query(
        client,
        `
          SELECT
            COALESCE("companyName", '') AS "companyName",
            COALESCE("vendorCode", '') AS "vendorCode",
            COALESCE("sku", '') AS "sku",
            SUM(COALESCE("quantity", 0)) AS "quantity",
            SUM(COALESCE("salesAmount", 0)) AS "salesAmount",
            SUM(COALESCE("totalAmount", 0)) AS "totalAmount"
          FROM "OzonFinance"
          WHERE "accrualDate" >= $1::timestamptz
            AND "accrualDate" < $2::timestamptz
            AND ($3::text = 'ALL' OR "companyName" = $3::text)
          GROUP BY "companyName", "vendorCode", "sku"
        `,
        [dateFrom, dateToExclusive, companyName]
      ),
    ]);

    const { costByVendorCode, costByNmId } = buildCostLookups(costs);
    const wbSupplierArticleByNmId = buildWbSupplierArticleByNmId(wbProductCards);
    const ozonVendorCodeBySku = buildOzonVendorCodeBySku(ozonProducts);
    const missing = new Map();
    let checked = 0;

    function hasWbCost(row) {
      const vendorCode = normalizeText(row.vendorCode);
      const nmId = normalizeText(row.nmId);

      if (vendorCode && costByVendorCode.has(vendorCode)) return true;
      if (nmId && costByNmId.has(nmId)) return true;

      const supplierArticle = nmId ? wbSupplierArticleByNmId.get(nmId) || '' : '';
      return Boolean(supplierArticle && costByVendorCode.has(supplierArticle));
    }

    function hasOzonCost(row) {
      const sku = normalizeText(row.sku);
      const directVendorCode = normalizeText(row.vendorCode);
      const mappedVendorCode = sku ? ozonVendorCodeBySku.get(sku) || '' : '';
      const vendorCode = directVendorCode || mappedVendorCode || sku;

      if (!vendorCode) return false;
      if (costByVendorCode.has(vendorCode) || costByNmId.has(vendorCode)) return true;

      const baseArticle = normalizeText(getOzonBaseArticle(vendorCode));
      if (!baseArticle) return false;
      if (costByVendorCode.has(baseArticle) || costByNmId.has(baseArticle)) return true;

      const supplierArticle = wbSupplierArticleByNmId.get(baseArticle) || '';
      return Boolean(supplierArticle && costByVendorCode.has(supplierArticle));
    }

    for (const row of wbRows) {
      const vendorCode = cleanText(row.vendorCode);
      const nmId = cleanText(row.nmId);
      const quantity = Math.abs(toNumber(row.quantity));
      const amount = Math.abs(toNumber(row.wbRealizedAmount) || toNumber(row.sellerPayout));

      if (!vendorCode && !nmId) continue;
      if (quantity <= 0 && amount <= 0) continue;

      checked += 1;

      if (hasWbCost({ vendorCode, nmId })) continue;

      uniquePush(missing, {
        marketplace: 'WB',
        companyName: cleanText(row.companyName) || 'Без компании',
        vendorCode: vendorCode || '—',
        externalId: nmId || '—',
        productName: cleanText(row.productName) || vendorCode || nmId || 'Без названия',
        quantity,
        amount,
      });
    }

    for (const row of ozonRows) {
      const vendorCode = cleanText(row.vendorCode);
      const sku = cleanText(row.sku);
      const quantity = Math.abs(toNumber(row.quantity));
      const amount = Math.abs(toNumber(row.salesAmount) || toNumber(row.totalAmount));

      if (!vendorCode && !sku) continue;
      if (quantity <= 0 && amount <= 0) continue;

      checked += 1;

      if (hasOzonCost({ vendorCode, sku })) continue;

      uniquePush(missing, {
        marketplace: 'OZON',
        companyName: cleanText(row.companyName) || 'Без компании',
        vendorCode: vendorCode || '—',
        externalId: sku || '—',
        productName: vendorCode || sku || 'Без названия',
        quantity,
        amount,
      });
    }

    const missingItems = Array.from(missing.values()).sort((a, b) => (b.amount - a.amount) || (b.quantity - a.quantity));
    const wbMissing = missingItems.filter((item) => item.marketplace === 'WB').length;
    const ozonMissing = missingItems.filter((item) => item.marketplace === 'OZON').length;
    const quantity = missingItems.reduce((sum, item) => sum + item.quantity, 0);
    const amount = missingItems.reduce((sum, item) => sum + item.amount, 0);

    console.log('[cost-coverage] checked unique items:', checked);
    console.log('[cost-coverage] missing unique items:', missingItems.length);
    console.log('[cost-coverage] missing WB:', wbMissing);
    console.log('[cost-coverage] missing Ozon:', ozonMissing);
    console.log('[cost-coverage] missing quantity:', Math.round(quantity));
    console.log('[cost-coverage] missing turnover:', money(amount));

    if (missingItems.length > 0) {
      console.log('[cost-coverage] ATTENTION: missing cost price for sold items. Profit can be overstated.');
      console.log('[cost-coverage] top missing items:');

      for (const item of missingItems.slice(0, 50)) {
        console.log(
          `${item.marketplace}\t${item.companyName}\t${item.vendorCode}\t${item.externalId}\tqty=${Math.round(item.quantity)}\tamount=${Math.round(item.amount)}\t${item.productName}`
        );
      }
    } else {
      console.log('[cost-coverage] OK: cost price exists for all checked sold items');
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('[cost-coverage] fatal');
  console.error(error);
  process.exit(1);
});
