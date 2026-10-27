/**
 * Local month XLSX source control (Petrov Ozon accruals).
 * Week 19–25 must match month slice; 01–18 + 19–25 = 01–25.
 * Does NOT import to production.
 *
 * Ozon export stores Cyrillic headers in a legacy single-byte codepage that
 * sheet_to_json surfaces as a stable mojibake. Column positions are fixed;
 * group names are mapped from that stable mojibake (not re-encoded).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import XLSX from "xlsx";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WT = path.resolve(__dirname, "../..");
const OUT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(WT, "scripts/fin_patch/out_full_replay");

const COL = {
  day: 1,
  group: 2,
  sku: 5,
  qty: 7,
  amount: 15,
};

/** Stable mojibake → canonical Russian group (from this export family). */
const GROUP_MOJIBAKE = new Map([
  ["\x1F@>4068", "Продажи"],
  ["\x12>72@0BK", "Возвраты"],
  ["\x12>7=03@0645=85 Ozon", "Вознаграждение Ozon"],
  ["#A;C38 4>AB02:8", "Услуги доставки"],
  ["#A;C38 ?0@B=Q@>2", "Услуги партнёров"],
  ["\x14@C385 CA;C38 8 HB@0DK", "Другие услуги и штрафы"],
  ["#A;C38 FBO", "Услуги FBO"],
  ["\x1F@>42865=85 8 @5:;0<0", "Продвижение и реклама"],
  ["\x1A><?5=A0F88 8 45:><?5=A0F88", "Компенсации и декомпенсации"],
  ['\x1E7>= "5E=>;>388', "Озон Технологии"],
  ["\x1F@>G85 =0G8A;5=8O", "Прочие начисления"],
]);

function findXlsx(dir) {
  if (!fs.existsSync(dir)) return {};
  const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".xlsx"));
  const week = files.find((f) => f.includes("19.10") && f.includes("25.10"));
  const month = files.find((f) => f.includes("01.10") && f.includes("25.10"));
  return {
    week: week ? path.join(dir, week) : null,
    month: month ? path.join(dir, month) : null,
  };
}

const sources = findXlsx(
  path.join(WT, "scripts/fin_patch/FIN_JOIN_ASSIGNMENT/prior/sources"),
);
const ozonSources = findXlsx(
  path.join(WT, "scripts/fin_patch/FIN_OZON_ASSIGNMENT/sources"),
);
const weekPath = sources.week || ozonSources.week;
const monthPath = sources.month || ozonSources.month;

function money(v) {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = Number(String(v).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function dayKey(v) {
  if (v == null) return "";
  if (v instanceof Date && Number.isFinite(v.getTime())) {
    // Ozon accrual export stamps end-of-Moscow-day as ~20:59:43Z previous UTC date.
    // Advance to the next UTC calendar day when hour >= 20 so 18T20:59 → 19.
    const utc = new Date(v.getTime());
    if (utc.getUTCHours() >= 20) {
      utc.setUTCDate(utc.getUTCDate() + 1);
    }
    return utc.toISOString().slice(0, 10);
  }
  if (typeof v === "number") {
    const d = XLSX.SSF.parse_date_code(v);
    if (!d) return "";
    return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
  }
  const s = String(v).trim();
  const m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const m2 = s.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (m2) return `${m2[3]}-${m2[2]}-${m2[1]}`;
  return "";
}

function loadRows(filePath) {
  const wb = XLSX.readFile(filePath, { cellDates: true, codepage: 1251 });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true });
}

function aggregate(matrix) {
  const byDay = {};
  const byGroup = {};
  let rowCount = 0;
  // Skip title row [0] and header row [1]
  for (let i = 2; i < matrix.length; i += 1) {
    const row = matrix[i];
    if (!Array.isArray(row)) continue;
    const day = dayKey(row[COL.day]);
    if (!day) continue;
    const rawGroup = String(row[COL.group] ?? "").trim();
    const group = GROUP_MOJIBAKE.get(rawGroup) || rawGroup;
    const amt = money(row[COL.amount]);
    rowCount += 1;
    byDay[day] = (byDay[day] || 0) + amt;
    byGroup[group] = (byGroup[group] || 0) + amt;
  }
  const sales = byGroup["Продажи"] || 0;
  const returns = byGroup["Возвраты"] || 0;
  const commission = byGroup["Вознаграждение Ozon"] || 0;
  const delivery = byGroup["Услуги доставки"] || 0;
  const partnerServices = byGroup["Услуги партнёров"] || 0;
  const other = byGroup["Другие услуги и штрафы"] || 0;
  const fbo = byGroup["Услуги FBO"] || 0;
  const ads = byGroup["Продвижение и реклама"] || 0;
  // Independent checker: G includes every non-goods signed accrual once.
  // Compensations, «Технологии Ozon», and positive «Другие начисления» are
  // part of G — do NOT drop them under a screenshot-regroup excuse.
  const compensation = byGroup["Компенсации и декомпенсации"] || 0;
  const ozonTech = byGroup["Озон Технологии"] || 0;
  const otherAccruals = byGroup["Прочие начисления"] || 0;
  // XLSX signed accrued: expenses negative. Gross expense G = −sum(non-goods).
  // E = sales+returns. Control identity: G = E − sourceNet (all rows sum).
  const nonGoods =
    commission +
    delivery +
    partnerServices +
    other +
    fbo +
    ads +
    compensation +
    ozonTech +
    otherAccruals;
  const G = -nonGoods;
  const E = sales + returns;
  return {
    byDay,
    byGroup,
    rowCount,
    sales,
    returns,
    commission,
    delivery,
    partnerServices,
    other,
    fbo,
    ads,
    compensation,
    ozonTech,
    otherAccruals,
    regroupNet: ozonTech + otherAccruals,
    E,
    G,
  };
}

function sumDays(byDay, from, to) {
  let s = 0;
  for (const [d, v] of Object.entries(byDay)) {
    if (d >= from && d <= to) s += v;
  }
  return s;
}

const result = {
  weekPath,
  monthPath,
  present: Boolean(weekPath && monthPath),
  controls: {
    month: {
      R: 6802059.68,
      B: 15922045.1,
      A: 81370.22,
      E: 22805475,
      G: 16870446.39,
      N: 948401.29,
      total: 5935028.61,
    },
  },
};

if (!weekPath || !monthPath) {
  result.error = "XLSX files not found in assignment sources";
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "MONTH_XLSX_CONTROL.json"), JSON.stringify(result, null, 2));
  console.error(result.error);
  process.exit(1);
}

const weekAgg = aggregate(loadRows(weekPath));
const monthAgg = aggregate(loadRows(monthPath));

const weekSliceFromMonth = {};
for (const [d, v] of Object.entries(monthAgg.byDay)) {
  if (d >= "2026-10-19" && d <= "2026-10-25") weekSliceFromMonth[d] = v;
}
const dayDiffs = [];
let dayDelta = 0;
for (const d of new Set([
  ...Object.keys(weekAgg.byDay),
  ...Object.keys(weekSliceFromMonth),
])) {
  const a = weekAgg.byDay[d] || 0;
  const b = weekSliceFromMonth[d] || 0;
  const delta = a - b;
  if (Math.abs(delta) > 0.02) dayDiffs.push({ day: d, week: a, monthSlice: b, delta });
  dayDelta += delta;
}

const prefix = sumDays(monthAgg.byDay, "2026-10-01", "2026-10-18");
const weekPart = sumDays(monthAgg.byDay, "2026-10-19", "2026-10-25");
const allPart = sumDays(monthAgg.byDay, "2026-10-01", "2026-10-25");
const additive = Math.abs(prefix + weekPart - allPart) < 0.05;

const WEEK_G = 6441866.62;
const WEEK_E = 8581210;
const monthGdelta = monthAgg.G - result.controls.month.G;
const monthEdelta = monthAgg.E - result.controls.month.E;
const weekGdelta = weekAgg.G - WEEK_G;
const weekEdelta = weekAgg.E - WEEK_E;

result.week = {
  rowCount: weekAgg.rowCount,
  byGroup: weekAgg.byGroup,
  dayCount: Object.keys(weekAgg.byDay).length,
  E: weekAgg.E,
  G: weekAgg.G,
  vsControl: {
    E: { observed: weekAgg.E, expected: WEEK_E, delta: weekEdelta },
    G: { observed: weekAgg.G, expected: WEEK_G, delta: weekGdelta },
  },
};
result.month = {
  rowCount: monthAgg.rowCount,
  byGroup: monthAgg.byGroup,
  dayCount: Object.keys(monthAgg.byDay).length,
  E: monthAgg.E,
  G: monthAgg.G,
  vsControl: {
    E: { observed: monthAgg.E, expected: result.controls.month.E, delta: monthEdelta },
    G: { observed: monthAgg.G, expected: result.controls.month.G, delta: monthGdelta },
    note: "Independent checker also certifies R/B/A/N/sourceNet; this script fails on G/E misses",
  },
};
result.weekEqualsMonthSlice = {
  weekRows: weekAgg.rowCount,
  monthSliceRowEstimate: "by day totals",
  dayDiffCount: dayDiffs.length,
  dayDiffs: dayDiffs.slice(0, 20),
  totalDayDelta: dayDelta,
  pass: dayDiffs.length === 0 && Math.abs(dayDelta) < 0.05,
};
result.additive_01_18_plus_19_25 = {
  prefix_01_18: prefix,
  week_19_25: weekPart,
  month_01_25: allPart,
  sum: prefix + weekPart,
  pass: additive,
};
result.gControls = {
  weekPass: Math.abs(weekGdelta) < 0.05,
  monthPass: Math.abs(monthGdelta) < 0.05,
  weekEPass: Math.abs(weekEdelta) < 0.05,
  monthEPass: Math.abs(monthEdelta) < 0.05,
};
result.boundary =
  "Primary XLSX monetary day/group/G/E control. Month COGS/tax/physical movements NOT accepted from Excel alone. PartnerTaxPolicy unresolved. No production import.";
result.screenshot_regroup_note =
  "−28000 +8329.99 are included in G (not dropped); they do not invent a separate new expense class.";

const pass =
  result.weekEqualsMonthSlice.pass &&
  result.additive_01_18_plus_19_25.pass &&
  result.gControls.weekPass &&
  result.gControls.monthPass &&
  result.gControls.weekEPass &&
  result.gControls.monthEPass;
result.pass = pass;

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "MONTH_XLSX_CONTROL.json"), JSON.stringify(result, null, 2));
console.log(
  JSON.stringify(
    {
      weekRows: weekAgg.rowCount,
      monthRows: monthAgg.rowCount,
      weekEqualsMonthSlice: result.weekEqualsMonthSlice.pass,
      additive: result.additive_01_18_plus_19_25.pass,
      monthE: monthAgg.E,
      monthG: monthAgg.G,
      pass,
    },
    null,
    2,
  ),
);
process.exit(pass ? 0 : 1);
