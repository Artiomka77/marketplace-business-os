import "dotenv/config";

import path from "path";
import * as XLSX from "xlsx";
import { prisma } from "../lib/prisma";

function normalizeHeader(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/\s+/g, " ")
    .trim();
}

function toNumber(value: unknown) {
  const number = Number(
    String(value ?? "")
      .replace(/\s/g, "")
      .replace(",", ".")
  );

  return Number.isFinite(number) ? number : 0;
}

function toDate(value: unknown) {
  if (!value) return new Date("2026-06-11T12:00:00.000Z");

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }

  if (typeof value === "number") {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) {
      return new Date(parsed.y, parsed.m - 1, parsed.d, 12, 0, 0);
    }
  }

  const text = String(value).trim();
  const parts = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);

  if (parts) {
    return new Date(Number(parts[3]), Number(parts[2]) - 1, Number(parts[1]), 12);
  }

  const date = new Date(text);
  return Number.isNaN(date.getTime())
    ? new Date("2026-06-11T12:00:00.000Z")
    : date;
}

async function main() {
  const fileArg = process.argv[2];

  if (!fileArg) {
    throw new Error(
      "Укажи путь к файлу. Пример: npx tsx scripts/import-wb-prime-costs.ts .\\wb_prime_costs_2026_06_11_08_32.xlsx"
    );
  }

  const filePath = path.resolve(process.cwd(), fileArg);
  const workbook = XLSX.readFile(filePath, { cellDates: true });

  const sheetName =
    workbook.SheetNames.find((name) =>
      normalizeHeader(name).includes("себестоимость")
    ) ?? workbook.SheetNames[0];

  const sheet = workbook.Sheets[sheetName];

  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: "",
  });

  const parsedRows = rows
    .map((row) => {
      const entries = Object.entries(row);

      function getByHeader(expected: string) {
        const found = entries.find(([key]) =>
          normalizeHeader(key).includes(expected)
        );

        return found?.[1] ?? "";
      }

      const vendorCode = String(getByHeader("артикул продавца")).trim();
      const costPrice = toNumber(getByHeader("себестоимость"));
      const name = String(getByHeader("название")).trim();
      const costDate = toDate(getByHeader("дата себестоимости"));

      return {
        vendorCode,
        costPrice,
        name,
        costDate,
      };
    })
    .filter((row) => row.vendorCode && row.costPrice > 0);

  if (parsedRows.length === 0) {
    throw new Error("Не нашёл строк с артикулами и себестоимостью.");
  }

  const vendorCodes = [...new Set(parsedRows.map((row) => row.vendorCode))];

  await prisma.$transaction([
    prisma.productCost.deleteMany({
      where: {
        vendorCode: {
          in: vendorCodes,
        },
      },
    }),

    prisma.productCost.createMany({
      data: parsedRows.map((row) => ({
        vendorCode: row.vendorCode,
        nmId: null,
        costPrice: row.costPrice,
        name: row.name || null,
        costDate: row.costDate,
      })),
    }),
  ]);

  console.log("WB себестоимость загружена.");
  console.log(`Лист: ${sheetName}`);
  console.log(`Строк в файле: ${rows.length}`);
  console.log(`Загружено строк: ${parsedRows.length}`);
  console.log(`Уникальных артикулов: ${vendorCodes.length}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });