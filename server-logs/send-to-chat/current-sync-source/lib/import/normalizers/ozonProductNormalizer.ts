import { prisma } from "@/lib/prisma";

function cleanText(value: unknown): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const cleaned = String(value)
    .trim()
    .replace(/^'/, "")
    .replace(/^`/, "")
    .replace(/^"/, "")
    .trim();

  return cleaned || null;
}

function getByIndex(row: Record<string, unknown>, index: number) {
  return Object.values(row)[index] ?? null;
}

export async function normalizeOzonProduct(
  rows: Record<string, unknown>[],
  importSessionId: string,
  companyName: string | null
) {
  const data = rows
    .map((row) => ({
      importSessionId,
      companyName,

      vendorCode: cleanText(getByIndex(row, 0)),

      productName: cleanText(getByIndex(row, 1)),

      sku: cleanText(getByIndex(row, 2)),
    }))
    .filter(
      (row): row is {
        importSessionId: string;
        companyName: string | null;
        vendorCode: string;
        productName: string | null;
        sku: string;
      } => Boolean(row.vendorCode && row.sku)
    );

  if (data.length === 0) {
    return {
      savedRows: 0,
    };
  }

  await prisma.ozonProduct.deleteMany({
    where: {
      importSessionId,
      companyName,
    },
  });

  await prisma.ozonProduct.createMany({
    data,
  });

  return {
    savedRows: data.length,
  };
}