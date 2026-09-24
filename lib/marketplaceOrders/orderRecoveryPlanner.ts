import { prisma } from "@/lib/prisma";

export type MarketplaceName = "WB" | "OZON";

export type OrderRecoveryScope = {
  companyId: string;
  companyName: string;
  marketplace: MarketplaceName;
  date: string;
  reasonCode: "MISSING" | "STALE";
};

export type ConfiguredOrderScope = {
  companyId: string;
  companyName: string;
  marketplace: MarketplaceName;
  configured: boolean;
};

export type ExistingOrderStat = {
  companyName: string;
  marketplace: string;
  orderDate: Date;
  lastSuccessfulSyncAt: Date | null;
};

export type OrderRecoveryDeps = {
  listConfiguredScopes: () => Promise<ConfiguredOrderScope[]>;
  listExistingStats: (date: string) => Promise<ExistingOrderStat[]>;
};

export const PRIMARY_ORDER_SYNC_UTC_HOUR = 3;
export const PRIMARY_ORDER_SYNC_UTC_MINUTE = 20;

export function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function getYesterdayMoscowDate(now = new Date()): Date {
  const moscowNow = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  return new Date(
    Date.UTC(
      moscowNow.getUTCFullYear(),
      moscowNow.getUTCMonth(),
      moscowNow.getUTCDate() - 1,
      12,
      0,
      0
    )
  );
}

export function getExpectedPrimarySyncAt(targetDate: Date): Date {
  return new Date(
    Date.UTC(
      targetDate.getUTCFullYear(),
      targetDate.getUTCMonth(),
      targetDate.getUTCDate() + 1,
      PRIMARY_ORDER_SYNC_UTC_HOUR,
      PRIMARY_ORDER_SYNC_UTC_MINUTE,
      0,
      0
    )
  );
}

export function isPrimaryOrderSyncDue(targetDate: Date, now = new Date()): boolean {
  return now.getTime() >= getExpectedPrimarySyncAt(targetDate).getTime();
}

function isConfigured(scope: ConfiguredOrderScope): boolean {
  return scope.configured;
}

export async function defaultListConfiguredScopes(): Promise<ConfiguredOrderScope[]> {
  const companies = await prisma.company.findMany({
    where: { isActive: true },
    orderBy: { name: "asc" },
    include: { apiConnections: true },
  });
  const scopes: ConfiguredOrderScope[] = [];
  for (const company of companies) {
    const wb = company.apiConnections.find((item) => item.marketplace === "WB" && item.isEnabled);
    const ozon = company.apiConnections.find((item) => item.marketplace === "OZON" && item.isEnabled);
    scopes.push({
      companyId: company.id,
      companyName: company.name,
      marketplace: "WB",
      configured: Boolean(wb?.wbToken),
    });
    scopes.push({
      companyId: company.id,
      companyName: company.name,
      marketplace: "OZON",
      configured: Boolean(ozon?.ozonClientId && ozon.ozonApiKey),
    });
  }
  return scopes;
}

export async function defaultListExistingStats(date: string): Promise<ExistingOrderStat[]> {
  const day = new Date(`${date}T00:00:00.000Z`);
  const next = new Date(day.getTime() + 24 * 60 * 60 * 1000);
  return prisma.marketplaceDailyOrderStat.findMany({
    where: {
      orderDate: {
        gte: day,
        lt: next,
      },
    },
    select: {
      companyName: true,
      marketplace: true,
      orderDate: true,
      lastSuccessfulSyncAt: true,
    },
  });
}

export async function getMarketplaceOrderRecoveryScopes(params: {
  targetDate: Date;
  now?: Date;
  deps?: OrderRecoveryDeps;
}): Promise<OrderRecoveryScope[]> {
  const deps = params.deps ?? {
    listConfiguredScopes: defaultListConfiguredScopes,
    listExistingStats: defaultListExistingStats,
  };
  const date = formatDateOnly(params.targetDate);
  const now = params.now ?? new Date();
  const cutoff = getExpectedPrimarySyncAt(params.targetDate);
  if (now.getTime() < cutoff.getTime()) {
    return [];
  }
  const configured = (await deps.listConfiguredScopes()).filter(isConfigured);
  const existing = await deps.listExistingStats(date);
  const byKey = new Map(
    existing.map((row) => [`${row.companyName}|${row.marketplace}|${formatDateOnly(row.orderDate)}`, row])
  );

  const recovery: OrderRecoveryScope[] = [];
  for (const scope of configured) {
    const key = `${scope.companyName}|${scope.marketplace}|${date}`;
    const row = byKey.get(key);
    if (!row) {
      recovery.push({
        companyId: scope.companyId,
        companyName: scope.companyName,
        marketplace: scope.marketplace,
        date,
        reasonCode: "MISSING",
      });
      continue;
    }
    const marker = row.lastSuccessfulSyncAt;
    if (marker == null || marker.getTime() < cutoff.getTime()) {
      recovery.push({
        companyId: scope.companyId,
        companyName: scope.companyName,
        marketplace: scope.marketplace,
        date,
        reasonCode: "STALE",
      });
    }
  }
  return recovery;
}
