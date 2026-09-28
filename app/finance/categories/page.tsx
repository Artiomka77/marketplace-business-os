import Link from "next/link";
import { prisma } from "@/lib/prisma";
import FinanceNav from "@/components/finance/FinanceNav";
import {
  buildFinanceCategoryTreatmentIndex,
  calculateFinanceMetricsForRows,
  getFinanceTransactionCashEffect,
  getFinanceTransactionTreatment,
} from "@/lib/finance/financeMetrics";
import { getEffectiveFinanceTransactions } from "@/lib/finance/effectiveFinanceTransactions";
import {
  loadPeriodFinancePack,
  WaveDEConsumerUnavailableError,
} from "@/lib/consumers/waveDE";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type SearchParams = {
  companyName?: string;
  dateFrom?: string;
  dateTo?: string;
};

function formatMoney(value: unknown) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0,
  }).format(n);
}

function parseDateInput(value?: string | null) {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

function defaultPeriod() {
  const to = new Date();
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - 6);
  return { dateFrom: isoDate(from), dateTo: isoDate(to) };
}

export default async function FinanceCategoriesPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  const params = searchParams ?? {};
  const company =
    params.companyName && params.companyName !== "ALL"
      ? params.companyName
      : "ALL";
  const fallback = defaultPeriod();
  const dateFrom =
    parseDateInput(params.dateFrom) != null
      ? params.dateFrom!
      : fallback.dateFrom;
  const dateTo =
    parseDateInput(params.dateTo) != null ? params.dateTo! : fallback.dateTo;
  const periodStart = parseDateInput(dateFrom)!;
  const periodEndExclusive = parseDateInput(dateTo)!;
  periodEndExclusive.setUTCDate(periodEndExclusive.getUTCDate() + 1);

  const companies = await prisma.company.findMany({
    select: { name: true },
    orderBy: { name: "asc" },
  });

  const categories = await prisma.financeCategory.findMany({
    where: { isActive: true },
    orderBy: [{ categoryType: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
  });
  const categoryIndex = buildFinanceCategoryTreatmentIndex(categories);

  const asOfDate = new Date(periodEndExclusive.getTime() - 1);
  const effectiveRows = await getEffectiveFinanceTransactions({
    prisma,
    companyName: company !== "ALL" ? company : null,
    dateFrom: periodStart,
    dateToExclusive: periodEndExclusive,
    asOfDate,
  });
  // Category reporting uses canonical EFFECTIVE finance rows (explicit FACT + due schedule EFFECTIVE FACT).
  // Future PLAN is excluded by the helper (asOf boundary) and must not enter realized category cash/P&L.
  const factRows = effectiveRows.map((row) => ({
    companyName: row.companyName,
    operationType: row.operationType,
    category: row.category,
    subcategory: row.subcategory,
    amount: row.amount,
    isInternalTransfer: row.isInternalTransfer,
    transferDirection: row.transferDirection,
    __effectiveFactSynthetic: Boolean(row.__effectiveFactSynthetic),
    transactionStatus: row.transactionStatus,
    sourceType: row.sourceType,
  }));

  const metrics = calculateFinanceMetricsForRows({
    transactions: factRows,
    categories,
  });

  type Agg = {
    category: string;
    categoryType: string;
    treatment: string;
    treatmentLabel: string;
    txnCount: number;
    cashEffect: number;
    incomeAbs: number;
    expenseAbs: number;
  };
  const byCategory = new Map<string, Agg>();
  for (const row of factRows) {
    const treatment = getFinanceTransactionTreatment(row, categoryIndex);
    const cash = getFinanceTransactionCashEffect(row, categoryIndex);
    const key = row.category || "(без статьи)";
    const catMeta =
      categoryIndex.byTypeAndName.get(
        `${String(row.operationType || "").toLowerCase()}::${key.toLowerCase()}`,
      ) ?? categoryIndex.byName.get(key.toLowerCase());
    const current = byCategory.get(key) ?? {
      category: key,
      categoryType: catMeta?.categoryType ?? row.operationType ?? "UNKNOWN",
      treatment: treatment.treatment,
      treatmentLabel: treatment.label,
      txnCount: 0,
      cashEffect: 0,
      incomeAbs: 0,
      expenseAbs: 0,
    };
    current.txnCount += 1;
    current.cashEffect += cash;
    const abs = Math.abs(Number(row.amount ?? 0) || 0);
    if (cash > 0) current.incomeAbs += abs;
    else if (cash < 0) current.expenseAbs += abs;
    byCategory.set(key, current);
  }
  const categoryRows = [...byCategory.values()].sort(
    (a, b) => Math.abs(b.cashEffect) - Math.abs(a.cashEffect),
  );

  let periodMeta: Awaited<ReturnType<typeof loadPeriodFinancePack>>["meta"] | null =
    null;
  let periodUnavailable: { reason: string; message: string } | null = null;
  try {
    const loaded = await loadPeriodFinancePack({
      companyScope: company,
      dateFrom,
      dateTo,
    });
    periodMeta = loaded.meta;
  } catch (error) {
    if (error instanceof WaveDEConsumerUnavailableError) {
      periodUnavailable = { reason: error.reason, message: error.message };
    } else {
      throw error;
    }
  }

  const qs = new URLSearchParams();
  if (company !== "ALL") qs.set("companyName", company);
  qs.set("dateFrom", dateFrom);
  qs.set("dateTo", dateTo);

  return (
    <main className="mx-auto max-w-7xl space-y-6 px-4 py-6">
      <FinanceNav />
      <div className="space-y-2">
        <h1 className="text-2xl font-black text-slate-950">
          Справочник статей
        </h1>
        <p className="text-sm text-slate-600">
          Разложение EFFECTIVE finance-операций по статьям FinanceCategory с treatments
          (owner / loan / transfer). Marketplace-агрегаты — только из period
          read model, без live Financial Core.
        </p>
        <div className="text-xs text-slate-500" data-wave-de="finance-categories">
          source=EFFECTIVE_FINANCE+FinanceCategory
          {periodMeta
            ? ` | periodContext=${periodMeta.formulaVersion}/${periodMeta.dataMode}`
            : periodUnavailable
              ? ` | periodContext=UNAVAILABLE:${periodUnavailable.reason}`
              : ""}
          {` | heavyFc=0`}
        </div>
      </div>

      <form className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4">
        <label className="text-sm">
          <span className="mb-1 block text-slate-500">Компания</span>
          <select
            name="companyName"
            defaultValue={company}
            className="rounded-md border border-slate-300 px-3 py-2"
          >
            <option value="ALL">ALL</option>
            {companies.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-slate-500">С</span>
          <input
            type="date"
            name="dateFrom"
            defaultValue={dateFrom}
            className="rounded-md border border-slate-300 px-3 py-2"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-slate-500">По</span>
          <input
            type="date"
            name="dateTo"
            defaultValue={dateTo}
            className="rounded-md border border-slate-300 px-3 py-2"
          />
        </label>
        <button
          type="submit"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white"
        >
          Применить
        </button>
        <Link
          href={`/finance/operations?${qs.toString()}`}
          className="text-sm font-semibold text-slate-700 underline"
        >
          К операциям
        </Link>
      </form>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs uppercase text-slate-500">ДДС приток</div>
          <div className="mt-1 text-xl font-black">{formatMoney(metrics.cashIncome)}</div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs uppercase text-slate-500">ДДС отток</div>
          <div className="mt-1 text-xl font-black">{formatMoney(metrics.cashOutflow)}</div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs uppercase text-slate-500">Вывод собственника</div>
          <div className="mt-1 text-xl font-black">{formatMoney(metrics.ownerWithdrawals)}</div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs uppercase text-slate-500">Тело / % кредита</div>
          <div className="mt-1 text-xl font-black">
            {formatMoney(metrics.creditPrincipal)} / {formatMoney(metrics.creditInterest)}
          </div>
        </div>
      </section>

      <section className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
            <tr>
              <th className="px-3 py-2">Статья</th>
              <th className="px-3 py-2">Тип</th>
              <th className="px-3 py-2">Treatment</th>
              <th className="px-3 py-2 text-right">Операций</th>
              <th className="px-3 py-2 text-right">Приток</th>
              <th className="px-3 py-2 text-right">Отток</th>
              <th className="px-3 py-2 text-right">ДДС эффект</th>
            </tr>
          </thead>
          <tbody>
            {categoryRows.map((row) => (
              <tr key={row.category} className="border-t border-slate-100">
                <td className="px-3 py-2 font-semibold text-slate-900">{row.category}</td>
                <td className="px-3 py-2">{row.categoryType}</td>
                <td className="px-3 py-2">{row.treatmentLabel}</td>
                <td className="px-3 py-2 text-right">{row.txnCount}</td>
                <td className="px-3 py-2 text-right">{formatMoney(row.incomeAbs)}</td>
                <td className="px-3 py-2 text-right">{formatMoney(row.expenseAbs)}</td>
                <td className="px-3 py-2 text-right font-semibold">{formatMoney(row.cashEffect)}</td>
              </tr>
            ))}
            {categoryRows.length === 0 ? (
              <tr>
                <td className="px-3 py-6 text-slate-500" colSpan={7}>
                  Нет FACT-операций за выбранный период/компанию.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-black uppercase tracking-wide text-slate-500">
          Активные статьи справочника
        </h2>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {categories.map((c) => (
            <div key={c.id} className="rounded-lg border border-slate-100 px-3 py-2 text-sm">
              <div className="font-semibold text-slate-900">{c.name}</div>
              <div className="text-xs text-slate-500">
                {c.categoryType} · {c.profitTreatment}
                {c.parentName ? ` · parent=${c.parentName}` : ""}
              </div>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
