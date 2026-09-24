import {
  classifyDatabaseError,
  isConnectAcquisitionTimeout,
  type DatabaseErrorClassification,
} from "./transientDatabaseError";
import { PRISMA_POOL_CONNECTION_TIMEOUT_MS } from "./prismaPoolConfig";

export type ReadOnlyCallback<T> = () => Promise<T>;

export type TransientDbRetryOptions<T> = {
  executeRead: ReadOnlyCallback<T>;
  connectionTimeoutMillis?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

const MAX_ATTEMPTS = 2;
const FAST_RETRY_BACKOFF_MS = 75;

function defaultSleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * At most two read attempts. A full pg connect-acquisition timeout is never
 * followed by a second full wait.
 */
export async function runReadWithTransientDbPolicy<T>(
  options: TransientDbRetryOptions<T>,
): Promise<T> {
  const connectionTimeoutMillis =
    options.connectionTimeoutMillis ?? PRISMA_POOL_CONNECTION_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const started = now();
    try {
      return await options.executeRead();
    } catch (error) {
      lastError = error;
      const elapsed = Math.max(0, now() - started);
      const consumedFullConnectBudget =
        isConnectAcquisitionTimeout(error) ||
        elapsed >= connectionTimeoutMillis;
      const classification: DatabaseErrorClassification = classifyDatabaseError(
        error,
        { consumedFullConnectBudget },
      );

      if (!classification.transient) {
        throw error;
      }

      if (isConnectAcquisitionTimeout(error) || consumedFullConnectBudget) {
        throw error;
      }

      if (!classification.retryable || attempt >= MAX_ATTEMPTS) {
        throw error;
      }

      await sleep(FAST_RETRY_BACKOFF_MS);
    }
  }

  throw lastError;
}

export function countReadAttemptsForTest(): { maxAttempts: number } {
  return { maxAttempts: MAX_ATTEMPTS };
}
