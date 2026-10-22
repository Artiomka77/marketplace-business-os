import { NextRequest, NextResponse } from "next/server";

import { rejectUnauthorizedCron } from "@/lib/security/cronAuth";
import {
  listDueOwnerMorningRetries,
  runOwnerMorningDeliveryWatchdog,
} from "@/lib/telegram/dailyOwnerReportDelivery";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Independent delivery watchdog (30–60 min cadence via host cron).
 * Does not send FINAL itself — requeues the existing retry path.
 */
export async function GET(request: NextRequest) {
  const denied = rejectUnauthorizedCron(request);
  if (denied) return denied;

  const now = new Date();
  const watchdog = await runOwnerMorningDeliveryWatchdog(now);
  const due = await listDueOwnerMorningRetries(now);

  return NextResponse.json({
    ok: true,
    watchdog,
    dueScopes: due.map((d: { scope: string }) => d.scope),
    dueCount: due.length,
  });
}
