/**
 * Negative READY-gate check against the real assessSkuSourceCompleteness.
 */
import assert from "node:assert/strict";

import { assessSkuSourceCompleteness } from "../../lib/insights/skuSourceCompleteness";

const companies = ["ИП Петров", "ИП Лебедева"];

{
  const r = assessSkuSourceCompleteness({
    selectedCompany: "ALL",
    expectedCompanies: companies,
    rows: [
      { companyScope: "ALL", marketplace: "WB" },
      { companyScope: "ALL", marketplace: "OZON" },
    ],
  });
  assert.equal(r.complete, false);
  assert.deepEqual(r.gaps, [
    "ИП Петров:WB_SKU_MISSING",
    "ИП Петров:OZON_SKU_MISSING",
    "ИП Лебедева:WB_SKU_MISSING",
    "ИП Лебедева:OZON_SKU_MISSING",
  ]);
}

{
  const r = assessSkuSourceCompleteness({
    selectedCompany: "ALL",
    expectedCompanies: companies,
    rows: [
      { companyScope: "ИП Петров", marketplace: "WB" },
      { companyScope: "ИП Петров", marketplace: "OZON" },
      { companyScope: "ИП Лебедева", marketplace: "OZON" },
    ],
  });
  assert.equal(r.complete, false);
  assert.deepEqual(r.gaps, ["ИП Лебедева:WB_SKU_MISSING"]);
}

{
  const r = assessSkuSourceCompleteness({
    selectedCompany: "ALL",
    expectedCompanies: companies,
    rows: [
      { companyScope: "ИП Петров", marketplace: "WB" },
      { companyScope: "ИП Петров", marketplace: "OZON" },
      { companyScope: "ИП Лебедева", marketplace: "WB" },
      { companyScope: "ИП Лебедева", marketplace: "OZON" },
    ],
  });
  assert.equal(r.complete, true);
  assert.deepEqual(r.gaps, []);
}

console.log(
  JSON.stringify({
    ok: true,
    cases: 3,
    note: "ALL-scope alone never READY; missing any of 4 scopes blocks READY",
  }),
);
