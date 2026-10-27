import assert from "node:assert/strict";
import {
  classifyCanonicalWbProductOperation,
  mergePreliminaryWbSaleRowsByEconomicKey,
  wbPreliminaryEconomicKey,
} from "./wbProductOperationClassify.ts";

assert.equal(
  classifyCanonicalWbProductOperation({
    paymentReason: "Возмещение за выдачу и возврат товаров на ПВЗ",
    documentType: "Продажа",
  }),
  "OTHER",
);

assert.equal(
  classifyCanonicalWbProductOperation({
    paymentReason: "Возврат",
    documentType: "Возврат",
  }),
  "RETURN",
);

assert.equal(
  classifyCanonicalWbProductOperation({
    paymentReason: "Продажа",
    documentType: "Продажа",
  }),
  "SALE",
);

assert.equal(
  classifyCanonicalWbProductOperation({
    paymentReason: "Сторно возвратов",
    documentType: "Продажа",
  }),
  "SALE",
);

const daily = {
  id: "WB_SALES_DAILY-db-row",
  companyName: "ИП Петров",
  saleDate: new Date("2026-10-24T10:00:00.000Z"),
  productName: "X",
  size: "42",
  barcode: "b1",
  nmId: "111",
  vendorCode: "v1",
  paymentReason: "Продажа",
  documentType: "Продажа",
  quantity: 1,
  retailPrice: 100,
  retailPriceWithDiscount: 90,
  wbRealizedAmount: 80,
  sellerPayout: 70,
};

const operationalSame = { ...daily, id: "WB_SALES_OPERATIONAL-db-row" };
const operationalDistinct = { ...daily, id: "ops-other", barcode: "b2", quantity: 2 };

const merged = mergePreliminaryWbSaleRowsByEconomicKey({
  dailyRows: [daily],
  operationalRows: [operationalSame, operationalDistinct],
  keyOf: wbPreliminaryEconomicKey,
});

assert.equal(merged.length, 2, "same economic sale must not double");
assert.ok(merged.some((r) => r.id.includes("DAILY")));
assert.ok(merged.some((r) => r.id === "ops-other"));

// Two distinct DAILY sales with identical money/SKU fingerprint must both remain
const dailyTwin = { ...daily, id: "real-sale-1" };
const dailyTwin2 = { ...daily, id: "real-sale-2" };
const dailyKeep = mergePreliminaryWbSaleRowsByEconomicKey({
  dailyRows: [dailyTwin, dailyTwin2],
  operationalRows: [],
  keyOf: wbPreliminaryEconomicKey,
});
assert.equal(dailyKeep.length, 2);
assert.deepEqual(
  dailyKeep.map((r) => r.id).sort(),
  ["real-sale-1", "real-sale-2"],
);

// Two distinct OPERATIONAL sales with identical fingerprint must both remain
const opsKeep = mergePreliminaryWbSaleRowsByEconomicKey({
  dailyRows: [],
  operationalRows: [
    { ...daily, id: "sale-1" },
    { ...daily, id: "sale-2" },
  ],
  keyOf: wbPreliminaryEconomicKey,
});
assert.equal(opsKeep.length, 2);
assert.deepEqual(
  opsKeep.map((r) => r.id).sort(),
  ["sale-1", "sale-2"],
);

console.log("sourceOwnership.classifier.test.ts OK");
