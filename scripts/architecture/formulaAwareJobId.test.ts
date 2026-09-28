import assert from "node:assert/strict";
import test from "node:test";

import {
  FINANCIAL_CORE_V6_PERIOD_READMODEL_V1,
  FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
  buildDashboardPeriodSnapshotJobId,
  buildLegacyDashboardPeriodSnapshotJobId,
} from "../../lib/dashboard/v6PeriodReadModel";

const PETROV = "ИП Петров";
const LEBEDEVA = "ИП Лебедева";
const TARGET = { dateFrom: "2026-09-01", dateTo: "2026-09-03" };
const CLOSED = { dateFrom: "2026-08-17", dateTo: "2026-08-23" };
const PRODUCTION_LEGACY_TARGET_ALL_ID = "v6rm_QUxMfDIwMjYtMDktMDF8MjAyNi0wOS0wMw";

test("JOB_ID includes formulaVersion, companyScope, and date range", () => {
  const id = buildDashboardPeriodSnapshotJobId({
    formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
    companyScope: "ALL",
    ...TARGET,
  });
  assert.match(id, /^v6rmj_[0-9a-f]{64}$/);
  assert.notEqual(
    id,
    buildDashboardPeriodSnapshotJobId({
      formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V1,
      companyScope: "ALL",
      ...TARGET,
    })
  );
});

test("JOB_ID_DETERMINISTIC: same tuple yields the same id", () => {
  const a = buildDashboardPeriodSnapshotJobId({
    formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
    companyScope: PETROV,
    ...CLOSED,
  });
  const b = buildDashboardPeriodSnapshotJobId({
    formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
    companyScope: PETROV,
    dateFrom: "2026-08-17T00:00:00.000Z",
    dateTo: "2026-08-23T12:00:00.000Z",
  });
  assert.equal(a, b);
});

test("V1 and V2 same range coexist: ids differ and neither equals truncated hash", () => {
  const v1 = buildDashboardPeriodSnapshotJobId({
    formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V1,
    companyScope: "ALL",
    ...TARGET,
  });
  const v2 = buildDashboardPeriodSnapshotJobId({
    formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
    companyScope: "ALL",
    ...TARGET,
  });
  assert.notEqual(v1, v2);
  assert.notEqual(v2, PRODUCTION_LEGACY_TARGET_ALL_ID);
  assert.equal(v1.length, v2.length);
});

test("legacy V1-style id matches the production collision id", () => {
  assert.equal(
    buildLegacyDashboardPeriodSnapshotJobId({ companyScope: "ALL", ...TARGET }),
    PRODUCTION_LEGACY_TARGET_ALL_ID
  );
});

test("COMPANY_SCOPE_JOB_ISOLATION: ALL / Petrov / Lebedeva differ", () => {
  const ids = ["ALL", PETROV, LEBEDEVA].map((companyScope) =>
    buildDashboardPeriodSnapshotJobId({
      formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
      companyScope,
      ...TARGET,
    })
  );
  assert.equal(new Set(ids).size, 3);
});

test("DATE_RANGE_JOB_ISOLATION: target vs closed differ", () => {
  const a = buildDashboardPeriodSnapshotJobId({
    formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
    companyScope: "ALL",
    ...TARGET,
  });
  const b = buildDashboardPeriodSnapshotJobId({
    formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
    companyScope: "ALL",
    ...CLOSED,
  });
  assert.notEqual(a, b);
});

test("Cyrillic company names are UTF-8 stable, not locale-dependent", () => {
  const id = buildDashboardPeriodSnapshotJobId({
    formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
    companyScope: PETROV,
    ...CLOSED,
  });
  assert.match(id, /^v6rmj_[0-9a-f]{64}$/);
  assert.equal(
    id,
    buildDashboardPeriodSnapshotJobId({
      formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
      companyScope: PETROV,
      ...CLOSED,
    })
  );
});

test("formulaVersion is required and not truncated away", () => {
  assert.throws(() =>
    buildDashboardPeriodSnapshotJobId({
      formulaVersion: "   ",
      companyScope: "ALL",
      ...TARGET,
    })
  );
  const v2 = buildDashboardPeriodSnapshotJobId({
    formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
    companyScope: "ALL",
    ...TARGET,
  });
  const other = buildDashboardPeriodSnapshotJobId({
    formulaVersion: `${FINANCIAL_CORE_V6_PERIOD_READMODEL_V2}_X`,
    companyScope: "ALL",
    ...TARGET,
  });
  assert.notEqual(v2, other);
});
