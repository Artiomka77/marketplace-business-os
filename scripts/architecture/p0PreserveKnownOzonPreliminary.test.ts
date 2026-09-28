import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
// Windows pathname from file URL may start with /C:/
const rootFixed = process.platform === "win32" && root.startsWith("\\")
  ? root.replace(/^\\/, "")
  : root.startsWith("/") && /^\/[A-Za-z]:/.test(root)
    ? root.slice(1)
    : root;

function read(rel: string) {
  const candidates = [
    path.join(rootFixed, rel),
    path.resolve("scripts/architecture/../../", rel),
    path.resolve(process.cwd(), rel),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf8");
  }
  throw new Error("missing " + rel + " tried=" + candidates.join(" | "));
}

test("P0: dailyReport keeps known Ozon analytics when PRELIMINARY/incomplete", () => {
  const src = read("lib/telegram/dailyReport.ts");
  assert.match(src, /ozonFinancialUnavailable && !profitAnalyticsHasOzonData/);
  // Must not unconditionally wipe on ozonFinancialUnavailable alone.
  assert.equal(
    /if \(ozonFinancialUnavailable\) \{/.test(src),
    false,
    "unconditional ozonFinancialUnavailable wipe must be removed"
  );
});

test("P0: v6 snapshot dailyReport mirrors the same gate", () => {
  const src = read("financial-core/v6/snapshot/lib/telegram/dailyReport.ts");
  assert.match(src, /ozonFinancialUnavailable && !profitAnalyticsHasOzonData/);
});

test("P0: managementRevenue still hides CASE3 unavailable (no trusted zero)", () => {
  const src = read("lib/dashboard/managementRevenue.ts");
  assert.match(src, /if \(metrics\.financialUnavailable\) return null;/);
});
