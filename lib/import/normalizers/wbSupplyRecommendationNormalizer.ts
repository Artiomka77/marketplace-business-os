import { prisma } from "@/lib/prisma";

function normalizeHeader(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/\s+/g, " ")
    .trim();
}

function getByHeader(row: Record<string, unknown>, candidates: string[]) {
  const normalizedCandidates = candidates.map(normalizeHeader);

  for (const [key, value] of Object.entries(row)) {
    if (normalizedCandidates.includes(normalizeHeader(key))) {
      return value;
    }
  }

  return null;
}

function getByHeaderIncludes(row: Record<string, unknown>, expectedPart: string) {
  const target = normalizeHeader(expectedPart);

  for (const [key, value] of Object.entries(row)) {
    if (normalizeHeader(key).includes(target)) {
      return value;
    }
  }

  return null;
}

function getByHeaderIncludesAny(
  row: Record<string, unknown>,
  expectedParts: string[]
) {
  for (const expectedPart of expectedParts) {
    const value = getByHeaderIncludes(row, expectedPart);

    if (value !== null && value !== undefined && String(value).trim() !== "") {
      return value;
    }
  }

  return null;
}

function getByHeaderStrictOrIncludes(
  row: Record<string, unknown>,
  exactCandidates: string[],
  includeCandidates: string[]
) {
  const exactValue = getByHeader(row, exactCandidates);

  if (
    exactValue !== null &&
    exactValue !== undefined &&
    String(exactValue).trim() !== ""
  ) {
    return exactValue;
  }

  return getByHeaderIncludesAny(row, includeCandidates);
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

function makeUtcNoonDate(day: number, month: number, year: number) {
  const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  return Number.isNaN(date.getTime()) ? null : date;
}

function getRecommendationDate(row: Record<string, unknown>) {
  const headersText = Object.keys(row).join(" ");
  const match = headersText.match(/(\d{2})[.\-_](\d{2})[.\-_](\d{4})/);

  if (!match) return null;

  const [, day, month, year] = match;

  return makeUtcNoonDate(Number(day), Number(month), Number(year));
}

function isServiceRow(row: {
  regionName: string | null;
  vendorCode: string | null;
  nmId: string | null;
}) {
  const region = normalizeHeader(row.regionName);
  const vendorCode = normalizeHeader(row.vendorCode);
  const nmId = normalizeHeader(row.nmId);

  return (
    (!region && !vendorCode && !nmId) ||
    region === "регион" ||
    vendorCode === "артикул продавца" ||
    nmId === "артикул wb"
  );
}

export async function normalizeWbSupplyRecommendation(
  rows: Record<string, unknown>[],
  importSessionId: string,
  companyName: string | null
) {
  const data = rows
    .map((row) => {
      const regionName = toText(
        getByHeaderStrictOrIncludes(row, ["Регион"], ["регион"])
      );
      const vendorCode = toText(
        getByHeaderStrictOrIncludes(
          row,
          ["Артикул продавца"],
          ["артикул продавца"]
        )
      );
      const nmId = toText(
        getByHeaderStrictOrIncludes(row, ["Артикул WB"], ["артикул wb"])
      );

      return {
        importSessionId,
        companyName,

        recommendationDate: getRecommendationDate(row),

        regionName: regionName ?? "",
        warehousesText: toText(
          getByHeaderStrictOrIncludes(
            row,
            ["Склады в регионе"],
            ["склады в регионе"]
          )
        ),

        vendorCode: vendorCode ?? "",
        size: toText(getByHeaderStrictOrIncludes(row, ["Размер"], ["размер"])),
        productName: toText(
          getByHeaderStrictOrIncludes(
            row,
            ["Наименование товара"],
            ["наименование товара"]
          )
        ),
        nmId,
        barcode: toText(getByHeaderStrictOrIncludes(row, ["Баркоды"], ["баркод"])),

        regionStockQty: toInt(getByHeaderIncludes(row, "Остаток в регионе")),

        avgOrdersPerDay: toNumber(
          getByHeaderStrictOrIncludes(
            row,
            ["Среднее количество заказов в день в регионе, шт"],
            ["среднее количество заказов в день в регионе, шт"]
          )
        ),
        forecastOrdersPerDay: toNumber(
          getByHeaderIncludes(row, "прогнозное")
        ),
        stockDays: toNumber(
          getByHeaderStrictOrIncludes(
            row,
            ["На сколько дней хватит остатков"],
            ["на сколько дней хватит"]
          )
        ),

        stockLevel: toText(
          getByHeaderStrictOrIncludes(
            row,
            ["Уровень остатка"],
            ["уровень остатка"]
          )
        ),
        recommendation: toText(
          getByHeaderStrictOrIncludes(row, ["Рекомендация"], ["рекомендация"])
        ),

        potentialLostRevenue28: toNumber(
          getByHeaderIncludes(row, "Потенциальная потеря выручки")
        ),

        plannedSupplyQty: toInt(
          getByHeaderIncludes(row, "Все запланированные поставки")
        ),

        recommendedQty14: toInt(
          getByHeaderIncludes(row, "хватит на 14 дней")
        ),
        recommendedQty21: toInt(
          getByHeaderIncludes(row, "хватит на 21 день")
        ),
        recommendedQty28: toInt(
          getByHeaderIncludes(row, "хватит на 28 дней")
        ),
        recommendedQty56: toInt(
          getByHeaderIncludes(row, "хватит на 56 дней")
        ),

        isAllRegions: normalizeHeader(regionName) === "все регионы",
      };
    })
    .filter((row) => !isServiceRow(row))
    .filter((row) => row.regionName && row.vendorCode && row.nmId);

  if (data.length === 0) {
    return {
      savedRows: 0,
    };
  }

  await prisma.wbSupplyRecommendation.deleteMany({
    where: companyName
      ? {
          OR: [{ companyName }, { companyName: null }],
        }
      : {
          companyName: null,
        },
  });

  await prisma.wbSupplyRecommendation.createMany({
    data,
  });

  return {
    savedRows: data.length,
  };
}
