export type SyncOzonAllMode = "full" | "scheduled";

export type SyncOzonAllOptions = {
  mode?: SyncOzonAllMode;
};

export const SYNC_OZON_ALL_FULL = {
  mode: "full" as const,
  ownedDomains: ["finance", "products", "stocks", "ads"] as const,
  deferredDomains: [] as const,
  includeAds: true,
};

export const SYNC_OZON_ALL_SCHEDULED = {
  mode: "scheduled" as const,
  ownedDomains: ["finance", "products", "stocks"] as const,
  deferredDomains: ["ads"] as const,
  includeAds: false,
};

export function resolveSyncOzonAllMode(options: SyncOzonAllOptions = {}) {
  return options.mode === "scheduled"
    ? SYNC_OZON_ALL_SCHEDULED
    : SYNC_OZON_ALL_FULL;
}

export type SyncOzonAllStepHooks = {
  finance: (companyId: string) => Promise<unknown>;
  products: (companyId: string) => Promise<unknown>;
  stocks: (companyId: string) => Promise<unknown>;
  ads: (companyId: string) => Promise<unknown>;
  setConnected: (companyId: string) => Promise<void>;
  setError: (companyId: string, error: unknown) => Promise<void>;
};

function errorToMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function runSyncOzonAllSequence(
  companyId: string,
  options: SyncOzonAllOptions = {},
  hooks: SyncOzonAllStepHooks
) {
  const plan = resolveSyncOzonAllMode(options);
  const results: unknown[] = [];

  try {
    results.push(await hooks.finance(companyId));
    results.push(await hooks.products(companyId));
    results.push(await hooks.stocks(companyId));
    if (plan.includeAds) {
      results.push(await hooks.ads(companyId));
    }
    await hooks.setConnected(companyId);

    return {
      ok: true as const,
      results,
      mode: plan.mode,
      ownedDomains: [...plan.ownedDomains],
      deferredDomains: [...plan.deferredDomains],
    };
  } catch (error) {
    await hooks.setError(companyId, error);

    return {
      ok: false as const,
      results,
      error: errorToMessage(error),
      mode: plan.mode,
      ownedDomains: [...plan.ownedDomains],
      deferredDomains: [...plan.deferredDomains],
    };
  }
}
