import assert from "node:assert/strict";
import { calculateMarketplaceTax } from "./marketplaceTax.ts";

// Ordinary inclusive 105 → USN on 100, VAT 5
const t = calculateMarketplaceTax({
  ordinarySalesVatInclusive: 105,
  usnRate: 1,
  vatRate: 5,
});
assert.ok(Math.abs(t.ordinarySalesExVat - 100) < 1e-9);
assert.ok(Math.abs(t.vatAmount - 5) < 1e-9);
assert.ok(Math.abs(t.usnAmount - 1) < 1e-9);
assert.ok(Math.abs(t.totalTax - 6) < 1e-9);

// Inclusive-USN bug would be 105*0.01+5 = 6.05
assert.ok(Math.abs(105 * 0.01 + 5 - 6.05) < 1e-9);
assert.notEqual(t.totalTax, 6.05);

console.log("marketplaceTax.ozonParity.test.ts OK");
