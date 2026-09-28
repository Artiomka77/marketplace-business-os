const { Client } = require('pg');

function arg(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function toNumber(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'object' && typeof value.toNumber === 'function') {
    return value.toNumber();
  }
  const normalized = String(value)
    .replace(/\s/g, '')
    .replace(',', '.')
    .replace(/[^\d.-]/g, '');
  const number = Number(normalized);
  return Number.isFinite(number) ? number : 0;
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
  return String(value ?? '').trim();
}

function rub(value) {
  const n = toNumber(value);
  return new Intl.NumberFormat('ru-RU', {
    maximumFractionDigits: 2,
  }).format(n);
}

function pct(value) {
  const n = toNumber(value);
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(n)}%`;
}

function table(title, rows) {
  console.log(`\n=== ${title} ===`);
  if (!rows || rows.length === 0) {
    console.log('no rows');
    return;
  }
  console.table(rows);
}

function section(title) {
  console.log(`\n\n============================================================`);
  console.log(title);
  console.log(`============================================================`);
}

function sqlDateFilter(column) {
  return `${column} >= $1::date AND ${column} < ($2::date + INTERVAL '1 day')`;
}

function companyClause(alias, companyName, nextIndex) {
  if (!companyName || companyName === 'ALL') {
    return { sql: '', params: [] };
  }
  const prefix = alias ? `${alias}.` : '';
  return { sql: ` AND ${prefix}"companyName" = $${nextIndex}`, params: [companyName] };
}

async function tableExists(client, tableName) {
  const result = await client.query(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1
     ) AS exists`,
    [tableName],
  );
  return Boolean(result.rows[0]?.exists);
}

async function safeQuery(client, title, query, params = []) {
  try {
    return await client.query(query, params);
  } catch (error) {
    console.log(`\n[WARN] ${title}: ${error.message}`);
    return { rows: [] };
  }
}

function isOzonFinanceClickAdOperation(operationType) {
  const value = normalizeText(operationType);
  return value.includes('оплата за клик') || value.includes('cpc') || value.includes('click');
}

function isOzonFinanceOrderAdOperation(operationType) {
  const value = normalizeText(operationType);
  return (
    value.includes('оплата за заказ') ||
    value.includes('продвижение с оплатой за заказ') ||
    value.includes('реклама оплата за заказ') ||
    value.includes('cpo') ||
    (value.includes('заказ') &&
      (value.includes('продвиж') || value.includes('реклам') || value.includes('оплат')))
  );
}

function isOzonFinanceAdOperation(operationType) {
  const value = normalizeText(operationType);
  return (
    isOzonFinanceClickAdOperation(operationType) ||
    isOzonFinanceOrderAdOperation(operationType) ||
    (value.includes('реклам') && !value.includes('сторно'))
  );
}

function isOzonNonOperatingFinanceOperation(operationType) {
  const value = normalizeText(operationType);
  return (
    value.includes('займ') ||
    value.includes('факторинг') ||
    value.includes('кредит') ||
    value.includes('финансирован') ||
    value.includes('loan') ||
    value.includes('factor')
  );
}

function getOzonFinanceAdAmount(row) {
  const totalAmount = Math.abs(toNumber(row.totalAmount));
  const salesAmount = Math.abs(toNumber(row.salesAmount));
  return totalAmount > 0 ? totalAmount : salesAmount;
}

function calculateVatTax(revenue, vatRate) {
  if (vatRate <= 0) return 0;
  return revenue * (vatRate / (100 + vatRate));
}

function clampRate(value, allowedRates, fallback) {
  const rate = toNumber(value);
  return allowedRates.includes(rate) ? rate : fallback;
}

function buildCostByVendorCode(costs) {
  const costByVendorCode = new Map();
  for (const cost of costs) {
    const vendorCode = normalizeText(cost.vendorCode);
    if (!vendorCode) continue;
    if (!costByVendorCode.has(vendorCode)) {
      costByVendorCode.set(vendorCode, toNumber(cost.costPrice));
    }
  }
  return costByVendorCode;
}

function buildOzonProductLookup(ozonProducts) {
  const normalizedVendorCodeBySku = new Map();
  for (const product of ozonProducts) {
    const sku = normalizeText(product.sku);
    const vendorCode = normalizeText(product.vendorCode);
    if (!sku || !vendorCode) continue;
    if (!normalizedVendorCodeBySku.has(sku)) {
      normalizedVendorCodeBySku.set(sku, vendorCode);
    }
  }
  return { normalizedVendorCodeBySku };
}

async function getCompanyNames(client, dateFrom, dateTo, requestedCompanyName) {
  if (requestedCompanyName && requestedCompanyName !== 'ALL') return [requestedCompanyName];

  const result = await client.query(
    `SELECT DISTINCT "companyName"
     FROM "OzonFinance"
     WHERE ${sqlDateFilter('"accrualDate"')}
       AND "companyName" IS NOT NULL
     ORDER BY "companyName"`,
    [dateFrom, dateTo],
  );

  const names = result.rows.map((row) => row.companyName).filter(Boolean);
  return names.length > 0 ? names : ['ALL'];
}

async function getCompanyTaxRates(client, companyName) {
  if (!companyName || companyName === 'ALL') return { usnRate: 1, vatRate: 5 };

  const result = await safeQuery(
    client,
    'Company tax rates',
    `SELECT "usnRate", "vatRate" FROM "Company" WHERE "name" = $1 LIMIT 1`,
    [companyName],
  );

  const row = result.rows[0] || {};
  return {
    usnRate: clampRate(row.usnRate, [0, 1, 2, 3, 4, 5, 6], 1),
    vatRate: clampRate(row.vatRate, [0, 5, 7], 5),
  };
}

async function getOzonFinanceRows(client, dateFrom, dateTo, companyName) {
  const clause = companyClause('', companyName, 3);
  const result = await client.query(
    `SELECT
       "companyName", "accrualDate", "operationType", "sku", "vendorCode", "quantity",
       "salesAmount", "totalAmount", "ozonCommission", "logisticsCost", "reverseLogisticsCost"
     FROM "OzonFinance"
     WHERE ${sqlDateFilter('"accrualDate"')}${clause.sql}
     ORDER BY "accrualDate" ASC, "companyName" ASC`,
    [dateFrom, dateTo, ...clause.params],
  );
  return result.rows;
}

async function getRealizationSummary(client, dateFrom, dateTo, companyName) {
  if (!(await tableExists(client, 'OzonRealizationSummary'))) return null;

  const clause = companyClause('', companyName, 3);
  const exact = await safeQuery(
    client,
    'OzonRealizationSummary exact',
    `SELECT
       COALESCE(SUM("realizedAmount"), 0) AS "realizedAmount",
       COALESCE(SUM("returnedAmount"), 0) AS "returnedAmount",
       COALESCE(SUM("taxableRevenue"), 0) AS "taxableRevenue",
       COALESCE(SUM("partnerProgramsAmount"), 0) AS "partnerProgramsAmount",
       COUNT(*)::int AS rows
     FROM "OzonRealizationSummary"
     WHERE "dateFrom"::date = $1::date
       AND "dateTo"::date = $2::date${clause.sql}`,
    [dateFrom, dateTo, ...clause.params],
  );

  const exactRow = exact.rows[0];
  const exactAmount =
    Math.abs(toNumber(exactRow?.realizedAmount)) +
    Math.abs(toNumber(exactRow?.returnedAmount)) +
    Math.abs(toNumber(exactRow?.taxableRevenue)) +
    Math.abs(toNumber(exactRow?.partnerProgramsAmount));

  if (exactRow && exactAmount > 0.005) return { ...exactRow, source: 'exact-period' };

  const aggregate = await safeQuery(
    client,
    'OzonRealizationSummary aggregate',
    `SELECT
       COALESCE(SUM("realizedAmount"), 0) AS "realizedAmount",
       COALESCE(SUM("returnedAmount"), 0) AS "returnedAmount",
       COALESCE(SUM("taxableRevenue"), 0) AS "taxableRevenue",
       COALESCE(SUM("partnerProgramsAmount"), 0) AS "partnerProgramsAmount",
       COUNT(*)::int AS rows
     FROM "OzonRealizationSummary"
     WHERE "dateFrom"::date >= $1::date
       AND "dateTo"::date <= $2::date${clause.sql}`,
    [dateFrom, dateTo, ...clause.params],
  );

  const row = aggregate.rows[0];
  const amount =
    Math.abs(toNumber(row?.realizedAmount)) +
    Math.abs(toNumber(row?.returnedAmount)) +
    Math.abs(toNumber(row?.taxableRevenue)) +
    Math.abs(toNumber(row?.partnerProgramsAmount));

  return row && amount > 0.005 ? { ...row, source: 'inside-period-aggregate' } : null;
}

async function getDiscountSummary(client, dateFrom, dateTo, companyName) {
  if (!(await tableExists(client, 'OzonDiscountPointsSummary'))) return null;

  const clause = companyClause('', companyName, 3);
  const exact = await safeQuery(
    client,
    'OzonDiscountPointsSummary exact',
    `SELECT
       COALESCE(SUM("pointsAccrued"), 0) AS "pointsAccrued",
       COALESCE(SUM("pointsWrittenOff"), 0) AS "pointsWrittenOff",
       COALESCE(SUM("totalPaidByPoints"), 0) AS "totalPaidByPoints",
       COUNT(*)::int AS rows
     FROM "OzonDiscountPointsSummary"
     WHERE "dateFrom"::date = $1::date
       AND "dateTo"::date = $2::date${clause.sql}`,
    [dateFrom, dateTo, ...clause.params],
  );

  const exactRow = exact.rows[0];
  const exactAmount =
    toNumber(exactRow?.totalPaidByPoints) ||
    toNumber(exactRow?.pointsWrittenOff) ||
    toNumber(exactRow?.pointsAccrued);

  if (exactRow && Math.abs(exactAmount) > 0.005) return { ...exactRow, source: 'exact-period' };

  const aggregate = await safeQuery(
    client,
    'OzonDiscountPointsSummary aggregate',
    `SELECT
       COALESCE(SUM("pointsAccrued"), 0) AS "pointsAccrued",
       COALESCE(SUM("pointsWrittenOff"), 0) AS "pointsWrittenOff",
       COALESCE(SUM("totalPaidByPoints"), 0) AS "totalPaidByPoints",
       COUNT(*)::int AS rows
     FROM "OzonDiscountPointsSummary"
     WHERE "dateFrom"::date >= $1::date
       AND "dateTo"::date <= $2::date${clause.sql}`,
    [dateFrom, dateTo, ...clause.params],
  );

  const row = aggregate.rows[0];
  const amount =
    toNumber(row?.totalPaidByPoints) ||
    toNumber(row?.pointsWrittenOff) ||
    toNumber(row?.pointsAccrued);

  return row && Math.abs(amount) > 0.005 ? { ...row, source: 'inside-period-aggregate' } : null;
}

async function getCosts(client) {
  const result = await client.query(
    `SELECT "vendorCode", "costPrice"
     FROM "ProductCost"
     ORDER BY "costDate" DESC NULLS LAST, "createdAt" DESC`,
  );
  return result.rows;
}

async function getOzonProductMappings(client, companyName) {
  const params = [];
  const where = companyName && companyName !== 'ALL' ? 'WHERE "companyName" = $1' : '';
  if (where) params.push(companyName);

  const productRows = await safeQuery(
    client,
    'OzonProduct mappings',
    `SELECT "vendorCode", "sku" FROM "OzonProduct" ${where}`,
    params,
  );

  const stockRows = await safeQuery(
    client,
    'OzonStock mappings',
    `SELECT "vendorCode", "sku" FROM "OzonStock" ${where}`,
    params,
  );

  return [...productRows.rows, ...stockRows.rows];
}

async function getOzonAdsRows(client, dateFrom, dateTo, companyName) {
  if (!(await tableExists(client, 'OzonAds'))) return [];

  const clause = companyClause('', companyName, 3);
  const result = await safeQuery(
    client,
    'OzonAds',
    `SELECT "reportDate", "sku", "spend", "importSessionId", "createdAt"
     FROM "OzonAds"
     WHERE ${sqlDateFilter('"reportDate"')}${clause.sql}
     ORDER BY "createdAt" DESC`,
    [dateFrom, dateTo, ...clause.params],
  );

  const latestSessionByDate = new Map();
  for (const row of result.rows) {
    const dateKey = row.reportDate ? row.reportDate.toISOString().slice(0, 10) : 'NO_DATE';
    if (!latestSessionByDate.has(dateKey)) {
      latestSessionByDate.set(dateKey, row.importSessionId ?? null);
    }
  }

  return result.rows.filter((row) => {
    const dateKey = row.reportDate ? row.reportDate.toISOString().slice(0, 10) : 'NO_DATE';
    return latestSessionByDate.get(dateKey) === (row.importSessionId ?? null);
  });
}

function summarizeByDay(financeRows) {
  const byDay = new Map();

  for (const row of financeRows) {
    const date = row.accrualDate ? row.accrualDate.toISOString().slice(0, 10) : 'NO_DATE';
    const current = byDay.get(date) || {
      date,
      rows: 0,
      salesAmount: 0,
      totalAmount: 0,
      commission: 0,
      logistics: 0,
      reverseLogistics: 0,
      financeAds: 0,
      nonAdSalesAmount: 0,
      nonAdTotalAmount: 0,
    };

    current.rows += 1;
    current.salesAmount += toNumber(row.salesAmount);
    current.totalAmount += toNumber(row.totalAmount);
    current.commission += Math.abs(toNumber(row.ozonCommission));
    current.logistics += Math.abs(toNumber(row.logisticsCost));
    current.reverseLogistics += Math.abs(toNumber(row.reverseLogisticsCost));

    if (isOzonFinanceAdOperation(row.operationType)) {
      current.financeAds += getOzonFinanceAdAmount(row);
    } else if (!isOzonNonOperatingFinanceOperation(row.operationType)) {
      current.nonAdSalesAmount += toNumber(row.salesAmount);
      current.nonAdTotalAmount += toNumber(row.totalAmount);
    }

    byDay.set(date, current);
  }

  return Array.from(byDay.values()).map((row) => ({
    date: row.date,
    rows: row.rows,
    salesAmount: rub(row.salesAmount),
    nonAdSalesAmount: rub(row.nonAdSalesAmount),
    totalAmount: rub(row.totalAmount),
    nonAdTotalAmount: rub(row.nonAdTotalAmount),
    commission: rub(row.commission),
    logistics: rub(row.logistics),
    reverseLogistics: rub(row.reverseLogistics),
    financeAds: rub(row.financeAds),
  }));
}

function calculateOzonPageLikeTotals({ financeRows, adsRows, costs, mappings, realizationSummary, discountSummary, usnRate, vatRate }) {
  const costByVendorCode = buildCostByVendorCode(costs);
  const { normalizedVendorCodeBySku } = buildOzonProductLookup(mappings);

  const financeClickAdsCost = financeRows.reduce(
    (sum, row) => isOzonFinanceClickAdOperation(row.operationType) ? sum + getOzonFinanceAdAmount(row) : sum,
    0,
  );
  const financeOrderAdsCost = financeRows.reduce(
    (sum, row) => isOzonFinanceOrderAdOperation(row.operationType) ? sum + getOzonFinanceAdAmount(row) : sum,
    0,
  );
  const financeOtherAdsCost = financeRows.reduce(
    (sum, row) =>
      isOzonFinanceAdOperation(row.operationType) &&
      !isOzonFinanceClickAdOperation(row.operationType) &&
      !isOzonFinanceOrderAdOperation(row.operationType)
        ? sum + getOzonFinanceAdAmount(row)
        : sum,
    0,
  );
  const financeAdsCost = financeClickAdsCost + financeOrderAdsCost + financeOtherAdsCost;

  let performanceAdsCost = 0;
  const hasFinanceClickAds = financeRows.some((row) => isOzonFinanceClickAdOperation(row.operationType));
  if (!hasFinanceClickAds) {
    performanceAdsCost = adsRows.reduce((sum, row) => sum + toNumber(row.spend), 0);
  }

  const marketplaceFinanceRows = financeRows.filter(
    (row) => !isOzonFinanceAdOperation(row.operationType) && !isOzonNonOperatingFinanceOperation(row.operationType),
  );

  const totals = {
    financeRows: financeRows.length,
    marketplaceRows: marketplaceFinanceRows.length,
    salesQty: 0,
    returnsQty: 0,
    netSalesQty: 0,
    rawSalesAmount: 0,
    rawSellerPayout: 0,
    revenue: 0,
    realizedAmount: 0,
    returnedAmount: 0,
    taxableRevenue: 0,
    partnerProgramsAmount: 0,
    discountPointsAmount: 0,
    economicTurnover: 0,
    expenseShareBase: 0,
    sellerPayout: 0,
    commission: 0,
    logistics: 0,
    reverseLogistics: 0,
    logisticsTotal: 0,
    deductions: 0,
    adsCost: 0,
    clickAdsCost: 0,
    orderAdsCost: 0,
    otherAdsCost: 0,
    performanceAdsCost,
    financeAdsCost,
    totalCost: 0,
    taxesAmount: 0,
    grossOzonExpenses: 0,
    netOzonExpenses: 0,
    marginProfit: 0,
    netProfitAfterTax: 0,
    drrPercent: 0,
    marginAfterTaxPercent: 0,
    rowsWithoutVendorCode: 0,
    rowsWithoutCost: 0,
    qtyWithoutCost: 0,
  };

  for (const row of marketplaceFinanceRows) {
    const skuKey = normalizeText(row.sku);
    const directVendorCodeKey = normalizeText(row.vendorCode);
    const mappedVendorCodeKey = skuKey ? (normalizedVendorCodeBySku.get(skuKey) || '') : '';
    const vendorCodeKey = directVendorCodeKey || mappedVendorCodeKey || skuKey;
    const costPrice = vendorCodeKey ? (costByVendorCode.get(vendorCodeKey) || 0) : 0;
    const quantity = Math.abs(toNumber(row.quantity));
    const salesAmount = toNumber(row.salesAmount);
    const totalAmount = toNumber(row.totalAmount);

    totals.rawSalesAmount += salesAmount;
    totals.rawSellerPayout += totalAmount;
    totals.revenue += salesAmount;
    totals.sellerPayout += totalAmount;

    if (!vendorCodeKey) totals.rowsWithoutVendorCode += 1;
    if (costPrice === 0 && quantity > 0 && (salesAmount !== 0 || totalAmount !== 0)) {
      totals.rowsWithoutCost += 1;
      totals.qtyWithoutCost += quantity;
    }

    if (salesAmount > 0 || quantity > 0) {
      totals.salesQty += quantity;
      totals.netSalesQty += quantity;
      totals.totalCost += costPrice * quantity;
    }

    if (salesAmount < 0 || totalAmount < 0) {
      totals.returnsQty += quantity;
      totals.netSalesQty -= quantity;
      totals.totalCost -= costPrice * quantity;
    }

    const commission = Math.abs(toNumber(row.ozonCommission));
    const directLogistics = Math.abs(toNumber(row.logisticsCost));
    const reverseLogistics = Math.abs(toNumber(row.reverseLogisticsCost));
    const logistics = directLogistics + reverseLogistics;

    totals.commission += commission;
    totals.logistics += directLogistics;
    totals.reverseLogistics += reverseLogistics;
    totals.logisticsTotal += logistics;

    const knownMarketplaceExpenses = commission + logistics;
    const payoutGap = salesAmount - totalAmount;
    const otherDeductions = payoutGap - knownMarketplaceExpenses;
    totals.deductions += otherDeductions;
  }

  totals.clickAdsCost = performanceAdsCost + financeClickAdsCost + financeOtherAdsCost;
  totals.orderAdsCost = financeOrderAdsCost;
  totals.otherAdsCost = financeOtherAdsCost;
  totals.adsCost = totals.clickAdsCost + totals.orderAdsCost;

  const taxableRevenue = toNumber(realizationSummary?.taxableRevenue);
  const realizedAmount = toNumber(realizationSummary?.realizedAmount);
  const returnedAmount = toNumber(realizationSummary?.returnedAmount);
  const partnerProgramsAmount = toNumber(realizationSummary?.partnerProgramsAmount);
  const discountPointsAmount =
    toNumber(discountSummary?.totalPaidByPoints) ||
    toNumber(discountSummary?.pointsWrittenOff) ||
    toNumber(discountSummary?.pointsAccrued);

  if (taxableRevenue > 0) {
    totals.revenue = taxableRevenue;
    totals.taxableRevenue = taxableRevenue;
    totals.realizedAmount = realizedAmount;
    totals.returnedAmount = returnedAmount;
    totals.partnerProgramsAmount = partnerProgramsAmount;
  } else {
    totals.taxableRevenue = totals.revenue;
  }

  totals.discountPointsAmount = discountPointsAmount;
  const economicTurnover = totals.taxableRevenue + discountPointsAmount + partnerProgramsAmount;
  totals.economicTurnover = economicTurnover > 0 ? economicTurnover : totals.revenue;
  totals.expenseShareBase = totals.economicTurnover > 0 ? totals.economicTurnover : totals.revenue;
  totals.taxesAmount = totals.revenue * (usnRate / 100) + calculateVatTax(totals.revenue, vatRate);
  totals.grossOzonExpenses = totals.commission + totals.logisticsTotal + totals.adsCost + totals.deductions;
  totals.netOzonExpenses = totals.grossOzonExpenses - discountPointsAmount;
  totals.marginProfit = totals.economicTurnover - totals.totalCost - totals.grossOzonExpenses;
  totals.netProfitAfterTax = totals.marginProfit - totals.taxesAmount;
  totals.drrPercent = totals.expenseShareBase > 0 ? (totals.adsCost / totals.expenseShareBase) * 100 : 0;
  totals.marginAfterTaxPercent = totals.expenseShareBase > 0 ? (totals.netProfitAfterTax / totals.expenseShareBase) * 100 : 0;

  return totals;
}

async function getFinanceTransactionBreakdown(client, dateFrom, dateTo, companyName) {
  if (!(await tableExists(client, 'FinanceTransaction'))) return [];

  const clause = companyClause('t', companyName, 3);
  const result = await safeQuery(
    client,
    'FinanceTransaction breakdown',
    `SELECT
       t."companyName",
       t."operationType",
       t."category",
       COALESCE(c."profitTreatment", 'AUTO') AS "profitTreatment",
       COUNT(*)::int AS rows,
       COALESCE(SUM(t."amount"), 0) AS amount
     FROM "FinanceTransaction" t
     LEFT JOIN "FinanceCategory" c ON c."name" = t."category"
     WHERE t."operationDate" >= $1::date
       AND t."operationDate" < ($2::date + INTERVAL '1 day')${clause.sql}
       AND COALESCE(t."isInternalTransfer", false) = false
     GROUP BY t."companyName", t."operationType", t."category", COALESCE(c."profitTreatment", 'AUTO')
     ORDER BY ABS(COALESCE(SUM(t."amount"), 0)) DESC`,
    [dateFrom, dateTo, ...clause.params],
  );

  return result.rows.map((row) => ({
    companyName: row.companyName,
    operationType: row.operationType,
    category: row.category,
    profitTreatment: row.profitTreatment,
    rows: row.rows,
    amount: rub(row.amount),
  }));
}

function formatTotalsForTable(companyName, totals, taxRates, realizationSummary, discountSummary) {
  return {
    companyName,
    usnRate: taxRates.usnRate,
    vatRate: taxRates.vatRate,
    financeRows: totals.financeRows,
    marketplaceRows: totals.marketplaceRows,
    rawSalesAmount: rub(totals.rawSalesAmount),
    rawSellerPayout: rub(totals.rawSellerPayout),
    taxableRevenue: rub(totals.taxableRevenue),
    economicTurnover: rub(totals.economicTurnover),
    commission: rub(totals.commission),
    logisticsDirect: rub(totals.logistics),
    reverseLogistics: rub(totals.reverseLogistics),
    logisticsTotal: rub(totals.logisticsTotal),
    financeAds: rub(totals.financeAdsCost),
    performanceAdsUsed: rub(totals.performanceAdsCost),
    adsCostFinal: rub(totals.adsCost),
    deductionsOther: rub(totals.deductions),
    totalCost: rub(totals.totalCost),
    taxesAmount: rub(totals.taxesAmount),
    grossOzonExpenses: rub(totals.grossOzonExpenses),
    discountPoints: rub(totals.discountPointsAmount),
    netOzonExpenses: rub(totals.netOzonExpenses),
    netProfitAfterTax: rub(totals.netProfitAfterTax),
    marginAfterTax: pct(totals.marginAfterTaxPercent),
    drr: pct(totals.drrPercent),
    realizationSource: realizationSummary?.source || 'none',
    realizationRows: realizationSummary?.rows || 0,
    discountSource: discountSummary?.source || 'none',
    discountRows: discountSummary?.rows || 0,
    rowsWithoutCost: totals.rowsWithoutCost,
    qtyWithoutCost: rub(totals.qtyWithoutCost),
  };
}

function warnIfUiLooksLikeSingleDay(companyName, totals, dayRows) {
  const lastDay = dayRows[dayRows.length - 1];
  if (!lastDay) return;

  const lastDayCommission = toNumber(lastDay.commission);
  const lastDayAds = toNumber(lastDay.financeAds);
  const lastDayLogistics = toNumber(lastDay.logistics) + toNumber(lastDay.reverseLogistics);

  const checks = [
    ['commission', totals.commission, lastDayCommission],
    ['adsCost', totals.adsCost, lastDayAds],
    ['logisticsTotal', totals.logisticsTotal, lastDayLogistics],
  ];

  const suspicious = checks.filter(([, periodValue, lastDayValue]) => {
    const p = toNumber(periodValue);
    const d = toNumber(lastDayValue);
    return p > 0 && d > 0 && Math.abs(d / p) < 0.25;
  });

  if (suspicious.length > 0) {
    console.log(`\n[NOTE] ${companyName}: если UI показывает значения около последнего дня, это будет сильно ниже периода.`);
    console.log(`       Последний день в raw OzonFinance: ${lastDay.date}`);
    console.log(`       commission=${rub(lastDayCommission)}, logisticsTotal=${rub(lastDayLogistics)}, ads=${rub(lastDayAds)}`);
  }
}

async function auditCompany(client, dateFrom, dateTo, companyName) {
  section(`OZON BREAKDOWN: ${companyName}`);

  const [financeRows, costs, mappings, adsRows, realizationSummary, discountSummary, taxRates] = await Promise.all([
    getOzonFinanceRows(client, dateFrom, dateTo, companyName),
    getCosts(client),
    getOzonProductMappings(client, companyName),
    getOzonAdsRows(client, dateFrom, dateTo, companyName),
    getRealizationSummary(client, dateFrom, dateTo, companyName),
    getDiscountSummary(client, dateFrom, dateTo, companyName),
    getCompanyTaxRates(client, companyName),
  ]);

  const totals = calculateOzonPageLikeTotals({
    financeRows,
    adsRows,
    costs,
    mappings,
    realizationSummary,
    discountSummary,
    usnRate: taxRates.usnRate,
    vatRate: taxRates.vatRate,
  });

  table('Ozon period totals, calculated from raw OzonFinance + current profitAnalyticsOzon model', [
    formatTotalsForTable(companyName, totals, taxRates, realizationSummary, discountSummary),
  ]);

  const dayRows = summarizeByDay(financeRows);
  table('Ozon raw daily breakdown from OzonFinance', dayRows);
  warnIfUiLooksLikeSingleDay(companyName, totals, dayRows);

  return totals;
}

async function auditWbFinance(client, dateFrom, dateTo, companyName) {
  if (!(await tableExists(client, 'WbFinance'))) return;
  section(`WB WEEKLY FINANCE: ${companyName}`);
  const clause = companyClause('', companyName, 3);
  const result = await safeQuery(
    client,
    'WB weekly finance',
    `SELECT
       "companyName",
       COUNT(*)::int AS rows,
       COALESCE(SUM("salesAmount"), 0) AS "salesAmount",
       COALESCE(SUM("payoutAmount"), 0) AS "payoutAmount",
       COALESCE(SUM("logisticsCost"), 0) AS "logisticsCost",
       COALESCE(SUM("storageCost"), 0) AS "storageCost",
       COALESCE(SUM("acceptanceCost"), 0) AS "acceptanceCost",
       COALESCE(SUM("otherDeductions"), 0) AS "otherDeductions",
       COALESCE(SUM("penaltiesAmount"), 0) AS "penaltiesAmount",
       COALESCE(SUM("totalToPay"), 0) AS "totalToPay"
     FROM "WbFinance"
     WHERE "dateFrom"::date >= $1::date
       AND "dateTo"::date <= $2::date${clause.sql}
     GROUP BY "companyName"
     ORDER BY "companyName"`,
    [dateFrom, dateTo, ...clause.params],
  );
  table(
    'WB finance totals',
    result.rows.map((row) => ({
      companyName: row.companyName,
      rows: row.rows,
      salesAmount: rub(row.salesAmount),
      payoutAmount: rub(row.payoutAmount),
      logisticsCost: rub(row.logisticsCost),
      storageCost: rub(row.storageCost),
      acceptanceCost: rub(row.acceptanceCost),
      otherDeductions: rub(row.otherDeductions),
      penaltiesAmount: rub(row.penaltiesAmount),
      totalToPay: rub(row.totalToPay),
    })),
  );
}

async function main() {
  const dateFrom = arg('dateFrom');
  const dateTo = arg('dateTo');
  const companyName = arg('companyName', 'ALL');

  if (!dateFrom || !dateTo) {
    console.error('Usage: node scripts/audit_dashboard_profit_breakdown.js --dateFrom=YYYY-MM-DD --dateTo=YYYY-MM-DD --companyName=ALL');
    process.exit(1);
  }

  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    section('AUDIT DASHBOARD PROFIT BREAKDOWN');
    console.log({ dateFrom, dateTo, companyName });

    const hasOzonFinancialCategoryFact = await tableExists(client, 'OzonFinancialCategoryFact');
    console.log(`OzonFinancialCategoryFact exists: ${hasOzonFinancialCategoryFact ? 'YES' : 'NO'}`);

    const companies = await getCompanyNames(client, dateFrom, dateTo, companyName);
    for (const name of companies) {
      await auditCompany(client, dateFrom, dateTo, name);
    }

    if (companyName === 'ALL' && companies.length > 1) {
      await auditCompany(client, dateFrom, dateTo, 'ALL');
    }

    await auditWbFinance(client, dateFrom, dateTo, companyName);

    section(`FINANCE TRANSACTIONS: ${companyName}`);
    const financeRows = await getFinanceTransactionBreakdown(client, dateFrom, dateTo, companyName);
    table('FinanceTransaction by category/profitTreatment', financeRows.slice(0, 80));

    section('READING HINTS');
    console.log('1. For Ozon, compare period totals with the Profit Ozon page cards.');
    console.log('2. If page cards match only one daily row, the UI/calculation is using a daily slice instead of the whole period.');
    console.log('3. If raw OzonFinance commission/logistics/ads match the external service, data loading is likely OK and the bug is in analytics/UI aggregation.');
    console.log('4. This script is read-only. It does not change DB data or formulas.');
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('[audit-dashboard-profit-breakdown] failed');
  console.error(error);
  process.exit(1);
});
