import assert from "node:assert/strict";
import test from "node:test";

import { WaveDEConsumerUnavailableError } from "../../lib/consumers/waveDE/types";

// Pure contract mirror of loadProfitReadModelPack gates (no DB).
function classifyProfitRmRow(row: {
  dataMode: string;
  coverageStatus: string;
  formulaVersion: string;
  expectedFormula: string;
} | null) {
  if (!row) {
    throw new WaveDEConsumerUnavailableError(
      "READ_MODEL_MISS",
      "Profit read model row missing",
      {},
    );
  }
  if (row.formulaVersion !== row.expectedFormula) {
    throw new WaveDEConsumerUnavailableError(
      "FORMULA_VERSION_MISMATCH",
      "Profit formulaVersion mismatch",
      {},
    );
  }
  if (row.dataMode !== "FINAL" && row.dataMode !== "PRELIMINARY") {
    throw new WaveDEConsumerUnavailableError(
      "READ_MODEL_MISS",
      "Profit read model dataMode is not usable",
      { dataMode: row.dataMode },
    );
  }
  if (row.dataMode === "FINAL" && row.coverageStatus !== "COMPLETE") {
    throw new WaveDEConsumerUnavailableError(
      "READ_MODEL_MISS",
      "Profit read model FINAL row is not COMPLETE",
      { dataMode: row.dataMode, coverageStatus: row.coverageStatus },
    );
  }
  return {
    meta: {
      dataMode: row.dataMode === "FINAL" ? "FINAL" : "PRELIMINARY",
      coverageStatus: row.coverageStatus,
    },
  };
}

const WB_F = "FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1";
const OZ_F = "FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1";

test("PRELIMINARY WB row with numeric totals returns PRELIMINARY", () => {
  const hit = classifyProfitRmRow({
    dataMode: "PRELIMINARY",
    coverageStatus: "COMPLETE",
    formulaVersion: WB_F,
    expectedFormula: WB_F,
  });
  assert.equal(hit.meta.dataMode, "PRELIMINARY");
});

test("PRELIMINARY Ozon row with numeric totals returns PRELIMINARY", () => {
  const hit = classifyProfitRmRow({
    dataMode: "PRELIMINARY",
    coverageStatus: "COMPLETE",
    formulaVersion: OZ_F,
    expectedFormula: OZ_F,
  });
  assert.equal(hit.meta.dataMode, "PRELIMINARY");
});

test("missing row READ_MODEL_MISS", () => {
  assert.throws(
    () => classifyProfitRmRow(null),
    (e: unknown) =>
      e instanceof WaveDEConsumerUnavailableError &&
      e.reason === "READ_MODEL_MISS",
  );
});

test("invalid dataMode READ_MODEL_MISS", () => {
  assert.throws(
    () =>
      classifyProfitRmRow({
        dataMode: "UNKNOWN",
        coverageStatus: "COMPLETE",
        formulaVersion: WB_F,
        expectedFormula: WB_F,
      }),
    (e: unknown) =>
      e instanceof WaveDEConsumerUnavailableError &&
      e.reason === "READ_MODEL_MISS",
  );
});

test("FINAL incomplete fail closed", () => {
  assert.throws(
    () =>
      classifyProfitRmRow({
        dataMode: "FINAL",
        coverageStatus: "PARTIAL",
        formulaVersion: WB_F,
        expectedFormula: WB_F,
      }),
    (e: unknown) =>
      e instanceof WaveDEConsumerUnavailableError &&
      e.reason === "READ_MODEL_MISS",
  );
});

test("FINAL COMPLETE returns FINAL", () => {
  const hit = classifyProfitRmRow({
    dataMode: "FINAL",
    coverageStatus: "COMPLETE",
    formulaVersion: OZ_F,
    expectedFormula: OZ_F,
  });
  assert.equal(hit.meta.dataMode, "FINAL");
});
