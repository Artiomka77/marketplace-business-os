import { prisma } from "@/lib/prisma";

function toNumber(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0;

  const number = Number(String(value).replace(/\s/g, "").replace(",", "."));

  return Number.isNaN(number) ? 0 : number;
}

function getValue(row: any, keys: string[]) {
  for (const key of keys) {
    if (row[key] !== undefined) return row[key];
  }

  return null;
}

export async function normalizeWbStock(
  rows: any[],
  importSessionId: string,
  companyName: string | null
) {
  const data: any[] = [];

  for (const row of rows) {
    const vendorCode = getValue(row, ["Артикул продавца"]);
    const barcode = getValue(row, ["Баркод"]);

    if (!vendorCode && !barcode) continue;

    const base = {
      importSessionId,
      companyName,
      brand: getValue(row, ["Бренд"]) ? String(getValue(row, ["Бренд"])) : null,
      subject: getValue(row, ["Предмет"])
        ? String(getValue(row, ["Предмет"]))
        : null,
      vendorCode: vendorCode ? String(vendorCode) : null,
      barcode: barcode ? String(barcode) : null,
      size: getValue(row, ["Размер", "Размер вещи"])
        ? String(getValue(row, ["Размер", "Размер вещи"]))
        : null,
    };

    data.push({
      ...base,
      inTransitToCustomer: toNumber(row["В пути до получателей"]),
      inTransitReturns: toNumber(row["В пути возвраты на склад WB"]),
      totalStock: toNumber(row["Всего находится на складах"]),
      warehouseName: "__TOTAL__",
      warehouseQty: null,
    });
  }

  if (data.length === 0) {
    return { savedRows: 0 };
  }

  await prisma.wbStock.deleteMany({
    where: {
      importSessionId,
      companyName,
    },
  });

  await prisma.wbStock.createMany({
    data,
  });

  return {
    savedRows: data.length,
  };
}