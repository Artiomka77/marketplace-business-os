/** Certified production pg Pool settings. Do not retune in this incident. */

export const PRISMA_POOL_MAX = 1;
export const PRISMA_POOL_IDLE_TIMEOUT_MS = 10_000;
export const PRISMA_POOL_CONNECTION_TIMEOUT_MS = 10_000;

export type SafePrismaPoolSnapshot = {
  total: number;
  idle: number;
  waiting: number;
  max: number;
  connectionTimeoutMillis: number;
};
