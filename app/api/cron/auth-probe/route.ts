import { NextResponse } from "next/server";

import { rejectUnauthorizedCron } from "@/lib/security/cronAuth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const cronDenied = rejectUnauthorizedCron(request);
  if (cronDenied) return cronDenied;

  return NextResponse.json({ ok: true, probe: "cron-auth" });
}
