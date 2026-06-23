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

function getByHeaderIncludes(row: Record<string, unknown>, expectedPart: string) {
  const target = normalizeHeader(expectedPart);

  for (const [key, value] of Object.entries(row)) {
    if (normalizeHeader(key).includes(target)) {
      return value;
    }
  }

  return null;
}

function getRecommendationPeriodDays(row: Record<string, unknown>) {
  const recommendationHeader = Object.keys(row).find((key) =>
    normalizeHeader(key).includes("рекомендуемая поставка")
  );

  if (!recommendationHeader) return null;

  const match = recommendationHeader.match(/(\d+)\s*(?:дней|дн|дня|день)/i);

  if (!match) return null;

  const days = Number(match[1]);

  return Number.isFinite(days) ? days : null;
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

function toNullableInt(value: unknown): number | null {
  const number = toNumber(value);

  if (number === null) return null;

  return Math.trunc(number);
}

function toText(value: unknown): string | null {
  const text = String(value ?? "").trim();

  return text ? text : null;
}

function isServiceRow(row: {
  sku: string | null;
  vendorCode: string | null;
  clusterName: string | null;
}) {
  const skuText = normalizeHeader(row.sku);
  const vendorCodeText = normalizeHeader(row.vendorCode);
  const clusterText = normalizeHeader(row.clusterName);

  return (
    (!skuText && !vendorCodeText) ||
    skuText === "sku" ||
    vendorCodeText === "артикул" ||
    clusterText === "кластер"
  );
}

export async function normalizeOzonSupplyRecommendation(
  rows: Record<string, unknown>[],
  importSessionId: string,
  companyName: string | null
) {
  const data = rows
    .map((row) => {
      const sku = toText(getByHeader(row, ["SKU"]));
      const vendorCode = toText(getByHeader(row, ["Артикул"]));
      const clusterName = toText(getByHeader(row, ["Кластер"]));

      const recommendedSupplyQty = toInt(
        getByHeaderIncludes(row, "Рекомендуемая поставка")
      );

      return {
        importSessionId,
        companyName,

        sku,
        vendorCode: vendorCode ?? "",

        productName: toText(
          getByHeader(row, ["Название товара", "Название товара или услуги"])
        ),

        recommendationPeriodDays: getRecommendationPeriodDays(row),
        recommendedSupplyQty,

        recommendation: toText(getByHeader(row, ["Рекомендация"])),
        clusterName: clusterName ?? "",
        salesScheme: toText(getByHeader(row, ["Схема продаж"])),

        daysWithoutStock28: toNullableInt(
          getByHeader(row, ["Дней без остатка за 28 дней"])
        ),

        avgDeliveryHours: toNumber(getByHeader(row, ["Среднее время доставки, ч"])),
        avgDailySalesRub28: toNumber(
          getByHeader(row, ["Среднесуточные продажи, руб. за 28дн"])
        ),
        avgDailySalesQty28: toNumber(
          getByHeader(row, [
            "Среднесуточные продажи, шт. за 28дн",
            "Среднесуточные продажи, шт за 28дн",
          ])
        ),

        productFlag: toText(getByHeader(row, ["Признак товара"])),

        daysToStockEndFbo: toNumber(getByHeader(row, ["До конца остатка FBO, дн"])),
        daysToStockEndFbs: toNumber(getByHeader(row, ["До конца остатка FBS, дн"])),

        fboStockQty: toNullableInt(getByHeader(row, ["Остаток FBO, шт"])),
        fbsStockQty: toNullableInt(getByHeader(row, ["Остаток FBS, шт"])),

        inTransitToOzonQty: toNullableInt(
          getByHeader(row, ["Товары в пути на склад Ozon, шт"])
        ),
      };
    })
    .filter((row) => !isServiceRow(row))
    .filter((row) => row.vendorCode && row.clusterName);

  if (data.length === 0) {
    return {
      savedRows: 0,
    };
  }

  await prisma.ozonSupplyRecommendation.deleteMany({
    where: companyName
      ? {
          OR: [{ companyName }, { companyName: null }],
        }
      : {
          companyName: null,
        },
  });

  await prisma.ozonSupplyRecommendation.createMany({
    data,
  });

  return {
    savedRows: data.length,
  };
}
