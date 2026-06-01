import { prisma } from "@/lib/prisma";

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

  const number = Number(normalized);

  return Number.isNaN(number) ? null : number;
}

function getByIndex(row: Record<string, unknown>, index: number) {
  return Object.values(row)[index] ?? null;
}

function isServiceRow(sku: unknown, vendorCode: unknown) {
  const skuText = String(sku ?? "").toLowerCase().trim();
  const vendorCodeText = String(vendorCode ?? "").toLowerCase().trim();

  return (
    skuText === "" ||
    skuText.includes("sku") ||
    skuText.includes("номер") ||
    skuText.includes("нередактируемое") ||
    vendorCodeText.includes("артикула") ||
    vendorCodeText.includes("нередактируемое")
  );
}

export async function normalizeOzonStock(
  rows: Record<string, unknown>[],
  importSessionId: string
) {
  const data = rows
    .map((row) => {
      const vendorCode = getByIndex(row, 0);
      const sku = getByIndex(row, 2);

      return {
        importSessionId,

        vendorCode: vendorCode ? String(vendorCode) : null,

        sku: sku ? String(sku) : null,

        clusterName: getByIndex(row, 5) ? String(getByIndex(row, 5)) : null,

        warehouseName: getByIndex(row, 6) ? String(getByIndex(row, 6)) : null,

        availableQty: toNumber(getByIndex(row, 7)),

        preparingQty: toNumber(getByIndex(row, 8)),

        supplyQty: toNumber(getByIndex(row, 16)),

        inTransitQty: toNumber(getByIndex(row, 17)),

        returnQty: toNumber(getByIndex(row, 18)),
      };
    })
    .filter((row) => !isServiceRow(row.sku, row.vendorCode));

  if (data.length === 0) {
    return {
      savedRows: 0,
    };
  }

  await prisma.ozonStock.deleteMany({
    where: {
      importSessionId,
    },
  });

  await prisma.ozonStock.createMany({
    data,
  });

  return {
    savedRows: data.length,
  };
}