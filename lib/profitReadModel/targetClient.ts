/**
 * Wave B Profit read-model target Prisma binding.
 *
 * PRODUCTION default: SAME_PRODUCTION_DB — reuse canonical `@/lib/prisma` pool.
 * Do NOT open a second pg.Pool against the same production database.
 *
 * EPHEMERAL_SEPARATE_DB: dedicated pool only when WAVE_B_PROFIT_TARGET_DATABASE_URL
 * points at a distinct ephemeral/staging database (preprod canaries).
 */
import type { PrismaClient } from "@prisma/client";
import { PrismaClient as PrismaClientCtor } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import {
  PRISMA_POOL_CONNECTION_TIMEOUT_MS,
  PRISMA_POOL_IDLE_TIMEOUT_MS,
  PRISMA_POOL_MAX,
} from "@/lib/db/prismaPoolConfig";
import { prisma as canonicalAppPrisma } from "@/lib/prisma";

export type WaveBTargetDbMode = "SAME_PRODUCTION_DB" | "EPHEMERAL_SEPARATE_DB";

type GlobalTarget = {
  waveBProfitTargetPrisma?: PrismaClient;
  waveBProfitTargetPool?: Pool;
  waveBProfitTargetMode?: WaveBTargetDbMode;
  waveBProfitTargetOwnsClient?: boolean;
};

function envRecord(): Record<string, string | undefined> {
  return process.env as Record<string, string | undefined>;
}

/** Compare host+db path only — never log full URLs/secrets. */
export function sameDatabaseIdentity(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return (
      ua.protocol === ub.protocol &&
      ua.hostname === ub.hostname &&
      ua.port === ub.port &&
      ua.pathname === ub.pathname
    );
  } catch {
    return a === b;
  }
}

export function resolveWaveBTargetDbMode(): WaveBTargetDbMode {
  const env = envRecord();
  const forced = env["WAVE_B_TARGET_DB_MODE"]?.trim();
  if (forced === "EPHEMERAL_SEPARATE_DB") return "EPHEMERAL_SEPARATE_DB";
  if (forced === "SAME_PRODUCTION_DB") return "SAME_PRODUCTION_DB";

  const target = env["WAVE_B_PROFIT_TARGET_DATABASE_URL"]?.trim();
  const canonical = env["DATABASE_URL"]?.trim();
  if (!target) return "SAME_PRODUCTION_DB";
  if (canonical && sameDatabaseIdentity(target, canonical)) {
    return "SAME_PRODUCTION_DB";
  }
  return "EPHEMERAL_SEPARATE_DB";
}

function sslOptionForUrl(url: string): false | { rejectUnauthorized: boolean } {
  if (
    /localhost|127\.0\.0\.1|@waveb-ephem|@ephem/i.test(url) ||
    envRecord()["WAVE_B_PROFIT_TARGET_SSL"] === "0"
  ) {
    return false;
  }
  return { rejectUnauthorized: false };
}

/**
 * Returns the Prisma client used for Wave B read-model tables/jobs.
 * SAME_PRODUCTION_DB → canonical app prisma (single protected pool).
 * EPHEMERAL_SEPARATE_DB → dedicated max=1 pool to ephemeral target only.
 */
export function createWaveBProfitTargetPrismaClient(): PrismaClient {
  const mode = resolveWaveBTargetDbMode();
  const globalFor = globalThis as unknown as GlobalTarget;

  if (
    globalFor.waveBProfitTargetPrisma &&
    globalFor.waveBProfitTargetMode === mode
  ) {
    return globalFor.waveBProfitTargetPrisma;
  }

  // Mode switched (e.g. tests): drop previous owned client only.
  if (
    globalFor.waveBProfitTargetOwnsClient &&
    globalFor.waveBProfitTargetPrisma
  ) {
    void globalFor.waveBProfitTargetPrisma.$disconnect().catch(() => undefined);
    globalFor.waveBProfitTargetPrisma = undefined;
  }
  if (globalFor.waveBProfitTargetPool) {
    void globalFor.waveBProfitTargetPool.end().catch(() => undefined);
    globalFor.waveBProfitTargetPool = undefined;
  }

  if (mode === "SAME_PRODUCTION_DB") {
    // Reuse the canonical app singleton (static import — Next/webpack CJS interop
    // breaks `require("@/lib/prisma").prisma` and yields undefined delegates).
    globalFor.waveBProfitTargetPrisma = canonicalAppPrisma;
    globalFor.waveBProfitTargetMode = mode;
    globalFor.waveBProfitTargetOwnsClient = false;
    return canonicalAppPrisma;
  }

  const env = envRecord();
  const connectionString = env["WAVE_B_PROFIT_TARGET_DATABASE_URL"]?.trim();
  if (!connectionString) {
    throw new Error(
      "EPHEMERAL_SEPARATE_DB requires WAVE_B_PROFIT_TARGET_DATABASE_URL"
    );
  }

  const max =
    Number(env["WAVE_B_PROFIT_TARGET_POOL_MAX"] ?? PRISMA_POOL_MAX) ||
    PRISMA_POOL_MAX;
  const idle =
    Number(env["WAVE_B_PROFIT_TARGET_IDLE_TIMEOUT_MS"] ?? PRISMA_POOL_IDLE_TIMEOUT_MS) ||
    PRISMA_POOL_IDLE_TIMEOUT_MS;
  const connect =
    Number(
      env["WAVE_B_PROFIT_TARGET_CONNECTION_TIMEOUT_MS"] ??
        PRISMA_POOL_CONNECTION_TIMEOUT_MS
    ) || PRISMA_POOL_CONNECTION_TIMEOUT_MS;

  const pool = new Pool({
    connectionString,
    max: Math.min(1, Math.max(1, max)),
    idleTimeoutMillis: idle,
    connectionTimeoutMillis: connect,
    ssl: sslOptionForUrl(connectionString),
  });
  const adapter = new PrismaPg(pool);
  const client = new PrismaClientCtor({ adapter });
  globalFor.waveBProfitTargetPool = pool;
  globalFor.waveBProfitTargetPrisma = client;
  globalFor.waveBProfitTargetMode = mode;
  globalFor.waveBProfitTargetOwnsClient = true;
  return client;
}

export async function disconnectWaveBProfitTargetPrismaClient() {
  const globalFor = globalThis as unknown as GlobalTarget;
  // Never disconnect the shared canonical prisma.
  if (globalFor.waveBProfitTargetOwnsClient && globalFor.waveBProfitTargetPrisma) {
    await globalFor.waveBProfitTargetPrisma.$disconnect().catch(() => undefined);
  }
  globalFor.waveBProfitTargetPrisma = undefined;
  globalFor.waveBProfitTargetMode = undefined;
  globalFor.waveBProfitTargetOwnsClient = undefined;
  if (globalFor.waveBProfitTargetPool) {
    await globalFor.waveBProfitTargetPool.end().catch(() => undefined);
    globalFor.waveBProfitTargetPool = undefined;
  }
}

/** Evidence helper — no URLs. */
export function waveBTargetPoolContract(): {
  TARGET_DB_MODE: WaveBTargetDbMode;
  PRODUCTION_SAME_DB_SEPARATE_POOL_CREATED: "YES" | "NO";
  PRODUCTION_TOTAL_WAVE_B_POOL_MAX_EFFECTIVE: number;
} {
  const mode = resolveWaveBTargetDbMode();
  return {
    TARGET_DB_MODE: mode,
    PRODUCTION_SAME_DB_SEPARATE_POOL_CREATED:
      mode === "SAME_PRODUCTION_DB" ? "NO" : "YES",
    PRODUCTION_TOTAL_WAVE_B_POOL_MAX_EFFECTIVE: 1,
  };
}
