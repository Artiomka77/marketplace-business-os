import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

function normalizeKey(value: string) {
  return value
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/\s+/g, " ")
    .trim();
}

function getValue(row: Record<string, unknown>, possibleKeys: string[]) {
  const entries = Object.entries(row);

  for (const key of possibleKeys) {
    const normalizedTarget = normalizeKey(key);

    const found = entries.find(
      ([rowKey]) => normalizeKey(rowKey) === normalizedTarget
    );

    if (found) return found[1];
  }

  return null;
}

function toStringValue(value: unknown) {
  return String(value ?? "").trim();
}

function toDecimal(value: unknown) {
  if (value === null || value === undefined || value === "") return null;

  const normalized = String(value)
    .replace(/\s/g, "")
    .replace(",", ".")
    .replace(/[^\d.-]/g, "");

  if (!normalized) return null;

  const number = Number(normalized);

  if (!Number.isFinite(number)) return null;

  return new Prisma.Decimal(number);
}

function toDate(value: unknown) {
  if (!value) return null;

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }

  const raw = String(value).trim();

  if (!raw) return null;

  const parsed = new Date(raw);

  if (!Number.isNaN(parsed.getTime())) {
    return parsed;
  }

  return null;
}

export async function normalizeProductCost(
  rows: Record<string, unknown>[],
  importSessionId: string
) {
  const prepared = rows
    .map((row) => {
      const vendorCode = toStringValue(
        getValue(row, [
          "Артикул продавца",
          "Артикул",
          "Артикул поставщика",
          "vendorCode",
          "vendor_code",
          "sku",
        ])
      );

      const costPrice = toDecimal(
        getValue(row, [
          "Себестоимость",
          "Себестоимость товара",
          "Закупочная цена",
          "Цена закупки",
          "costPrice",
          "cost_price",
          "cost",
        ])
      );

      const name = toStringValue(
        getValue(row, [
          "Наименование",
          "Название",
          "Название товара",
          "Предмет",
          "Товар",
          "name",
        ])
      );

      const costDate =
        toDate(
          getValue(row, [
            "Дата",
            "Дата себестоимости",
            "Дата закупки",
            "costDate",
            "cost_date",
          ])
        ) ?? new Date();

      if (!vendorCode || !costPrice) {
        return null;
      }

      return {
        vendorCode,
        costPrice,
        name: name || null,
        costDate,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  const uniqueVendorCodes = Array.from(
    new Set(prepared.map((row) => row.vendorCode))
  );

  await prisma.$transaction(async (tx) => {
    await tx.productCost.deleteMany({
      where: {
        vendorCode: {
          in: uniqueVendorCodes,
        },
      },
    });

    if (prepared.length > 0) {
      await tx.productCost.createMany({
        data: prepared,
      });
    }
  });

  return {
    importSessionId,
    savedRows: prepared.length,
    skippedRows: rows.length - prepared.length,
  };
}