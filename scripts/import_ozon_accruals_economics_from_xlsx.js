#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { randomUUID } = require('crypto');
const XLSX = require('xlsx');

function parseArgs() {
  const args = {};
  for (const arg of process.argv.slice(2)) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match) args[match[1]] = match[2];
  }

  if (!args.file || !args.dateFrom || !args.dateTo || !args.companyName) {
    console.error('Usage: node scripts/import_ozon_accruals_economics_from_xlsx.js --file=/work/tmp/report.xlsx --dateFrom=YYYY-MM-DD --dateTo=YYYY-MM-DD --companyName="ИП Петров"');
    process.exit(1);
  }

  return args;
}

function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(/[–—−]/g, '-')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const parsed = Number(
    String(value)
      .replace(/\u00A0/g, '')
      .replace(/\s/g, '')
      .replace(',', '.')
      .replace(/[^\d.-]/g, ''),
  );
  return Number.isFinite(parsed) ? parsed : 0;
}

function money(value) {
  return new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(toNumber(value));
}

function createId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function toDateKey(value) {
  if (!value) return '';

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }

  if (typeof value === 'number') {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) {
      return new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d)).toISOString().slice(0, 10);
    }
  }

  const text = String(value).trim();
  const ru = text.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  if (ru) return `${ru[3]}-${ru[2]}-${ru[1]}`;

  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

function addDays(dateText, days) {
  const date = new Date(`${dateText}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function listDays(dateFrom, dateTo) {
  const days = [];
  for (let day = dateFrom; day <= dateTo; day = addDays(day, 1)) days.push(day);
  return days;
}

function findHeader(matrix) {
  for (let i = 0; i < matrix.length; i += 1) {
    const cells = matrix[i].map(normalizeText);
    const hasDate = cells.some((cell) => cell.includes('дата начисления'));
    const hasGroup = cells.some((cell) => cell.includes('группа услуг'));
    const hasType = cells.some((cell) => cell.includes('тип начисления'));
    const hasAmount = cells.some((cell) => cell.includes('сумма итого'));
    if (hasDate && hasGroup && hasType && hasAmount) return i;
  }
  return -1;
}

function findColumn(headers, predicate) {
  for (let i = 0; i < headers.length; i += 1) {
    if (predicate(normalizeText(headers[i]))) return i;
  }
  return -1;
}

function emptyComponents(dateKey = null) {
  return {
    dateKey,
    rows: 0,
    taxableRevenue: 0,
    realizedAmount: 0,
    returnedAmount: 0,
    discountPointsSales: 0,
    discountPointsReturns: 0,
    discountPointsAmount: 0,
    partnerProgramsSales: 0,
    partnerProgramsReturns: 0,
    partnerProgramsAmount: 0,
    economicTurnover: 0,
    unclassifiedRevenue: 0,
  };
}

function addComponent(acc, groupRaw, typeRaw, amount) {
  const group = normalizeText(groupRaw);
  const type = normalizeText(typeRaw);

  if (group.includes('продажи') && type === 'выручка') {
    acc.realizedAmount += amount;
    acc.taxableRevenue += amount;
    acc.economicTurnover += amount;
    return true;
  }

  if (group.includes('возврат') && (type.includes('возврат выручки') || type === 'выручка')) {
    const negative = amount > 0 ? -amount : amount;
    acc.returnedAmount += Math.abs(negative);
    acc.taxableRevenue += negative;
    acc.economicTurnover += negative;
    return true;
  }

  if (group.includes('продажи') && type.includes('балл') && type.includes('скид')) {
    acc.discountPointsSales += amount;
    acc.discountPointsAmount += amount;
    acc.economicTurnover += amount;
    return true;
  }

  if (group.includes('возврат') && type.includes('балл') && type.includes('скид')) {
    const negative = amount > 0 ? -amount : amount;
    acc.discountPointsReturns += Math.abs(negative);
    acc.discountPointsAmount += negative;
    acc.economicTurnover += negative;
    return true;
  }

  if (group.includes('продажи') && type.includes('программ') && type.includes('партнер')) {
    acc.partnerProgramsSales += amount;
    acc.partnerProgramsAmount += amount;
    acc.economicTurnover += amount;
    return true;
  }

  if (group.includes('возврат') && type.includes('программ') && type.includes('партнер')) {
    const negative = amount > 0 ? -amount : amount;
    acc.partnerProgramsReturns += Math.abs(negative);
    acc.partnerProgramsAmount += negative;
    acc.economicTurnover += negative;
    return true;
  }

  return false;
}

function parseReport(filePath, dateFrom, dateTo) {
  const workbook = XLSX.readFile(filePath, { cellDates: true });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) throw new Error('В Excel-файле нет листов');

  const sheet = workbook.Sheets[firstSheetName];
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });
  const headerIndex = findHeader(matrix);
  if (headerIndex < 0) {
    throw new Error('Не найдена строка заголовков отчёта начислений Ozon. Нужны колонки: Дата начисления, Группа услуг, Тип начисления, Сумма итого, руб.');
  }

  const headers = matrix[headerIndex];
  const dateCol = findColumn(headers, (v) => v.includes('дата начисления'));
  const groupCol = findColumn(headers, (v) => v.includes('группа услуг'));
  const typeCol = findColumn(headers, (v) => v.includes('тип начисления'));
  const amountCol = findColumn(headers, (v) => v.includes('сумма итого'));

  if (dateCol < 0 || groupCol < 0 || typeCol < 0 || amountCol < 0) {
    throw new Error('Не найдены обязательные колонки отчёта начислений Ozon');
  }

  const byDay = new Map();
  const period = emptyComponents(null);
  const serviceTotals = new Map();

  for (let i = headerIndex + 1; i < matrix.length; i += 1) {
    const row = matrix[i];
    const dateKey = toDateKey(row[dateCol]);
    if (!dateKey || dateKey < dateFrom || dateKey > dateTo) continue;

    const group = row[groupCol];
    const type = row[typeCol];
    const amount = toNumber(row[amountCol]);
    if (amount === 0) continue;

    if (!byDay.has(dateKey)) byDay.set(dateKey, emptyComponents(dateKey));
    const day = byDay.get(dateKey);

    day.rows += 1;
    period.rows += 1;

    const serviceKey = `${String(group ?? '').trim()} / ${String(type ?? '').trim()}`;
    serviceTotals.set(serviceKey, (serviceTotals.get(serviceKey) || 0) + amount);

    const classifiedDay = addComponent(day, group, type, amount);
    const classifiedPeriod = addComponent(period, group, type, amount);

    if (!classifiedDay || !classifiedPeriod) {
      // Not a revenue component. Expenses are intentionally ignored here:
      // Ozon expenses are already taken from OzonFinance in profitAnalyticsOzon.
    }
  }

  const expectedDays = listDays(dateFrom, dateTo);
  const missingReportDays = expectedDays.filter((day) => !byDay.has(day));

  return {
    sheetName: firstSheetName,
    headerRow: headerIndex + 1,
    expectedDays,
    missingReportDays,
    byDay,
    period,
    serviceTotals,
  };
}

async function tableExists(client, tableName) {
  const result = await client.query('SELECT to_regclass($1) IS NOT NULL AS exists', [`public."${tableName}"`]);
  return Boolean(result.rows[0]?.exists);
}

async function ensureTables(client) {
  const required = ['ImportSession', 'OzonRealizationSummary', 'OzonRealizationRow', 'OzonDiscountPointsSummary', 'OzonDiscountPointsRow'];
  const missing = [];
  for (const table of required) {
    if (!(await tableExists(client, table))) missing.push(table);
  }
  if (missing.length > 0) {
    throw new Error(`Отсутствуют таблицы: ${missing.join(', ')}`);
  }
}

async function deleteExistingForPeriod(client, companyName, dateFrom, dateTo) {
  await client.query(
    'DELETE FROM "OzonRealizationRow" WHERE "companyName" = $1 AND "dateFrom"::date = $2::date AND "dateTo"::date = $3::date',
    [companyName, dateFrom, dateTo],
  );
  await client.query(
    'DELETE FROM "OzonRealizationSummary" WHERE "companyName" = $1 AND "dateFrom"::date = $2::date AND "dateTo"::date = $3::date',
    [companyName, dateFrom, dateTo],
  );
  await client.query(
    'DELETE FROM "OzonDiscountPointsRow" WHERE "companyName" = $1 AND "dateFrom"::date = $2::date AND "dateTo"::date = $3::date',
    [companyName, dateFrom, dateTo],
  );
  await client.query(
    'DELETE FROM "OzonDiscountPointsSummary" WHERE "companyName" = $1 AND "dateFrom"::date = $2::date AND "dateTo"::date = $3::date',
    [companyName, dateFrom, dateTo],
  );
}

async function insertImportSession(client, params) {
  const id = createId('impozaccr');
  await client.query(
    `
      INSERT INTO "ImportSession" (
        "id", "fileName", "reportType", "marketplace", "companyName", "rowsCount",
        "previewJson", "sheetName", "headerRow", "status", "createdAt"
      )
      VALUES ($1, $2, 'OZON_ACCRUALS_ECONOMICS', 'OZON', $3, $4, $5::jsonb, $6, $7, $8, NOW())
    `,
    [
      id,
      params.fileName,
      params.companyName,
      params.rowsCount,
      JSON.stringify(params.previewJson),
      params.sheetName,
      params.headerRow,
      params.status,
    ],
  );
  return id;
}

async function insertSummaries(client, params) {
  const { companyName, dateFrom, dateTo, components, importSessionId, sourceFileName, rowsCount } = params;
  const realizationSummaryId = createId('ozracc');
  const pointsSummaryId = createId('ozpacc');

  await deleteExistingForPeriod(client, companyName, dateFrom, dateTo);

  await client.query(
    `
      INSERT INTO "OzonRealizationSummary" (
        "id", "importSessionId", "companyName", "dateFrom", "dateTo", "contractNumber", "sourceFileName",
        "realizedAmount", "returnedAmount", "taxableRevenue", "partnerProgramsAmount", "rowsCount", "createdAt"
      )
      VALUES ($1, $2, $3, $4::date, $5::date, 'OZON_ACCRUALS_REPORT', $6, $7, $8, $9, $10, $11, NOW())
    `,
    [
      realizationSummaryId,
      importSessionId,
      companyName,
      dateFrom,
      dateTo,
      sourceFileName,
      components.realizedAmount,
      components.returnedAmount,
      components.taxableRevenue,
      components.partnerProgramsAmount,
      rowsCount,
    ],
  );

  await client.query(
    `
      INSERT INTO "OzonRealizationRow" (
        "id", "summaryId", "importSessionId", "companyName", "dateFrom", "dateTo", "operationDate",
        "sku", "vendorCode", "productName", "realizedQty", "returnedQty", "netQty",
        "realizedAmount", "returnedAmount", "taxableRevenue", "partnerProgramsAmount", "createdAt"
      )
      VALUES ($1, $2, $3, $4, $5::date, $6::date, $5::date, NULL, NULL, $7, 0, 0, 0, $8, $9, $10, $11, NOW())
    `,
    [
      createId('ozrracc'),
      realizationSummaryId,
      importSessionId,
      companyName,
      dateFrom,
      dateTo,
      dateFrom === dateTo ? 'Итого по дню из отчёта начислений Ozon' : 'Итого за период из отчёта начислений Ozon',
      components.realizedAmount,
      components.returnedAmount,
      components.taxableRevenue,
      components.partnerProgramsAmount,
    ],
  );

  await client.query(
    `
      INSERT INTO "OzonDiscountPointsSummary" (
        "id", "importSessionId", "companyName", "dateFrom", "dateTo", "sourceFileName",
        "pointsAccrued", "pointsWrittenOff", "commissionPaidByPoints", "logisticsPaidByPoints", "fboPaidByPoints",
        "advertisingPaidByPoints", "otherPaidByPoints", "totalPaidByPoints", "createdAt"
      )
      VALUES ($1, $2, $3, $4::date, $5::date, $6, $7, $8, 0, 0, 0, 0, $9, $10, NOW())
    `,
    [
      pointsSummaryId,
      importSessionId,
      companyName,
      dateFrom,
      dateTo,
      sourceFileName,
      components.discountPointsSales,
      components.discountPointsReturns,
      components.discountPointsAmount,
      components.discountPointsAmount,
    ],
  );

  if (Math.abs(components.discountPointsAmount) > 0.005) {
    await client.query(
      `
        INSERT INTO "OzonDiscountPointsRow" (
          "id", "summaryId", "importSessionId", "companyName", "dateFrom", "dateTo", "category", "name", "amount", "createdAt"
        )
        VALUES ($1, $2, $3, $4, $5::date, $6::date, 'DISCOUNT_POINTS', 'Баллы за скидки Ozon из отчёта начислений', $7, NOW())
      `,
      [
        createId('ozpracc'),
        pointsSummaryId,
        importSessionId,
        companyName,
        dateFrom,
        dateTo,
        components.discountPointsAmount,
      ],
    );
  }
}

async function main() {
  const args = parseArgs();
  const filePath = path.resolve(args.file);
  if (!fs.existsSync(filePath)) throw new Error(`Файл не найден: ${filePath}`);

  const parsed = parseReport(filePath, args.dateFrom, args.dateTo);
  const preview = {
    dateFrom: args.dateFrom,
    dateTo: args.dateTo,
    companyName: args.companyName,
    expectedDays: parsed.expectedDays.length,
    reportDays: parsed.byDay.size,
    missingReportDays: parsed.missingReportDays,
    period: parsed.period,
  };

  console.log('[ozon-accruals-economics-import] parsed');
  console.log(JSON.stringify(preview, null, 2));

  if (parsed.period.rows === 0) {
    throw new Error('В выбранном периоде не найдено строк отчёта начислений');
  }

  if (Math.abs(parsed.period.economicTurnover) < 0.005) {
    throw new Error('Экономический оборот по отчёту равен нулю. Проверьте период и файл.');
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    await ensureTables(client);
    await client.query('BEGIN');

    const importSessionId = await insertImportSession(client, {
      fileName: path.basename(filePath),
      companyName: args.companyName,
      rowsCount: parsed.period.rows,
      previewJson: preview,
      sheetName: parsed.sheetName,
      headerRow: parsed.headerRow,
      status: parsed.missingReportDays.length ? 'WARNING' : 'SUCCESS',
    });

    await insertSummaries(client, {
      companyName: args.companyName,
      dateFrom: args.dateFrom,
      dateTo: args.dateTo,
      components: parsed.period,
      importSessionId,
      sourceFileName: path.basename(filePath),
      rowsCount: parsed.period.rows,
    });

    for (const day of parsed.expectedDays) {
      const dayComponents = parsed.byDay.get(day);
      if (!dayComponents) continue;
      await insertSummaries(client, {
        companyName: args.companyName,
        dateFrom: day,
        dateTo: day,
        components: dayComponents,
        importSessionId,
        sourceFileName: path.basename(filePath),
        rowsCount: dayComponents.rows,
      });
    }

    await client.query('COMMIT');

    const byDayRows = parsed.expectedDays.map((day) => {
      const c = parsed.byDay.get(day) || emptyComponents(day);
      return {
        date: day,
        rows: c.rows,
        economicTurnover: money(c.economicTurnover),
        taxableRevenue: money(c.taxableRevenue),
        discountPoints: money(c.discountPointsAmount),
        partnerPrograms: money(c.partnerProgramsAmount),
      };
    });

    console.log('\n=== PERIOD TOTALS FROM OZON ACCRUALS REPORT ===');
    console.table([
      {
        companyName: args.companyName,
        dateFrom: args.dateFrom,
        dateTo: args.dateTo,
        rows: parsed.period.rows,
        economicTurnover: money(parsed.period.economicTurnover),
        taxableRevenue: money(parsed.period.taxableRevenue),
        discountPoints: money(parsed.period.discountPointsAmount),
        partnerPrograms: money(parsed.period.partnerProgramsAmount),
      },
    ]);

    console.log('\n=== DAILY TOTALS FROM OZON ACCRUALS REPORT ===');
    console.table(byDayRows);

    console.log('\n[ozon-accruals-economics-import] done');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[ozon-accruals-economics-import] failed');
    console.error(error);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
