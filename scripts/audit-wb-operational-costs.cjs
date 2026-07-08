const { Pool } = require('pg');

const DATE_FROM = process.env.DATE_FROM || '2026-07-01';
const DATE_TO = process.env.DATE_TO || '2026-07-07';
const COMPANIES = (process.env.COMPANIES || 'ИП Петров,ИП Лебедева')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const FETCH_WB_DETAIL = process.env.FETCH_WB_DETAIL !== 'false';
const WB_DETAIL_LIMIT = Number(process.env.WB_DETAIL_LIMIT || 100000);
const WB_DETAIL_MAX_PAGES = Number(process.env.WB_DETAIL_MAX_PAGES || 20);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function round2(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const normalized = String(value).replace(/\s/g, '').replace(',', '.').replace(/[^\d.-]/g, '');
  const number = Number(normalized);
  return Number.isFinite(number) ? number : 0;
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(/[–—−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function addDaysIso(iso, days) {
  const date = new Date(`${iso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dateOnly(value) {
  if (!value) return null;
  return new Date(value).toISOString().slice(0, 10);
}

function getMoscowDateKey(value) {
  if (!value) return 'unknown';
  const date = value instanceof Date ? value : new Date(value);
  return new Date(date.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function getDateSpan(from, to) {
  if (!from && !to) return [];
  let cursor = dateOnly(from || to);
  const end = dateOnly(to || from);
  const result = [];
  while (cursor && end && cursor <= end) {
    result.push(cursor);
    cursor = addDaysIso(cursor, 1);
  }
  return result;
}

function isWbSaleOperation(reason) {
  const value = normalizeText(reason);
  return value === 'продажа' || value === 'сторно возвратов' || value.includes('продажа');
}

function isWbReturnOperation(reason) {
  const value = normalizeText(reason);
  return value === 'возврат' || value.includes('возврат');
}

function isDailyStatsReport(reportNumber) {
  return String(reportNumber || '').startsWith('WB_DAILY_STATISTICS_');
}

function selectPreferredWbSaleRows(rows) {
  const rowsByCompanyDay = new Map();
  for (const row of rows) {
    const key = `${row.companyName}__${getMoscowDateKey(row.saleDate)}`;
    const current = rowsByCompanyDay.get(key) || [];
    current.push(row);
    rowsByCompanyDay.set(key, current);
  }

  const preferred = [];
  for (const dayRows of rowsByCompanyDay.values()) {
    const detailedRows = dayRows.filter((row) => !isDailyStatsReport(row.reportNumber));
    const dailyRows = dayRows.filter((row) => isDailyStatsReport(row.reportNumber));
    preferred.push(...(detailedRows.length > 0 ? detailedRows : dailyRows));
  }
  return preferred;
}

function emptySummary() {
  return {
    rows: 0,
    salesRows: 0,
    returnRows: 0,
    salesQty: 0,
    returnsQty: 0,
    netQty: 0,
    sellerRetailAmount: 0,
    revenueGrossSales: 0,
    revenueReturns: 0,
    revenueNet: 0,
    sellerPayoutSales: 0,
    sellerPayoutReturns: 0,
    sellerPayoutNet: 0,
    commissionBeforeVat: 0,
    commissionVat: 0,
    commissionTotal: 0,
    commissionFallbackFromRevenueMinusPayout: 0,
    logisticsCost: 0,
    storageCost: 0,
    acceptanceCost: 0,
    penaltiesAmount: 0,
    deductions: 0,
    paymentServiceCost: 0,
    pvzCompensation: 0,
    transportCompensation: 0,
    deliveryAmount: 0,
    returnAmount: 0,
    reasons: {},
    reportNumbers: [],
    importSessions: [],
  };
}

function addReason(summary, reason) {
  const key = String(reason || 'NO_REASON');
  summary.reasons[key] = (summary.reasons[key] || 0) + 1;
}

function summarizeDbWbSaleRows(rows) {
  const summary = emptySummary();
  summary.rows = rows.length;
  summary.reportNumbers = [...new Set(rows.map((row) => row.reportNumber).filter(Boolean))].slice(0, 50);
  summary.importSessions = [...new Set(rows.map((row) => row.importSessionId).filter(Boolean))].slice(0, 50);

  for (const row of rows) {
    const reason = row.paymentReason || row.documentType;
    const qty = Math.abs(toNumber(row.quantity)) || 1;
    const sellerRetail = Math.abs(toNumber(row.retailPriceWithDiscount) || toNumber(row.retailPrice));
    const realized = Math.abs(toNumber(row.wbRealizedAmount));
    const payout = Math.abs(toNumber(row.sellerPayout));
    const commissionBeforeVat = Math.abs(toNumber(row.wbReward));
    const commissionVat = Math.abs(toNumber(row.wbRewardVat));
    const commissionTotal = Math.abs(toNumber(row.wbRewardTotal)) || commissionBeforeVat + commissionVat;

    addReason(summary, reason);

    if (isWbReturnOperation(reason)) {
      summary.returnRows += 1;
      summary.returnsQty += qty;
      summary.revenueReturns += realized;
      summary.sellerPayoutReturns += payout;
    } else if (isWbSaleOperation(reason)) {
      summary.salesRows += 1;
      summary.salesQty += qty;
      summary.sellerRetailAmount += sellerRetail;
      summary.revenueGrossSales += realized;
      summary.sellerPayoutSales += payout;
    }

    summary.commissionBeforeVat += commissionBeforeVat;
    summary.commissionVat += commissionVat;
    summary.commissionTotal += commissionTotal;
    summary.logisticsCost += Math.abs(toNumber(row.logisticsCost));
    summary.storageCost += Math.abs(toNumber(row.storageCost));
    summary.acceptanceCost += Math.abs(toNumber(row.acceptanceCost));
    summary.penaltiesAmount += Math.abs(toNumber(row.penaltiesAmount));
    summary.deductions += Math.abs(toNumber(row.deductions));
    summary.paymentServiceCost += Math.abs(toNumber(row.paymentServiceCost));
    summary.pvzCompensation += Math.abs(toNumber(row.pvzCompensation));
    summary.transportCompensation += Math.abs(toNumber(row.transportCompensation));
    summary.deliveryAmount += Math.abs(toNumber(row.deliveriesCount));
    summary.returnAmount += Math.abs(toNumber(row.returnsCount));
  }

  summary.netQty = summary.salesQty - summary.returnsQty;
  summary.revenueNet = summary.revenueGrossSales - summary.revenueReturns;
  summary.sellerPayoutNet = summary.sellerPayoutSales - summary.sellerPayoutReturns;
  if (summary.commissionTotal === 0 && summary.revenueNet > 0 && summary.sellerPayoutNet > 0) {
    summary.commissionFallbackFromRevenueMinusPayout = Math.max(0, summary.revenueNet - summary.sellerPayoutNet);
  }

  for (const key of Object.keys(summary)) {
    if (typeof summary[key] === 'number') summary[key] = round2(summary[key]);
  }
  return summary;
}

function getField(row, ...names) {
  for (const name of names) {
    if (row[name] !== undefined && row[name] !== null && row[name] !== '') return row[name];
  }
  return null;
}

function getDetailReason(row) {
  return getField(
    row,
    'supplier_oper_name',
    'supplierOperName',
    'sellerOperName',
    'seller_oper_name',
    'doc_type_name',
    'docTypeName'
  );
}

function summarizeOperationalApiRows(rows) {
  const summary = emptySummary();
  summary.rows = rows.length;
  summary.reportNumbers = [...new Set(rows.map((row) => getField(row, 'realizationreport_id', 'reportId')).filter(Boolean).map(String))].slice(0, 50);

  for (const row of rows) {
    const reason = getDetailReason(row);
    const docType = getField(row, 'doc_type_name', 'docTypeName');
    const effectiveReason = reason || docType;
    const qty = Math.abs(toNumber(getField(row, 'quantity')));
    const sellerRetail = Math.abs(toNumber(getField(row, 'retail_price_withdisc_rub', 'retail_price_with_discount', 'retailPriceWithDiscount', 'retail_price')));
    const realized = Math.abs(toNumber(getField(row, 'retail_amount', 'retailAmount')));
    const payout = Math.abs(toNumber(getField(row, 'ppvz_for_pay', 'forPay')));
    const commissionBeforeVat = Math.abs(toNumber(getField(row, 'ppvz_vw', 'vw')));
    const commissionVat = Math.abs(toNumber(getField(row, 'ppvz_vw_nds', 'ppvzVwNds')));
    const commissionTotal = commissionBeforeVat + commissionVat;

    addReason(summary, effectiveReason);

    if (isWbReturnOperation(effectiveReason) || normalizeText(docType) === 'возврат') {
      summary.returnRows += 1;
      summary.returnsQty += qty;
      summary.revenueReturns += realized;
      summary.sellerPayoutReturns += payout;
    } else if (isWbSaleOperation(effectiveReason) || normalizeText(docType) === 'продажа') {
      summary.salesRows += 1;
      summary.salesQty += qty;
      summary.sellerRetailAmount += sellerRetail;
      summary.revenueGrossSales += realized;
      summary.sellerPayoutSales += payout;
    }

    summary.commissionBeforeVat += commissionBeforeVat;
    summary.commissionVat += commissionVat;
    summary.commissionTotal += commissionTotal;
    summary.logisticsCost += Math.abs(toNumber(getField(row, 'delivery_rub', 'deliveryService')));
    summary.storageCost += Math.abs(toNumber(getField(row, 'storage_fee', 'paidStorage')));
    summary.acceptanceCost += Math.abs(toNumber(getField(row, 'acceptance', 'paidAcceptance')));
    summary.penaltiesAmount += Math.abs(toNumber(getField(row, 'penalty')));
    summary.deductions += Math.abs(toNumber(getField(row, 'deduction')));
    summary.paymentServiceCost += Math.abs(toNumber(getField(row, 'acquiring_fee', 'acquiringFee')));
    summary.pvzCompensation += Math.abs(toNumber(getField(row, 'ppvz_reward', 'ppvzReward')));
    summary.transportCompensation += Math.abs(toNumber(getField(row, 'rebill_logistic_cost', 'rebillLogisticCost')));
    summary.deliveryAmount += Math.abs(toNumber(getField(row, 'delivery_amount', 'deliveryAmount')));
    summary.returnAmount += Math.abs(toNumber(getField(row, 'return_amount', 'returnAmount')));
  }

  summary.netQty = summary.salesQty - summary.returnsQty;
  summary.revenueNet = summary.revenueGrossSales - summary.revenueReturns;
  summary.sellerPayoutNet = summary.sellerPayoutSales - summary.sellerPayoutReturns;
  if (summary.commissionTotal === 0 && summary.revenueNet > 0 && summary.sellerPayoutNet > 0) {
    summary.commissionFallbackFromRevenueMinusPayout = Math.max(0, summary.revenueNet - summary.sellerPayoutNet);
  }

  for (const key of Object.keys(summary)) {
    if (typeof summary[key] === 'number') summary[key] = round2(summary[key]);
  }
  return summary;
}

async function fetchWbOperationalDetailRows(token, dateFrom, dateTo) {
  const allRows = [];
  let rrdid = 0;
  let page = 0;

  while (true) {
    if (page >= WB_DETAIL_MAX_PAGES) {
      throw new Error(`Остановлено после ${WB_DETAIL_MAX_PAGES} страниц, чтобы не уйти в бесконечную пагинацию`);
    }

    const url = new URL('https://statistics-api.wildberries.ru/api/v5/supplier/reportDetailByPeriod');
    url.searchParams.set('dateFrom', `${dateFrom}T00:00:00`);
    url.searchParams.set('dateTo', `${dateTo}T23:59:59`);
    url.searchParams.set('limit', String(WB_DETAIL_LIMIT));
    url.searchParams.set('rrdid', String(rrdid));

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: { Authorization: token },
      cache: 'no-store',
    });

    const text = await response.text();
    if (response.status === 204) break;
    if (!response.ok) {
      throw new Error(`WB reportDetailByPeriod: ${response.status} ${text.slice(0, 1000)}`);
    }

    let json;
    try {
      json = text ? JSON.parse(text) : [];
    } catch (error) {
      throw new Error(`WB reportDetailByPeriod вернул не JSON: ${text.slice(0, 500)}`);
    }

    if (!Array.isArray(json) || json.length === 0) break;
    allRows.push(...json);

    const last = json[json.length - 1];
    const nextRrdid = getField(last, 'rrd_id', 'rrdId');
    if (json.length < WB_DETAIL_LIMIT) break;
    if (!nextRrdid || String(nextRrdid) === String(rrdid)) break;

    rrdid = nextRrdid;
    page += 1;
  }

  return allRows;
}

async function main() {
  const companiesResult = await pool.query(
    `
      SELECT c."id", c."name", mac."wbToken", mac."isEnabled", mac."status", mac."lastSyncAt", mac."lastError"
      FROM "Company" c
      LEFT JOIN "MarketplaceApiConnection" mac ON mac."companyId" = c."id" AND mac."marketplace" = 'WB'
      WHERE c."name" = ANY($1)
      ORDER BY c."name"
    `,
    [COMPANIES]
  );

  const saleRowsResult = await pool.query(
    `
      SELECT
        "companyName", "reportNumber", "importSessionId", "saleDate", "paymentReason", "documentType",
        "quantity", "retailPrice", "retailPriceWithDiscount", "wbRealizedAmount", "sellerPayout",
        "wbReward", "wbRewardVat", "wbRewardTotal", "logisticsCost", "storageCost", "acceptanceCost",
        "penaltiesAmount", "deductions", "paymentServiceCost", "pvzCompensation", "transportCompensation",
        "deliveriesCount", "returnsCount"
      FROM "WbSale"
      WHERE "companyName" = ANY($1)
        AND "saleDate" >= $2::date
        AND "saleDate" < ($3::date + interval '1 day')
      ORDER BY "companyName", "saleDate", "reportNumber"
    `,
    [COMPANIES, DATE_FROM, DATE_TO]
  );

  const financeRowsResult = await pool.query(
    `
      SELECT
        "companyName", "reportNumber", "dateFrom", "dateTo",
        COALESCE("salesAmount", 0)::float AS "salesAmount",
        COALESCE("payoutAmount", 0)::float AS "payoutAmount",
        COALESCE("logisticsCost", 0)::float AS "logisticsCost",
        COALESCE("storageCost", 0)::float AS "storageCost",
        COALESCE("acceptanceCost", 0)::float AS "acceptanceCost",
        COALESCE("otherDeductions", 0)::float AS "otherDeductions",
        COALESCE("penaltiesAmount", 0)::float AS "penaltiesAmount",
        COALESCE("totalToPay", 0)::float AS "totalToPay",
        "createdAt"
      FROM "WbFinance"
      WHERE "companyName" = ANY($1)
        AND "dateFrom" <= $3::date
        AND "dateTo" >= $2::date
      ORDER BY "companyName", "dateFrom", "reportNumber"
    `,
    [COMPANIES, DATE_FROM, DATE_TO]
  );

  const preferredRows = selectPreferredWbSaleRows(saleRowsResult.rows);
  const byCompany = {};

  for (const company of COMPANIES) {
    const companyRow = companiesResult.rows.find((row) => row.name === company) || null;
    const rowsForCompany = saleRowsResult.rows.filter((row) => row.companyName === company);
    const preferredForCompany = preferredRows.filter((row) => row.companyName === company);
    const dailyForCompany = rowsForCompany.filter((row) => isDailyStatsReport(row.reportNumber));
    const detailedForCompany = rowsForCompany.filter((row) => !isDailyStatsReport(row.reportNumber));
    const financeRows = financeRowsResult.rows.filter((row) => row.companyName === company);

    const report = {
      db: {
        allWbSaleRows: summarizeDbWbSaleRows(rowsForCompany),
        preferredWbSaleRows: summarizeDbWbSaleRows(preferredForCompany),
        dailyStatisticsRowsOnly: summarizeDbWbSaleRows(dailyForCompany),
        detailedRowsOnly: summarizeDbWbSaleRows(detailedForCompany),
        overlappingWbFinanceRows: financeRows,
      },
      operationalApi: {
        attempted: FETCH_WB_DETAIL,
        ok: false,
        error: null,
        rows: 0,
        summary: null,
        sampleFields: null,
      },
      conclusions: [],
    };

    if (FETCH_WB_DETAIL) {
      if (!companyRow?.wbToken) {
        report.operationalApi.error = 'WB token не найден';
      } else {
        try {
          const apiRows = await fetchWbOperationalDetailRows(companyRow.wbToken, DATE_FROM, DATE_TO);
          report.operationalApi.ok = true;
          report.operationalApi.rows = apiRows.length;
          report.operationalApi.summary = summarizeOperationalApiRows(apiRows);
          report.operationalApi.sampleFields = apiRows[0] ? Object.keys(apiRows[0]).sort() : [];
        } catch (error) {
          report.operationalApi.error = error instanceof Error ? error.message : String(error);
        }
      }
    }

    if (report.db.preferredWbSaleRows.rows > 0 && report.db.preferredWbSaleRows.logisticsCost === 0) {
      report.conclusions.push('В текущих выбранных WbSale-строках логистика = 0. Если источник — WB_DAILY_STATISTICS, это оперативные sales-строки без детальных расходов.');
    }
    if (report.db.preferredWbSaleRows.rows > 0 && report.db.preferredWbSaleRows.commissionTotal === 0) {
      report.conclusions.push('В текущих выбранных WbSale-строках комиссия WB = 0. Для daily-строк её нужно брать из детального отчёта или временно показывать как предварительную оценку revenue - sellerPayout.');
    }
    if (financeRows.length === 0) {
      report.conclusions.push('В WbFinance нет пересекающегося финального недельного отчёта за этот период; финальная логистика/хранение/штрафы из недельного WB Finance ещё не подтянуты.');
    }

    byCompany[company] = report;
  }

  const result = {
    mode: 'AUDIT_ONLY',
    applied: false,
    ok: true,
    generatedAt: new Date().toISOString(),
    params: {
      dateFrom: DATE_FROM,
      dateTo: DATE_TO,
      companies: COMPANIES,
      fetchWbDetail: FETCH_WB_DETAIL,
    },
    keyPurpose: 'Проверить, почему /profit-wb показывает 0 по комиссии/логистике/хранению/штрафам, и может ли API reportDetailByPeriod дать детальные расходы за день.',
    byCompany,
  };

  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end();
  });
