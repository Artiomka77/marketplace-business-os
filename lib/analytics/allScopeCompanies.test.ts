import assert from "node:assert/strict";
import test from "node:test";

import { selectAllScopeCompanyNames } from "./allScopeCompanies";

test("ALL scope keeps preliminary cabinet with sales but no finance", () => {
  const names = selectAllScopeCompanyNames({
    candidateNames: [
      "ИП Петров",
      "ИП Лебедева",
      "Контрольный активный кабинет",
      "ООО Тест",
    ],
    financeTouch: [
      { companyName: "ИП Петров" },
      { companyName: "ИП Лебедева" },
    ],
    saleTouch: [
      { companyName: "ИП Петров" },
      { companyName: "Контрольный активный кабинет" },
    ],
  });

  assert.deepEqual(names, [
    "ИП Лебедева",
    "ИП Петров",
    "Контрольный активный кабинет",
  ]);
  assert.ok(!names.includes("ООО Тест"));
});

test("ALL scope excludes empty cabinet even when listed in Company", () => {
  const names = selectAllScopeCompanyNames({
    candidateNames: ["ИП Петров", "ООО Тест", "Спящий кабинет"],
    financeTouch: [{ companyName: "ИП Петров" }],
    saleTouch: [{ companyName: "ИП Петров" }],
  });
  assert.deepEqual(names, ["ИП Петров"]);
});

test("ALL scope does not invent names absent from candidates", () => {
  const names = selectAllScopeCompanyNames({
    candidateNames: ["ИП Петров"],
    financeTouch: [{ companyName: "Чужой кабинет" }],
    saleTouch: [],
  });
  assert.deepEqual(names, []);
});
