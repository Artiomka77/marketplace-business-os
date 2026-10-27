/**
 * Strict offline Prisma I/O for FIN_RUN producer replay.
 * Unknown model/SQL/operator → throw (never silent []).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

type Row = Record<string, unknown>;

/**
 * Date hydrate for offline fixtures.
 * - Explicit Z / ±offset preserved via Date.parse ISO rules.
 * - Bare calendar / Prisma `timestamp without time zone` text treated as UTC
 *   (never Windows local TZ), matching FIN_ACCEPT UTC contract.
 */
function asDate(value: unknown): Date | null {
  if (value == null) return null;
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null;
  }
  if (typeof value === "number") {
    const d = new Date(value);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  const raw = String(value).trim();
  if (!raw) return null;
  // Keep existing Z / offset literals intact.
  if (/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(raw)) {
    const d = new Date(raw);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  const m = raw.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?)?$/,
  );
  if (m) {
    const ms = m[7] ? Number(String(m[7]).padEnd(3, "0").slice(0, 3)) : 0;
    const d = new Date(
      Date.UTC(
        Number(m[1]),
        Number(m[2]) - 1,
        Number(m[3]),
        Number(m[4] ?? 0),
        Number(m[5] ?? 0),
        Number(m[6] ?? 0),
        ms,
      ),
    );
    return Number.isFinite(d.getTime()) ? d : null;
  }
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d : null;
}

function compare(a: unknown, b: unknown): number {
  const da = asDate(a);
  const db = asDate(b);
  if (da && db) return da.getTime() - db.getTime();
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return String(a ?? "").localeCompare(String(b ?? ""));
}

function matchField(val: unknown, cond: unknown): boolean {
  if (cond && typeof cond === "object" && !Array.isArray(cond) && !(cond instanceof Date)) {
    const c = cond as Row;
    // Evaluate ALL operators on the same predicate object (gte+lte etc).
    if ("in" in c) {
      if (!Array.isArray(c.in) || !c.in.includes(val)) return false;
    }
    if ("not" in c) {
      if (c.not === null) {
        if (val == null) return false;
      } else if (val === c.not) return false;
    }
    if ("gte" in c && !(compare(val, c.gte) >= 0)) return false;
    if ("lte" in c && !(compare(val, c.lte) <= 0)) return false;
    if ("gt" in c && !(compare(val, c.gt) > 0)) return false;
    if ("lt" in c && !(compare(val, c.lt) < 0)) return false;
    if ("contains" in c || "startsWith" in c || "endsWith" in c || "mode" in c) {
      throw new Error(
        `OFFLINE_PRISMA_UNSUPPORTED_STRING_FILTER:${JSON.stringify(Object.keys(c))}`,
      );
    }
    if (
      !("in" in c) &&
      !("not" in c) &&
      !("gte" in c) &&
      !("lte" in c) &&
      !("gt" in c) &&
      !("lt" in c)
    ) {
      throw new Error(
        `OFFLINE_PRISMA_UNSUPPORTED_FILTER:${JSON.stringify(Object.keys(c))}`,
      );
    }
    return true;
  }
  // Date equality by UTC day / epoch, not object identity.
  const da = asDate(val);
  const db = asDate(cond);
  if (da && db) return da.getTime() === db.getTime();
  return val === cond;
}

function matchesWhere(row: Row, where: Row | undefined): boolean {
  if (!where || typeof where !== "object") return true;
  for (const [key, cond] of Object.entries(where)) {
    if (key === "AND") {
      if (!Array.isArray(cond) || !cond.every((c) => matchesWhere(row, c as Row)))
        return false;
      continue;
    }
    if (key === "OR") {
      if (!Array.isArray(cond) || !cond.some((c) => matchesWhere(row, c as Row)))
        return false;
      continue;
    }
    if (key === "NOT") {
      if (Array.isArray(cond)) {
        if (cond.some((c) => matchesWhere(row, c as Row))) return false;
      } else if (matchesWhere(row, cond as Row)) return false;
      continue;
    }
    if (!matchField(row[key], cond)) return false;
  }
  return true;
}

function project(row: Row, select: Row | undefined): Row {
  if (!select) return { ...row };
  const out: Row = {};
  for (const key of Object.keys(select)) {
    if (select[key]) out[key] = row[key];
  }
  return out;
}

function sortRows(list: Row[], orderBy: unknown): Row[] {
  if (!orderBy) return list;
  const specs = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...list].sort((a, b) => {
    for (const spec of specs) {
      if (!spec || typeof spec !== "object") continue;
      const [field, dir] = Object.entries(spec as Row)[0] ?? [];
      if (!field) continue;
      const cmp = compare(a[field], b[field]);
      if (cmp !== 0) return dir === "desc" ? -cmp : cmp;
    }
    return 0;
  });
}

function makeModel(
  modelName: string,
  rows: Row[],
  opts?: { nestPaymentsFrom?: () => Row[] },
) {
  return {
    async findMany(args?: {
      where?: Row;
      select?: Row;
      orderBy?: unknown;
      include?: unknown;
    }) {
      if (args?.include) {
        const inc = args.include as Row;
        // Canonical Finance path: loan.findMany({ include: { payments: { orderBy } } })
        if (
          modelName === "loan" &&
          inc &&
          typeof inc === "object" &&
          "payments" in inc &&
          Object.keys(inc).length === 1
        ) {
          const paymentsAll = opts?.nestPaymentsFrom ? opts.nestPaymentsFrom() : [];
          const payOrder =
            inc.payments &&
            typeof inc.payments === "object" &&
            (inc.payments as Row).orderBy
              ? (inc.payments as Row).orderBy
              : undefined;
          const list = sortRows(
            rows.filter((r) => matchesWhere(r, args?.where)),
            args?.orderBy,
          );
          return list.map((loan) => {
            const payments = sortRows(
              paymentsAll.filter((p) => String(p.loanId) === String(loan.id)),
              payOrder,
            );
            return { ...loan, payments };
          });
        }
        throw new Error(`OFFLINE_PRISMA_UNSUPPORTED_INCLUDE:${modelName}`);
      }
      const list = sortRows(
        rows.filter((r) => matchesWhere(r, args?.where)),
        args?.orderBy,
      );
      return list.map((r) => project(r, args?.select));
    },
    async findFirst(args?: { where?: Row; select?: Row; orderBy?: unknown }) {
      const all = await this.findMany(args);
      return all[0] ?? null;
    },
    async findUnique(args?: { where?: Row; select?: Row }) {
      return this.findFirst(args);
    },
    async count(args?: { where?: Row }) {
      return rows.filter((r) => matchesWhere(r, args?.where)).length;
    },
    async groupBy(args?: {
      by?: string[];
      where?: Row;
      _sum?: Row;
      _count?: unknown;
    }) {
      if (!args?.by?.length) {
        throw new Error(`OFFLINE_PRISMA_GROUPBY_NO_BY:${modelName}`);
      }
      const filtered = rows.filter((r) => matchesWhere(r, args.where));
      const map = new Map<string, Row>();
      for (const row of filtered) {
        const key = args.by.map((f) => String(row[f] ?? "")).join("|");
        const cur =
          map.get(key) ??
          Object.fromEntries(args.by.map((f) => [f, row[f]]));
        if (args._sum) {
          cur._sum = cur._sum || {};
          for (const field of Object.keys(args._sum)) {
            const sum = cur._sum as Row;
            sum[field] = Number(sum[field] ?? 0) + Number(row[field] ?? 0);
          }
        }
        if (args._count) {
          cur._count = Number(cur._count ?? 0) + 1;
        }
        map.set(key, cur);
      }
      return [...map.values()];
    },
  };
}

function readJson(filePath: string): unknown {
  if (!fs.existsSync(filePath)) {
    throw new Error(`OFFLINE_FIXTURE_MISSING:${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function hydrateDates(rows: Row[], fields: string[]): Row[] {
  return rows.map((row) => {
    const out = { ...row };
    for (const f of fields) {
      if (out[f] != null) out[f] = asDate(out[f]) ?? out[f];
    }
    return out;
  });
}

function sha256File(filePath: string) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

function parseQueryRawSql(strings: TemplateStringsArray | string): string {
  if (typeof strings === "string") return strings;
  return strings.join("?");
}

export function buildOfflineFixturePrisma(params: {
  weekFinalRoot: string;
  dumpRoot: string;
}) {
  const extract = path.join(params.weekFinalRoot, "raw", "extract");
  const primaryDir = path.join(params.weekFinalRoot, "raw", "ozon_primary");
  const dump = params.dumpRoot;

  const inputManifest: Row[] = [];
  const track = (model: string, file: string, rows: unknown) => {
    const count = Array.isArray(rows) ? rows.length : 1;
    const sha = fs.existsSync(file) ? sha256File(file) : null;
    inputManifest.push({ model, file, count, sha256: sha });
  };

  const costsRaw = readJson(path.join(extract, "RAW_PRODUCT_COST.json"));
  const costRows: Row[] = Array.isArray(costsRaw)
    ? (costsRaw as Row[])
    : Array.isArray((costsRaw as Row).rows)
      ? ((costsRaw as Row).rows as Row[])
      : [];
  const productCosts = hydrateDates(
    costRows.map((c: Row) => ({
      id: String(c.id ?? ""),
      vendorCode: c.vendorCode,
      nmId: c.nmId ?? null,
      costPrice: c.cost ?? c.costPrice,
      costDate: c.costDate,
      createdAt: c.createdAt ?? new Date(0),
    })),
    ["costDate", "createdAt"],
  );
  track("productCost", path.join(extract, "RAW_PRODUCT_COST.json"), productCosts);

  const skuMap = readJson(path.join(extract, "21_OZON_SKU.json"));
  const ozonProducts: Row[] = [];
  for (const row of Array.isArray(skuMap) ? skuMap : []) {
    ozonProducts.push({
      companyName: (row as Row).company || (row as Row).companyName || null,
      sku: (row as Row).sku != null ? String((row as Row).sku) : null,
      vendorCode: (row as Row).vendorCode ?? null,
    });
  }
  track("ozonProduct", path.join(extract, "21_OZON_SKU.json"), ozonProducts);

  const cabinets = readJson(path.join(extract, "01_CABINETS.json"));
  const companiesDump = readJson(path.join(dump, "companies.json")) as Row[];
  const companies: Row[] = companiesDump.length
    ? hydrateDates(companiesDump, [])
    : [];
  if (!companies.length) {
    const seen = new Set<string>();
    for (const c of Array.isArray(cabinets) ? cabinets : []) {
      const name = String((c as Row).company || "").trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      companies.push({
        id: String((c as Row).company_id || name),
        name,
        companyName: name,
        isActive: true,
        usnRate: Number((c as Row).usn_rate ?? (name.includes("Лебедева") ? 6 : 1)),
        vatRate: Number((c as Row).vat_rate ?? 5),
      });
    }
  }
  for (const c of companies) {
    if (c.isActive == null) c.isActive = true;
  }
  track("company", path.join(dump, "companies.json"), companies);

  const sessions: Row[] = [];
  for (const file of fs
    .readdirSync(primaryDir)
    .filter((f) => f.startsWith("raw_session_") && f.endsWith(".json"))) {
    const full = path.join(primaryDir, file);
    const j = JSON.parse(fs.readFileSync(full, "utf8"));
    const meta = j.meta || {};
    const dateFrom = String(meta.dateFrom || "2026-10-19");
    sessions.push({
      id: String(meta.sessionId || file),
      companyName: meta.company || meta.companyName,
      reportType: "OZON_ACCRUAL_BY_DAY_API",
      marketplace: "OZON",
      status: "SUCCESS",
      fileName: file,
      rowsCount: Array.isArray(j.rawAccruals) ? j.rawAccruals.length : 0,
      createdAt: new Date(`${dateFrom}T12:00:00.000Z`),
      previewJson: {
        dateFrom: meta.dateFrom,
        dateTo: meta.dateTo,
        requestedDates: meta.requestedDates || [meta.dateFrom].filter(Boolean),
        pagesByDay: meta.pagesByDay,
        rawAccruals: Array.isArray(j.rawAccruals) ? j.rawAccruals : [],
        payloadSha256: meta.payloadSha256,
      },
    });
    track("importSession.ozon_raw", full, [1]);
  }

  const wbSessionsPath = path.join(dump, "import_sessions_wb_by_sale.json");
  const wbSessions = hydrateDates(
    readJson(wbSessionsPath) as Row[],
    ["createdAt"],
  );
  for (const s of wbSessions) {
    sessions.push({
      ...s,
      marketplace: s.marketplace || "WB",
      previewJson: s.previewJson ?? null,
    });
  }
  track("importSession.wb", wbSessionsPath, wbSessions);

  const wbSales = hydrateDates(
    readJson(path.join(dump, "wb_sale_week.json")) as Row[],
    ["saleDate"],
  );
  track("wbSale", path.join(dump, "wb_sale_week.json"), wbSales);

  const wbFinance = hydrateDates(
    readJson(path.join(dump, "wb_finance_week.json")) as Row[],
    ["dateFrom", "dateTo", "createdAt"],
  );
  track("wbFinance", path.join(dump, "wb_finance_week.json"), wbFinance);

  const wbAds = hydrateDates(
    readJson(path.join(dump, "wb_ads_week.json")) as Row[],
    ["dateFrom", "dateTo", "createdAt"],
  );
  track("wbAds", path.join(dump, "wb_ads_week.json"), wbAds);

  const ozonCat = hydrateDates(
    readJson(path.join(dump, "ozon_financial_category_fact_week.json")) as Row[],
    ["operationDate", "dateFrom", "dateTo", "createdAt"],
  );
  track(
    "ozonFinancialCategoryFact",
    path.join(dump, "ozon_financial_category_fact_week.json"),
    ozonCat,
  );

  const ozonRealSum = hydrateDates(
    readJson(path.join(dump, "ozon_realization_summary_week.json")) as Row[],
    ["dateFrom", "dateTo", "createdAt"],
  );
  track(
    "ozonRealizationSummary",
    path.join(dump, "ozon_realization_summary_week.json"),
    ozonRealSum,
  );

  const ozonDiscount = hydrateDates(
    readJson(path.join(dump, "ozon_discount_points_summary_week.json")) as Row[],
    ["dateFrom", "dateTo", "createdAt"],
  );
  track(
    "ozonDiscountPointsSummary",
    path.join(dump, "ozon_discount_points_summary_week.json"),
    ozonDiscount,
  );

  const adMaps = readJson(path.join(dump, "ad_campaign_map_wb.json")) as Row[];
  track("adCampaignMap", path.join(dump, "ad_campaign_map_wb.json"), adMaps);

  const realizationPath = path.join(extract, "22_OZON_REALIZATION_CROSSCHECK.json");
  const realizationRows: Row[] = [];
  if (fs.existsSync(realizationPath)) {
    const rr = readJson(realizationPath) as Row[];
    for (const r of rr) {
      const day = String(r.day || "").slice(0, 10);
      if (!day) continue;
      realizationRows.push({
        id: r.id,
        companyName: r.company,
        sku: r.sku != null ? String(r.sku) : null,
        vendorCode: r.vendorCode ?? null,
        productName: r.productName ?? null,
        realizedQty: Number(r.realized_qty ?? 0),
        returnedQty: Number(r.returned_qty ?? 0),
        netQty: Number(r.net_qty ?? 0),
        realizedAmount: Number(r.taxable ?? 0),
        returnedAmount: 0,
        taxableRevenue: Number(r.taxable ?? 0),
        partnerProgramsAmount: Number(r.partner ?? 0),
        dateFrom: new Date(`${day}T00:00:00.000Z`),
        dateTo: new Date(`${day}T00:00:00.000Z`),
      });
    }
    track("ozonRealizationRow", realizationPath, realizationRows);
  }

  // Proven empty OzonFinance for the week (count dump).
  const ozonFinanceCount = readJson(
    path.join(dump, "ozon_finance_week_count.json"),
  ) as Row[];
  track(
    "ozonFinance.empty_proven",
    path.join(dump, "ozon_finance_week_count.json"),
    ozonFinanceCount,
  );

  // Mutable read-model + Finance stores for producer → loader e2e.
  const profitPeriodRows: Row[] = [];
  const profitSkuPeriodRows: Row[] = [];
  const financeTxPath = path.join(extract, "40_FINANCE_WEEK.json");
  const financeTxRaw = fs.existsSync(financeTxPath)
    ? (readJson(financeTxPath) as Row[])
    : [];

  const roleToTreatment = (pnlRole: unknown, cashRole: unknown, category: unknown) => {
    const p = String(pnlRole ?? "");
    const c = String(cashRole ?? "");
    if (p.startsWith("EXCLUDE")) return "IGNORE";
    if (p.startsWith("OWNER") || c === "OWNER") return "OWNER_WITHDRAWAL";
    if (p.startsWith("CASH_ONLY") || c === "CASH") return "CASH_ONLY";
    if (p === "INCLUDE_INTEREST" || c === "CREDIT_INTEREST") return "CREDIT_INTEREST";
    if (c === "CREDIT_PRINCIPAL" || String(category).includes("Тело кредита"))
      return "CREDIT_PRINCIPAL";
    if (c === "MP_SETTLEMENT_INFLOW") return "IGNORE";
    if (p.startsWith("INCLUDE")) return "INCLUDE_IN_NET_PROFIT";
    return "AUTO";
  };
  const catSeen = new Set<string>();
  const financeCategoriesDerived: Row[] = [];
  for (const r of financeTxRaw) {
    const name = String(r.category ?? "").trim();
    if (!name || catSeen.has(name)) continue;
    catSeen.add(name);
    financeCategoriesDerived.push({
      name,
      categoryType: "EXPENSE",
      parentName: null,
      profitTreatment: roleToTreatment(r.pnlRole, r.cashRole, r.category),
    });
  }
  // Primary Finance bundle (FIN_ACCEPT): prefer live FINANCE_SOURCE.json, else
  // attached primary_finance 42/41. Categories from source when present.
  // Never promote an empty primary catalog to PRIMARY via derived roles.
  const primaryFinanceRoots = [
    path.resolve(process.cwd(), "scripts/fin_patch/FIN_ACCEPT_RESULT_" + (process.env.FIN_ACCEPT_TS || "") + "/primary_finance_complete"),
    path.join(params.weekFinalRoot, "primary_finance_complete"),
    path.join(params.weekFinalRoot, "primary_finance"),
    extract,
    path.resolve(process.cwd(), "scripts/fin_patch/FIN_ACCEPT_ASSIGNMENT/primary_finance"),
  ].filter((p) => p && !p.includes("RESULT_/"));
  function resolvePrimary(name: string): string | null {
    for (const root of primaryFinanceRoots) {
      const p = path.join(root, name);
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  const financeSourcePath = resolvePrimary("FINANCE_SOURCE.json");
  const financeSource = financeSourcePath
    ? (readJson(financeSourcePath) as Row)
    : null;

  function mapFinanceTxRow(r: Row, i: number): Row {
    return {
      id: String(r.id ?? `fin_${i}`),
      companyName: r.companyName ?? null,
      amount: r.amount,
      operationType: r.operationType ?? null,
      category: r.category,
      subcategory: r.subcategory ?? null,
      isInternalTransfer: Boolean(r.isInternalTransfer),
      counterparty: r.counterparty ?? null,
      comment: r.comment ?? null,
      sourceType: r.sourceType ?? null,
      sourceId: r.sourceId ?? null,
      // FACT status required by getEffectiveFinanceTransactions filter.
      transactionStatus: String(r.transactionStatus ?? "FACT"),
      operationDate: r.operationDate ?? r.obligationDate ?? r.day ?? null,
      obligationDate: r.obligationDate ?? null,
      transferGroupId: r.transferGroupId ?? null,
      transferDirection: r.transferDirection ?? null,
      pnlRole: r.pnlRole ?? null,
      cashRole: r.cashRole ?? null,
    };
  }

  // Wire ALL arrays from one FINANCE_SOURCE when present:
  // week ops + early repayment events, deduped by id (early may also appear in week).
  let financeTransactions: Row[];
  let financeTxProvenance: string;
  let financeTxTrackPath: string;
  if (financeSource) {
    const byId = new Map<string, Row>();
    const weekArr = Array.isArray(financeSource.financeTransactionsWeek)
      ? (financeSource.financeTransactionsWeek as Row[])
      : [];
    const earlyArr = Array.isArray(financeSource.earlyRepaymentEvents)
      ? (financeSource.earlyRepaymentEvents as Row[])
      : [];
    let i = 0;
    for (const r of weekArr) {
      const mapped = mapFinanceTxRow(r, i++);
      byId.set(String(mapped.id), mapped);
    }
    let earlyMerged = 0;
    let earlyDupSkipped = 0;
    for (const r of earlyArr) {
      const mapped = mapFinanceTxRow(r, i++);
      const id = String(mapped.id);
      if (byId.has(id)) {
        earlyDupSkipped += 1;
        continue;
      }
      byId.set(id, mapped);
      earlyMerged += 1;
    }
    financeTransactions = hydrateDates([...byId.values()], [
      "operationDate",
      "obligationDate",
    ]);
    financeTxProvenance = `financeTransaction.PRIMARY_FINANCE_SOURCE_WEEK_PLUS_EARLY(week=${weekArr.length},early=${earlyArr.length},mergedEarly=${earlyMerged},dupSkipped=${earlyDupSkipped})`;
    financeTxTrackPath = financeSourcePath!;
  } else {
    financeTransactions = hydrateDates(
      financeTxRaw.map((r, i) => mapFinanceTxRow(r, i)),
      ["operationDate", "obligationDate"],
    );
    financeTxProvenance = "financeTransaction.FALLBACK_40_FINANCE_WEEK";
    financeTxTrackPath = financeTxPath;
  }
  track(financeTxProvenance, financeTxTrackPath, financeTransactions);

  let financeCategoriesFinal = financeCategoriesDerived;
  let financeCategoryProvenance =
    "DERIVED_FROM_40_FINANCE_WEEK_PNL_CASH_ROLES";
  if (financeSource) {
    const primaryCats = Array.isArray(financeSource.financeCategories)
      ? (financeSource.financeCategories as Row[])
      : [];
    if (primaryCats.length > 0) {
      financeCategoriesFinal = primaryCats.map((c) => ({
        id: c.id,
        name: String(c.name ?? ""),
        parentName: c.parentName ?? null,
        categoryType: String(c.categoryType ?? "EXPENSE"),
        profitTreatment: c.profitTreatment ?? "AUTO",
        isActive: c.isActive ?? true,
        sortOrder: c.sortOrder ?? null,
      }));
      financeCategoryProvenance = "PRIMARY_FINANCE_SOURCE_FINANCE_CATEGORY";
    } else {
      // Keep derived only as offline fallback; never relabel as PRIMARY/PASS.
      financeCategoryProvenance =
        "DERIVED_FROM_40_FINANCE_WEEK_PNL_CASH_ROLES_PRIMARY_CATALOG_EMPTY";
    }
  }
  track(financeCategoryProvenance, financeSourcePath ?? financeTxPath, financeCategoriesFinal);

  const loansPath = financeSource
    ? financeSourcePath
    : resolvePrimary("42_LOANS.json");
  const loanPayPath = financeSource
    ? financeSourcePath
    : resolvePrimary("41_LOAN_PAYMENTS_WEEK.json");
  const loansRaw = financeSource
    ? ((financeSource.loans as Row[]) ?? [])
    : loansPath
      ? (readJson(loansPath) as Row[])
      : [];
  const loanPayFile = financeSource
    ? { rows: financeSource.loanPayments }
    : loanPayPath
      ? readJson(loanPayPath)
      : null;
  const loanPayRaw: Row[] = Array.isArray(loanPayFile)
    ? (loanPayFile as Row[])
    : Array.isArray((loanPayFile as Row | null)?.rows)
      ? ((loanPayFile as Row).rows as Row[])
      : [];

  const primaryLoans = hydrateDates(
    (Array.isArray(loansRaw) ? loansRaw : []).map((r) => ({
      id: String(r.id),
      companyName: r.companyName ?? r.company ?? null,
      bankName: r.bankName ?? null,
      currentDebt: r.currentDebt ?? null,
      endDate: r.endDate ?? null,
      startDate: r.startDate ?? null,
      monthlyPayment: r.monthlyPayment ?? null,
      interestRate: r.interestRate ?? null,
      paymentFrequency: r.paymentFrequency ?? null,
      creditLimit: r.creditLimit ?? null,
    })),
    ["endDate", "startDate"],
  );

  // Keep ALL schedule rows (including EXCLUDE_STALE_AFTER_CLOSE candidates).
  // Runtime getEffectiveFinanceTransactions applies endDate/early/dedup.
  const primaryLoanPayments = hydrateDates(
    loanPayRaw.map((r) => ({
      id: String(r.id),
      loanId: String(r.loanId),
      paymentDate: r.paymentDate,
      paid: Boolean(r.paid),
      principalAmount: Number(r.principalAmount ?? 0),
      interestAmount: Number(r.interestAmount ?? 0),
      totalAmount: Number(
        r.totalAmount ??
          Number(r.principalAmount ?? 0) + Number(r.interestAmount ?? 0),
      ),
      __auditorClassification: r.classification ?? null,
      __includeInWeekCanon: r.includeInWeekCanon ?? null,
    })),
    ["paymentDate"],
  );

  track(
    financeSource ? "loan.PRIMARY_FINANCE_SOURCE" : loansPath
      ? "loan.PRIMARY_42_LOANS"
      : "loan.PRIMARY_MISSING",
    loansPath ?? financeTxPath,
    primaryLoans,
  );
  track(
    financeSource
      ? "loanPayment.PRIMARY_FINANCE_SOURCE_FULL_SCHEDULE"
      : loanPayPath
        ? "loanPayment.PRIMARY_41_ALL_WEEK_ROWS_RUNTIME_CLOSE"
        : "loanPayment.PRIMARY_MISSING",
    loanPayPath ?? financeTxPath,
    primaryLoanPayments,
  );

  const known: Record<string, ReturnType<typeof makeModel>> = {
    productCost: makeModel("productCost", productCosts),
    ozonProduct: makeModel("ozonProduct", ozonProducts),
    ozonStock: makeModel("ozonStock", []),
    ozonWarehouseStock: makeModel("ozonWarehouseStock", []),
    ozonFinance: makeModel("ozonFinance", []), // proven empty week
    ozonAds: makeModel("ozonAds", []),
    ozonRealizationRow: makeModel("ozonRealizationRow", realizationRows),
    importSession: makeModel("importSession", sessions),
    company: makeModel("company", companies),
    wbSale: makeModel("wbSale", wbSales),
    wbAds: makeModel("wbAds", wbAds),
    wbFinance: makeModel("wbFinance", wbFinance),
    wbStock: makeModel("wbStock", []),
    adCampaignMap: makeModel("adCampaignMap", adMaps),
    wbProductCard: makeModel("wbProductCard", []),
    profitPeriodMetric: makeModel("profitPeriodMetric", profitPeriodRows),
    profitSkuPeriodMetric: makeModel("profitSkuPeriodMetric", profitSkuPeriodRows),
    financeTransaction: makeModel("financeTransaction", financeTransactions),
    financeCategory: makeModel("financeCategory", financeCategoriesFinal),
    // Primary Loan/LoanPayment (full week rows incl. stale). Runtime close uses
    // endDate when currentDebt≈0. include:{payments} supported.
    loan: makeModel("loan", primaryLoans, {
      nestPaymentsFrom: () => primaryLoanPayments,
    }),
    loanPayment: makeModel("loanPayment", primaryLoanPayments),
  };

  function handleQueryRaw(
    strings: TemplateStringsArray | { strings?: TemplateStringsArray },
    values: unknown[],
  ) {
    const sql =
      typeof strings === "object" && strings && "strings" in strings
        ? parseQueryRawSql((strings as { strings: TemplateStringsArray }).strings)
        : parseQueryRawSql(strings as TemplateStringsArray);
    const text = String(sql).replace(/\s+/g, " ");

    if (text.includes('"OzonFinancialCategoryFact"')) {
      const company = typeof values[2] === "string" ? values[2] : null;
      // dateFrom, dateTo are values[0], values[1] as strings typically
      const dateFrom = String(values[0] ?? "").slice(0, 10);
      const dateTo = String(values[1] ?? "").slice(0, 10);
      const filtered = ozonCat.filter((row) => {
        const d = asDate(row.operationDate);
        if (!d) return false;
        const key = d.toISOString().slice(0, 10);
        if (dateFrom && key < dateFrom) return false;
        // SQL uses operationDate < dateTo + 1 day → inclusive dateTo
        if (dateTo && key > dateTo) return false;
        if (company && row.companyName !== company) return false;
        return true;
      });
      const map = new Map<string, Row>();
      for (const row of filtered) {
        const k = [
          row.category,
          row.sourceOperationType,
          row.sourceOperationCode,
          row.sourceServiceName,
        ].join("|");
        const cur = map.get(k) ?? {
          category: row.category,
          sourceOperationType: row.sourceOperationType,
          sourceOperationCode: row.sourceOperationCode,
          sourceServiceName: row.sourceServiceName,
          amount: 0,
        };
        cur.amount = Number(cur.amount) + Number(row.amount ?? 0);
        map.set(k, cur);
      }
      return [...map.values()];
    }

    if (text.includes('"OzonRealizationSummary"')) {
      const dateFrom = String(values[0] ?? "").slice(0, 10);
      const dateTo = String(values[1] ?? "").slice(0, 10);
      const company =
        typeof values[2] === "string" && values.length >= 3 ? values[2] : null;
      return ozonRealSum
        .filter((row) => {
          const from = asDate(row.dateFrom)?.toISOString().slice(0, 10) || "";
          const to = asDate(row.dateTo)?.toISOString().slice(0, 10) || "";
          if (dateFrom && from < dateFrom) return false;
          if (dateTo && to > dateTo) return false;
          if (company && row.companyName !== company) return false;
          return true;
        })
        .map((row) => ({
          dateFrom: row.dateFrom,
          dateTo: row.dateTo,
          realizedAmount: row.realizedAmount,
          returnedAmount: row.returnedAmount,
          taxableRevenue: row.taxableRevenue,
          partnerProgramsAmount: row.partnerProgramsAmount,
          rows: row.rowsCount ?? 1,
        }));
    }

    if (text.includes('"OzonDiscountPointsSummary"') || text.includes("DiscountPoints")) {
      const dateFrom = String(values[0] ?? "").slice(0, 10);
      const dateTo = String(values[1] ?? "").slice(0, 10);
      const company =
        typeof values[2] === "string" && values.length >= 3 ? values[2] : null;
      return ozonDiscount.filter((row) => {
        const from = asDate(row.dateFrom)?.toISOString().slice(0, 10) || "";
        const to = asDate(row.dateTo)?.toISOString().slice(0, 10) || "";
        if (dateFrom && from < dateFrom) return false;
        if (dateTo && to > dateTo) return false;
        if (company && row.companyName !== company) return false;
        return true;
      });
    }

    throw new Error(
      `OFFLINE_PRISMA_UNMAPPED_QUERY_RAW:${text.slice(0, 240)}`,
    );
  }

  const client: Record<string, unknown> = {
    $queryRaw: async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => handleQueryRaw(strings, values),
    $queryRawUnsafe: async (sql: string, ...values: unknown[]) => {
      throw new Error(`OFFLINE_PRISMA_QUERY_RAW_UNSAFE:${String(sql).slice(0, 120)}`);
    },
    $executeRaw: async () => {
      throw new Error("OFFLINE_PRISMA_EXECUTE_RAW_FORBIDDEN");
    },
    $transaction: async (fn: (tx: unknown) => unknown) =>
      typeof fn === "function" ? fn(client) : fn,
    _meta: {
      inputManifest,
      wbSaleCount: wbSales.length,
      ozonCategoryFactCount: ozonCat.length,
      ozonRealizationSummaryCount: ozonRealSum.length,
      ozonFinanceProvenEmpty: true,
    },
    _inputManifest: inputManifest,
    /** Upsert producer output into mutable period/SKU stores for loader e2e. */
    _upsertProfitReadModel(args: {
      period: Row;
      skus: Row[];
    }) {
      const key = [
        args.period.companyScope,
        args.period.marketplace,
        asDate(args.period.dateFrom)?.toISOString().slice(0, 10),
        asDate(args.period.dateTo)?.toISOString().slice(0, 10),
        args.period.formulaVersion,
      ].join("|");
      for (let i = profitPeriodRows.length - 1; i >= 0; i -= 1) {
        const row = profitPeriodRows[i];
        const rowKey = [
          row.companyScope,
          row.marketplace,
          asDate(row.dateFrom)?.toISOString().slice(0, 10),
          asDate(row.dateTo)?.toISOString().slice(0, 10),
          row.formulaVersion,
        ].join("|");
        if (rowKey === key) profitPeriodRows.splice(i, 1);
      }
      profitPeriodRows.push({
        id: `ppm_${profitPeriodRows.length + 1}_${key}`,
        ...args.period,
      });
      for (let i = profitSkuPeriodRows.length - 1; i >= 0; i -= 1) {
        const row = profitSkuPeriodRows[i];
        if (
          row.companyScope === args.period.companyScope &&
          row.marketplace === args.period.marketplace &&
          asDate(row.dateFrom)?.toISOString().slice(0, 10) ===
            asDate(args.period.dateFrom)?.toISOString().slice(0, 10) &&
          asDate(row.dateTo)?.toISOString().slice(0, 10) ===
            asDate(args.period.dateTo)?.toISOString().slice(0, 10)
        ) {
          profitSkuPeriodRows.splice(i, 1);
        }
      }
      for (const sku of args.skus) {
        const payload = (sku.payload ?? {}) as Row;
        profitSkuPeriodRows.push({
          id: `psku_${profitSkuPeriodRows.length + 1}_${sku.productKey}`,
          companyScope: sku.companyScope,
          marketplace: sku.marketplace,
          dateFrom: sku.dateFrom,
          dateTo: sku.dateTo,
          formulaVersion: sku.formulaVersion,
          productKey: sku.productKey,
          nmId: payload.nmId ?? payload.sku ?? null,
          vendorCode: payload.vendorCode ?? null,
          subject: payload.subject ?? null,
          revenue: payload.revenue ?? null,
          netProfitAfterTax: payload.netProfitAfterTax ?? null,
          netSalesQty: payload.netSalesQty ?? null,
          payload,
          generatedAt: sku.generatedAt ?? new Date(),
        });
      }
    },
  };

  return new Proxy(client, {
    get(target, prop, receiver) {
      if (typeof prop === "symbol") return Reflect.get(target, prop, receiver);
      if (prop in target) return Reflect.get(target, prop, receiver);
      if (typeof prop === "string" && prop in known) return known[prop];
      throw new Error(`OFFLINE_PRISMA_UNKNOWN_MODEL:${String(prop)}`);
    },
  });
}
