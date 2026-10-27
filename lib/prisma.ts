import "dotenv/config";

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import {
  PRISMA_POOL_CONNECTION_TIMEOUT_MS,
  PRISMA_POOL_IDLE_TIMEOUT_MS,
  PRISMA_POOL_MAX,
  type SafePrismaPoolSnapshot,
} from "@/lib/db/prismaPoolConfig";

export {
  PRISMA_POOL_CONNECTION_TIMEOUT_MS,
  PRISMA_POOL_IDLE_TIMEOUT_MS,
  PRISMA_POOL_MAX,
  type SafePrismaPoolSnapshot,
} from "@/lib/db/prismaPoolConfig";

const OFFLINE = process.env.FIN_GATE_OFFLINE === "1";

type AnyClient = Record<string, unknown>;

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
  __avorofinPrismaActive?: AnyClient;
  __avorofinPrismaReal?: PrismaClient;
  __avorofinPrismaPool?: Pool;
};

function createRealPrisma(): PrismaClient {
  const connectionString = process.env.DATABASE_URL ?? "";
  const disableSsl =
    process.env.EPHEMERAL_PG === "1" ||
    /sslmode=disable/i.test(connectionString) ||
    /127\.0\.0\.1|localhost/i.test(connectionString);

  const pool = new Pool({
    connectionString,
    max: PRISMA_POOL_MAX,
    idleTimeoutMillis: PRISMA_POOL_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: PRISMA_POOL_CONNECTION_TIMEOUT_MS,
    ssl: disableSsl ? false : { rejectUnauthorized: false },
  });
  globalForPrisma.__avorofinPrismaPool = pool;

  const adapter = new PrismaPg(pool);
  return new PrismaClient({ adapter });
}

function refuseUnboundOfflineClient(): AnyClient {
  const refuse = (label: string) => async () => {
    throw new Error(
      `OFFLINE_PRISMA_UNBOUND:${label} — call bindPrismaClientForOfflineReplay first`,
    );
  };
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return undefined;
        return refuse(String(prop));
      },
    },
  ) as AnyClient;
}

function resolveActiveClient(): AnyClient {
  if (globalForPrisma.__avorofinPrismaActive) {
    return globalForPrisma.__avorofinPrismaActive;
  }
  if (OFFLINE) {
    // Never silently return empty tables — wiring errors must fail loud.
    return refuseUnboundOfflineClient();
  }
  if (!globalForPrisma.__avorofinPrismaReal) {
    globalForPrisma.__avorofinPrismaReal =
      globalForPrisma.prisma ?? createRealPrisma();
    if (process.env.NODE_ENV !== "production") {
      globalForPrisma.prisma = globalForPrisma.__avorofinPrismaReal;
    }
  }
  globalForPrisma.__avorofinPrismaActive =
    globalForPrisma.__avorofinPrismaReal as unknown as AnyClient;
  return globalForPrisma.__avorofinPrismaActive!;
}

/**
 * Offline replay I/O boundary (FIN_GATE). Allowed only when FIN_GATE_OFFLINE=1.
 * Substitutes Prisma I/O; does not replace compute/tax/resolver logic.
 */
export function bindPrismaClientForOfflineReplay(client: unknown) {
  if (process.env.FIN_GATE_OFFLINE !== "1") {
    throw new Error(
      "bindPrismaClientForOfflineReplay requires FIN_GATE_OFFLINE=1",
    );
  }
  globalForPrisma.__avorofinPrismaActive = client as AnyClient;
}

export function unbindPrismaClientForOfflineReplay() {
  if (process.env.FIN_GATE_OFFLINE !== "1") return;
  globalForPrisma.__avorofinPrismaActive = undefined;
}

export function getSafePrismaPoolSnapshot(): SafePrismaPoolSnapshot {
  const pool = globalForPrisma.__avorofinPrismaPool;
  return {
    total: pool?.totalCount ?? 0,
    idle: pool?.idleCount ?? 0,
    waiting: pool?.waitingCount ?? 0,
    max: PRISMA_POOL_MAX,
    connectionTimeoutMillis: PRISMA_POOL_CONNECTION_TIMEOUT_MS,
  };
}

/**
 * Proxy so already-imported modules always hit the active client
 * (real DB or offline fixture bind).
 */
export const prisma = new Proxy({} as PrismaClient, {
  get(_target, prop, _receiver) {
    const current = resolveActiveClient();
    const value = Reflect.get(current, prop, current);
    if (typeof value === "function") {
      return (value as (...args: unknown[]) => unknown).bind(current);
    }
    return value;
  },
  has(_target, prop) {
    return prop in resolveActiveClient();
  },
});
