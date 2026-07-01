import { prisma } from "@/lib/prisma";

type NormalizeWbAdsOptions = {
  replaceMode?: "PERIOD" | "CAMPAIGNS";
  campaignIds?: string[];
};

type NormalizedWbAdsRow = {
  importSessionId: string;
  companyName: string | null;
  dateFrom: Date | null;
  dateTo: Date | null;
  campaignId: string | null;
  campaignName: string | null;
  impressions: number | null;
  clicks: number | null;
  ctr: number | null;
  cpc: number | null;
  spend: number | null;
};

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const normalized = String(value)
    .replace(/\s/g, "")
    .replace(",", ".")
    .replace(/[^\d.-]/g, "");

  const number = Number(normalized);

  return Number.isNaN(number) ? null : number;
}

function makeUtcDay(year: number, monthIndex: number, day: number) {
  return new Date(Date.UTC(year, monthIndex, day));
}

function startOfUtcDay(date: Date) {
  return makeUtcDay(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate()
  );
}

function toDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;

    return startOfUtcDay(value);
  }

  if (typeof value === "number") {
    const excelEpoch = new Date(Date.UTC(1899, 11, 30));
    const rawDate = new Date(excelEpoch.getTime() + value * 24 * 60 * 60 * 1000);

    if (Number.isNaN(rawDate.getTime())) return null;

    return startOfUtcDay(rawDate);
  }

  const text = String(value).trim();

  const russianDate = text.match(/^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})/);

  if (russianDate) {
    const [, day, month, year] = russianDate;

    return makeUtcDay(Number(year), Number(month) - 1, Number(day));
  }

  const isoDate = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);

  if (isoDate) {
    const [, year, month, day] = isoDate;

    return makeUtcDay(Number(year), Number(month) - 1, Number(day));
  }

  const parsedDate = new Date(text);

  if (Number.isNaN(parsedDate.getTime())) return null;

  return startOfUtcDay(parsedDate);
}

function getRowDate(row: Record<string, unknown>) {
  return (
    toDate(row["Дата"]) ??
    toDate(row["Дата списания"]) ??
    toDate(row["Дата отчета"]) ??
    toDate(row["Дата отчёта"]) ??
    toDate(row["date"]) ??
    toDate(row["day"])
  );
}

function normalizeCampaignIds(campaignIds: string[] | undefined) {
  return Array.from(
    new Set(
      (campaignIds ?? [])
        .map((campaignId) => String(campaignId ?? "").trim())
        .filter(Boolean)
    )
  );
}

function getSpend(row: Record<string, unknown>) {
  return (
    toNumber(row["Затраты"]) ??
    toNumber(row["Расход"]) ??
    toNumber(row["Сумма"]) ??
    toNumber(row["sum"]) ??
    toNumber(row["spend"])
  );
}

function getFallbackDate(date: Date | null | undefined) {
  return date ? startOfUtcDay(date) : null;
}

function getDateRangeForDelete(data: NormalizedWbAdsRow[], fallbackDateFrom?: Date | null, fallbackDateTo?: Date | null) {
  const dates = data
    .map((row) => row.dateFrom)
    .filter((date): date is Date => Boolean(date))
    .sort((left, right) => left.getTime() - right.getTime());

  if (dates.length > 0) {
    return {
      dateFrom: dates[0],
      dateTo: dates[dates.length - 1],
    };
  }

  const dateFrom = getFallbackDate(fallbackDateFrom);
  const dateTo = getFallbackDate(fallbackDateTo);

  if (!dateFrom || !dateTo) {
    return null;
  }

  return {
    dateFrom,
    dateTo,
  };
}

export async function normalizeWbAds(
  rows: any[],
  importSessionId: string,
  dateFrom?: Date | null,
  dateTo?: Date | null,
  companyName?: string | null,
  options: NormalizeWbAdsOptions = {}
) {
  const replaceMode = options.replaceMode ?? "PERIOD";
  const campaignIds = normalizeCampaignIds(options.campaignIds);

  const fallbackDateFrom = getFallbackDate(dateFrom);
  const fallbackDateTo = getFallbackDate(dateTo);

  const data: NormalizedWbAdsRow[] = rows
    .map((rawRow) => {
      const row = rawRow as Record<string, unknown>;
      const rowDate = getRowDate(row);
      const spend = getSpend(row);

      return {
        importSessionId,
        companyName: companyName ?? null,

        // Важное правило:
        // WB API fullstats возвращает расходы по дням в item.days[].date.
        // Поэтому если в строке есть поле "Дата", сохраняем именно дату строки,
        // а не общий период загрузки 2026-06-20 — 2026-06-22.
        // Иначе ежедневный Telegram-отчёт будет брать расход за весь период,
        // а не за конкретный день.
        dateFrom: rowDate ?? fallbackDateFrom,
        dateTo: rowDate ?? fallbackDateTo,

        campaignId: row["ID кампании"] ? String(row["ID кампании"]) : null,

        campaignName: row["Кампания"] ? String(row["Кампания"]) : null,

        impressions: toNumber(row["Показы"]),
        clicks: toNumber(row["Клики"]),

        ctr: toNumber(row["CTR(%)"]),
        cpc: toNumber(row["CPC"]),

        spend,
      };
    })
    .filter((row) => row.campaignId || row.campaignName || row.spend);

  const deleteDateRange = getDateRangeForDelete(data, fallbackDateFrom, fallbackDateTo);

  if (deleteDateRange) {
    if (replaceMode === "CAMPAIGNS" && campaignIds.length > 0) {
      await prisma.wbAds.deleteMany({
        where: {
          companyName: companyName ?? null,
          campaignId: {
            in: campaignIds,
          },
          dateFrom: {
            gte: deleteDateRange.dateFrom,
            lte: deleteDateRange.dateTo,
          },
        },
      });
    } else {
      await prisma.wbAds.deleteMany({
        where: {
          companyName: companyName ?? null,
          dateFrom: {
            gte: deleteDateRange.dateFrom,
            lte: deleteDateRange.dateTo,
          },
        },
      });
    }
  } else {
    await prisma.wbAds.deleteMany({
      where: {
        importSessionId,
        companyName: companyName ?? null,
      },
    });
  }

  if (data.length === 0) {
    return {
      savedRows: 0,
    };
  }

  await prisma.wbAds.createMany({
    data,
  });

  return {
    savedRows: data.length,
  };
}
