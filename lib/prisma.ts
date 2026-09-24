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

export function getSafePrismaPoolSnapshot(): SafePrismaPoolSnapshot {
  return {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
    max: PRISMA_POOL_MAX,
    connectionTimeoutMillis: PRISMA_POOL_CONNECTION_TIMEOUT_MS,
  };
}

const adapter = new PrismaPg(pool);

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
