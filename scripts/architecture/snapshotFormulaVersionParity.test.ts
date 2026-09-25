import assert from "node:assert/strict";
import test from "node:test";

import {
  FINANCIAL_CORE_V6_PERIOD_READMODEL_V1,
  FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
  LEGACY_V4_PERIOD_SNAPSHOT_FORMULA,
  isV6PeriodReadModelFormula,
  rejectsLegacyV4AsV6Final,
} from "../../lib/dashboard/v6PeriodReadModel/contract";

test("snapshotFormulaVersionParity: consumer accepts only V2 readmodel formula", () => {
  assert.equal(isV6PeriodReadModelFormula(FINANCIAL_CORE_V6_PERIOD_READMODEL_V2), true);
  assert.equal(isV6PeriodReadModelFormula(FINANCIAL_CORE_V6_PERIOD_READMODEL_V1), false);
  assert.equal(isV6PeriodReadModelFormula(LEGACY_V4_PERIOD_SNAPSHOT_FORMULA), false);
  assert.equal(rejectsLegacyV4AsV6Final(LEGACY_V4_PERIOD_SNAPSHOT_FORMULA), true);
  assert.equal(
    FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
    "FINANCIAL_CORE_V6_PERIOD_READMODEL_V2"
  );
});
