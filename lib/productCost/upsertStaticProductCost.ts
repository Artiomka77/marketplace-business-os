import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { normalizeProductCost } from "@/lib/import/normalizers/productCostNormalizer";
import {
  collapseProductCostsByNormalizedVendor,
  normalizeProductCostVendor,
} from "@/lib/productCost/staticProductCost";
import { parseOwnerCostInput as parseOwnerCostInputShared } from "@/lib/telegram/ownerReportMissingCogs";

export type StaticProductCostMutationSource = "TELEGRAM_OWNER";

export type StaticProductCostAudit = {
  source: StaticProductCostMutationSource;
  actorChatId: string;
  actorUserId: string | null;
  presentedArticle: string;
  presentedSku: string | null;
  marketplace: "WB" | "OZON" | null;
  canonicalVendorKey: string;
  oldCost: number | null;
  newCost: number;
  confirmationReceived: true;
  at: string;
  importSessionId: string;
  resultingProductCostId: string | null;
};

export const parseOwnerCostInput = parseOwnerCostInputShared;

function toPositiveCost(value: unknown): number | null {
  const parsed = parseOwnerCostInputShared(String(value ?? ""));
  return parsed.ok ? parsed.value : null;
}

export async function findStaticProductCostByVendor(vendorCode: string) {
  const key = normalizeProductCostVendor(vendorCode);
  if (!key) return null;
  const rows = await prisma.productCost.findMany({
    select: {
      id: true,
      vendorCode: true,
      nmId: true,
      costPrice: true,
      name: true,
      createdAt: true,
    },
  });
  const matches = rows.filter(
    (r) => normalizeProductCostVendor(r.vendorCode) === key,
  );
  if (matches.length === 0) return null;
  const collapsed = collapseProductCostsByNormalizedVendor(
    matches.map((r) => ({
      vendorCode: r.vendorCode,
      costPrice: Number(r.costPrice),
      name: r.name,
      costDate: r.createdAt,
    })),
  );
  const chosen = collapsed[0];
  const row = matches.find(
    (r) => normalizeProductCostVendor(r.vendorCode) === key,
  );
  return {
    id: row?.id ?? null,
    vendorCode: chosen?.vendorCode ?? vendorCode,
    costPrice: chosen ? Number(chosen.costPrice) : null,
    nmId: row?.nmId ?? null,
    name: row?.name ?? null,
    duplicateCount: matches.length,
  };
}

/**
 * Canonical static ProductCost write for Telegram owner flow.
 * Reuses normalizeProductCost (delete-by-normalized-vendor + createMany).
 * Does not invent a second writer.
 */
export async function upsertStaticProductCostFromOwner(params: {
  vendorCode: string;
  costPrice: number;
  nmId?: string | null;
  name?: string | null;
  actorChatId: string;
  actorUserId?: string | null;
  presentedArticle: string;
  presentedSku?: string | null;
  marketplace?: "WB" | "OZON" | null;
  confirmationReceived: true;
}): Promise<{
  ok: true;
  audit: StaticProductCostAudit;
  created: boolean;
  updated: boolean;
} | {
  ok: false;
  reason: string;
}> {
  const vendorKey = normalizeProductCostVendor(params.vendorCode);
  if (!vendorKey) {
    return { ok: false, reason: "AMBIGUOUS_OR_EMPTY_VENDOR" };
  }
  const cost = toPositiveCost(params.costPrice);
  if (cost == null) {
    return { ok: false, reason: "INVALID_COST" };
  }

  const existing = await findStaticProductCostByVendor(params.vendorCode);
  const oldCost = existing?.costPrice ?? null;

  const session = await prisma.importSession.create({
    data: {
      reportType: "PRODUCT_COST",
      marketplace: params.marketplace ?? "ALL",
      status: "SUCCESS",
      companyName: "ALL",
      rowsCount: 1,
      fileName: `telegram-owner-cost:${vendorKey}`,
      previewJson: {
        source: "TELEGRAM_OWNER",
        actorChatId: params.actorChatId,
        actorUserId: params.actorUserId ?? null,
        presentedArticle: params.presentedArticle,
        presentedSku: params.presentedSku ?? null,
        marketplace: params.marketplace ?? null,
        canonicalVendorKey: vendorKey,
        oldCost,
        newCost: cost,
        confirmationReceived: true,
        at: new Date().toISOString(),
      } as Prisma.InputJsonValue,
    },
  });

  await normalizeProductCost(
    [
      {
        "Артикул продавца": params.vendorCode.trim(),
        Себестоимость: cost,
        Наименование: params.name ?? params.presentedArticle,
      },
    ],
    session.id,
  );

  const after = await findStaticProductCostByVendor(params.vendorCode);
  const audit: StaticProductCostAudit = {
    source: "TELEGRAM_OWNER",
    actorChatId: params.actorChatId,
    actorUserId: params.actorUserId ?? null,
    presentedArticle: params.presentedArticle,
    presentedSku: params.presentedSku ?? null,
    marketplace: params.marketplace ?? null,
    canonicalVendorKey: vendorKey,
    oldCost,
    newCost: cost,
    confirmationReceived: true,
    at: new Date().toISOString(),
    importSessionId: session.id,
    resultingProductCostId: after?.id ?? null,
  };

  await prisma.importSession.update({
    where: { id: session.id },
    data: {
      previewJson: audit as unknown as Prisma.InputJsonValue,
    },
  });

  return {
    ok: true,
    audit,
    created: oldCost == null,
    updated: oldCost != null,
  };
}
