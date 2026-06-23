import { prisma } from "@/lib/prisma";

function normalizeHeader(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/\s+/g, " ")
    .trim();
}

function getByHeader(row: Record<string, unknown>, candidates: string[]) {
  const entries = Object.entries(row);
  const normalizedCandidates = candidates.map(normalizeHeader);

  for (const [key, value] of entries) {
    const normalizedKey = normalizeHeader(key);

    if (normalizedCandidates.includes(normalizedKey)) {
      return value;
    }
  }

  return null;
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value === "number") {
    return Number.isNaN(value) ? null : value;
  }

  const normalized = String(value)
    .replace(/\s/g, "")
    .replace(",", ".")
    .replace(/[^\d.-]/g, "");

  if (!normalized) return null;

  const number = Number(normalized);

  return Number.isNaN(number) ? null : number;
}

function toInt(value: unknown): number {
  const number = toNumber(value);

  if (number === null) return 0;

  return Math.max(0, Math.trunc(number));
}

function toText(value: unknown): string | null {
  const text = String(value ?? "").trim();

  return text ? text : null;
}

function parseDate(value: unknown): Date | null {
  if (!value) return null;

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }

  const text = String(value).trim();

  const russianDate = text.match(/^(\d{2})[.\-_](\d{2})[.\-_](\d{4})$/);

  if (russianDate) {
    const [, day, month, year] = russianDate;
    const date = new Date(
      Date.UTC(Number(year), Number(month) - 1, Number(day), 12, 0, 0)
    );

    return Number.isNaN(date.getTime()) ? null : date;
  }

  const date = new Date(text);

  return Number.isNaN(date.getTime()) ? null : date;
}

function isServiceRow(row: {
  companyName: string | null;
  vendorCode: string | null;
}) {
  const companyText = normalizeHeader(row.companyName);
  const vendorCodeText = normalizeHeader(row.vendorCode);

  return (
    !vendorCodeText ||
    vendorCodeText === "артикул" ||
    companyText === "компания"
  );
}

export async function normalizeOzonWarehouseStock(
  rows: Record<string, unknown>[],
  importSessionId: string,
  fallbackCompanyName: string
) {
  const data = rows
    .map((row) => {
      const companyName =
        toText(getByHeader(row, ["Компания"])) ?? fallbackCompanyName;
      const vendorCode = toText(getByHeader(row, ["Артикул"]));
      const warehouseQty = toInt(getByHeader(row, ["Количество на складе, шт"]));
      const reservedQty = toInt(getByHeader(row, ["Резерв, шт"]));
      const availableForSupplyQty = Math.max(0, warehouseQty - reservedQty);

      return {
        importSessionId,
        companyName,
        vendorCode: vendorCode ?? "",
        sku: toText(getByHeader(row, ["SKU Ozon", "SKU"])),
        productName: toText(
          getByHeader(row, ["Название товара", "Название"])
        ),
        color: toText(getByHeader(row, ["Цвет"])),
        size: toText(getByHeader(row, ["Размер"])),
        barcode: toText(getByHeader(row, ["Штрихкод", "Баркод"])),
        warehouseQty,
        reservedQty,
        availableForSupplyQty,
        costPrice: toNumber(getByHeader(row, ["Себестоимость"])),
        inventoryDate: parseDate(getByHeader(row, ["Дата инвентаризации"])),
        comment: toText(getByHeader(row, ["Комментарий"])),
      };
    })
    .filter((row) => !isServiceRow(row));

  if (data.length === 0) {
    return {
      savedRows: 0,
    };
  }

  const companyNames = Array.from(
    new Set(data.map((row) => row.companyName).filter(Boolean))
  );

  await prisma.ozonWarehouseStock.deleteMany({
    where: {
      companyName: {
        in: companyNames,
      },
    },
  });

  await prisma.ozonWarehouseStock.createMany({
    data,
  });

  return {
    savedRows: data.length,
  };
}
