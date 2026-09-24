import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadCanonicalAnalyticsForUi } from "../../lib/analytics/loadCanonicalAnalyticsForUi";
import { withAnalyticsPageFailSoft } from "../../lib/analytics/withAnalyticsPageFailSoft";
import { reloadCurrentDocument } from "../../components/analytics/AnalyticsTemporarilyUnavailable";
import { buildAnalyticsDbUnavailableLog } from "../../lib/db/logAnalyticsDbUnavailable";
import {
  countReadAttemptsForTest,
  runReadWithTransientDbPolicy,
} from "../../lib/db/runReadWithTransientDbPolicy";
import {
  classifyDatabaseError,
  isTransientDatabaseError,
} from "../../lib/db/transientDatabaseError";
import { WbTaxReportKindError } from "../../lib/finance/wbAccountantTaxBase";
import {
  PRISMA_POOL_CONNECTION_TIMEOUT_MS,
  PRISMA_POOL_IDLE_TIMEOUT_MS,
  PRISMA_POOL_MAX,
} from "../../lib/db/prismaPoolConfig";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CONNECT_TIMEOUT = "timeout exceeded when trying to connect";

function connectTimeoutError() {
  const error = new Error(CONNECT_TIMEOUT);
  (error as { clientVersion?: string }).clientVersion = "7.8.0";
  return error;
}

test("incident connect-timeout classifies as non-retryable transient", () => {
  const classification = classifyDatabaseError(connectTimeoutError());
  assert.equal(classification.kind, "transient_database");
  assert.equal(classification.transient, true);
  assert.equal(classification.retryable, false);
  assert.equal(classification.consumedFullConnectBudget, true);
  assert.equal(classification.safeCode, "DB_CONNECT_ACQUISITION_TIMEOUT");
  assert.equal(isTransientDatabaseError(connectTimeoutError()), true);
});

test("P2024 is treated as connect-acquisition timeout", () => {
  const error = Object.assign(new Error("Timed out fetching a new connection from the connection pool"), {
    code: "P2024",
  });
  const classification = classifyDatabaseError(error);
  assert.equal(classification.kind, "transient_database");
  assert.equal(classification.retryable, false);
  assert.equal(classification.safeCode, "DB_CONNECT_ACQUISITION_TIMEOUT");
});

test("fast ECONNRESET is retryable transient", () => {
  const error = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
  const classification = classifyDatabaseError(error);
  assert.equal(classification.kind, "transient_database");
  assert.equal(classification.retryable, true);
  assert.equal(classification.safeCode, "DB_NETWORK_RESET");
});

test("non-transient Prisma/schema/programming errors are not swallowed", () => {
  const cases = [
    Object.assign(new Error("The column `foo` does not exist"), { code: "P2022" }),
    Object.assign(new Error("Value out of range"), { code: "P2009" }),
    new TypeError("Cannot read properties of undefined"),
    Object.assign(new Error("Authentication failed"), { code: "P1000" }),
  ];
  for (const error of cases) {
    const classification = classifyDatabaseError(error);
    assert.equal(classification.kind, "non_transient", String(error));
    assert.equal(classification.retryable, false);
    assert.equal(isTransientDatabaseError(error), false);
  }
});

test("WbTaxReportKindError remains non-transient", () => {
  const error = new WbTaxReportKindError(
    "WB_TAX_REPORT_KIND_UNRESOLVED",
    "unresolved",
  );
  const classification = classifyDatabaseError(error);
  assert.equal(classification.kind, "non_transient");
  assert.equal(isTransientDatabaseError(error), false);
});

test("SQLSTATE 08xxx is transient", () => {
  const error = Object.assign(new Error("connection_failure"), { sqlState: "08006" });
  assert.equal(classifyDatabaseError(error).kind, "transient_database");
});

test("connect-timeout does not consume a second full wait", async () => {
  let calls = 0;
  let slept = 0;
  await assert.rejects(
    () =>
      runReadWithTransientDbPolicy({
        connectionTimeoutMillis: 10_000,
        now: () => 0,
        sleep: async (ms) => {
          slept += ms;
        },
        executeRead: async () => {
          calls += 1;
          throw connectTimeoutError();
        },
      }),
    (err: unknown) => err instanceof Error && err.message === CONNECT_TIMEOUT,
  );
  assert.equal(calls, 1);
  assert.equal(slept, 0);
  assert.equal(countReadAttemptsForTest().maxAttempts, 2);
});

test("fast ECONNRESET retries once then exits", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  await assert.rejects(
    () =>
      runReadWithTransientDbPolicy({
        connectionTimeoutMillis: 10_000,
        now: (() => {
          let t = 0;
          return () => {
            t += 1;
            return t;
          };
        })(),
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        executeRead: async () => {
          calls += 1;
          throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
        },
      }),
    (err: unknown) =>
      err instanceof Error && (err as { code?: string }).code === "ECONNRESET",
  );
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [75]);
});

test("non-transient error is never retried", async () => {
  let calls = 0;
  const error = Object.assign(new Error("The column `foo` does not exist"), {
    code: "P2022",
  });
  await assert.rejects(
    () =>
      runReadWithTransientDbPolicy({
        executeRead: async () => {
          calls += 1;
          throw error;
        },
      }),
    (err: unknown) => err === error,
  );
  assert.equal(calls, 1);
});

test("UI adapter maps incident timeout to UNAVAILABLE without fabricated FINAL zeroes", async () => {
  const dashboard = await loadCanonicalAnalyticsForUi({
    surface: "dashboard",
    log: false,
    executeRead: async () => {
      throw connectTimeoutError();
    },
  });
  const wb = await loadCanonicalAnalyticsForUi({
    surface: "profit-wb",
    log: false,
    executeRead: async () => {
      throw connectTimeoutError();
    },
  });
  const ozon = await loadCanonicalAnalyticsForUi({
    surface: "profit-ozon",
    log: false,
    executeRead: async () => {
      throw connectTimeoutError();
    },
  });

  for (const result of [dashboard, wb, ozon]) {
    assert.equal(result.status, "UNAVAILABLE");
    if (result.status !== "UNAVAILABLE") continue;
    assert.equal(result.fabricatedNumericFinal, false);
    assert.equal(result.reason.safeCode, "DB_CONNECT_ACQUISITION_TIMEOUT");
    assert.equal("data" in result, false);
  }
});

test("UI adapter still surfaces non-transient Prisma errors", async () => {
  const error = Object.assign(new Error("The column `foo` does not exist"), {
    code: "P2022",
  });
  await assert.rejects(
    () =>
      loadCanonicalAnalyticsForUi({
        surface: "profit-wb",
        log: false,
        executeRead: async () => {
          throw error;
        },
      }),
    (err: unknown) => err === error,
  );
});

test("UI adapter still surfaces WbTaxReportKindError", async () => {
  const error = new WbTaxReportKindError(
    "WB_TAX_REPORT_KIND_UNRESOLVED",
    "unresolved",
  );
  await assert.rejects(
    () =>
      loadCanonicalAnalyticsForUi({
        surface: "profit-wb",
        log: false,
        executeRead: async () => {
          throw error;
        },
      }),
    (err: unknown) => err instanceof WbTaxReportKindError,
  );
});

test("page fail-soft boundary does not let connect-timeout escape RSC", async () => {
  const element = await withAnalyticsPageFailSoft({
    surface: "profit-wb",
    pool: {
      total: 1,
      idle: 0,
      waiting: 1,
      max: 1,
      connectionTimeoutMillis: 10_000,
    },
    render: async () => {
      throw connectTimeoutError();
    },
  });
  const typeName =
    typeof element.type === "function"
      ? element.type.name
      : String(element.type);
  const props = element.props as { surface?: string; safeCode?: string };
  assert.equal(typeName, "AnalyticsTemporarilyUnavailable");
  assert.equal(props.surface, "profit-wb");
  assert.equal(props.safeCode, "DB_CONNECT_ACQUISITION_TIMEOUT");
});

test("page fail-soft rethrows non-transient errors", async () => {
  const error = new TypeError("boom");
  await assert.rejects(
    () =>
      withAnalyticsPageFailSoft({
        surface: "dashboard",
        render: async () => {
          throw error;
        },
      }),
    (err: unknown) => err === error,
  );
});

test("pool log redacts URL/password/token material", () => {
  const payload = buildAnalyticsDbUnavailableLog({
    surface: "profit-wb",
    retryAttempt: 1,
    classification: {
      kind: "transient_database",
      transient: true,
      retryable: false,
      consumedFullConnectBudget: true,
      safeCode: "DB_CONNECT_ACQUISITION_TIMEOUT",
      safeMessageClass: "pg_pool_connect_timeout",
    },
    pool: {
      total: 1,
      idle: 0,
      waiting: 3,
      max: 1,
      connectionTimeoutMillis: 10_000,
    },
    now: () => new Date("2026-08-27T07:52:27.000Z"),
  });
  const serialized = JSON.stringify(payload);
  assert.equal(payload.event, "analytics_db_unavailable");
  assert.equal(payload.dataMode, "UNAVAILABLE");
  assert.match(serialized, /"total":1/);
  assert.doesNotMatch(serialized, /DATABASE_URL/i);
  assert.doesNotMatch(serialized, /password/i);
  assert.doesNotMatch(serialized, /token/i);
  assert.doesNotMatch(serialized, /postgresql:\/\//i);
});

test("pool configuration is unchanged from certified production values", () => {
  assert.equal(PRISMA_POOL_MAX, 1);
  assert.equal(PRISMA_POOL_IDLE_TIMEOUT_MS, 10_000);
  assert.equal(PRISMA_POOL_CONNECTION_TIMEOUT_MS, 10_000);
  const prismaSrc = fs.readFileSync(path.join(root, "lib/prisma.ts"), "utf8");
  assert.match(prismaSrc, /max: PRISMA_POOL_MAX/);
  assert.match(prismaSrc, /idleTimeoutMillis: PRISMA_POOL_IDLE_TIMEOUT_MS/);
  assert.match(prismaSrc, /connectionTimeoutMillis: PRISMA_POOL_CONNECTION_TIMEOUT_MS/);
  assert.doesNotMatch(prismaSrc, /max:\s*[2-9]/);
});

test("protected analytics pages wrap the fail-soft boundary", () => {
  const dashboard = fs.readFileSync(path.join(root, "app/page.tsx"), "utf8");
  const wb = fs.readFileSync(path.join(root, "app/profit-wb/page.tsx"), "utf8");
  const ozon = fs.readFileSync(path.join(root, "app/profit-ozon/page.tsx"), "utf8");
  const unavailable = fs.readFileSync(
    path.join(root, "components/analytics/AnalyticsTemporarilyUnavailable.tsx"),
    "utf8",
  );
  const errorBoundary = fs.readFileSync(path.join(root, "app/error.tsx"), "utf8");
  const sentinel = fs.readFileSync(
    path.join(root, "scripts/runtime/readOnlyAnalyticsSentinel.ts"),
    "utf8",
  );

  assert.match(dashboard, /withAnalyticsPageFailSoft/);
  assert.match(dashboard, /surface: "dashboard"/);
  assert.match(dashboard, /loadDashboardV6PeriodReadModel/);
  assert.doesNotMatch(dashboard, /getDashboardDailyAnalytics\(/);
  assert.match(wb, /withAnalyticsPageFailSoft/);
  assert.match(wb, /surface: "profit-wb"/);
  assert.match(wb, /getProfitAnalytics/);
  assert.match(ozon, /withAnalyticsPageFailSoft/);
  assert.match(ozon, /surface: "profit-ozon"/);
  assert.match(ozon, /getProfitAnalyticsOzon/);
  assert.match(unavailable, /временно недоступ/);
  assert.doesNotMatch(unavailable, /выручка:\s*0/);
  assert.doesNotMatch(unavailable, /\?retry=1/);
  assert.match(unavailable, /"use client"/);
  assert.match(unavailable, /window\.location\.reload\(\)/);
  assert.match(unavailable, /onClick=\{reloadCurrentDocument\}/);
  assert.match(unavailable, /href="\/"/);
  assert.match(errorBoundary, /Не удалось загрузить раздел/);
  assert.doesNotMatch(errorBoundary, /\{error\.digest\}/);
  assert.doesNotMatch(errorBoundary, /\{error\.stack\}/);
  assert.match(sentinel, /getProfitAnalytics/);
  assert.match(sentinel, /getDashboardDailyAnalytics/);
  assert.match(sentinel, /getProfitAnalyticsOzon/);
  assert.doesNotMatch(sentinel, /cron/);
  assert.doesNotMatch(sentinel, /telegram/i);
});

test("sentinel source is not scheduled", () => {
  const crontabHints = [
    path.join(root, "package.json"),
    path.join(root, "Dockerfile"),
  ];
  for (const file of crontabHints) {
    const src = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(src, /readOnlyAnalyticsSentinel/);
  }
});

test("retry reloads the exact current document and does not replace the query", () => {
  const unavailable = fs.readFileSync(
    path.join(root, "components/analytics/AnalyticsTemporarilyUnavailable.tsx"),
    "utf8",
  );
  assert.doesNotMatch(unavailable, /\?retry=1/);
  assert.doesNotMatch(unavailable, /href="\?"/);
  assert.match(unavailable, /window\.location\.reload\(\)/);

  let reloaded = 0;
  const previous = (globalThis as { window?: Window }).window;
  (globalThis as { window: { location: { reload: () => void } } }).window = {
    location: {
      reload: () => {
        reloaded += 1;
      },
    },
  };
  try {
    reloadCurrentDocument();
    assert.equal(reloaded, 1);
  } finally {
    if (previous === undefined) {
      delete (globalThis as { window?: Window }).window;
    } else {
      (globalThis as { window: Window }).window = previous;
    }
  }
});
