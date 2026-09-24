import { prisma } from "@/lib/prisma";

function normalizeHeader(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[–—−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeKey(value: unknown) {
  return normalizeHeader(value).replace(/\s+/g, "");
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

  const excelSerial = toNumber(text);

  if (excelSerial !== null && excelSerial > 20000 && excelSerial < 80000) {
    const date = new Date(Date.UTC(1899, 11, 30 + Math.trunc(excelSerial), 12, 0, 0));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const date = new Date(text);

  return Number.isNaN(date.getTime()) ? null : date;
}

function getWarehouseQty(row: Record<string, unknown>) {
  const warehouseQty = toNumber(
    getByHeader(row, [
      "Количество на складе, шт",
      "Остаток на складе, шт",
      "Остаток, шт",
      "Остаток",
      "Количество",
      "Кол-во",
    ])
  );

  const reservedQty = toNumber(
    getByHeader(row, [
      "Резерв, шт",
      "Резерв",
      "Зарезервировано",
      "Забронировано",
    ])
  );

  const availableForSupplyQty = toNumber(
    getByHeader(row, [
      "Доступно к поставке, шт",
      "Доступно к поставке",
      "Доступно",
      "Свободный остаток",
    ])
  );

  const safeReservedQty = Math.max(0, Math.trunc(reservedQty ?? 0));

  if (warehouseQty !== null) {
    const safeWarehouseQty = Math.max(0, Math.trunc(warehouseQty));

    return {
      warehouseQty: safeWarehouseQty,
      reservedQty: safeReservedQty,
      availableForSupplyQty: Math.max(0, safeWarehouseQty - safeReservedQty),
    };
  }

  const safeAvailableForSupplyQty = Math.max(
    0,
    Math.trunc(availableForSupplyQty ?? 0)
  );

  return {
    warehouseQty: safeAvailableForSupplyQty + safeReservedQty,
    reservedQty: safeReservedQty,
    availableForSupplyQty: safeAvailableForSupplyQty,
  };
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
    vendorCodeText === "артикул продавца" ||
    companyText === "компания"
  );
}

type OwnWarehouseStockData = {
  importSessionId: string;
  companyName: string;
  vendorCode: string;
  sku: string | null;
  productName: string | null;
  color: string | null;
  size: string | null;
  barcode: string | null;
  warehouseQty: number;
  reservedQty: number;
  availableForSupplyQty: number;
  costPrice: number | null;
  inventoryDate: Date | null;
  comment: string | null;
};

function buildDedupeKey(row: OwnWarehouseStockData) {
  return [
    normalizeKey(row.companyName),
    normalizeKey(row.vendorCode),
    normalizeKey(row.sku),
    normalizeKey(row.size),
    normalizeKey(row.barcode),
  ].join("::");
}

// Техническое имя функции пока оставляем прежним, чтобы не делать рискованную
// миграцию и не менять все места вызова. По смыслу это импорт общего собственного
// склада для будущего планирования поставок WB и Ozon.
export async function normalizeOzonWarehouseStock(
  rows: Record<string, unknown>[],
  importSessionId: string,
  fallbackCompanyName: string
) {
  const parsedRows: OwnWarehouseStockData[] = rows
    .map((row) => {
      const companyName =
        toText(getByHeader(row, ["Компания", "ИП", "Организация"])) ??
        fallbackCompanyName;

      const vendorCode = toText(
        getByHeader(row, [
          "Артикул",
          "Артикул продавца",
          "Артикул поставщика",
          "Артикул WB/Ozon",
        ])
      );

      const { warehouseQty, reservedQty, availableForSupplyQty } =
        getWarehouseQty(row);

      return {
        importSessionId,
        companyName,
        vendorCode: vendorCode ?? "",
        sku: toText(getByHeader(row, ["SKU Ozon", "Ozon SKU", "SKU"])),
        productName: toText(
          getByHeader(row, ["Название товара", "Название", "Товар"])
        ),
        color: toText(getByHeader(row, ["Цвет"])),
        size: toText(getByHeader(row, ["Размер", "Размер вещи"])),
        barcode: toText(
          getByHeader(row, ["Штрихкод", "Баркод", "Barcode", "Бар код"])
        ),
        warehouseQty,
        reservedQty,
        availableForSupplyQty,
        costPrice: toNumber(
          getByHeader(row, [
            "Себестоимость",
            "Себестоимость, ₽",
            "Себестоимость, руб",
            "Закупочная цена",
            "Цена закупки",
          ])
        ),
        inventoryDate: parseDate(
          getByHeader(row, ["Дата инвентаризации", "Дата остатка", "Дата"])
        ),
        comment: toText(getByHeader(row, ["Комментарий", "Примечание"])),
      };
    })
    .filter((row) => !isServiceRow(row));

  const grouped = new Map<string, OwnWarehouseStockData>();

  for (const row of parsedRows) {
    const key = buildDedupeKey(row);
    const existing = grouped.get(key);

    if (!existing) {
      grouped.set(key, row);
      continue;
    }

    existing.warehouseQty += row.warehouseQty;
    existing.reservedQty += row.reservedQty;
    existing.availableForSupplyQty = Math.max(
      0,
      existing.warehouseQty - existing.reservedQty
    );

    existing.sku = existing.sku || row.sku;
    existing.productName = existing.productName || row.productName;
    existing.color = existing.color || row.color;
    existing.size = existing.size || row.size;
    existing.barcode = existing.barcode || row.barcode;
    existing.costPrice = existing.costPrice ?? row.costPrice;
    existing.inventoryDate = existing.inventoryDate ?? row.inventoryDate;
    existing.comment = existing.comment || row.comment;
  }

  const data = Array.from(grouped.values());

  if (data.length === 0) {
    return {
      savedRows: 0,
    };
  }

  const companyNames = Array.from(
    new Set(data.map((row) => row.companyName).filter(Boolean))
  );

  // Импорт собственного склада сейчас работает как полный снимок по компании:
  // перед сохранением нового файла очищаем старые строки этих компаний.
  // Так не остаются фантомные остатки по товарам, которых уже нет на складе.
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
