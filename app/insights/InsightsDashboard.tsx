"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import type {
  InsightSkuRow,
  InsightStockRow,
  InsightsPayload,
  MarketplaceSlice,
} from "./insightsTypes";

function formatMoney(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "н/д";
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatNumber(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "н/д";
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(
    value,
  );
}

function formatPercent(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "н/д";
  return `${value.toFixed(1)}%`;
}

function formatDateRu(iso: string) {
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return iso;
  return `${d}.${m}.${y}`;
}

function moneyClass(value: number) {
  if (value > 0) return "text-emerald-600";
  if (value < 0) return "text-rose-600";
  return "text-slate-800";
}

function SkuThumb({ marketplace }: { marketplace: string }) {
  return (
    <div
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[10px] font-black ${
        marketplace === "WB"
          ? "bg-violet-100 text-violet-700"
          : "bg-sky-100 text-sky-700"
      }`}
      aria-hidden
    >
      {marketplace === "WB" ? "WB" : "Oz"}
    </div>
  );
}

function KpiCard({
  title,
  value,
  accent,
  icon,
  subtitle,
  tip,
}: {
  title: string;
  value: string;
  accent: "blue" | "green" | "violet" | "red" | "purple";
  icon: string;
  subtitle?: string;
  tip?: string;
}) {
  const accents = {
    blue: "border-sky-100 bg-gradient-to-br from-white to-sky-50/80",
    green: "border-emerald-100 bg-gradient-to-br from-white to-emerald-50/70",
    violet: "border-violet-100 bg-gradient-to-br from-white to-violet-50/70",
    red: "border-rose-100 bg-gradient-to-br from-white to-rose-50/80",
    purple: "border-fuchsia-100 bg-gradient-to-br from-white to-fuchsia-50/70",
  } as const;
  const iconBg = {
    blue: "bg-sky-100 text-sky-700",
    green: "bg-emerald-100 text-emerald-700",
    violet: "bg-violet-100 text-violet-700",
    red: "bg-rose-100 text-rose-700",
    purple: "bg-fuchsia-100 text-fuchsia-700",
  } as const;

  return (
    <article
      className={`rounded-2xl border p-4 shadow-sm ${accents[accent]}`}
      title={tip}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
          {title}
        </div>
        <div
          className={`flex h-8 w-8 items-center justify-center rounded-xl text-sm ${iconBg[accent]}`}
          aria-hidden
        >
          {icon}
        </div>
      </div>
      <div className="mt-3 text-2xl font-black tracking-tight text-slate-900 sm:text-[1.65rem]">
        {value}
      </div>
      <div className="mt-2 text-xs font-semibold text-slate-500">
        {subtitle ?? "нет сравнения"}
      </div>
    </article>
  );
}

function AttentionCard({
  href,
  icon,
  tone,
  title,
  body,
}: {
  href: string;
  icon: string;
  tone: "rose" | "amber" | "emerald" | "violet";
  title: string;
  body: string;
}) {
  const tones = {
    rose: "border-rose-100 bg-rose-50/60 hover:bg-rose-50",
    amber: "border-amber-100 bg-amber-50/60 hover:bg-amber-50",
    emerald: "border-emerald-100 bg-emerald-50/60 hover:bg-emerald-50",
    violet: "border-violet-100 bg-violet-50/60 hover:bg-violet-50",
  } as const;
  const icons = {
    rose: "bg-rose-100 text-rose-700",
    amber: "bg-amber-100 text-amber-700",
    emerald: "bg-emerald-100 text-emerald-700",
    violet: "bg-violet-100 text-violet-700",
  } as const;

  return (
    <a
      href={href}
      className={`flex items-start gap-3 rounded-2xl border p-3.5 transition ${tones[tone]}`}
    >
      <div
        className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-sm ${icons[tone]}`}
        aria-hidden
      >
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-black text-slate-900">{title}</div>
        <div className="mt-1 text-xs leading-5 text-slate-600">{body}</div>
      </div>
      <span className="mt-1 text-slate-400" aria-hidden>
        →
      </span>
    </a>
  );
}

function DriversPanel({ drivers }: { drivers: MarketplaceSlice[] }) {
  const [mode, setMode] = useState<"revenue" | "profit" | "margin">("revenue");
  const rows = useMemo(() => {
    return drivers.map((d) => {
      const value =
        mode === "revenue"
          ? d.revenue
          : mode === "profit"
            ? d.profit
            : d.marginPercent;
      return { ...d, value };
    });
  }, [drivers, mode]);

  const maxAbs =
    mode === "margin"
      ? Math.max(
          1,
          ...rows.map((r) =>
            r.value == null || !Number.isFinite(r.value)
              ? 0
              : Math.abs(Number(r.value)),
          ),
        )
      : Math.max(
          1,
          ...rows.map((r) => Math.abs(Number(r.value ?? 0))),
        );

  const totalPositive =
    mode === "margin"
      ? null
      : rows.reduce((s, r) => s + Math.max(0, Number(r.value ?? 0)), 0);

  return (
    <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-black text-slate-900">
            Драйверы прибыли
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            Вклад маркетплейсов в выручку и чистую прибыль
          </p>
        </div>
        <div
          className="inline-flex rounded-xl bg-slate-100 p-1 text-xs font-bold"
          role="tablist"
          aria-label="Метрика драйверов"
        >
          {(
            [
              ["revenue", "Выручка"],
              ["profit", "Прибыль"],
              ["margin", "Маржа"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={mode === key}
              onClick={() => setMode(key)}
              className={`rounded-lg px-3 py-1.5 transition ${
                mode === key
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-500 hover:text-slate-800"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-5 space-y-4">
        {rows.map((row) => {
          const numeric = Number(row.value ?? 0);
          const widthPct =
            mode === "margin"
              ? Math.min(100, (Math.abs(numeric) / maxAbs) * 100)
              : Math.min(100, (Math.abs(numeric) / maxAbs) * 100);
          const share =
            mode !== "margin" && totalPositive && totalPositive > 0 && numeric > 0
              ? (numeric / totalPositive) * 100
              : null;
          const barColor =
            numeric < 0
              ? "bg-rose-400"
              : row.marketplace === "WB"
                ? "bg-violet-500"
                : "bg-sky-500";

          return (
            <div key={row.marketplace}>
              <div className="mb-1.5 flex items-center justify-between gap-3 text-sm">
                <span className="font-bold text-slate-800">
                  {row.marketplace === "WB" ? "Wildberries" : "Ozon"}
                </span>
                <span className="font-black text-slate-900">
                  {mode === "margin"
                    ? formatPercent(row.value as number | null)
                    : formatMoney(numeric)}
                  {share != null ? (
                    <span className="ml-2 text-xs font-semibold text-slate-500">
                      ({share.toFixed(1)}%)
                    </span>
                  ) : null}
                </span>
              </div>
              <div className="h-2.5 overflow-hidden rounded-full bg-slate-100">
                <div
                  className={`h-full rounded-full ${barColor}`}
                  style={{ width: `${widthPct}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
      {mode === "margin" ? (
        <p className="mt-4 text-[11px] leading-4 text-slate-500">
          Режим «Маржа» сравнивает проценты по МП отдельно — без суммирования
          долей в 100%.
        </p>
      ) : null}
    </section>
  );
}

function ProblemsPanel({
  problems,
}: {
  problems: InsightsPayload["problems"];
}) {
  const items = [
    {
      label: "Убыточные SKU",
      value: problems.lossSkuCount,
      color: "bg-rose-500",
    },
    {
      label: "Маржа ниже 5%",
      value: problems.lowMarginSkuCount,
      color: "bg-amber-500",
    },
    {
      label: "Без движения",
      value: problems.noMovementSkuCount,
      color: "bg-violet-500",
    },
    {
      label: "Избыточные остатки",
      value: problems.excessStockSkuCount,
      color: "bg-sky-500",
    },
  ];
  const max = Math.max(
    1,
    ...items.map((i) => (i.value == null ? 0 : i.value)),
  );

  return (
    <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm">
      <div>
        <h2 className="text-lg font-black text-slate-900">
          Структура проблем
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          Независимые индикаторы (категории могут пересекаться)
        </p>
      </div>

      <div className="mt-5 grid gap-5 sm:grid-cols-[140px_1fr] sm:items-center">
        <div className="relative mx-auto flex h-32 w-32 items-center justify-center">
          <div
            className="absolute inset-0 rounded-full"
            style={{
              background: `conic-gradient(#6366f1 0 ${(problems.uniqueProblemSkuCount > 0 ? 72 : 12)}%, #e2e8f0 0)`,
            }}
            aria-hidden
          />
          <div className="absolute inset-3 flex flex-col items-center justify-center rounded-full bg-white text-center shadow-inner">
            <div className="text-2xl font-black text-slate-900">
              {formatNumber(problems.uniqueProblemSkuCount)}
            </div>
            <div className="px-2 text-[10px] font-semibold leading-3 text-slate-500">
              уникальных проблемных SKU
            </div>
          </div>
        </div>

        <div className="space-y-3">
          {items.map((item) => (
            <div key={item.label}>
              <div className="mb-1 flex items-center justify-between text-xs font-bold text-slate-700">
                <span className="flex items-center gap-2">
                  <span
                    className={`inline-block h-2.5 w-2.5 rounded-full ${item.color}`}
                  />
                  {item.label}
                </span>
                <span>{item.value == null ? "н/д" : formatNumber(item.value)}</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                <div
                  className={`h-full rounded-full ${item.color}`}
                  style={{
                    width:
                      item.value == null
                        ? "0%"
                        : `${Math.min(100, (item.value / max) * 100)}%`,
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function SkuRankTable({
  id,
  title,
  rows,
  allRows,
  emptyText,
  tone,
}: {
  id: string;
  title: string;
  rows: InsightSkuRow[];
  allRows: InsightSkuRow[];
  emptyText: string;
  tone: "profit" | "loss";
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? allRows : rows;

  return (
    <section
      id={id}
      className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-sm"
    >
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <h2 className="text-base font-black text-slate-900">{title}</h2>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-xs font-bold text-violet-700 hover:underline"
        >
          {expanded ? "Свернуть" : "Смотреть все →"}
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-slate-50 text-left text-[11px] font-bold uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">#</th>
              <th className="px-2 py-3">Артикул</th>
              <th className="px-2 py-3">МП</th>
              <th className="px-2 py-3 text-right">Выручка</th>
              <th className="px-2 py-3 text-right">Прибыль</th>
              <th className="px-4 py-3 text-right">Маржа</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row, index) => (
              <tr
                key={`${row.companyName}-${row.marketplace}-${row.sku}-${row.vendorCode}-${index}`}
                className="border-t border-slate-100"
              >
                <td className="px-4 py-2.5 text-xs font-bold text-slate-400">
                  {index + 1}
                </td>
                <td className="px-2 py-2.5">
                  <div className="flex items-center gap-2">
                    <SkuThumb marketplace={row.marketplace} />
                    <div className="min-w-0">
                      <div className="truncate font-bold text-slate-900">
                        {row.vendorCode || row.sku || "—"}
                      </div>
                      <div className="truncate text-[11px] text-slate-500">
                        {row.companyName}
                        {row.anomaly !== "NONE" ? (
                          <span className="ml-1 rounded bg-amber-100 px-1 font-semibold text-amber-800">
                            без продаж
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </td>
                <td className="px-2 py-2.5 font-semibold text-slate-700">
                  {row.marketplace}
                </td>
                <td className="px-2 py-2.5 text-right tabular-nums">
                  {formatMoney(row.revenue)}
                </td>
                <td
                  className={`px-2 py-2.5 text-right font-bold tabular-nums ${moneyClass(row.profit)}`}
                >
                  {formatMoney(row.profit)}
                </td>
                <td
                  className={`px-4 py-2.5 text-right font-bold tabular-nums ${
                    row.marginPercent == null
                      ? "text-slate-400"
                      : tone === "loss" || (row.marginPercent ?? 0) < 0
                        ? "text-rose-600"
                        : "text-emerald-600"
                  }`}
                >
                  {formatPercent(row.marginPercent)}
                </td>
              </tr>
            ))}
            {visible.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-4 py-8 text-center text-sm text-slate-500"
                >
                  {emptyText}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function LowMarginTable({
  rows,
  allRows,
}: {
  rows: InsightSkuRow[];
  allRows: InsightSkuRow[];
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? allRows : rows;
  return (
    <section
      id="risk-margin"
      className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-sm"
    >
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <h2 className="text-base font-black text-slate-900">
          Зона риска: маржа ниже 5%
        </h2>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-xs font-bold text-violet-700 hover:underline"
        >
          {expanded ? "Свернуть" : "Смотреть все →"}
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="bg-slate-50 text-left text-[11px] font-bold uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">#</th>
              <th className="px-2 py-3">Артикул</th>
              <th className="px-2 py-3">МП</th>
              <th className="px-2 py-3 text-right">Продажи</th>
              <th className="px-2 py-3 text-right">Выручка</th>
              <th className="px-2 py-3 text-right">Прибыль</th>
              <th className="px-4 py-3 text-right">Маржа</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row, index) => (
              <tr
                key={`lm-${row.companyName}-${row.marketplace}-${row.vendorCode}-${index}`}
                className="border-t border-slate-100"
              >
                <td className="px-4 py-2.5 text-xs font-bold text-slate-400">
                  {index + 1}
                </td>
                <td className="px-2 py-2.5">
                  <div className="flex items-center gap-2">
                    <SkuThumb marketplace={row.marketplace} />
                    <div>
                      <div className="font-bold text-slate-900">
                        {row.vendorCode || row.sku || "—"}
                      </div>
                      <div className="text-[11px] text-slate-500">
                        {row.companyName}
                      </div>
                    </div>
                  </div>
                </td>
                <td className="px-2 py-2.5 font-semibold">{row.marketplace}</td>
                <td className="px-2 py-2.5 text-right tabular-nums">
                  {formatNumber(row.salesQty)}
                </td>
                <td className="px-2 py-2.5 text-right tabular-nums">
                  {formatMoney(row.revenue)}
                </td>
                <td
                  className={`px-2 py-2.5 text-right font-bold tabular-nums ${moneyClass(row.profit)}`}
                >
                  {formatMoney(row.profit)}
                </td>
                <td className="px-4 py-2.5 text-right font-bold tabular-nums text-amber-600">
                  {formatPercent(row.marginPercent)}
                </td>
              </tr>
            ))}
            {visible.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-4 py-8 text-center text-sm text-slate-500"
                >
                  SKU с маржой ниже 5% не найдены.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function FrozenTable({
  rows,
  allRows,
  asOfLabel,
  partial,
}: {
  rows: InsightStockRow[];
  allRows: InsightStockRow[];
  asOfLabel: string;
  partial: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? allRows : rows;
  return (
    <section
      id="frozen-stock"
      className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-sm"
    >
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <div>
          <h2 className="text-base font-black text-slate-900">
            Замороженные деньги в остатках
          </h2>
          <p className="mt-1 text-[11px] text-slate-500">
            Срез: {asOfLabel}
            {partial ? " · покрытие себестоимости частичное" : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-xs font-bold text-violet-700 hover:underline"
        >
          {expanded ? "Свернуть" : "Смотреть все →"}
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="bg-slate-50 text-left text-[11px] font-bold uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">#</th>
              <th className="px-2 py-3">Артикул</th>
              <th className="px-2 py-3">МП</th>
              <th className="px-2 py-3 text-right">Остаток</th>
              <th className="px-2 py-3 text-right">Себестоимость</th>
              <th className="px-4 py-3 text-right">Заморожено</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row, index) => (
              <tr
                key={`fz-${row.companyName}-${row.marketplace}-${row.vendorCode}-${index}`}
                className="border-t border-slate-100"
              >
                <td className="px-4 py-2.5 text-xs font-bold text-slate-400">
                  {index + 1}
                </td>
                <td className="px-2 py-2.5">
                  <div className="flex items-center gap-2">
                    <SkuThumb marketplace={row.marketplace} />
                    <div>
                      <div className="font-bold text-slate-900">
                        {row.vendorCode || row.sku || "—"}
                      </div>
                      <div className="text-[11px] text-slate-500">
                        {row.companyName}
                      </div>
                    </div>
                  </div>
                </td>
                <td className="px-2 py-2.5 font-semibold">{row.marketplace}</td>
                <td className="px-2 py-2.5 text-right tabular-nums">
                  {formatNumber(row.quantity)}
                </td>
                <td className="px-2 py-2.5 text-right tabular-nums">
                  {row.unitCost == null ? "н/д" : formatMoney(row.unitCost)}
                </td>
                <td className="px-4 py-2.5 text-right font-bold tabular-nums text-rose-600">
                  {row.frozenMoney == null
                    ? "н/д"
                    : formatMoney(row.frozenMoney)}
                </td>
              </tr>
            ))}
            {visible.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-4 py-8 text-center text-sm text-slate-500"
                >
                  Нет данных по остаткам с известной себестоимостью.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function InsightsDashboard({ data }: { data: InsightsPayload }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const marginTip =
    data.kpi.netMarginPercent != null && data.kpi.netMarginPercent > 100
      ? "Проверьте состав выручки и распределённых корректировок"
      : undefined;

  return (
    <main className="min-h-screen bg-[#eef2f7] p-4 sm:p-5 lg:p-6">
      <div className="mx-auto max-w-[1480px] space-y-4">
        <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h1 className="text-3xl font-black tracking-tight text-slate-950 sm:text-[2rem]">
              Центр прибыли / Insights 2.0
            </h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">
              Быстрый управленческий обзор: где бизнес зарабатывает, где теряет
              деньги и какие товары требуют внимания.
            </p>
            {data.dataModes.length > 0 ? (
              <p className="mt-2 text-xs font-semibold text-amber-700">
                Режим данных: {data.dataModes.join(", ")}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 shadow-sm">
              Последнее обновление{" "}
              <span className="text-slate-900">{data.generatedAtLabel}</span>
            </div>
            <button
              type="button"
              disabled={pending}
              onClick={() => startTransition(() => router.refresh())}
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-black text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:opacity-60"
            >
              {pending ? "Обновление…" : "Обновить"}
            </button>
          </div>
        </header>

        <form className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-sm">
          <div className="grid gap-3 md:grid-cols-[1.2fr_1fr_1fr_auto] md:items-end">
            <label className="block">
              <span className="text-xs font-bold text-slate-500">Компания</span>
              <select
                name="company"
                defaultValue={data.company}
                className="mt-1.5 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm font-bold text-slate-800 outline-none focus:border-slate-400 focus:bg-white"
              >
                <option value="ALL">Все компании</option>
                {data.companies.map((c) => (
                  <option key={c.id} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-bold text-slate-500">Дата от</span>
              <input
                type="date"
                name="dateFrom"
                defaultValue={data.dateFrom}
                className="mt-1.5 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm font-bold text-slate-800 outline-none focus:border-slate-400 focus:bg-white"
              />
            </label>
            <label className="block">
              <span className="text-xs font-bold text-slate-500">Дата до</span>
              <input
                type="date"
                name="dateTo"
                defaultValue={data.dateTo}
                className="mt-1.5 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm font-bold text-slate-800 outline-none focus:border-slate-400 focus:bg-white"
              />
            </label>
            <button className="rounded-xl bg-[#0f1c3f] px-5 py-2.5 text-sm font-black text-white shadow-md shadow-slate-300 transition hover:bg-[#182752]">
              Применить
            </button>
          </div>
          <p className="mt-2 text-[11px] text-slate-400">
            Период: {formatDateRu(data.dateFrom)} — {formatDateRu(data.dateTo)}
          </p>
        </form>

        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <KpiCard
            title="Выручка"
            value={formatMoney(data.kpi.revenue)}
            accent="blue"
            icon="₽"
            tip="База Insights: поле revenue SKU-аналитики WB+Ozon (как на прежней странице)."
          />
          <KpiCard
            title="Чистая прибыль"
            value={formatMoney(data.kpi.netProfit)}
            accent="green"
            icon="↑"
          />
          <KpiCard
            title="Чистая маржа"
            value={formatPercent(data.kpi.netMarginPercent)}
            accent="violet"
            icon="%"
            subtitle={marginTip}
            tip={marginTip}
          />
          <KpiCard
            title="Убыточные SKU"
            value={formatNumber(data.kpi.lossSkuCount)}
            accent="red"
            icon="!"
          />
          <KpiCard
            title="Заморожено в остатках"
            value={formatMoney(data.kpi.frozenMoney)}
            accent="purple"
            icon="▣"
            subtitle={
              data.kpi.frozenCoveragePartial
                ? `Срез ${data.kpi.frozenAsOfLabel} · COGS частично`
                : `Срез ${data.kpi.frozenAsOfLabel}`
            }
          />
        </section>

        <section className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-sm sm:p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-base font-black text-slate-900">
              Что требует внимания сегодня
            </h2>
            <a
              href="#loss-sku"
              className="text-xs font-bold text-violet-700 hover:underline"
            >
              Смотреть все рекомендации
            </a>
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <AttentionCard
              href="#loss-sku"
              icon="↓"
              tone="rose"
              title={`${formatNumber(data.attention.lossSkuCount)} убыточных SKU`}
              body="Проверить рекламу и цены"
            />
            <AttentionCard
              href="#risk-margin"
              icon="%"
              tone="amber"
              title={`${formatNumber(data.attention.lowMarginSkuCount)} SKU с маржой ниже 5%`}
              body="Зона риска — требуется анализ"
            />
            <AttentionCard
              href="#profit-sku"
              icon="↑"
              tone="emerald"
              title="ТОП прибыльных SKU"
              body={`${formatNumber(data.attention.profitableSkuCount)} позиций — изучить масштабирование`}
            />
            <AttentionCard
              href="#frozen-stock"
              icon="▣"
              tone="violet"
              title={`Заморожено ${formatMoney(data.attention.frozenMoney)}`}
              body="Проверить залежавшиеся SKU"
            />
          </div>
        </section>

        <section className="grid gap-4 xl:grid-cols-2">
          <DriversPanel drivers={data.drivers} />
          <ProblemsPanel problems={data.problems} />
        </section>

        <section className="grid gap-4 xl:grid-cols-2">
          <SkuRankTable
            id="profit-sku"
            title="ТОП-10 прибыльных SKU"
            rows={data.profitablePreview}
            allRows={data.profitableAll}
            emptyText="Прибыльных SKU с продажами не найдено."
            tone="profit"
          />
          <SkuRankTable
            id="loss-sku"
            title="ТОП-10 убыточных SKU"
            rows={data.lossPreview}
            allRows={data.lossAll}
            emptyText="Убыточных SKU не найдено."
            tone="loss"
          />
        </section>

        {data.adjustments.length > 0 ? (
          <section className="rounded-2xl border border-amber-200 bg-amber-50/50 p-4 shadow-sm">
            <h2 className="text-sm font-black text-amber-900">
              Прибыль/расходы без продаж — корректировки
            </h2>
            <p className="mt-1 text-xs text-amber-800">
              Строки с выручкой 0 и ненулевой прибылью не входят в ТОП как
              «лидеры продаж»; суммы сохранены в общих KPI.
            </p>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead className="text-left text-[11px] font-bold uppercase text-amber-800/80">
                  <tr>
                    <th className="py-2">Артикул</th>
                    <th className="py-2">МП</th>
                    <th className="py-2 text-right">Прибыль</th>
                    <th className="py-2 text-right">Маржа</th>
                  </tr>
                </thead>
                <tbody>
                  {data.adjustments.slice(0, 10).map((row, i) => (
                    <tr
                      key={`adj-${i}-${row.vendorCode}`}
                      className="border-t border-amber-100"
                    >
                      <td className="py-2 font-semibold">
                        {row.vendorCode || row.sku} · {row.companyName}
                      </td>
                      <td className="py-2">{row.marketplace}</td>
                      <td
                        className={`py-2 text-right font-bold ${moneyClass(row.profit)}`}
                      >
                        {formatMoney(row.profit)}
                      </td>
                      <td className="py-2 text-right text-slate-500">н/д</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        <section className="grid gap-4 xl:grid-cols-2">
          <LowMarginTable
            rows={data.lowMarginPreview}
            allRows={data.lowMarginAll}
          />
          <FrozenTable
            rows={data.frozenPreview}
            allRows={data.frozenAll}
            asOfLabel={data.kpi.frozenAsOfLabel}
            partial={data.kpi.frozenCoveragePartial}
          />
        </section>

        <p className="pb-4 text-center text-[11px] text-slate-400">
          Источники: getProfitAnalytics / getProfitAnalyticsOzon · ProductCost ·
          wbStock / ozonStock. Финансовые формулы не изменялись.
        </p>
      </div>
    </main>
  );
}
