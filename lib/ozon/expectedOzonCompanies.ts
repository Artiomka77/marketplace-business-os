/**
 * Authoritative expected Ozon company set for finality / producers.
 *
 * Source model: MarketplaceApiConnection + Company
 * Filter matches getActiveOzonConnections (lib/ozon/reportAdsRetry.ts):
 *   marketplace=OZON, isEnabled, credentials present, company.isActive
 *
 * Excludes inactive/test companies such as ООО Тест when isActive=false.
 * Does NOT hardcode company names.
 */
export type ExpectedOzonCompanyClient = {
  marketplaceApiConnection: {
    // Loose Prisma-compatible signature (avoid structural Promise generic fights).
    findMany: (...args: any[]) => Promise<any>;
  };
};

export function normalizeExpectedOzonCompanyNames(
  names: Array<string | null | undefined>,
): string[] {
  return [
    ...new Set(
      names
        .map((name) => String(name ?? "").trim())
        .filter((name) => name.length > 0),
    ),
  ];
}

export async function listExpectedOzonCompanyNames(
  client: ExpectedOzonCompanyClient,
): Promise<string[]> {
  const rows = await client.marketplaceApiConnection.findMany({
    where: {
      marketplace: "OZON",
      isEnabled: true,
      ozonClientId: { not: null },
      ozonApiKey: { not: null },
      company: { isActive: true },
    },
    select: {
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

  return normalizeExpectedOzonCompanyNames(
    (rows as Array<{ company?: { name?: string | null } | null }>).map(
      (row) => row.company?.name ?? null,
    ),
  );
}
