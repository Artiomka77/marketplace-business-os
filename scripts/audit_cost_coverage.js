/* eslint-disable no-console */
/**
 * Cost coverage audit v7.2.
 *
 * Safe diagnostic script:
 * - Reads DB via pg directly (no PrismaClient, so it works with Prisma 7 projects in temporary Node containers).
 * - Does not change any DB data.
 * - Checks sold WB/Ozon items for missing or zero ProductCost.
 * - Separates technical WB zero-turnover rows from real missing cost.
 * - Separates Ozon SKU mapping problems from true missing ProductCost.
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
    .replace(/[–—−]/g, '-')
    .replace(/\s*-\s*/g, '-')
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

function getBaseArticle(value) {
  const text = cleanText(value);
  if (!text) return '';
  return cleanText(text.split('-')[0]);
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

function buildOzonProductLookup(products) {
  const normalizedVendorCodeBySku = new Map();
  const displayVendorCodeBySku = new Map();

  for (const product of products) {
    const sku = normalizeText(product.sku);
    const normalizedVendorCode = normalizeText(product.vendorCode);
    const displayVendorCode = cleanText(product.vendorCode);

    if (!sku || !normalizedVendorCode || normalizedVendorCodeBySku.has(sku)) continue;
    normalizedVendorCodeBySku.set(sku, normalizedVendorCode);
    displayVendorCodeBySku.set(sku, displayVendorCode || normalizedVendorCode);
  }

  return { normalizedVendorCodeBySku, displayVendorCodeBySku };
}

function uniquePush(map, item) {
  const key = [
    item.marketplace,
    item.companyName,
    item.issueType || 'MISSING_COST',
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

function printItems(title, items, limit = 50) {
  if (items.length === 0) return;

  console.log(title);
  for (const item of items.slice(0, limit)) {
    console.log(
      `${item.marketplace}\t${item.companyName}\t${item.vendorCode}\t${item.externalId}\tqty=${Math.round(item.quantity)}\tamount=${Math.round(item.amount)}\t${item.issueType || ''}\t${item.productName}`
    );
  }
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

    const costs = await query(
      client,
      `
        SELECT "vendorCode", "nmId", "costPrice"
        FROM "ProductCost"
        ORDER BY "costDate" DESC NULLS LAST, "createdAt" DESC
      `
    );

    const wbProductCards = await query(
      client,
      `
        SELECT "nmId", "vendorCode"
        FROM "WbProductCard"
        WHERE ($1::text = 'ALL' OR "companyName" = $1::text)
      `,
      [companyName]
    );

    const ozonProducts = await query(
      client,
      `
        SELECT "sku", "vendorCode"
        FROM "OzonProduct"
        WHERE ($1::text = 'ALL' OR "companyName" = $1::text)
      `,
      [companyName]
    );

    const ozonStockMappings = await query(
      client,
      `
        SELECT "sku", "vendorCode"
        FROM "OzonStock"
        WHERE ($1::text = 'ALL' OR "companyName" = $1::text)
      `,
      [companyName]
    );

    const wbRows = await query(
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
    );

    const ozonRows = await query(
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
    );

    const { costByVendorCode, costByNmId } = buildCostLookups(costs);
    const wbSupplierArticleByNmId = buildWbSupplierArticleByNmId(wbProductCards);
    const ozonProductLookup = buildOzonProductLookup([...ozonProducts, ...ozonStockMappings]);
    const missing = new Map();
    const technicalWbRows = [];
    let checked = 0;

    function hasCostByAnyKey(keys) {
      for (const key of keys) {
        const normalizedKey = normalizeText(key);
        if (!normalizedKey) continue;

        if (costByVendorCode.has(normalizedKey) || costByNmId.has(normalizedKey)) return true;

        const baseArticle = normalizeText(getBaseArticle(normalizedKey));
        if (baseArticle && (costByVendorCode.has(baseArticle) || costByNmId.has(baseArticle))) return true;

        const supplierArticle = wbSupplierArticleByNmId.get(normalizedKey) || '';
        if (supplierArticle && costByVendorCode.has(supplierArticle)) return true;

        const supplierArticleByBase = baseArticle ? wbSupplierArticleByNmId.get(baseArticle) || '' : '';
        if (supplierArticleByBase && costByVendorCode.has(supplierArticleByBase)) return true;
      }

      return false;
    }

    function hasWbCost(row) {
      return hasCostByAnyKey([row.vendorCode, row.nmId]);
    }

    function resolveOzon(row) {
      const sku = normalizeText(row.sku);
      const directVendorCode = normalizeText(row.vendorCode);
      const mappedVendorCode = sku ? ozonProductLookup.normalizedVendorCodeBySku.get(sku) || '' : '';
      const mappedDisplayVendorCode = sku ? ozonProductLookup.displayVendorCodeBySku.get(sku) || '' : '';
      const hasProductMapping = Boolean(directVendorCode || mappedVendorCode);
      const resolvedVendorCode = directVendorCode || mappedVendorCode || sku;
      const displayVendorCode = cleanText(row.vendorCode) || mappedDisplayVendorCode || cleanText(row.sku) || '—';

      const keys = [directVendorCode, mappedVendorCode, sku, getBaseArticle(resolvedVendorCode)];

      return {
        hasCost: hasCostByAnyKey(keys),
        hasProductMapping,
        resolvedVendorCode,
        displayVendorCode,
      };
    }

    for (const row of wbRows) {
      const vendorCode = cleanText(row.vendorCode);
      const nmId = cleanText(row.nmId);
      const quantity = Math.abs(toNumber(row.quantity));
      const amount = Math.abs(toNumber(row.wbRealizedAmount) || toNumber(row.sellerPayout));

      if (!vendorCode && !nmId) continue;
      if (quantity <= 0 && amount <= 0) continue;

      if (amount <= 0) {
        if (!hasWbCost({ vendorCode, nmId })) {
          technicalWbRows.push({
            marketplace: 'WB',
            companyName: cleanText(row.companyName) || 'Без компании',
            vendorCode: vendorCode || '—',
            externalId: nmId || '—',
            productName: cleanText(row.productName) || vendorCode || nmId || 'Без названия',
            quantity,
            amount,
            issueType: 'TECHNICAL_ZERO_TURNOVER',
          });
        }
        continue;
      }

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
        issueType: 'MISSING_COST',
      });
    }

    for (const row of ozonRows) {
      const vendorCode = cleanText(row.vendorCode);
      const sku = cleanText(row.sku);
      const quantity = Math.abs(toNumber(row.quantity));
      const salesAmount = Math.abs(toNumber(row.salesAmount));
      const totalAmount = Math.abs(toNumber(row.totalAmount));
      const amount = salesAmount || totalAmount;

      if (!vendorCode && !sku) continue;
      if (quantity <= 0 && salesAmount <= 0) continue;

      checked += 1;

      const resolved = resolveOzon({ vendorCode, sku });
      if (resolved.hasCost) continue;

      uniquePush(missing, {
        marketplace: 'OZON',
        companyName: cleanText(row.companyName) || 'Без компании',
        vendorCode: vendorCode || resolved.displayVendorCode || '—',
        externalId: sku || '—',
        productName: vendorCode || resolved.displayVendorCode || sku || 'Без названия',
        quantity,
        amount,
        issueType: resolved.hasProductMapping ? 'MISSING_COST' : 'MISSING_OZON_MAPPING',
      });
    }

    const missingItems = Array.from(missing.values()).sort((a, b) => (b.amount - a.amount) || (b.quantity - a.quantity));
    const missingCostItems = missingItems.filter((item) => item.issueType === 'MISSING_COST');
    const missingMappingItems = missingItems.filter((item) => item.issueType === 'MISSING_OZON_MAPPING');
    const wbMissing = missingItems.filter((item) => item.marketplace === 'WB').length;
    const ozonMissing = missingItems.filter((item) => item.marketplace === 'OZON').length;
    const missingQuantity = missingItems.reduce((sum, item) => sum + item.quantity, 0);
    const missingAmount = missingItems.reduce((sum, item) => sum + item.amount, 0);
    const technicalQuantity = technicalWbRows.reduce((sum, item) => sum + item.quantity, 0);

    console.log('[cost-coverage] checked unique sold items with turnover:', checked);
    console.log('[cost-coverage] missing cost/mapping unique items:', missingItems.length);
    console.log('[cost-coverage] missing real cost items:', missingCostItems.length);
    console.log('[cost-coverage] missing Ozon mapping/cost items:', missingMappingItems.length);
    console.log('[cost-coverage] missing WB:', wbMissing);
    console.log('[cost-coverage] missing Ozon:', ozonMissing);
    console.log('[cost-coverage] missing quantity:', Math.round(missingQuantity));
    console.log('[cost-coverage] missing turnover:', money(missingAmount));
    console.log('[cost-coverage] ignored technical WB zero-turnover rows:', technicalWbRows.length);
    console.log('[cost-coverage] ignored technical WB zero-turnover quantity:', Math.round(technicalQuantity));

    if (missingItems.length > 0) {
      console.log('[cost-coverage] ATTENTION: missing cost price or Ozon SKU mapping for sold items. Profit can be overstated.');
      printItems('[cost-coverage] top missing cost/mapping items:', missingItems);
    } else {
      console.log('[cost-coverage] OK: cost price/mapping exists for all checked sold items with turnover');
    }

    printItems('[cost-coverage] ignored technical WB zero-turnover rows:', technicalWbRows, 20);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('[cost-coverage] fatal');
  console.error(error);
  process.exit(1);
});
