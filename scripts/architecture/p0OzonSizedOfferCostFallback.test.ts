import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCanonicalPositiveCostLookups,
  extractSizedOfferBaseNmId,
  resolveCanonicalUnitCost,
} from "../../lib/analytics/productCostResolver";

describe("P0 COGS final — sized offer base nmId cost fallback", () => {
  it("extracts digit base nmId from sized offer codes only", () => {
    assert.equal(extractSizedOfferBaseNmId("1492430240-158"), "1492430240");
    assert.equal(extractSizedOfferBaseNmId("1542554225-140"), "1542554225");
    assert.equal(extractSizedOfferBaseNmId("ади-флис-вчерный"), null);
    assert.equal(extractSizedOfferBaseNmId("1492430240"), null);
  });

  it("resolves missing size-variant ProductCost via base nmId 1450", () => {
    const { costByVendorCode, costByNmId } = buildCanonicalPositiveCostLookups([
      {
        id: "pc1",
        vendorCode: "ади-флис-вчерный",
        nmId: "1492430240",
        costPrice: 1450,
        costDate: new Date("2026-09-14"),
        createdAt: new Date("2026-09-14"),
      },
    ]);
    assert.equal(
      resolveCanonicalUnitCost({
        costByVendorCode,
        costByNmId,
        vendorCodeKey: "1492430240-158",
      }),
      1450
    );
    assert.equal(
      resolveCanonicalUnitCost({
        costByVendorCode,
        costByNmId,
        vendorCodeKey: "1492430240-128",
      }),
      1450
    );
  });

  it("resolves vest sized offer via base nmId 800", () => {
    const { costByVendorCode, costByNmId } = buildCanonicalPositiveCostLookups([
      {
        id: "pc-vest",
        vendorCode: "жилет-черный",
        nmId: "1585902090",
        costPrice: 800,
        costDate: new Date("2026-09-28"),
        createdAt: new Date("2026-09-28"),
      },
    ]);
    assert.equal(
      resolveCanonicalUnitCost({
        costByVendorCode,
        costByNmId,
        vendorCodeKey: "1585902090-158",
      }),
      800
    );
  });

  it("does not invent gray cost when base nmId has no ProductCost", () => {
    const { costByVendorCode, costByNmId } = buildCanonicalPositiveCostLookups([
      {
        id: "pc-black",
        vendorCode: "ади-флис-вчерный",
        nmId: "1492430240",
        costPrice: 1450,
        costDate: new Date("2026-09-14"),
        createdAt: new Date("2026-09-14"),
      },
    ]);
    assert.equal(
      resolveCanonicalUnitCost({
        costByVendorCode,
        costByNmId,
        vendorCodeKey: "1542554225-140",
        wbSupplierArticleByNmId: new Map([
          ["1542554225", "ади-флис-всерый"],
        ]),
      }),
      null
    );
  });
});
