import {
  buildOwnerReportFinalSnapshot,
  captureOwnerReportSourceFingerprint,
  gateOwnerMorningReportSend,
  markOwnerMorningFinalSent,
  markOwnerMorningPreliminarySent,
  type OwnerMorningGateResult,
} from "@/lib/telegram/dailyOwnerReportDelivery";
import { evaluateOwnerReportCogsCoverage } from "@/lib/telegram/ownerReportCogsCoverage";
import {
  enrichMissingCogsItemsForDisplay,
  listUnresolvedCogsItems,
  missingCogsInlineKeyboard,
} from "@/lib/telegram/ownerReportMissingCogs";
import { morningReportInlineKeyboard } from "@/lib/telegram/ownerTopProductsFlow";
import {
  buildDailyReport,
  type DailyReport,
} from "@/lib/telegram/dailyReport";
import { formatOwnerReportV3 } from "@/lib/telegram/ownerReportV3";
import { loadOwnerReportV3Extras } from "@/lib/telegram/ownerReportV3Loaders";
import {
  getTelegramAllowedChatIds,
  sendTelegramMessage,
} from "@/lib/telegram/sendTelegramMessage";
import { syncMarketplaceDailyOrders } from "@/lib/marketplaceOrders/syncMarketplaceDailyOrders";

async function refreshOrdersAsOf(businessDate: string): Promise<string | null> {
  try {
    const day = new Date(`${businessDate}T00:00:00.000Z`);
    await syncMarketplaceDailyOrders({
      dateFrom: day,
      dateTo: day,
      mode: "manual",
    });
    return new Date().toISOString();
  } catch {
    return null;
  }
}

/**
 * Execute SEND_PRELIMINARY / SEND_FINAL from an already-passed gate result.
 */
export async function executeOwnerMorningGateSend(params: {
  gate: Extract<
    OwnerMorningGateResult,
    { action: "SEND_FINAL" | "SEND_PRELIMINARY" }
  >;
  send?: boolean;
}): Promise<Record<string, unknown>> {
  const { gate } = params;
  const send = params.send !== false;
  const businessDate = gate.businessDate;

  const ordersAsOf = await refreshOrdersAsOf(businessDate);
  const cogs =
    gate.action === "SEND_PRELIMINARY"
      ? gate.cogs
      : gate.cogs ?? (await evaluateOwnerReportCogsCoverage(businessDate));

  if (gate.action === "SEND_FINAL" && !cogs.coverageComplete) {
    return {
      businessDate,
      action: "DEFER",
      reason: "WAITING_PRODUCT_COST_COVERAGE",
      unresolvedSkuCount: cogs.unresolvedSkuCount,
      unresolvedQty: cogs.unresolvedQty,
    };
  }

  const report = await buildDailyReport({ date: businessDate });
  if (
    Boolean(
      (report as { combinedFinancialUnavailable?: boolean })
        .combinedFinancialUnavailable
    ) ||
    report.companies.some((c) =>
      Boolean(
        (c.ozon as { financialUnavailable?: boolean } | undefined)
          ?.financialUnavailable
      )
    )
  ) {
    return {
      businessDate,
      action: "DEFER_AFTER_BUILD",
      reason: "OZON_STILL_INCOMPLETE_IN_REPORT",
    };
  }

  const extras = await loadOwnerReportV3Extras(report);
  extras.cogsCoverage = cogs;
  if (!cogs.coverageComplete) {
    extras.missingCogsItems = await enrichMissingCogsItemsForDisplay(
      listUnresolvedCogsItems(cogs),
    );
  }
  const v3 = formatOwnerReportV3(
    report,
    extras,
    (report as { previousReport?: DailyReport | null }).previousReport ?? null
  );
  const header =
    gate.action === "SEND_FINAL" && gate.recoveryHeader
      ? `${gate.recoveryHeader}\n\n`
      : "";
  const message1 = `${header}${v3.message1}`;
  const message2 = v3.message2;
  const replyMarkup =
    gate.action === "SEND_PRELIMINARY"
      ? morningReportInlineKeyboard({
          businessDate,
          unresolvedSkuCount: cogs.unresolvedSkuCount,
        })
      : gate.action === "SEND_FINAL"
        ? morningReportInlineKeyboard({ businessDate, unresolvedSkuCount: 0 })
        : undefined;

  if (!send) {
    return {
      ok: true,
      sent: false,
      action: gate.action,
      businessDate,
      deliveryStatus:
        gate.action === "SEND_PRELIMINARY"
          ? "PRELIMINARY_MISSING_COGS"
          : "READY_TO_FINAL_SEND",
      message1,
      message2,
      replyMarkup,
      cogsCoverageComplete: cogs.coverageComplete,
      unresolvedSkuCount: cogs.unresolvedSkuCount,
      unresolvedQty: cogs.unresolvedQty,
      missingItems: cogs.marketplaces.flatMap((m) =>
        m.rows
          .filter((r) => !r.covered)
          .map((r) => ({
            companyName: m.companyName,
            marketplace: m.marketplace,
            article: r.vendorCode || r.nmId || r.skuKey,
            nmId: r.nmId,
            qty: Math.abs(r.netQty),
          })),
      ),
    };
  }

  const chatIds = getTelegramAllowedChatIds();
  const messageIds: Array<{ chatId: string; messageId: number | string | null }> =
    [];
  for (const chatId of chatIds) {
    const r1 = await sendTelegramMessage({
      chatId,
      text: message1,
      parseMode: "HTML",
      replyMarkup,
    });
    messageIds.push({
      chatId,
      messageId: (r1 as any)?.result?.message_id ?? (r1 as any)?.message_id ?? null,
    });
    if (message2.trim()) {
      await sendTelegramMessage({ chatId, text: message2, parseMode: "HTML" });
    }
  }

  const sourceFingerprint = await captureOwnerReportSourceFingerprint(businessDate);
  if (ordersAsOf) sourceFingerprint.ordersAsOf = ordersAsOf;

  if (gate.action === "SEND_PRELIMINARY") {
    const provenance = await markOwnerMorningPreliminarySent({
      businessDate,
      provenance: gate.provenance,
      messageIds,
      cogs,
    });
    return {
      businessDate,
      action: "PRELIMINARY_SENT",
      recipients: chatIds.length,
      deliveryStatus: provenance.deliveryStatus,
      preliminarySentAt: provenance.preliminarySentAt,
      finalMessageIds: provenance.finalMessageIds,
      cogsCoverageComplete: false,
      unresolvedSkuCount: cogs.unresolvedSkuCount,
    };
  }

  const finalSentAt = new Date().toISOString();
  const finalSnapshot = buildOwnerReportFinalSnapshot({
    report,
    message1,
    message2,
    sourceFingerprint,
    cogsCoverage: cogs,
    sourceMode: "FINAL_SENT_SNAPSHOT",
    canonical: true,
    historicalAuditOnly: false,
    finalSentAt,
  });
  const provenance = await markOwnerMorningFinalSent({
    businessDate,
    provenance: gate.provenance,
    messageIds,
    recoveryHeaderUsed: Boolean(gate.recoveryHeader),
    finalSnapshot,
  });
  return {
    businessDate,
    action: "FINAL_SENT",
    recipients: chatIds.length,
    deliveryStatus: provenance.deliveryStatus,
    finalMessageIds: provenance.finalMessageIds,
    snapshotTotals: finalSnapshot.totals,
    ordersAsOf: finalSnapshot.ordersAsOf,
    cogsCoverageComplete: cogs.coverageComplete,
    sourceFingerprint,
  };
}

/** After ProductCost save — auto FINAL if coverage complete; else keep preliminary. */
export async function recalcOwnerMorningAfterCogsSave(businessDate: string) {
  const gate = await gateOwnerMorningReportSend({
    businessDate,
    allowRecoveryHeader: true,
    forceRefresh: false,
  });
  if (gate.action === "ALREADY_FINAL_SENT") {
    return { action: "ALREADY_FINAL_SENT" as const, businessDate };
  }
  if (gate.action === "SEND_FINAL") {
    return executeOwnerMorningGateSend({ gate, send: true });
  }
  if (gate.action === "SEND_PRELIMINARY") {
    // Should not normally happen if preliminary already sent; execute once.
    return executeOwnerMorningGateSend({ gate, send: true });
  }
  if (gate.action === "ALREADY_PRELIMINARY_SENT") {
    return {
      action: "STILL_PRELIMINARY" as const,
      businessDate,
      unresolvedSkuCount: gate.cogs.unresolvedSkuCount,
    };
  }
  return {
    action: gate.action,
    businessDate,
    reason: "reason" in gate ? gate.reason : null,
  };
}
