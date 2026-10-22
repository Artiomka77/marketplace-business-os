/**
 * Narrow classifier for transient DB connectivity / pool-acquisition failures.
 * Does not swallow schema, programming, auth, or financial invariant errors.
 */

export const TRANSIENT_DB_SAFE_CODES = {
  CONNECT_ACQUISITION_TIMEOUT: "DB_CONNECT_ACQUISITION_TIMEOUT",
  LOCAL_POOL_CONTENTION: "DB_LOCAL_POOL_CONTENTION",
  UPSTREAM_UNREACHABLE: "DB_UPSTREAM_UNREACHABLE",
  NETWORK_RESET: "DB_NETWORK_RESET",
  CONNECTION_EXCEPTION: "DB_CONNECTION_EXCEPTION",
} as const;

export type TransientDbSafeCode =
  (typeof TRANSIENT_DB_SAFE_CODES)[keyof typeof TRANSIENT_DB_SAFE_CODES];

export type TransientDatabaseClassification = {
  kind: "transient_database";
  transient: true;
  retryable: boolean;
  consumedFullConnectBudget: boolean;
  safeCode: TransientDbSafeCode;
  safeMessageClass: string;
};

export type NonTransientDatabaseClassification = {
  kind: "non_transient";
  transient: false;
  retryable: false;
  consumedFullConnectBudget: false;
  safeCode: "NON_TRANSIENT";
  safeMessageClass: "non_transient";
};

export type DatabaseErrorClassification =
  | TransientDatabaseClassification
  | NonTransientDatabaseClassification;

const CONNECT_TIMEOUT_MESSAGE = "timeout exceeded when trying to connect";

const FAST_NETWORK_CODES = new Set([
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
]);

const PRISMA_CONNECTIVITY_CODES = new Set([
  "P1001",
  "P1002",
  "P1008",
  "P1017",
  "P2024",
]);

function collectErrorParts(error: unknown): {
  name: string;
  code: string;
  message: string;
  sqlState: string;
} {
  const err = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const cause =
    err.cause && typeof err.cause === "object"
      ? (err.cause as Record<string, unknown>)
      : {};
  const name = String(err.name ?? "");
  const code = String(err.code ?? cause.code ?? "");
  const message = String(err.message ?? cause.message ?? error ?? "");
  const sqlState = String(
    err.sqlState ?? cause.sqlState ?? (code.length === 5 ? code : ""),
  );
  return { name, code, message, sqlState };
}

export function isConnectAcquisitionTimeout(error: unknown): boolean {
  const { message, code } = collectErrorParts(error);
  return (
    message.toLowerCase().includes(CONNECT_TIMEOUT_MESSAGE) ||
    code === "P2024"
  );
}

export function classifyDatabaseError(
  error: unknown,
  options: { consumedFullConnectBudget?: boolean } = {},
): DatabaseErrorClassification {
  if (error && typeof error === "object") {
    const named = error as { name?: string };
    if (named.name === "WbTaxReportKindError") {
      return {
        kind: "non_transient",
        transient: false,
        retryable: false,
        consumedFullConnectBudget: false,
        safeCode: "NON_TRANSIENT",
        safeMessageClass: "non_transient",
      };
    }
  }

  const { name, code, message, sqlState } = collectErrorParts(error);
  const lower = message.toLowerCase();
  const consumed = options.consumedFullConnectBudget === true;
  const connectTimeout =
    lower.includes(CONNECT_TIMEOUT_MESSAGE) || code === "P2024";

  if (connectTimeout) {
    return {
      kind: "transient_database",
      transient: true,
      retryable: false,
      consumedFullConnectBudget: true,
      safeCode: TRANSIENT_DB_SAFE_CODES.CONNECT_ACQUISITION_TIMEOUT,
      safeMessageClass: "pg_pool_connect_timeout",
    };
  }

  if (PRISMA_CONNECTIVITY_CODES.has(code) && code !== "P2024") {
    const retryable = !consumed && (code === "P1001" || code === "P1017");
    return {
      kind: "transient_database",
      transient: true,
      retryable,
      consumedFullConnectBudget: consumed,
      safeCode:
        code === "P1001" || code === "P1002"
          ? TRANSIENT_DB_SAFE_CODES.UPSTREAM_UNREACHABLE
          : TRANSIENT_DB_SAFE_CODES.CONNECTION_EXCEPTION,
      safeMessageClass: `prisma_${code.toLowerCase()}`,
    };
  }

  if (FAST_NETWORK_CODES.has(code)) {
    return {
      kind: "transient_database",
      transient: true,
      retryable: !consumed,
      consumedFullConnectBudget: consumed,
      safeCode:
        code === "ECONNREFUSED" || code === "EHOSTUNREACH" || code === "ENETUNREACH"
          ? TRANSIENT_DB_SAFE_CODES.UPSTREAM_UNREACHABLE
          : TRANSIENT_DB_SAFE_CODES.NETWORK_RESET,
      safeMessageClass: `network_${code.toLowerCase()}`,
    };
  }

  if (/^08/.test(sqlState)) {
    return {
      kind: "transient_database",
      transient: true,
      retryable: !consumed,
      consumedFullConnectBudget: consumed,
      safeCode: TRANSIENT_DB_SAFE_CODES.CONNECTION_EXCEPTION,
      safeMessageClass: `sqlstate_${sqlState}`,
    };
  }

  void name;
  return {
    kind: "non_transient",
    transient: false,
    retryable: false,
    consumedFullConnectBudget: false,
    safeCode: "NON_TRANSIENT",
    safeMessageClass: "non_transient",
  };
}

export function isTransientDatabaseError(error: unknown): boolean {
  return classifyDatabaseError(error).transient;
}

export class AnalyticsDatabaseUnavailableError extends Error {
  readonly classification: TransientDatabaseClassification;
  readonly surface: string;

  constructor(
    surface: string,
    classification: TransientDatabaseClassification,
  ) {
    super("analytics_database_temporarily_unavailable");
    this.name = "AnalyticsDatabaseUnavailableError";
    this.surface = surface;
    this.classification = classification;
  }
}
