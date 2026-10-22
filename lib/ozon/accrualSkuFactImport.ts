import { spawnSync } from "child_process";
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";

export type ImportOzonAccrualSkuFactsResult = {
  status: "SUCCESS" | "WARNING";
  companyName: string;
  marketplaceAccountId: string | null;
  sourceFileName: string;
  sourceFileHash: string;
  dateFrom: string;
  dateTo: string;
  parsedRows: number;
  upsertedFacts: number;
  skippedNoSku: number;
};

type ParsedFact = {
  operationDate: string;
  vendorCode: string;
  sku: string;
  taxableRevenue: number;
  discountPoints: number;
  partnerPrograms: number;
  commissionExpense: number;
  logisticsExpense: number;
  otherSkuExpense: number;
  fboExpense: number;
  adsExpense: number;
  rowsCount: number;
};

export function isOzonAccrualSkuReportMatrix(matrix: unknown[][]): boolean {
  // Kept for reportDetector fallback checks on decoded matrices.
  for (let i = 0; i < Math.min(matrix.length, 12); i++) {
    const row = (matrix[i] ?? []).map((c) =>
      String(c ?? "")
        .toLowerCase()
        .replaceAll("ё", "е"),
    );
    if (row.some((c) => c.includes("группа услуг")) && row.some((c) => c.includes("дата начисления"))) {
      return true;
    }
    if (row.some((c) => c.trim() === "sku") && row.length >= 10) return true;
  }
  return false;
}

export async function resolveOzonMarketplaceAccountId(companyName: string) {
  const company = await prisma.company.findFirst({
    where: { name: companyName },
    select: { id: true },
  });
  if (!company) return null;
  const marketplace = await prisma.marketplace.findFirst({
    where: { code: "OZON" },
    select: { id: true },
  });
  if (!marketplace) return null;
  const account = await prisma.marketplaceAccount.findFirst({
    where: { companyId: company.id, marketplaceId: marketplace.id },
    select: { id: true },
  });
  return account?.id ?? null;
}

function parseWithPython(buf: Buffer, sourceFileName: string) {
  const dir = mkdtempSync(join(tmpdir(), "ozon-accrual-"));
  const xlsxPath = join(dir, sourceFileName.endsWith(".xlsx") ? sourceFileName : "report.xlsx");
  const jsonPath = join(dir, "facts.json");
  writeFileSync(xlsxPath, buf);

  const scriptCandidates = [
    join(process.cwd(), "lib/ozon/parse_accrual_sku_xlsx.py"),
    "/app/lib/ozon/parse_accrual_sku_xlsx.py",
    "/app/parse_accrual_sku_xlsx.py",
    "/app/scripts/parse_accrual_sku_xlsx.py",
    join(__dirname, "parse_accrual_sku_xlsx.py"),
  ];
  let script = scriptCandidates.find((p) => {
    try {
      readFileSync(p);
      return true;
    } catch {
      return false;
    }
  });
  if (!script) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error("parse_accrual_sku_xlsx.py not found");
  }

  const py = spawnSync("python3", [script, xlsxPath, jsonPath], {
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (py.status !== 0) {
    const err = (py.stderr || py.stdout || "python parse failed").toString();
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`Ozon accrual XLSX parse failed: ${err.slice(0, 500)}`);
  }
  const parsed = JSON.parse(readFileSync(jsonPath, "utf-8")) as {
    parsedRows: number;
    skippedNoSku: number;
    facts: ParsedFact[];
    sourceFileHash?: string;
  };
  rmSync(dir, { recursive: true, force: true });
  return parsed;
}

/**
 * Durable company-bound import of official Ozon «Отчёт по начислениям».
 * Uses openpyxl parser (Cyrillic-safe). Does NOT mutate top-level P&L.
 */
export async function importOzonAccrualSkuFactsFromBuffer(params: {
  fileBuffer: Buffer | Uint8Array;
  companyName: string;
  sourceFileName?: string;
  marketplaceAccountId?: string | null;
}): Promise<ImportOzonAccrualSkuFactsResult> {
  const companyName = String(params.companyName || "").trim();
  if (!companyName) throw new Error("companyName is required for accrual SKU import");

  const marketplaceAccountId =
    params.marketplaceAccountId ??
    (await resolveOzonMarketplaceAccountId(companyName));

  const sourceFileName = params.sourceFileName || "ozon-accrual.xlsx";
  const buf = Buffer.from(params.fileBuffer);
  const sourceFileHash = createHash("sha256").update(buf).digest("hex");
  const parsed = parseWithPython(buf, sourceFileName);
  const facts = parsed.facts || [];
  if (!facts.length) throw new Error("В отчёте нет SKU/артикул строк для импорта");

  const dates = [...new Set(facts.map((f) => f.operationDate))];
  await prisma.$executeRawUnsafe(
    `DELETE FROM "OzonAccrualSkuFact"
     WHERE "companyName" = $1
       AND "operationDate" = ANY($2::date[])`,
    companyName,
    dates,
  );

  let upserted = 0;
  const minDate = dates.slice().sort()[0];
  const maxDate = dates.slice().sort().slice(-1)[0];
  for (const f of facts) {
    const id = `oasf_${companyName}_${f.operationDate}_${f.vendorCode || "nov"}_${f.sku || "nosku"}`
      .replace(/\s+/g, "_")
      .slice(0, 180);
    await prisma.$executeRawUnsafe(
      `INSERT INTO "OzonAccrualSkuFact" (
        id, "companyName", "marketplaceAccountId", "operationDate", "vendorCode", sku,
        "taxableRevenue", "discountPoints", "partnerPrograms",
        "commissionExpense", "logisticsExpense", "otherSkuExpense",
        "fboExpense", "adsExpense", "rowsCount",
        "sourceType", "sourceFileName", "sourceFileHash",
        "sourcePeriodFrom", "sourcePeriodTo", "createdAt", "updatedAt"
      ) VALUES (
        $1,$2,$3,$4::date,$5,$6,
        $7,$8,$9,$10,$11,$12,$13,$14,$15,
        'OWNER_XLSX_IMPORT',$16,$17,$18::date,$19::date,NOW(),NOW()
      )
      ON CONFLICT ("companyName", "operationDate", "vendorCode", sku)
      DO UPDATE SET
        "marketplaceAccountId"=EXCLUDED."marketplaceAccountId",
        "taxableRevenue"=EXCLUDED."taxableRevenue",
        "discountPoints"=EXCLUDED."discountPoints",
        "partnerPrograms"=EXCLUDED."partnerPrograms",
        "commissionExpense"=EXCLUDED."commissionExpense",
        "logisticsExpense"=EXCLUDED."logisticsExpense",
        "otherSkuExpense"=EXCLUDED."otherSkuExpense",
        "fboExpense"=EXCLUDED."fboExpense",
        "adsExpense"=EXCLUDED."adsExpense",
        "rowsCount"=EXCLUDED."rowsCount",
        "sourceType"=EXCLUDED."sourceType",
        "sourceFileName"=EXCLUDED."sourceFileName",
        "sourceFileHash"=EXCLUDED."sourceFileHash",
        "sourcePeriodFrom"=EXCLUDED."sourcePeriodFrom",
        "sourcePeriodTo"=EXCLUDED."sourcePeriodTo",
        "updatedAt"=NOW()`,
      id,
      companyName,
      marketplaceAccountId,
      f.operationDate,
      f.vendorCode || "",
      f.sku || "",
      f.taxableRevenue,
      f.discountPoints,
      f.partnerPrograms,
      f.commissionExpense,
      f.logisticsExpense,
      f.otherSkuExpense,
      f.fboExpense,
      f.adsExpense,
      f.rowsCount,
      sourceFileName,
      sourceFileHash,
      minDate,
      maxDate,
    );
    upserted += 1;
  }

  return {
    status: parsed.skippedNoSku > 0 ? "WARNING" : "SUCCESS",
    companyName,
    marketplaceAccountId,
    sourceFileName,
    sourceFileHash,
    dateFrom: minDate,
    dateTo: maxDate,
    parsedRows: parsed.parsedRows,
    upsertedFacts: upserted,
    skippedNoSku: parsed.skippedNoSku,
  };
}
