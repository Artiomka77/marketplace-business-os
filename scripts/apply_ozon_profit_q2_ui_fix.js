const fs = require("fs");
const path = require("path");

const projectRoot = process.cwd();

function readFile(relativePath) {
  const fullPath = path.join(projectRoot, relativePath);
  return {
    fullPath,
    text: fs.readFileSync(fullPath, "utf8"),
  };
}

function writeFile(fullPath, text) {
  fs.writeFileSync(fullPath, text, "utf8");
}

function assertChanged(name, before, after) {
  if (before === after) {
    throw new Error(`Patch did not change ${name}. The file structure is different from expected.`);
  }
}

function patchProfitAnalytics() {
  const relativePath = "lib/analytics/profitAnalyticsOzon.ts";
  const file = readFile(relativePath);
  let text = file.text;

  if (text.includes("financeClickAdsFromFacts")) {
    console.log(`${relativePath}: already patched`);
    return;
  }

  const before = text;

  const target = /totals\.adsCost\s*=\s*advertising;\s*totals\.otherAdsCost\s*=\s*advertising\s*-\s*totals\.clickAdsCost\s*-\s*totals\.orderAdsCost;/m;

  const replacement = `totals.adsCost = advertising;

  const financeClickAdsFromFacts = facts.reduce((sum, fact) => {
    const operationType = normalizeText(fact.sourceOperationType);
    const operationCode = normalizeText(fact.sourceOperationCode);

    if (
      fact.category === "OZON_ADVERTISING" &&
      (operationCode.includes("operationmarketplacecostperclick") ||
        operationType.includes("оплата за клик"))
    ) {
      return sum + toNumber(fact.amount);
    }

    return sum;
  }, 0);

  const financeOrderAdsFromFacts = facts.reduce((sum, fact) => {
    const operationType = normalizeText(fact.sourceOperationType);
    const operationCode = normalizeText(fact.sourceOperationCode);

    if (
      fact.category === "OZON_ADVERTISING" &&
      (operationCode.includes("operationpromotionwithcostperorder") ||
        operationType.includes("продвижение с оплатой за заказ"))
    ) {
      return sum + toNumber(fact.amount);
    }

    return sum;
  }, 0);

  const financeOtherAdsFromFacts = Math.max(
    0,
    advertising - financeClickAdsFromFacts - financeOrderAdsFromFacts
  );

  const hasFinanceAdDetails =
    advertising > 0 &&
    financeClickAdsFromFacts + financeOrderAdsFromFacts + financeOtherAdsFromFacts > 0;

  if (hasFinanceAdDetails) {
    totals.clickAdsCost = financeClickAdsFromFacts;
    totals.orderAdsCost = financeOrderAdsFromFacts;
    totals.otherAdsCost = financeOtherAdsFromFacts;
  } else {
    totals.otherAdsCost = Math.max(
      0,
      advertising - totals.clickAdsCost - totals.orderAdsCost
    );
  }`;

  text = text.replace(target, replacement);
  assertChanged(relativePath, before, text);
  writeFile(file.fullPath, text);
  console.log(`${relativePath}: patched`);
}

function patchProfitOzonPage() {
  const relativePath = "app/profit-ozon/page.tsx";
  const file = readFile(relativePath);
  let text = file.text;
  const before = text;

  text = text.replace(
    /\{Math\.abs\(otherAdsCost\)\s*>\s*0\.5\s*\?\s*\(/g,
    "{otherAdsCost > 0.5 ? ("
  );

  text = text.replaceAll("<span>Прочее</span>", "<span>Интернет/прочее</span>");
  text = text.replaceAll("<span>РџСЂРѕС‡РµРµ</span>", "<span>Интернет/прочее</span>");

  const excludedBlockUtf8 = `                <div className="grid grid-cols-[minmax(0,1fr)_105px_62px] items-center gap-3">
                  <div className="font-black text-emerald-600">
                    Исключено из прибыли: займы / факторинг
                  </div>
                  <div className="text-right font-black text-emerald-600">
                    {formatMoney(excludedLoansFactoringAmount)}
                  </div>
                  <div className="text-right font-black text-emerald-600">
                    {formatPercent(shareBase > 0 ? (excludedLoansFactoringAmount / shareBase) * 100 : 0)}
                  </div>
                </div>`;

  const excludedBlockMojibake = `                <div className="grid grid-cols-[minmax(0,1fr)_105px_62px] items-center gap-3">
                  <div className="font-black text-emerald-600">
                    РСЃРєР»СЋС‡РµРЅРѕ РёР· РїСЂРёР±С‹Р»Рё: Р·Р°Р№РјС‹ / С„Р°РєС‚РѕСЂРёРЅРі
                  </div>
                  <div className="text-right font-black text-emerald-600">
                    {formatMoney(excludedLoansFactoringAmount)}
                  </div>
                  <div className="text-right font-black text-emerald-600">
                    {formatPercent(shareBase > 0 ? (excludedLoansFactoringAmount / shareBase) * 100 : 0)}
                  </div>
                </div>`;

  const wrappedBlockUtf8 = `                {Math.abs(excludedLoansFactoringAmount) > 0.5 ? (
${excludedBlockUtf8}
                ) : null}`;

  const wrappedBlockMojibake = `                {Math.abs(excludedLoansFactoringAmount) > 0.5 ? (
${excludedBlockMojibake}
                ) : null}`;

  if (text.includes(excludedBlockUtf8) && !text.includes("Math.abs(excludedLoansFactoringAmount) > 0.5")) {
    text = text.replace(excludedBlockUtf8, wrappedBlockUtf8);
  } else if (text.includes(excludedBlockMojibake) && !text.includes("Math.abs(excludedLoansFactoringAmount) > 0.5")) {
    text = text.replace(excludedBlockMojibake, wrappedBlockMojibake);
  } else if (!text.includes("Math.abs(excludedLoansFactoringAmount) > 0.5")) {
    throw new Error(`${relativePath}: could not find excluded loans/factoring block`);
  }

  assertChanged(relativePath, before, text);
  writeFile(file.fullPath, text);
  console.log(`${relativePath}: patched`);
}

try {
  patchProfitAnalytics();
  patchProfitOzonPage();
  console.log("DONE: Ozon profit Q2 UI/data fix was applied.");
} catch (error) {
  console.error("PATCH_FAILED:", error);
  process.exit(1);
}
