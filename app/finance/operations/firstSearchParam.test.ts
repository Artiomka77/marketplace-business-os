import assert from "node:assert/strict";
import test from "node:test";

import { firstSearchParam } from "./searchParams";

test("firstSearchParam keeps a plain string", () => {
  assert.equal(firstSearchParam("INCOME", "ALL"), "INCOME");
});

test("firstSearchParam collapses duplicate query keys to the first non-empty value", () => {
  assert.equal(firstSearchParam(["ALL", "ALL"], "ALL"), "ALL");
  assert.equal(firstSearchParam(["Озон карта", "ALL"], "ALL"), "Озон карта");
});

test("firstSearchParam falls back for empty array or missing values", () => {
  assert.equal(firstSearchParam(undefined, "ALL"), "ALL");
  assert.equal(firstSearchParam([], "ALL"), "ALL");
  assert.equal(firstSearchParam(["", ""], "ALL"), "ALL");
});

test("duplicate bankAccount ALL must not remain an array for Prisma filters", () => {
  const selectedBankAccount = firstSearchParam(["ALL", "ALL"], "ALL");
  const where =
    selectedBankAccount !== "ALL" ? { bankAccount: selectedBankAccount } : {};
  assert.deepEqual(where, {});
  assert.equal(typeof selectedBankAccount, "string");
});
