import { NextRequest, NextResponse } from "next/server";

import { rejectUnauthorizedCron } from "@/lib/security/cronAuth";
import {
  gateOwnerMorningReportSend,
  listDueOwnerMorningRetries,
  loadDeliveryState,
  runOwnerMorningDeliveryWatchdog,
} from "@/lib/telegram/dailyOwnerReportDelivery";
import { executeOwnerMorningGateSend } from "@/lib/telegram/ownerReportSendHelpers";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const denied = rejectUnauthorizedCron(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const exactDate = url.searchParams.get("date");
  const dry = url.searchParams.get("send") === "false";
  const now = new Date();
  const watchdog = exactDate
    ? null
    : await runOwnerMorningDeliveryWatchdog(now);
  const due = exactDate
    ? [{ scope: exactDate }]
    : await listDueOwnerMorningRetries(now);

  const results: Array<Record<string, unknown>> = [];

  for (const item of due) {
    const businessDate = String(item.scope);
    const existing = await loadDeliveryState(businessDate);
    if (existing.provenance.deliveryStatus === "FINAL_SENT") {
      results.push({
        businessDate,
        action: "SKIP_ALREADY_FINAL",
      });
      continue;
    }

    const gate = await gateOwnerMorningReportSend({
      businessDate,
      allowRecoveryHeader: true,
      forceRefresh: true,
    });

    if (gate.action === "ALREADY_FINAL_SENT") {
      results.push({ businessDate, action: "ALREADY_FINAL_SENT" });
      continue;
    }

    if (gate.action === "ALREADY_PRELIMINARY_SENT") {
      results.push({
        businessDate,
        action: "ALREADY_PRELIMINARY_SENT",
        unresolvedSkuCount: gate.cogs.unresolvedSkuCount,
        nextAttemptAt: gate.provenance.nextAttemptAt,
      });
      continue;
    }

    if (gate.action === "DEFER") {
      results.push({
        businessDate,
        action: "DEFER",
        reason: gate.reason,
        nextAttemptAt: gate.provenance.nextAttemptAt,
        serviceNoticeSent: gate.serviceNoticeSent,
        technicalNoticeSent: gate.technicalNoticeSent,
        readiness: gate.readiness,
      });
      continue;
    }

    if (gate.action === "SEND_PRELIMINARY" || gate.action === "SEND_FINAL") {
      const sent = await executeOwnerMorningGateSend({
        gate,
        send: !dry,
      });
      results.push(sent);
      continue;
    }
  }

  return NextResponse.json({
    ok: true,
    processed: results.length,
    results,
    watchdog,
  });
}
