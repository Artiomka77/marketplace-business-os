import { prisma } from "@/lib/prisma";
import type { OzonAccrualDayStatusRecord } from "@/lib/ozon/accrualDayStatus";

type StatusClient = {
  ozonAccrualDayStatus: {
    findMany: (args: unknown) => Promise<Array<Record<string, unknown>>>;
    upsert: (args: unknown) => Promise<unknown>;
  };
};

function asStatusClient(client: unknown): StatusClient {
  return client as StatusClient;
}

export async function persistOzonAccrualDayStatuses(
  records: OzonAccrualDayStatusRecord[],
  client: unknown = prisma,
) {
  const db = asStatusClient(client);
  for (const record of records) {
    await db.ozonAccrualDayStatus.upsert({
      where: {
        companyName_date: {
          companyName: record.companyName,
          date: record.date,
        },
      },
      create: {
        companyName: record.companyName,
        date: record.date,
        importSessionId: record.importSessionId,
        dataMode: record.dataMode,
        coverageComplete: record.coverageComplete,
        quarantineCount: record.quarantineCount,
        missingEvidence: record.missingEvidence,
        payloadSha256: record.payloadSha256 ?? null,
        phase: record.phase,
      },
      update: {
        importSessionId: record.importSessionId,
        dataMode: record.dataMode,
        coverageComplete: record.coverageComplete,
        quarantineCount: record.quarantineCount,
        missingEvidence: record.missingEvidence,
        payloadSha256: record.payloadSha256 ?? null,
        phase: record.phase,
      },
    });
  }
}

export async function loadOzonAccrualDayStatuses(
  params: {
    companyName?: string | null;
    dateFrom: string;
    dateTo: string;
  },
  client: unknown = prisma,
): Promise<OzonAccrualDayStatusRecord[]> {
  const rows = await asStatusClient(client).ozonAccrualDayStatus.findMany({
    where: {
      date: {
        gte: params.dateFrom,
        lte: params.dateTo,
      },
      ...(params.companyName && params.companyName !== "ALL"
        ? { companyName: params.companyName }
        : {}),
    },
  });
  return rows.map((row) => ({
    companyName: String(row.companyName ?? ""),
    date: String(row.date ?? ""),
    importSessionId: String(row.importSessionId ?? ""),
    dataMode: row.dataMode === "FINAL" ? "FINAL" : "PRELIMINARY",
    coverageComplete: row.coverageComplete === true,
    quarantineCount: Number(row.quarantineCount ?? 0),
    missingEvidence: Array.isArray(row.missingEvidence)
      ? row.missingEvidence.map((item) => String(item))
      : [],
    payloadSha256: row.payloadSha256 ? String(row.payloadSha256) : null,
    phase: row.phase === "CANONICAL" ? "CANONICAL" : "RAW",
  }));
}
