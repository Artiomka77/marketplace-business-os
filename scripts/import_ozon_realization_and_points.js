const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function getArg(name, fallback = "") {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function createId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 11)}`;
}

function normalizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[–—−]/g, "-")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;

  const text = String(value)
    .replace(/\u00A0/g, "")
    .replace(/\s/g, "")
    .replace(",", ".")
    .replace(/[^\d.-]/g, "");

  const number = Number(text);
  return Number.isFinite(number) ? number : 0;
}

function toInt(value) {
  return Math.round(Math.abs(toNumber(value)));
}

function toDate(value) {
  if (!value) return null;

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }

  if (typeof value === "number") {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) {
      return new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d));
    }
  }

  const text = String(value).trim();
  const ru = text.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (ru) return new Date(Date.UTC(Number(ru[3]), Number(ru[2]) - 1, Number(ru[1])));

  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));

  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function readRows(filePath) {
  const workbook = XLSX.readFile(filePath, { cellDates: true });
  const rows = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });
    for (const row of matrix) rows.push(row);
  }

  return rows;
}

function findHeaderRow(rows, requiredMatchers) {
  for (let i = 0; i < rows.length; i += 1) {
    const normalizedCells = rows[i].map(normalizeText);
    const ok = requiredMatchers.every((matcher) =>
      normalizedCells.some((cell) => matcher(cell))
    );

    if (ok) return i;
  }

  return -1;
}

function findColumn(headers, matcher) {
  for (let i = 0; i < headers.length; i += 1) {
    if (matcher(normalizeText(headers[i]))) return i;
  }

  return -1;
}

function cell(row, index) {
  return index >= 0 ? row[index] : null;
}

function findFirstText(rows, matcher) {
  for (const row of rows) {
    const text = row.map((value) => String(value ?? "")).join(" ");
    if (matcher(normalizeText(text))) return text.trim();
  }
  return "";
}

function parseRealizationReport(filePath, params) {
  const rows = readRows(filePath);

  const headerIndex = findHeaderRow(rows, [
    (value) => value.includes("реализовано") && value.includes("сумм"),
    (value) => value.includes("возвращ") && value.includes("сумм"),
  ]);

  if (headerIndex < 0) {
    throw new Error(
      `Не удалось найти строку заголовков в отчёте реализации: ${filePath}`
    );
  }

  const headers = rows[headerIndex];

  const skuCol = findColumn(headers, (value) =>
    value === "sku" ||
    value.includes("ozon id") ||
    value.includes("id товара") ||
    value.includes("код товара")
  );

  const vendorCodeCol = findColumn(headers, (value) =>
    value.includes("артикул") ||
    value.includes("код продавца")
  );

  const productNameCol = findColumn(headers, (value) =>
    value.includes("наименование") ||
    value.includes("название")
  );

  const operationDateCol = findColumn(headers, (value) =>
    value.includes("дата") && !value.includes("период")
  );

  const realizedQtyCol = findColumn(headers, (value) =>
    value.includes("реализовано") && value.includes("кол")
  );

  const returnedQtyCol = findColumn(headers, (value) =>
    value.includes("возвращ") && value.includes("кол")
  );

  const realizedAmountCol = findColumn(headers, (value) =>
    value.includes("реализовано") && value.includes("сумм")
  );

  const returnedAmountCol = findColumn(headers, (value) =>
    value.includes("возвращ") && value.includes("сумм")
  );

  const partnerProgramsCol = findColumn(headers, (value) =>
    (value.includes("партнер") || value.includes("партнер")) &&
    (value.includes("программ") || value.includes("механик") || value.includes("выплат"))
  );

  if (realizedAmountCol < 0 || returnedAmountCol < 0) {
    throw new Error(
      `Не найдены колонки "Реализовано на сумму" / "Возвращено на сумму" в отчёте реализации: ${filePath}`
    );
  }

  const contractText = findFirstText(rows, (value) => value.includes("договор"));
  const contractNumberMatch = contractText.match(/[А-ЯA-Z]{1,4}[-\s]?\d+[\/\d-]*/i);
  const contractNumber = contractNumberMatch ? contractNumberMatch[0] : "";

  const detailRows = [];

  for (let i = headerIndex + 1; i < rows.length; i += 1) {
    const row = rows[i];
    const realizedAmount = toNumber(cell(row, realizedAmountCol));
    const returnedAmount = Math.abs(toNumber(cell(row, returnedAmountCol)));
    const partnerProgramsAmount = toNumber(cell(row, partnerProgramsCol));

    if (realizedAmount === 0 && returnedAmount === 0 && partnerProgramsAmount === 0) {
      continue;
    }

    const realizedQty = toInt(cell(row, realizedQtyCol));
    const returnedQty = toInt(cell(row, returnedQtyCol));
    const taxableRevenue = realizedAmount - returnedAmount;

    detailRows.push({
      operationDate: toDate(cell(row, operationDateCol)),
      sku: String(cell(row, skuCol) ?? "").trim(),
      vendorCode: String(cell(row, vendorCodeCol) ?? "").trim(),
      productName: String(cell(row, productNameCol) ?? "").trim(),
      realizedQty,
      returnedQty,
      netQty: realizedQty - returnedQty,
      realizedAmount,
      returnedAmount,
      taxableRevenue,
      partnerProgramsAmount,
    });
  }

  const summary = detailRows.reduce(
    (acc, row) => {
      acc.realizedAmount += row.realizedAmount;
      acc.returnedAmount += row.returnedAmount;
      acc.taxableRevenue += row.taxableRevenue;
      acc.partnerProgramsAmount += row.partnerProgramsAmount;
      return acc;
    },
    {
      realizedAmount: 0,
      returnedAmount: 0,
      taxableRevenue: 0,
      partnerProgramsAmount: 0,
    }
  );

  return {
    ...summary,
    contractNumber,
    rows: detailRows,
    rowsCount: detailRows.length,
    sourceFileName: path.basename(filePath),
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
  };
}

function getLastNumber(row) {
  for (let i = row.length - 1; i >= 0; i -= 1) {
    const number = toNumber(row[i]);
    if (number !== 0) return number;
  }
  return 0;
}

function classifyPointsRow(text) {
  const normalized = normalizeText(text);

  if (normalized === "вознаграждение ozon" || normalized.includes("вознаграждение ozon")) {
    return "COMMISSION";
  }

  if (normalized === "услуги доставки") {
    return "LOGISTICS";
  }

  if (normalized === "услуги fbo") {
    return "FBO";
  }

  if (normalized === "продвижение и реклама" || normalized.includes("продвижение и реклама")) {
    return "ADVERTISING";
  }

  if (normalized === "другие услуги и штрафы") {
    return "OTHER";
  }

  return "";
}

function parseDiscountPointsReport(filePath, params) {
  const rows = readRows(filePath);
  const details = [];

  let pointsAccrued = 0;
  let pointsWrittenOff = 0;

  for (const row of rows) {
    const textCells = row.filter((value) => String(value ?? "").trim());
    if (textCells.length === 0) continue;

    const text = String(textCells[0] ?? "").trim();
    const normalized = normalizeText(text);
    const amount = getLastNumber(row);

    if (normalized.includes("начисленные баллы") || normalized.includes("начислено баллов")) {
      pointsAccrued = Math.abs(amount);
      continue;
    }

    if (normalized.includes("списанные баллы") || normalized.includes("списано баллов")) {
      pointsWrittenOff = Math.abs(amount);
      continue;
    }

    const category = classifyPointsRow(text);
    if (!category || amount === 0) continue;

    details.push({
      category,
      name: text,
      amount: Math.abs(amount),
    });
  }

  const totals = {
    commissionPaidByPoints: 0,
    logisticsPaidByPoints: 0,
    fboPaidByPoints: 0,
    advertisingPaidByPoints: 0,
    otherPaidByPoints: 0,
  };

  for (const row of details) {
    if (row.category === "COMMISSION") totals.commissionPaidByPoints += row.amount;
    if (row.category === "LOGISTICS") totals.logisticsPaidByPoints += row.amount;
    if (row.category === "FBO") totals.fboPaidByPoints += row.amount;
    if (row.category === "ADVERTISING") totals.advertisingPaidByPoints += row.amount;
    if (row.category === "OTHER") totals.otherPaidByPoints += row.amount;
  }

  const totalPaidByPoints =
    totals.commissionPaidByPoints +
    totals.logisticsPaidByPoints +
    totals.fboPaidByPoints +
    totals.advertisingPaidByPoints +
    totals.otherPaidByPoints;

  return {
    ...totals,
    totalPaidByPoints,
    pointsAccrued: pointsAccrued || totalPaidByPoints,
    pointsWrittenOff: pointsWrittenOff || totalPaidByPoints,
    rows: details,
    sourceFileName: path.basename(filePath),
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
  };
}

async function upsertRealization(client, companyName, parsed) {
  await client.query(
    `
      DELETE FROM "OzonRealizationRow"
      WHERE "companyName" = $1 AND "dateFrom" = $2::date AND "dateTo" = $3::date
    `,
    [companyName, parsed.dateFrom, parsed.dateTo]
  );

  await client.query(
    `
      DELETE FROM "OzonRealizationSummary"
      WHERE "companyName" = $1 AND "dateFrom" = $2::date AND "dateTo" = $3::date
    `,
    [companyName, parsed.dateFrom, parsed.dateTo]
  );

  const summaryId = createId("ozr");

  await client.query(
    `
      INSERT INTO "OzonRealizationSummary" (
        "id", "companyName", "dateFrom", "dateTo", "contractNumber", "sourceFileName",
        "realizedAmount", "returnedAmount", "taxableRevenue", "partnerProgramsAmount", "rowsCount"
      )
      VALUES ($1, $2, $3::date, $4::date, $5, $6, $7, $8, $9, $10, $11)
    `,
    [
      summaryId,
      companyName,
      parsed.dateFrom,
      parsed.dateTo,
      parsed.contractNumber || null,
      parsed.sourceFileName,
      parsed.realizedAmount,
      parsed.returnedAmount,
      parsed.taxableRevenue,
      parsed.partnerProgramsAmount,
      parsed.rowsCount,
    ]
  );

  for (const row of parsed.rows) {
    await client.query(
      `
        INSERT INTO "OzonRealizationRow" (
          "id", "summaryId", "companyName", "dateFrom", "dateTo", "operationDate",
          "sku", "vendorCode", "productName",
          "realizedQty", "returnedQty", "netQty",
          "realizedAmount", "returnedAmount", "taxableRevenue", "partnerProgramsAmount"
        )
        VALUES (
          $1, $2, $3, $4::date, $5::date, $6,
          $7, $8, $9,
          $10, $11, $12,
          $13, $14, $15, $16
        )
      `,
      [
        createId("ozrr"),
        summaryId,
        companyName,
        parsed.dateFrom,
        parsed.dateTo,
        row.operationDate,
        row.sku || null,
        row.vendorCode || null,
        row.productName || null,
        row.realizedQty,
        row.returnedQty,
        row.netQty,
        row.realizedAmount,
        row.returnedAmount,
        row.taxableRevenue,
        row.partnerProgramsAmount,
      ]
    );
  }

  return summaryId;
}

async function upsertPoints(client, companyName, parsed) {
  await client.query(
    `
      DELETE FROM "OzonDiscountPointsRow"
      WHERE "companyName" = $1 AND "dateFrom" = $2::date AND "dateTo" = $3::date
    `,
    [companyName, parsed.dateFrom, parsed.dateTo]
  );

  await client.query(
    `
      DELETE FROM "OzonDiscountPointsSummary"
      WHERE "companyName" = $1 AND "dateFrom" = $2::date AND "dateTo" = $3::date
    `,
    [companyName, parsed.dateFrom, parsed.dateTo]
  );

  const summaryId = createId("ozp");

  await client.query(
    `
      INSERT INTO "OzonDiscountPointsSummary" (
        "id", "companyName", "dateFrom", "dateTo", "sourceFileName",
        "pointsAccrued", "pointsWrittenOff",
        "commissionPaidByPoints", "logisticsPaidByPoints", "fboPaidByPoints",
        "advertisingPaidByPoints", "otherPaidByPoints", "totalPaidByPoints"
      )
      VALUES (
        $1, $2, $3::date, $4::date, $5,
        $6, $7,
        $8, $9, $10,
        $11, $12, $13
      )
    `,
    [
      summaryId,
      companyName,
      parsed.dateFrom,
      parsed.dateTo,
      parsed.sourceFileName,
      parsed.pointsAccrued,
      parsed.pointsWrittenOff,
      parsed.commissionPaidByPoints,
      parsed.logisticsPaidByPoints,
      parsed.fboPaidByPoints,
      parsed.advertisingPaidByPoints,
      parsed.otherPaidByPoints,
      parsed.totalPaidByPoints,
    ]
  );

  for (const row of parsed.rows) {
    await client.query(
      `
        INSERT INTO "OzonDiscountPointsRow" (
          "id", "summaryId", "companyName", "dateFrom", "dateTo", "category", "name", "amount"
        )
        VALUES ($1, $2, $3, $4::date, $5::date, $6, $7, $8)
      `,
      [
        createId("ozpr"),
        summaryId,
        companyName,
        parsed.dateFrom,
        parsed.dateTo,
        row.category,
        row.name,
        row.amount,
      ]
    );
  }

  return summaryId;
}

async function main() {
  const companyName = getArg("companyName");
  const dateFrom = getArg("dateFrom");
  const dateTo = getArg("dateTo");
  const realizationPath = getArg("realization");
  const pointsPath = getArg("points");

  if (!companyName || !dateFrom || !dateTo) {
    throw new Error(
      "Передайте --companyName, --dateFrom и --dateTo. Например: --companyName=ИП Петров --dateFrom=2026-05-01 --dateTo=2026-05-31"
    );
  }

  if (!realizationPath && !pointsPath) {
    throw new Error("Передайте хотя бы один файл: --realization=... или --points=...");
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    let realization = null;
    let points = null;

    if (realizationPath) {
      if (!fs.existsSync(realizationPath)) throw new Error(`Файл не найден: ${realizationPath}`);
      realization = parseRealizationReport(realizationPath, { dateFrom, dateTo });
      await upsertRealization(client, companyName, realization);
    }

    if (pointsPath) {
      if (!fs.existsSync(pointsPath)) throw new Error(`Файл не найден: ${pointsPath}`);
      points = parseDiscountPointsReport(pointsPath, { dateFrom, dateTo });
      await upsertPoints(client, companyName, points);
    }

    await client.query("COMMIT");

    console.log("OZON REALIZATION IMPORT OK");
    console.log(JSON.stringify({
      companyName,
      dateFrom,
      dateTo,
      realization: realization
        ? {
            realizedAmount: realization.realizedAmount,
            returnedAmount: realization.returnedAmount,
            taxableRevenue: realization.taxableRevenue,
            partnerProgramsAmount: realization.partnerProgramsAmount,
            rowsCount: realization.rowsCount,
            sourceFileName: realization.sourceFileName,
          }
        : null,
      points: points
        ? {
            pointsAccrued: points.pointsAccrued,
            pointsWrittenOff: points.pointsWrittenOff,
            commissionPaidByPoints: points.commissionPaidByPoints,
            logisticsPaidByPoints: points.logisticsPaidByPoints,
            fboPaidByPoints: points.fboPaidByPoints,
            advertisingPaidByPoints: points.advertisingPaidByPoints,
            otherPaidByPoints: points.otherPaidByPoints,
            totalPaidByPoints: points.totalPaidByPoints,
            sourceFileName: points.sourceFileName,
          }
        : null,
    }, null, 2));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("OZON REALIZATION IMPORT FAILED");
    console.error(error);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
