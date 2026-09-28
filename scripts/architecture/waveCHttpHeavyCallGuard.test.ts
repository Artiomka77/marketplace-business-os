import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const root = process.cwd();

function read(rel: string) {
  return readFileSync(path.join(root, rel), "utf8");
}

describe("Wave C HTTP heavy-call guard", () => {
  it("Insights page HIT path never calls getProfitAnalytics*", () => {
    const src = read("app/insights/page.tsx");
    assert.match(src, /loadWaveCCompanyProfitPair/);
    assert.match(src, /data-wave-c-heavy-fc-calls="0"/);
    assert.doesNotMatch(src, /getProfitAnalytics\(/);
    assert.doesNotMatch(src, /getProfitAnalyticsOzon\(/);
    assert.doesNotMatch(src, /loadOzonAccrualDayStatuses/);
    assert.doesNotMatch(src, /Promise\.all/);
  });

  it("ABC page HIT path never calls getProfitAnalytics*", () => {
    const src = read("app/abc/page.tsx");
    assert.match(src, /loadWaveCAbcCompany/);
    assert.match(src, /abcDataMode/);
    assert.match(src, /data-abc-data-mode=\{abcDataMode\}/);
    assert.match(src, /data-wave-c-heavy-fc-calls="0"/);
    assert.doesNotMatch(src, /loadWaveCCompanyProfitPair/);
    assert.doesNotMatch(
      src,
      /wbUnavailable \|\| costIncomplete \? "PRELIMINARY" : "FINAL"/
    );
    assert.doesNotMatch(src, /getProfitAnalytics\(/);
    assert.doesNotMatch(src, /getProfitAnalyticsOzon\(/);
    assert.doesNotMatch(src, /Promise\.all/);
  });

  it("Wave C adapter never calls heavy FC and always reports 0", () => {
    const src = read("lib/waveC/insightsAbcAdapter.ts");
    assert.match(src, /loadProfitReadModel/);
    assert.match(src, /heavyFcCalls: 0/);
    assert.doesNotMatch(src, /getProfitAnalytics\(/);
    assert.doesNotMatch(src, /getProfitAnalyticsOzon\(/);
    assert.doesNotMatch(src, /WAVE_B_PROFIT_LIVE_FALLBACK/);
  });

  it("Wave B producer/worker files are untouched by Wave C consumer files", () => {
    const adapter = read("lib/waveC/insightsAbcAdapter.ts");
    assert.doesNotMatch(adapter, /runProfitReadModelWorker/);
    assert.doesNotMatch(adapter, /produceProfitReadModel/);
  });
});
