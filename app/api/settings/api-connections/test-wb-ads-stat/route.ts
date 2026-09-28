import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

type CompanyRow = {
  id: string;
  name: string;
};

type AdvertListItem = {
  advertId?: number;
  changeTime?: string;
};

type AdvertGroup = {
  type?: number;
  status?: number;
  count?: number;
  advert_list?: AdvertListItem[];
};

type AdvertCountResponse = {
  adverts?: AdvertGroup[];
};

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function formatDateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

function getDefaultPeriod() {
  const dateTo = new Date();
  const dateFrom = new Date();

  dateFrom.setDate(dateFrom.getDate() - 7);

  return {
    dateFrom: formatDateOnly(dateFrom),
    dateTo: formatDateOnly(dateTo),
  };
}

async function findCompany(companyId: string) {
  const companies = await prisma.$queryRaw<CompanyRow[]>`
    select "id", "name"
    from "Company"
    where "id" = ${companyId}
    limit 1
  `;

  return companies[0] ?? null;
}

function getFirstActiveAdvertId(data: AdvertCountResponse) {
  const groups = data.adverts ?? [];

  const activeGroups = groups.filter((group) => group.status === 9 || group.status === 11);

  for (const group of activeGroups) {
    const advertId = group.advert_list?.[0]?.advertId;

    if (advertId) {
      return advertId;
    }
  }

  for (const group of groups) {
    const advertId = group.advert_list?.[0]?.advertId;

    if (advertId) {
      return advertId;
    }
  }

  return null;
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const companyId = getString(formData, "companyId");

  const company = await findCompany(companyId);

  if (!company) {
    return NextResponse.json(
      { success: false, error: "Компания не найдена" },
      { status: 404 }
    );
  }

  const connection = await prisma.marketplaceApiConnection.findUnique({
    where: {
      companyId_marketplace: {
        companyId,
        marketplace: "WB",
      },
    },
  });

  if (!connection?.wbToken) {
    return NextResponse.json(
      { success: false, error: "WB token не сохранён" },
      { status: 400 }
    );
  }

  const countResponse = await fetch(
    "https://advert-api.wildberries.ru/adv/v1/promotion/count",
    {
      method: "GET",
      headers: {
        Authorization: connection.wbToken,
      },
      cache: "no-store",
    }
  );

  const countText = await countResponse.text();

  let countJson: AdvertCountResponse | null = null;

  try {
    countJson = countText ? (JSON.parse(countText) as AdvertCountResponse) : null;
  } catch {
    countJson = null;
  }

  if (!countResponse.ok || !countJson) {
    return NextResponse.json({
      success: false,
      step: "count",
      companyName: company.name,
      response: {
        status: countResponse.status,
        ok: countResponse.ok,
        contentType: countResponse.headers.get("content-type"),
      },
      result: {
        sample: countJson,
        rawText: countJson ? null : countText.slice(0, 3000),
      },
    });
  }

  const advertId = getFirstActiveAdvertId(countJson);

  if (!advertId) {
    return NextResponse.json({
      success: false,
      error: "Не найден advertId для теста статистики",
      companyName: company.name,
      countSample: countJson,
    });
  }

  const { dateFrom, dateTo } = getDefaultPeriod();

  const statUrl = new URL("https://advert-api.wildberries.ru/adv/v3/fullstats");

statUrl.searchParams.set("ids", String(advertId));
statUrl.searchParams.set("beginDate", dateFrom);
statUrl.searchParams.set("endDate", dateTo);

const statResponse = await fetch(statUrl.toString(), {
  method: "GET",
  headers: {
    Authorization: connection.wbToken,
  },
  cache: "no-store",
});

  const statText = await statResponse.text();

  let statJson: unknown = null;

  try {
    statJson = statText ? JSON.parse(statText) : null;
  } catch {
    statJson = null;
  }

  return NextResponse.json({
    success: statResponse.ok,
    companyName: company.name,
    advertId,
    request: {
      url: statUrl.toString(),
      dateFrom,
      dateTo,
    },
    response: {
      status: statResponse.status,
      ok: statResponse.ok,
      contentType: statResponse.headers.get("content-type"),
    },
    result: {
      sample: statJson,
      rawText: statJson ? null : statText.slice(0, 3000),
    },
  });
}