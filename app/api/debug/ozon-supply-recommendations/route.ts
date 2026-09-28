import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type OzonConnectionForProbe = {
  companyId: string;
  companyName: string;
  clientId: string;
  apiKey: string;
};

type ProbeConfig = {
  name: string;
  path: string;
  method: "POST";
  body: Record<string, unknown>;
  note: string;
};

type ProbeResult = {
  name: string;
  path: string;
  note: string;
  ok: boolean;
  status: number | null;
  responseShape: string[];
  looksLikeSupplyRecommendation: boolean;
  recommendationFieldsFound: string[];
  sampleText: string;
  error: string | null;
};

const KNOWN_SAFE_PROBES: ProbeConfig[] = [
  {
    name: "Контроль доступа: Ozon Product Stocks",
    path: "/v4/product/info/stocks",
    method: "POST",
    body: {
      filter: {
        visibility: "ALL",
      },
      limit: 1,
      cursor: "",
    },
    note:
      "Контрольный запрос. Этот endpoint уже используется в проекте для остатков Ozon. Он не является отчётом рекомендуемых поставок.",
  },
  {
    name: "Кандидат: supply-order/list",
    path: "/v1/supply-order/list",
    method: "POST",
    body: {
      filter: {},
      limit: 1,
      offset: 0,
    },
    note:
      "Проверка, есть ли у токена доступ к разделу поставок. Даже если endpoint существует, он может возвращать созданные поставки, а не рекомендации Ozon.",
  },
  {
    name: "Кандидат: analytics/stock_balance",
    path: "/v1/analytics/stock_balance",
    method: "POST",
    body: {
      limit: 1,
      offset: 0,
    },
    note:
      "Проверка возможного аналитического endpoint по остаткам. Нужен только как диагностика; боевую синхронизацию по нему не включаем без подтверждения структуры.",
  },
];

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Неизвестная ошибка";
}

function isAuthorized(req: Request) {
  if (process.env.NODE_ENV !== "production") {
    return true;
  }

  const secret = process.env.DEBUG_SECRET ?? process.env.CRON_SECRET;

  if (!secret) {
    return false;
  }

  const url = new URL(req.url);
  const tokenFromQuery = url.searchParams.get("secret");
  const authorization = req.headers.get("authorization");

  return tokenFromQuery === secret || authorization === `Bearer ${secret}`;
}

function getCompanyFilter(req: Request) {
  const url = new URL(req.url);

  return {
    companyId: url.searchParams.get("companyId")?.trim() || null,
    companyName: url.searchParams.get("companyName")?.trim() || null,
  };
}

async function getOzonConnections(req: Request): Promise<OzonConnectionForProbe[]> {
  const { companyId, companyName } = getCompanyFilter(req);

  const connections = await prisma.marketplaceApiConnection.findMany({
    where: {
      marketplace: "OZON",
      isEnabled: true,
      ozonClientId: {
        not: null,
      },
      ozonApiKey: {
        not: null,
      },
      ...(companyId
        ? {
            companyId,
          }
        : {}),
      ...(companyName
        ? {
            company: {
              name: companyName,
            },
          }
        : {}),
    },
    select: {
      companyId: true,
      ozonClientId: true,
      ozonApiKey: true,
      company: {
        select: {
          name: true,
        },
      },
    },
    orderBy: {
      companyId: "asc",
    },
  });

  return connections
    .filter((connection) => connection.ozonClientId && connection.ozonApiKey)
    .map((connection) => ({
      companyId: connection.companyId,
      companyName: connection.company?.name ?? "Без компании",
      clientId: connection.ozonClientId ?? "",
      apiKey: connection.ozonApiKey ?? "",
    }));
}

function extractTopLevelKeys(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  return Object.keys(value as Record<string, unknown>).slice(0, 30);
}

function collectObjectKeys(value: unknown, result = new Set<string>(), depth = 0) {
  if (depth > 4 || !value) {
    return result;
  }

  if (Array.isArray(value)) {
    for (const item of value.slice(0, 3)) {
      collectObjectKeys(item, result, depth + 1);
    }

    return result;
  }

  if (typeof value !== "object") {
    return result;
  }

  for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    result.add(key);
    collectObjectKeys(nestedValue, result, depth + 1);
  }

  return result;
}

function detectRecommendationFields(value: unknown) {
  const keys = Array.from(collectObjectKeys(value)).map((key) => key.toLowerCase());

  const targets = [
    "cluster",
    "cluster_name",
    "warehouse",
    "warehouse_name",
    "recommend",
    "recommendation",
    "recommended",
    "recommended_supply",
    "recommended_supply_qty",
    "supply",
    "supply_qty",
    "days_without_stock",
    "avg_daily_sales",
    "fbo",
    "fbs",
    "in_transit",
  ];

  return targets.filter((target) =>
    keys.some((key) => key.includes(target.toLowerCase()))
  );
}

function safeSampleText(value: unknown) {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "";

  return text.slice(0, 3000);
}

async function probeEndpoint(
  connection: OzonConnectionForProbe,
  config: ProbeConfig
): Promise<ProbeResult> {
  try {
    const response = await fetch(`https://api-seller.ozon.ru${config.path}`, {
      method: config.method,
      headers: {
        "Client-Id": connection.clientId,
        "Api-Key": connection.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(config.body),
      cache: "no-store",
    });

    const rawText = await response.text();
    let parsed: unknown = rawText;

    try {
      parsed = rawText ? JSON.parse(rawText) : null;
    } catch {
      parsed = rawText;
    }

    const recommendationFieldsFound = detectRecommendationFields(parsed);

    return {
      name: config.name,
      path: config.path,
      note: config.note,
      ok: response.ok,
      status: response.status,
      responseShape: extractTopLevelKeys(parsed),
      looksLikeSupplyRecommendation:
        response.ok && recommendationFieldsFound.length >= 3,
      recommendationFieldsFound,
      sampleText: safeSampleText(parsed),
      error: response.ok ? null : rawText.slice(0, 1000),
    };
  } catch (error) {
    return {
      name: config.name,
      path: config.path,
      note: config.note,
      ok: false,
      status: null,
      responseShape: [],
      looksLikeSupplyRecommendation: false,
      recommendationFieldsFound: [],
      sampleText: "",
      error: getErrorMessage(error),
    };
  }
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json(
      {
        success: false,
        error:
          "Доступ запрещён. В production передайте DEBUG_SECRET или CRON_SECRET через ?secret=... либо Authorization: Bearer <secret>.",
      },
      { status: 401 }
    );
  }

  const connections = await getOzonConnections(req);

  if (connections.length === 0) {
    return NextResponse.json(
      {
        success: false,
        error:
          "Не найдено активных Ozon-подключений с Client-Id и Api-Key. Проверьте настройки API-интеграций.",
      },
      { status: 404 }
    );
  }

  const results = [];

  for (const connection of connections) {
    const probes = [];

    for (const probe of KNOWN_SAFE_PROBES) {
      probes.push(await probeEndpoint(connection, probe));
    }

    results.push({
      companyId: connection.companyId,
      companyName: connection.companyName,
      probes,
      hasPossibleSupplyRecommendationEndpoint: probes.some(
        (probe) => probe.looksLikeSupplyRecommendation
      ),
    });
  }

  return NextResponse.json({
    success: true,
    mode: "diagnostic_only_no_database_writes",
    message:
      "Это безопасная диагностика. Route не меняет базу и не включает автосинхронизацию. Если один из endpoints реально отдаёт поля рекомендаций поставок, следующим шагом подключаем сохранение в OzonSupplyRecommendation.",
    checkedAt: new Date().toISOString(),
    totalCompanies: results.length,
    results,
  });
}
