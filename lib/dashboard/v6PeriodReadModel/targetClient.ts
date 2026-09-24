/**
 * Prisma client bound to V6 read-model TARGET database.
 * Source FC reads continue to use @/lib/prisma (DATABASE_URL).
 * Canary: V6_READMODEL_TARGET_DATABASE_URL = ephemeral PG only.
 * Production (after owner gate): may equal DATABASE_URL.
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import type { PrismaLikeV6Client } from "./repository";

type GlobalTarget = {
  waveAV6TargetPrisma?: PrismaClient;
  waveAV6TargetPool?: Pool;
};

function resolveTargetDatabaseUrl(): string {
  const target = process.env.V6_READMODEL_TARGET_DATABASE_URL?.trim();
  if (target) return target;
  const fallback = process.env.DATABASE_URL?.trim();
  if (!fallback) {
    throw new Error(
      "V6_READMODEL_TARGET_DATABASE_URL or DATABASE_URL is required for Prisma V6 read-model repository"
    );
  }
  return fallback;
}

function sslOptionForUrl(url: string): false | { rejectUnauthorized: boolean } {
  // Ephemeral local PG (host.docker.internal / 127.0.0.1 / docker network) has no TLS.
  if (
    /localhost|127\.0\.0\.1|@wavea-v2-ephem-pg|@ephem/i.test(url) ||
    process.env.V6_READMODEL_TARGET_SSL === "0"
  ) {
    return false;
  }
  return { rejectUnauthorized: false };
}

export function createV6ReadModelTargetPrismaClient(): PrismaClient {
  const globalFor = globalThis as unknown as GlobalTarget;
  if (globalFor.waveAV6TargetPrisma) return globalFor.waveAV6TargetPrisma;

  const connectionString = resolveTargetDatabaseUrl();
  const pool = new Pool({
    connectionString,
    max: Number(process.env.V6_READMODEL_TARGET_POOL_MAX ?? "2") || 2,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 30000,
    ssl: sslOptionForUrl(connectionString),
  });
  const adapter = new PrismaPg(pool);
  const client = new PrismaClient({ adapter });

  globalFor.waveAV6TargetPool = pool;
  globalFor.waveAV6TargetPrisma = client;
  return client;
}

export function asPrismaLikeV6Client(
  client: PrismaClient
): PrismaLikeV6Client {
  return client as unknown as PrismaLikeV6Client;
}

export async function disconnectV6ReadModelTargetPrismaClient() {
  const globalFor = globalThis as unknown as GlobalTarget;
  if (globalFor.waveAV6TargetPrisma) {
    await globalFor.waveAV6TargetPrisma.$disconnect().catch(() => undefined);
    globalFor.waveAV6TargetPrisma = undefined;
  }
  if (globalFor.waveAV6TargetPool) {
    await globalFor.waveAV6TargetPool.end().catch(() => undefined);
    globalFor.waveAV6TargetPool = undefined;
  }
}
