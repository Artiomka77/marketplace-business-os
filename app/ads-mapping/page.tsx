import { prisma } from "@/lib/prisma";
import { AdsMappingTable } from "./AdsMappingForm";

type Props = {
  searchParams?: Promise<{
    dateFrom?: string;
    dateTo?: string;
  }>;
};

function startOfDay(value: string) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function endOfDay(value: string) {
  const date = startOfDay(value);
  date.setHours(23, 59, 59, 999);
  return date;
}

function formatMoney(value: number) {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0,
  }).format(Number.isFinite(value) ? value : 0);
}

async function saveAllMappings(formData: FormData) {
  "use server";

  const raw = String(formData.get("mappingsJson") ?? "[]");

  const mappings = JSON.parse(raw) as {
    campaignName: string;
    vendorCodes: string[];
  }[];

  for (const mapping of mappings) {
    await prisma.adCampaignMap.deleteMany({
      where: {
        marketplace: "WB",
        companyName: "ИП Петров",
        campaignName: mapping.campaignName,
      },
    });

    if (mapping.vendorCodes.length > 0) {
      await prisma.adCampaignMap.createMany({
        data: mapping.vendorCodes.map((vendorCode) => ({
          marketplace: "WB",
          companyName: "ИП Петров",
          campaignName: mapping.campaignName,
          vendorCode,
        })),
      });
    }
  }
}

async function deleteCampaign(formData: FormData) {
  "use server";

  const campaignName = String(formData.get("deleteCampaignName") ?? "").trim();

  if (!campaignName) return;

  await prisma.adCampaignMap.deleteMany({
    where: {
      marketplace: "WB",
      companyName: "ИП Петров",
      campaignName,
    },
  });

  await prisma.wbAds.deleteMany({
    where: {
      campaignName,
    },
  });
}

export default async function AdsMappingPage({ searchParams }: Props) {
  const params = searchParams ? await searchParams : {};

  const dateFrom = params.dateFrom ?? "2026-05-18";
  const dateTo = params.dateTo ?? "2026-05-24";

  const selectedFrom = startOfDay(dateFrom);
  const selectedTo = endOfDay(dateTo);

  const periodFilter = {
    dateFrom: {
      lte: selectedTo,
    },
    dateTo: {
      gte: selectedFrom,
    },
  };

  const latestAdsRow = await prisma.wbAds.findFirst({
    where: periodFilter,
    orderBy: {
      createdAt: "desc",
    },
  });

  const adsRows = latestAdsRow
    ? await prisma.wbAds.findMany({
        where: {
          ...periodFilter,
          ...(latestAdsRow.importSessionId
            ? {
                importSessionId: latestAdsRow.importSessionId,
              }
            : {
                createdAt: {
                  gte: new Date(
                    latestAdsRow.createdAt.getTime() - 10 * 60 * 1000
                  ),
                  lte: new Date(
                    latestAdsRow.createdAt.getTime() + 10 * 60 * 1000
                  ),
                },
              }),
        },
        orderBy: {
          spend: "desc",
        },
      })
    : [];

  const campaignMap = new Map<string, number>();

  for (const row of adsRows) {
    const campaignName = row.campaignName ?? "";

    if (!campaignName) continue;

    campaignMap.set(
      campaignName,
      (campaignMap.get(campaignName) ?? 0) + Number(row.spend ?? 0)
    );
  }

  const campaigns = Array.from(campaignMap.entries())
    .map(([campaignName, spend]) => ({
      campaignName,
      spend,
    }))
    .sort((a, b) => b.spend - a.spend);

  const vendorCodes = await prisma.productCost.findMany({
    distinct: ["vendorCode"],
    select: {
      vendorCode: true,
    },
    orderBy: {
      vendorCode: "asc",
    },
  });

  const mappings = await prisma.adCampaignMap.findMany({
    where: {
      marketplace: "WB",
      companyName: "ИП Петров",
    },
    orderBy: [{ campaignName: "asc" }, { vendorCode: "asc" }],
  });

  const mappingMap = new Map<string, string[]>();

  for (const mapping of mappings) {
    const current = mappingMap.get(mapping.campaignName) ?? [];
    current.push(mapping.vendorCode);
    mappingMap.set(mapping.campaignName, current);
  }

  const selectedPeriodTotal = campaigns.reduce(
    (sum, campaign) => sum + campaign.spend,
    0
  );

  const mappedCampaigns = campaigns.filter(
    (campaign) => (mappingMap.get(campaign.campaignName)?.length ?? 0) > 0
  );

  const unallocatedCampaigns = campaigns.filter(
    (campaign) => (mappingMap.get(campaign.campaignName)?.length ?? 0) === 0
  );

  const allocatedSpend = mappedCampaigns.reduce(
    (sum, campaign) => sum + campaign.spend,
    0
  );

  const unallocatedSpend = unallocatedCampaigns.reduce(
    (sum, campaign) => sum + campaign.spend,
    0
  );

  const allocationPercent =
    selectedPeriodTotal > 0 ? (allocatedSpend / selectedPeriodTotal) * 100 : 0;

  const topCampaigns = [...campaigns].slice(0, 10);

  return (
    <main className="min-h-screen bg-slate-50 p-8">
      <div className="mx-auto max-w-[1700px] space-y-6">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">
            Связка рекламы с артикулами
          </h1>

          <p className="mt-2 text-slate-600">
            Рекламные кампании загружаются из WB Ads. Здесь связываем расходы
            рекламных кампаний с артикулами поставщика.
          </p>
        </div>

        <form
          action="/ads-mapping"
          className="rounded-2xl bg-white p-4 shadow-sm"
        >
          <div className="grid gap-3 sm:grid-cols-[180px_180px_120px_1fr] sm:items-end">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-500">
                Дата от
              </label>

              <input
                type="date"
                name="dateFrom"
                defaultValue={dateFrom}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-slate-500">
                Дата до
              </label>

              <input
                type="date"
                name="dateTo"
                defaultValue={dateTo}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
              />
            </div>

            <button className="rounded-xl bg-slate-900 px-5 py-2 text-sm font-semibold text-white">
              Применить
            </button>

            <div className="rounded-xl bg-slate-100 px-4 py-2 text-sm text-slate-600">
              Расход:{" "}
              <span className="font-bold text-slate-900">
                {formatMoney(selectedPeriodTotal)}
              </span>{" "}
              · Кампаний:{" "}
              <span className="font-bold text-slate-900">
                {campaigns.length}
              </span>
            </div>
          </div>
        </form>

        <section className="grid gap-4 md:grid-cols-4">
          <div className="rounded-2xl bg-white p-5 shadow-sm">
            <div className="text-sm text-slate-500">Всего рекламы</div>
            <div className="mt-2 text-2xl font-bold">
              {formatMoney(selectedPeriodTotal)}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-5 shadow-sm">
            <div className="text-sm text-slate-500">Распределено</div>
            <div className="mt-2 text-2xl font-bold text-emerald-600">
              {formatMoney(allocatedSpend)}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-5 shadow-sm">
            <div className="text-sm text-slate-500">Нераспределено</div>
            <div className="mt-2 text-2xl font-bold text-orange-600">
              {formatMoney(unallocatedSpend)}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-5 shadow-sm">
            <div className="text-sm text-slate-500">Покрытие</div>
            <div className="mt-2 text-2xl font-bold text-slate-900">
              {allocationPercent.toFixed(1)}%
            </div>

            <div className="mt-1 text-xs text-slate-500">
              {mappedCampaigns.length} из {campaigns.length} кампаний
            </div>
          </div>
        </section>

        <section className="overflow-hidden rounded-2xl bg-white shadow-sm">
          <div className="border-b border-slate-200 p-5">
            <h2 className="text-lg font-bold text-slate-900">
              ТОП-10 рекламных кампаний по расходам
            </h2>

            <p className="mt-1 text-sm text-slate-500">
              Самые затратные кампании выбранного периода.
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead className="bg-slate-50 text-left text-slate-600">
                <tr>
                  <th className="p-4">Кампания</th>
                  <th className="p-4 text-right">Расход</th>
                  <th className="p-4 text-center">Связка</th>
                </tr>
              </thead>

              <tbody>
                {topCampaigns.map((campaign) => {
                  const linked =
                    (mappingMap.get(campaign.campaignName)?.length ?? 0) > 0;

                  return (
                    <tr
                      key={campaign.campaignName}
                      className="border-t border-slate-100"
                    >
                      <td className="p-4 font-medium text-slate-900">
                        {campaign.campaignName}
                      </td>

                      <td className="p-4 text-right font-bold">
                        {formatMoney(campaign.spend)}
                      </td>

                      <td className="p-4 text-center">
                        {linked ? (
                          <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-700">
                            Связано
                          </span>
                        ) : (
                          <span className="rounded-full bg-orange-100 px-3 py-1 text-xs font-semibold text-orange-700">
                            Не связано
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}

                {topCampaigns.length === 0 && (
                  <tr>
                    <td
                      colSpan={3}
                      className="p-6 text-center text-slate-500"
                    >
                      Нет рекламных кампаний за выбранный период.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        {unallocatedCampaigns.length > 0 && (
          <section className="overflow-hidden rounded-2xl bg-white shadow-sm">
            <div className="border-b border-orange-100 bg-orange-50 p-5">
              <h2 className="text-lg font-bold text-orange-900">
                Нераспределенные рекламные кампании
              </h2>

              <p className="mt-1 text-sm text-orange-700">
                Эти кампании есть в рекламных расходах за выбранный период, но
                пока не связаны ни с одним артикулом.
              </p>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead className="bg-white text-left text-slate-600">
                  <tr>
                    <th className="p-4">Рекламная кампания</th>
                    <th className="p-4 text-right">Расход</th>
                  </tr>
                </thead>

                <tbody>
                  {unallocatedCampaigns.map((campaign) => (
                    <tr
                      key={campaign.campaignName}
                      className="border-t border-slate-100"
                    >
                      <td className="p-4 font-medium text-slate-900">
                        {campaign.campaignName}
                      </td>

                      <td className="p-4 text-right font-bold text-orange-600">
                        {formatMoney(campaign.spend)}
                      </td>
                    </tr>
                  ))}

                  <tr className="border-t border-orange-100 bg-orange-50">
                    <td className="p-4 font-bold text-orange-900">
                      Итого нераспределено
                    </td>

                    <td className="p-4 text-right font-bold text-orange-900">
                      {formatMoney(unallocatedSpend)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        )}

        <AdsMappingTable
          campaigns={campaigns.map((campaign) => ({
            campaignName: campaign.campaignName,
            spend: campaign.spend,
            selectedVendorCodes:
              mappingMap.get(campaign.campaignName) ?? [],
          }))}
          vendorCodes={vendorCodes.map((vendor) => ({
            value: vendor.vendorCode,
            label: vendor.vendorCode,
          }))}
          savedMappings={mappings.map((mapping) => ({
            campaignName: mapping.campaignName,
            vendorCode: mapping.vendorCode,
          }))}
          saveAllMappings={saveAllMappings}
          deleteCampaign={deleteCampaign}
        />
      </div>
    </main>
  );
}