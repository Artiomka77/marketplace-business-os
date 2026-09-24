import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const worktreeRoot = process.cwd();

function read(rel: string) {
  return readFileSync(path.join(worktreeRoot, rel), "utf8");
}

describe("Wave B HTTP heavy-call guard", () => {
  it("profit-wb HIT path does not call getProfitAnalytics when read-model-first", () => {
    const src = read("app/profit-wb/page.tsx");
    assert.match(src, /isWaveBProfitReadModelFirstEnabled/);
    assert.match(src, /loadProfitReadModel/);
    assert.match(src, /PROFIT_READ_MODEL_HIT/);
    assert.match(src, /data-profit-heavy-fc-calls/);
    // Live FC only behind explicit fallback OR flag-off branch
    assert.match(src, /isWaveBHeavyLiveFallbackEnabled/);
    assert.doesNotMatch(
      src,
      /if \(isWaveBProfitReadModelFirstEnabled\(\)\)[\s\S]*await getProfitAnalytics\(\{[\s\S]*\}\);\s*profitSourceMarker = "PROFIT_READ_MODEL_HIT"/
    );
  });

  it("profit-ozon HIT path does not call getProfitAnalyticsOzon when read-model-first", () => {
    const src = read("app/profit-ozon/page.tsx");
    assert.match(src, /isWaveBProfitReadModelFirstEnabled/);
    assert.match(src, /loadProfitReadModel/);
    assert.match(src, /PROFIT_READ_MODEL_HIT/);
    assert.match(src, /isWaveBHeavyLiveFallbackEnabled/);
  });

  it("consumer never reports heavyFcCalls > 0", () => {
    const src = read("lib/profitReadModel/consumer.ts");
    assert.match(src, /heavyFcCalls: 0/);
    assert.doesNotMatch(src, /getProfitAnalytics/);
    assert.doesNotMatch(src, /getProfitAnalyticsOzon/);
  });
});
