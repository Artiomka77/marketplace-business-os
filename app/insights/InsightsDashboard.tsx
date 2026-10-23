"use client";

import { useState, useTransition } from "react";
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

function RankBadge({ n }: { n: number }) {
  const tone =
    n === 1
      ? "bg-amber-400 text-amber-950"
      : n === 2
        ? "bg-slate-300 text-slate-800"
        : n === 3
          ? "bg-orange-300 text-orange-950"
          : "bg-slate-100 text-slate-500";
  return (
    <span
      className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-black ${tone}`}
    >
      {n}
    </span>
  );
}

function SkuThumb({
  marketplace,
  imageUrl,
}: {
  marketplace: string;
  imageUrl?: string | null;
}) {
  const [failed, setFailed] = useState(false);
  const showImg = Boolean(imageUrl) && !failed;

  if (showImg) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={imageUrl!}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className="h-8 w-8 shrink-0 rounded-md border border-slate-200 object-cover bg-white"
      />
    );
  }
  return (
    <div
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[9px] font-black ${
        marketplace === "WB"
          ? "bg-violet-100 text-violet-700"
          : "bg-sky-100 text-sky-700"
      }`}
      aria-hidden
      title="Нет фото"
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
    blue: "border-sky-100/90 bg-white",
    green: "border-emerald-100/90 bg-white",
    violet: "border-violet-100/90 bg-white",
    red: "border-rose-100/90 bg-white",
    purple: "border-fuchsia-100/90 bg-white",
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
      className={`rounded-xl border px-3 py-2.5 shadow-sm ${accents[accent]}`}
      title={tip}
    >
      <div className="flex items-start justify-between gap-1.5">
        <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">
          {title}
        </div>
        <div
          className={`flex h-6 w-6 items-center justify-center rounded-lg text-[11px] ${iconBg[accent]}`}
          aria-hidden
        >
          {icon}
        </div>
      </div>
      <div className="mt-1.5 text-lg font-black tracking-tight text-slate-900 tabular-nums sm:text-xl">
        {value}
      </div>
      <div className="mt-1 text-[10px] font-semibold leading-3 text-slate-500">
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
    rose: "border-rose-100 bg-rose-50/70 hover:bg-rose-50",
    amber: "border-amber-100 bg-amber-50/70 hover:bg-amber-50",
    emerald: "border-emerald-100 bg-emerald-50/70 hover:bg-emerald-50",
    violet: "border-violet-100 bg-violet-50/70 hover:bg-violet-50",
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
      className={`flex items-center gap-2 rounded-xl border px-2.5 py-2 transition ${tones[tone]}`}
    >
      <div
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-xs ${icons[tone]}`}
        aria-hidden
      >
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-black text-slate-900">{title}</div>
        <div className="truncate text-[10px] leading-3 text-slate-600">{body}</div>
      </div>
      <span className="text-slate-400" aria-hidden>
        →
      </span>
    </a>
  );
}

function DriversPanel({ drivers }: { drivers: MarketplaceSlice[] }) {
  const [mode, setMode] = useState<"revenue" | "profit" | "margin">("revenue");

  const primaryValue = (d: MarketplaceSlice) => {
    if (mode === "revenue") return d.economicTurnover;
    if (mode === "profit") return d.marketplaceNetProfit;
    return d.marginPercent;
  };

  const maxAbs = Math.max(
    1,
    ...drivers.map((d) => {
      const v = primaryValue(d);
      return v == null || !Number.isFinite(v) ? 0 : Math.abs(Number(v));
    }),
    ...drivers.map((d) =>
      mode === "profit" ? Math.abs(d.adjustmentProfit) : 0,
    ),
  );

  const totalPositiveRevenue = drivers.reduce(
    (s, d) => s + Math.max(0, d.economicTurnover ?? 0),
    0,
  );
  const totalPositiveSoldProfit = drivers.reduce(
    (s, d) => s + Math.max(0, d.marketplaceNetProfit ?? 0),
    0,
  );

  return (
    <section className="rounded-xl border border-slate-200/80 bg-white p-3 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-black text-slate-900">Драйверы прибыли</h2>
          <p className="text-[10px] text-slate-500">
            {mode === "revenue"
              ? "Экономический оборот WB + Ozon (управленческий)"
              : mode === "profit"
                ? "Прибыль МП после налога; корректировки SKU — отдельно"
                : "Рентабельность МП = прибыль МП / экономический оборот"}
          </p>
        </div>
        <div
          className="inline-flex rounded-lg bg-slate-100 p-0.5 text-[10px] font-bold"
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
              className={`rounded-md px-2 py-1 transition ${
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

      <div className="mt-3 space-y-2.5">
        {drivers.map((row) => {
          const numeric = Number(primaryValue(row) ?? 0);
          const widthPct = Math.min(100, (Math.abs(numeric) / maxAbs) * 100);
          const adjWidth =
            mode === "profit"
              ? Math.min(100, (Math.abs(row.adjustmentProfit) / maxAbs) * 100)
              : 0;
          const shareBase =
            mode === "revenue"
              ? totalPositiveRevenue
              : mode === "profit"
                ? totalPositiveSoldProfit
                : null;
          const share =
            shareBase != null && shareBase > 0 && numeric > 0
              ? (numeric / shareBase) * 100
              : null;
          const barColor =
            numeric < 0
              ? "bg-rose-400"
              : row.marketplace === "WB"
                ? "bg-violet-500"
                : "bg-sky-500";

          return (
            <div key={row.marketplace} data-driver={row.marketplace} data-mode={mode}>
              <div className="mb-1 flex items-center justify-between gap-2 text-xs">
                <span className="font-bold text-slate-800">
                  {row.marketplace === "WB" ? "Wildberries" : "Ozon"}
                </span>
                <span className="font-black tabular-nums text-slate-900">
                  {mode === "margin"
                    ? formatPercent(row.marginPercent)
                    : mode === "profit"
                      ? formatMoney(row.marketplaceNetProfit)
                      : formatMoney(row.economicTurnover)}
                  {share != null ? (
                    <span className="ml-1.5 text-[10px] font-semibold text-slate-500">
                      ({share.toFixed(1)}%)
                    </span>
                  ) : null}
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                <div
                  className={`h-full rounded-full ${barColor}`}
                  style={{ width: `${widthPct}%` }}
                  data-bar="primary"
                />
              </div>
              {mode === "profit" && row.adjustmentSkuCount > 0 ? (
                <div className="mt-1">
                  <div className="mb-0.5 flex items-center justify-between text-[10px] font-semibold text-amber-800">
                    <span>Корректировки без продаж (SKU)</span>
                    <span className={moneyClass(row.adjustmentProfit)}>
                      {formatMoney(row.adjustmentProfit)} ·{" "}
                      {formatNumber(row.adjustmentSkuCount)} поз.
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-amber-100">
                    <div
                      className={`h-full rounded-full ${
                        row.adjustmentProfit < 0 ? "bg-rose-400" : "bg-amber-400"
                      }`}
                      style={{ width: `${adjWidth}%` }}
                      data-bar="adjustments"
                    />
                  </div>
                  <p className="mt-0.5 text-[9px] leading-3 text-amber-800/80">
                    Не продажи недели и не выручка. Уже входят в прибыль МП
                    выше, если канон их учёл; здесь — прозрачный SKU-слой.
                  </p>
                </div>
              ) : null}
              {mode === "revenue" &&
              (row.economicTurnover ?? 0) === 0 &&
              row.adjustmentSkuCount > 0 ? (
                <p className="mt-1 text-[10px] leading-3 text-amber-700">
                  Экономический оборот 0 ₽ — есть корректировки без продаж (
                  {formatNumber(row.adjustmentSkuCount)} поз.,{" "}
                  <span className={moneyClass(row.adjustmentProfit)}>
                    {formatMoney(row.adjustmentProfit)}
                  </span>
                  ). Это не выручка. Смотрите режим «Прибыль».
                </p>
              ) : null}
              {mode === "revenue" && (row.economicTurnover ?? 0) > 0 ? (
                <p className="mt-1 text-[9px] leading-3 text-slate-500">
                  Атрибуция по товарам: {formatMoney(row.skuRevenue)}
                  {row.skuRevenue !== (row.economicTurnover ?? 0)
                    ? " (может отличаться от управленческого оборота)"
                    : null}
                </p>
              ) : null}
              {mode === "margin" &&
              !(row.economicTurnover != null && row.economicTurnover > 0) ? (
                <p className="mt-1 text-[10px] leading-3 text-slate-500">
                  Рентабельность н/д: нет экономического оборота за период.
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
      {mode === "margin" ? (
        <p className="mt-2 text-[10px] leading-3 text-slate-500">
          «Маржа» сравнивает % по МП отдельно — без суммирования долей в 100%.
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
      label: "Маржа 0–5%",
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
  const max = Math.max(1, ...items.map((i) => (i.value == null ? 0 : i.value)));

  return (
    <section className="rounded-xl border border-slate-200/80 bg-white p-3 shadow-sm">
      <div>
        <h2 className="text-sm font-black text-slate-900">Структура проблем</h2>
        <p className="text-[10px] text-slate-500">
          Независимые индикаторы · категории могут пересекаться · без ложных %
        </p>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-[108px_1fr] sm:items-center">
        <div className="relative mx-auto flex h-24 w-24 items-center justify-center">
          <div
            className="absolute inset-0 rounded-full"
            style={{
              background: `conic-gradient(#6366f1 0 ${
                (problems.uniqueProblemSkuCount ?? 0) > 0 ? 70 : 10
              }%, #e2e8f0 0)`,
            }}
            aria-hidden
          />
          <div className="absolute inset-2.5 flex flex-col items-center justify-center rounded-full bg-white text-center">
            <div className="text-xl font-black text-slate-900">
              {formatNumber(problems.uniqueProblemSkuCount)}
            </div>
            <div className="px-1 text-[9px] font-semibold leading-2.5 text-slate-500">
              уникальных
            </div>
          </div>
        </div>

        <div className="space-y-1.5">
          {items.map((item) => (
            <div key={item.label}>
              <div className="mb-0.5 flex items-center justify-between text-[10px] font-bold text-slate-700">
                <span className="flex items-center gap-1.5">
                  <span
                    className={`inline-block h-2 w-2 rounded-full ${item.color}`}
                  />
                  {item.label}
                </span>
                <span>
                  {item.value == null ? "н/д" : formatNumber(item.value)}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
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

function SizeCell({ row }: { row: InsightSkuRow }) {
  const [open, setOpen] = useState(false);
  const hasParts = row.sizeParts.length > 0;
  return (
    <div className="min-w-0">
      <button
        type="button"
        disabled={!hasParts}
        onClick={() => setOpen((v) => !v)}
        className={`truncate text-left text-[10px] font-semibold ${
          hasParts
            ? "text-violet-700 hover:underline"
            : "cursor-default text-slate-600"
        }`}
        title={
          row.sizeStatus === "FAMILY_ALL"
            ? "Прибыль на уровне артикула (все размеры)"
            : row.sizeStatus === "UNKNOWN"
              ? "Размер не подтверждён"
              : undefined
        }
      >
        {row.sizeLabel}
        {hasParts ? (open ? " ▴" : " ▾") : null}
      </button>
      {open && hasParts ? (
        <ul className="mt-1 max-h-28 space-y-0.5 overflow-y-auto rounded border border-slate-100 bg-slate-50 p-1 text-[9px] text-slate-600">
          {row.sizeParts.map((p, i) => (
            <li
              key={`${p.sizeLabel}-${i}`}
              className="flex justify-between gap-1 tabular-nums"
            >
              <span className="font-bold text-slate-800">{p.sizeLabel}</span>
              <span>
                {p.salesQty != null ? `${formatNumber(p.salesQty)} шт` : "н/д"}
                {p.profit != null ? ` · ${formatMoney(p.profit)}` : " · P&L н/д"}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
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
      className="overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-sm"
    >
      <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-3 py-2">
        <h2 className="text-sm font-black text-slate-900">{title}</h2>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-[10px] font-bold text-violet-700 hover:underline"
        >
          {expanded ? "Свернуть" : "Смотреть все →"}
        </button>
      </div>
      <div className="overflow-x-auto lg:overflow-x-visible">
        <table className="w-full min-w-[560px] text-xs lg:min-w-0 lg:table-fixed">
          <thead className="bg-slate-50 text-left text-[9px] font-bold uppercase tracking-wide text-slate-500">
            <tr>
              <th className="w-8 px-2 py-1.5">#</th>
              <th className="px-1.5 py-1.5">Артикул</th>
              <th className="w-16 px-1 py-1.5">Размер</th>
              <th className="w-10 px-1 py-1.5">МП</th>
              <th className="w-[15%] px-1 py-1.5 text-right">Выручка</th>
              <th className="w-[15%] px-1 py-1.5 text-right">Прибыль</th>
              <th className="w-14 px-2 py-1.5 text-right">Маржа</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row, index) => (
              <tr
                key={`${row.companyName}-${row.marketplace}-${row.sku}-${row.vendorCode}-${index}`}
                className="border-t border-slate-100"
              >
                <td className="px-2.5 py-1.5">
                  <RankBadge n={index + 1} />
                </td>
                <td className="px-1.5 py-1.5">
                  <div className="flex items-center gap-1.5">
                    <SkuThumb
                      marketplace={row.marketplace}
                      imageUrl={row.imageUrl}
                    />
                    <div className="min-w-0">
                      <div className="truncate font-bold text-slate-900">
                        {row.vendorCode || row.sku || "—"}
                      </div>
                      <div className="truncate text-[9px] text-slate-500">
                        {row.companyName}
                      </div>
                    </div>
                  </div>
                </td>
                <td className="px-1 py-1.5 align-top">
                  <SizeCell row={row} />
                </td>
                <td className="px-1.5 py-1.5 font-semibold text-slate-700">
                  {row.marketplace}
                </td>
                <td className="px-1.5 py-1.5 text-right tabular-nums">
                  {formatMoney(row.revenue)}
                </td>
                <td
                  className={`px-1.5 py-1.5 text-right font-bold tabular-nums ${moneyClass(row.profit)}`}
                >
                  {formatMoney(row.profit)}
                </td>
                <td
                  className={`px-2.5 py-1.5 text-right font-bold tabular-nums ${
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
                  colSpan={7}
                  className="px-3 py-5 text-center text-xs text-slate-500"
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

function AdjustmentsStrip({
  summary,
  rows,
}: {
  summary: InsightsPayload["adjustmentSummary"];
  rows: InsightSkuRow[];
}) {
  const [open, setOpen] = useState(false);
  if (summary.skuCount <= 0) return null;

  return (
    <section
      id="adjustments"
      className="rounded-xl border border-amber-200 bg-amber-50/60 px-3 py-2 shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-black text-amber-950">
            Корректировки без продаж
          </div>
          <div className="text-[10px] text-amber-800">
            {formatNumber(summary.skuCount)} позиций · сумма{" "}
            <span className={`font-bold ${moneyClass(summary.profitSum)}`}>
              {formatMoney(summary.profitSum)}
            </span>
            {" · "}не продажи недели; в главных KPI бизнеса не подменяют оборот
          </div>
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="rounded-lg border border-amber-300 bg-white px-2.5 py-1 text-[10px] font-bold text-amber-900 hover:bg-amber-50"
        >
          {open ? "Скрыть детали" : "Посмотреть детали"}
        </button>
      </div>
      {open ? (
        <div className="mt-2 overflow-x-auto rounded-lg border border-amber-100 bg-white">
          <table className="w-full min-w-[480px] text-xs">
            <thead className="bg-amber-50/80 text-left text-[9px] font-bold uppercase text-amber-900/80">
              <tr>
                <th className="px-2 py-1.5">Артикул</th>
                <th className="px-2 py-1.5">МП</th>
                <th className="px-2 py-1.5 text-right">Прибыль</th>
                <th className="px-2 py-1.5">Тип</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr
                  key={`adj-${i}-${row.vendorCode}`}
                  className="border-t border-amber-50"
                >
                  <td className="px-2 py-1.5 font-semibold">
                    {row.vendorCode || row.sku} · {row.companyName}
                  </td>
                  <td className="px-2 py-1.5">{row.marketplace}</td>
                  <td
                    className={`px-2 py-1.5 text-right font-bold ${moneyClass(row.profit)}`}
                  >
                    {formatMoney(row.profit)}
                  </td>
                  <td className="px-2 py-1.5 text-[10px] text-slate-500">
                    {row.anomaly === "PROFIT_WITHOUT_REVENUE"
                      ? "прибыль без выручки"
                      : "убыток без выручки"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
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
      className="overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-sm"
    >
      <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-3 py-2">
        <div>
          <h2 className="text-sm font-black text-slate-900">
            Зона риска: маржа 0–5%
          </h2>
          <p className="text-[9px] text-slate-500">
            Только положительная маржа ниже 5% · убыточные — в ТОП убыточных
          </p>
        </div>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-[10px] font-bold text-violet-700 hover:underline"
        >
          {expanded ? "Свернуть" : "Смотреть все →"}
        </button>
      </div>
      <div className="overflow-x-auto lg:overflow-x-visible">
        <table className="w-full min-w-[520px] text-xs lg:min-w-0 lg:table-fixed">
          <thead className="bg-slate-50 text-left text-[9px] font-bold uppercase tracking-wide text-slate-500">
            <tr>
              <th className="w-8 px-2 py-1.5">#</th>
              <th className="px-1.5 py-1.5">Артикул</th>
              <th className="w-16 px-1 py-1.5">Размер</th>
              <th className="w-10 px-1 py-1.5">МП</th>
              <th className="w-14 px-1 py-1.5 text-right">Прод.</th>
              <th className="w-[14%] px-1 py-1.5 text-right">Выручка</th>
              <th className="w-[14%] px-1 py-1.5 text-right">Прибыль</th>
              <th className="w-14 px-2 py-1.5 text-right">Маржа</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row, index) => (
              <tr
                key={`lm-${row.companyName}-${row.marketplace}-${row.vendorCode}-${index}`}
                className="border-t border-slate-100"
              >
                <td className="px-2.5 py-1.5">
                  <RankBadge n={index + 1} />
                </td>
                <td className="px-1.5 py-1.5">
                  <div className="flex items-center gap-1.5">
                    <SkuThumb
                      marketplace={row.marketplace}
                      imageUrl={row.imageUrl}
                    />
                    <div>
                      <div className="font-bold text-slate-900">
                        {row.vendorCode || row.sku || "—"}
                      </div>
                      <div className="text-[9px] text-slate-500">
                        {row.companyName}
                      </div>
                    </div>
                  </div>
                </td>
                <td className="px-1 py-1.5 align-top">
                  <SizeCell row={row} />
                </td>
                <td className="px-1.5 py-1.5 font-semibold">{row.marketplace}</td>
                <td className="px-1.5 py-1.5 text-right tabular-nums">
                  {formatNumber(row.salesQty)}
                </td>
                <td className="px-1.5 py-1.5 text-right tabular-nums">
                  {formatMoney(row.revenue)}
                </td>
                <td
                  className={`px-1.5 py-1.5 text-right font-bold tabular-nums ${moneyClass(row.profit)}`}
                >
                  {formatMoney(row.profit)}
                </td>
                <td className="px-2.5 py-1.5 text-right font-bold tabular-nums text-amber-600">
                  {formatPercent(row.marginPercent)}
                </td>
              </tr>
            ))}
            {visible.length === 0 ? (
              <tr>
                <td
                  colSpan={8}
                  className="px-3 py-5 text-center text-xs text-slate-500"
                >
                  SKU с положительной маржой ниже 5% не найдены.
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
  const topFrozen = Math.max(
    0,
    ...visible.map((r) => r.frozenMoney ?? 0),
  );

  return (
    <section
      id="frozen-stock"
      className="overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-sm"
    >
      <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-3 py-2">
        <div>
          <h2 className="text-sm font-black text-slate-900">
            Товарные остатки по себестоимости
          </h2>
          <p className="text-[9px] text-slate-500">
            Срез: {asOfLabel}
            {partial ? " · себестоимость частично" : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-[10px] font-bold text-violet-700 hover:underline"
        >
          {expanded ? "Свернуть" : "Смотреть все →"}
        </button>
      </div>
      <div className="overflow-x-auto lg:overflow-x-visible">
        <table className="w-full min-w-[520px] text-xs lg:min-w-0 lg:table-fixed">
          <thead className="bg-slate-50 text-left text-[9px] font-bold uppercase tracking-wide text-slate-500">
            <tr>
              <th className="w-8 px-2 py-1.5">#</th>
              <th className="px-1.5 py-1.5">Артикул</th>
              <th className="w-14 px-1 py-1.5">Размер</th>
              <th className="w-10 px-1 py-1.5">МП</th>
              <th className="w-14 px-1 py-1.5 text-right">Остаток</th>
              <th className="w-[16%] px-1 py-1.5 text-right">Себест.</th>
              <th className="w-[18%] px-2 py-1.5 text-right">На складе</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row, index) => {
              const isTop =
                topFrozen > 0 &&
                row.frozenMoney != null &&
                row.frozenMoney >= topFrozen * 0.85;
              return (
                <tr
                  key={`fz-${row.companyName}-${row.marketplace}-${row.vendorCode}-${index}`}
                  className={`border-t border-slate-100 ${
                    isTop ? "bg-rose-50/50" : ""
                  }`}
                >
                  <td className="px-2.5 py-1.5">
                    <RankBadge n={index + 1} />
                  </td>
                  <td className="px-1.5 py-1.5">
                    <div className="flex items-center gap-1.5">
                      <SkuThumb
                        marketplace={row.marketplace}
                        imageUrl={row.imageUrl}
                      />
                      <div>
                        <div className="font-bold text-slate-900">
                          {row.vendorCode || row.sku || "—"}
                        </div>
                        <div className="text-[9px] text-slate-500">
                          {row.companyName}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-1 py-1.5 text-[10px] font-semibold text-slate-700">
                    {row.sizeLabel || "н/д"}
                  </td>
                  <td className="px-1.5 py-1.5 font-semibold">
                    {row.marketplace}
                  </td>
                  <td className="px-1.5 py-1.5 text-right tabular-nums">
                    {formatNumber(row.quantity)}
                  </td>
                  <td className="px-1.5 py-1.5 text-right tabular-nums">
                    {row.unitCost == null ? "н/д" : formatMoney(row.unitCost)}
                  </td>
                  <td className="px-2.5 py-1.5 text-right font-bold tabular-nums text-rose-600">
                    {row.frozenMoney == null
                      ? "н/д"
                      : formatMoney(row.frozenMoney)}
                  </td>
                </tr>
              );
            })}
            {visible.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-3 py-5 text-center text-xs text-slate-500"
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
  const [showAllRecommendations, setShowAllRecommendations] = useState(false);
  const [showSkuDetail, setShowSkuDetail] = useState(false);
  const sku = data.kpi.skuDetail;

  const recommendationItems = [
    {
      href: "#loss-sku",
      icon: "↓",
      tone: "rose" as const,
      title:
        data.attention.lossSkuCount == null
          ? "Убыточные товары: н/д"
          : `${formatNumber(data.attention.lossSkuCount)} убыточных товаров`,
      body: "Проверить рекламу и цены",
      detail:
        "Открыть рейтинг убыточных позиций с выручкой: пересмотреть рекламу, цену и себестоимость.",
    },
    {
      href: "#risk-margin",
      icon: "%",
      tone: "amber" as const,
      title:
        data.attention.lowMarginSkuCount == null
          ? "Маржа 0–5%: н/д"
          : `${formatNumber(data.attention.lowMarginSkuCount)} товаров с маржой 0–5%`,
      body: "Зона риска — анализ",
      detail:
        "Товары в зоне тонкой маржи: проверить комиссию, логистику и себестоимость.",
    },
    {
      href: "#profit-sku",
      icon: "↑",
      tone: "emerald" as const,
      title: "ТОП прибыльных товаров",
      body:
        data.attention.profitableSkuCount == null
          ? "товарная детализация н/д"
          : `${formatNumber(data.attention.profitableSkuCount)} — масштабировать`,
      detail:
        "Прибыльные позиции с продажами: кандидаты на масштабирование остатков и рекламы.",
    },
    {
      href: "#frozen-stock",
      icon: "▣",
      tone: "violet" as const,
      title: `Остатки ${formatMoney(data.attention.stockAtCost)}`,
      body: "Проверить залежавшиеся",
      detail:
        "Оценка остатков по себестоимости: проверить оборачиваемость и позиции без продаж.",
    },
  ];

  return (
    <main className="min-h-screen bg-[#eef2f7] p-3 sm:p-4">
      <div className="mx-auto max-w-[1480px] space-y-2.5">
        <header className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-950 sm:text-[1.7rem]">
              Центр прибыли / Insights 2.0
            </h1>
            <p className="mt-0.5 max-w-3xl text-xs leading-4 text-slate-500">
              Быстрый управленческий обзор: где бизнес зарабатывает, где теряет
              деньги и какие товары требуют внимания.
            </p>
            {data.dataModes.length > 0 ? (
              <p className="mt-1 text-[10px] font-semibold text-amber-700">
                Режим данных:{" "}
                {data.dataModes
                  .filter(
                    (m) =>
                      !m.startsWith("financeReason:") &&
                      !m.startsWith("skuReason:"),
                  )
                  .join(", ")}
              </p>
            ) : null}
            {data.financeStatus === "PRELIMINARY_WITH_VALUE" ? (
              <p className="mt-1 text-[10px] font-semibold text-amber-800">
                Финансовые KPI: PRELIMINARY — доступные значения показаны, не
                FINAL. {data.financeStatusReason}
              </p>
            ) : null}
            {data.financeStatus === "PENDING_BUILD" ||
            data.financeStatus === "SOURCE_MISSING" ||
            data.financeStatus === "ERROR" ? (
              <p className="mt-1 text-[10px] font-semibold text-rose-700">
                Финансовые данные{" "}
                {data.financeStatus === "PENDING_BUILD"
                  ? "формируются"
                  : "не подтверждены"}
                — KPI не подменяются нулями. {data.financeStatusReason}
              </p>
            ) : null}
            {data.skuStatus === "UNAVAILABLE" || data.skuStatus === "PENDING" ? (
              <p className="mt-1 text-[10px] font-semibold text-slate-600">
                Товарная детализация недоступна/формируется — рейтинги SKU не
                выдаются за «0 товаров». {data.skuStatusReason}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[10px] font-semibold text-slate-600 shadow-sm">
              {data.sourceGeneratedAtLabel
                ? "Снимок read-model "
                : "Рендер страницы "}
              <span className="text-slate-900">
                {data.sourceGeneratedAtLabel ?? data.generatedAtLabel}
              </span>
            </div>
            <button
              type="button"
              disabled={pending}
              onClick={() => startTransition(() => router.refresh())}
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[10px] font-black text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:opacity-60"
            >
              {pending ? "Обновление…" : "Обновить"}
            </button>
          </div>
        </header>

        <form
          method="get"
          action="/insights"
          className="rounded-xl border border-slate-200/80 bg-white px-3 py-2.5 shadow-sm"
        >
          <div className="grid gap-2 md:grid-cols-[1.2fr_1fr_1fr_auto] md:items-end">
            <label className="block">
              <span className="text-[10px] font-bold text-slate-500">
                Компания
              </span>
              <select
                name="company"
                defaultValue={data.company}
                className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-bold text-slate-800 outline-none focus:border-slate-400 focus:bg-white"
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
              <span className="text-[10px] font-bold text-slate-500">
                Дата от
              </span>
              <input
                type="date"
                name="dateFrom"
                defaultValue={data.dateFrom}
                className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-bold text-slate-800 outline-none focus:border-slate-400 focus:bg-white"
              />
            </label>
            <label className="block">
              <span className="text-[10px] font-bold text-slate-500">
                Дата до
              </span>
              <input
                type="date"
                name="dateTo"
                defaultValue={data.dateTo}
                className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-bold text-slate-800 outline-none focus:border-slate-400 focus:bg-white"
              />
            </label>
            <button className="rounded-lg bg-[#0f1c3f] px-4 py-1.5 text-xs font-black text-white shadow-sm transition hover:bg-[#182752]">
              Применить
            </button>
          </div>
          <p className="mt-1 text-[10px] text-slate-400">
            Период: {formatDateRu(data.dateFrom)} — {formatDateRu(data.dateTo)}
          </p>
        </form>

        <section className="grid gap-2 grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
          <KpiCard
            title="Экономический оборот"
            value={formatMoney(data.kpi.economicTurnover)}
            accent="blue"
            icon="₽"
            subtitle="WB + Ozon · управленческий оборот"
            tip={`WB ${formatMoney(data.kpi.economicTurnoverWb)} + Ozon ${formatMoney(data.kpi.economicTurnoverOzon)}. Канон Dashboard: WB до СПП, Ozon taxable+баллы+партнёры.`}
          />
          <KpiCard
            title="Чистая прибыль бизнеса"
            value={formatMoney(data.kpi.businessNetProfit)}
            accent="green"
            icon="↑"
            subtitle={`МП ${formatMoney(data.kpi.marketplaceNetProfit)} · финансы ${formatMoney(data.kpi.financeNetProfitImpact)}`}
            tip={`Прибыль МП после налога (Ozon COGS ${formatMoney(data.kpi.ozonTotalCost)}, источник ${data.kpi.ozonProfitSource}) + Finance INCLUDE, до личных выводов. Не сумма SKU-корректировок.`}
          />
          <KpiCard
            title="Рентабельность бизнеса"
            value={formatPercent(data.kpi.businessMarginPercent)}
            accent="violet"
            icon="%"
            subtitle="Чистая прибыль / экономический оборот"
            tip="Одинаковый scope с двумя KPI выше. При отсутствии оборота — н/д."
          />
          <KpiCard
            title="Убыточные товары"
            value={formatNumber(data.kpi.lossSkuCount)}
            accent="red"
            icon="!"
            subtitle={
              data.kpi.lossCountIsUniqueIdentity
                ? "уникальные позиции с убытком"
                : "строки с отрицательной прибылью"
            }
          />
          <KpiCard
            title="Товарные остатки"
            value={formatMoney(data.kpi.stockAtCost)}
            accent="purple"
            icon="▣"
            subtitle={
              data.kpi.frozenCoveragePartial
                ? `${data.kpi.frozenAsOfLabel} · себест. частично`
                : data.kpi.frozenAsOfLabel
            }
            tip="Количество × себестоимость (ProductCost). Управленческая оценка, не касса."
          />
        </section>

        <section className="rounded-lg border border-slate-200/80 bg-white px-2.5 py-2 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-1.5">
            <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">
              Детализация по товарам (не главные KPI)
            </p>
            <button
              type="button"
              onClick={() => setShowSkuDetail((v) => !v)}
              className="text-[10px] font-bold text-violet-700 hover:underline"
            >
              {showSkuDetail ? "Свернуть" : "Из чего состоит"}
            </button>
          </div>
          <div className="mt-1.5 grid gap-1.5 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-md bg-slate-50 px-2 py-1.5">
              <div className="text-[9px] font-semibold text-slate-500">
                Выручка по товарам
              </div>
              <div className="text-sm font-black tabular-nums text-slate-900">
                {formatMoney(sku.skuRevenue)}
              </div>
            </div>
            <div className="rounded-md bg-slate-50 px-2 py-1.5">
              <div className="text-[9px] font-semibold text-slate-500">
                Прибыль именно от продаж
              </div>
              <div
                className={`text-sm font-black tabular-nums ${moneyClass(sku.soldProfit)}`}
              >
                {formatMoney(sku.soldProfit)}
              </div>
            </div>
            <div className="rounded-md bg-amber-50 px-2 py-1.5">
              <div className="text-[9px] font-semibold text-amber-800">
                Корректировки без продаж
              </div>
              <div
                className={`text-sm font-black tabular-nums ${moneyClass(sku.adjustmentProfit)}`}
              >
                {formatMoney(sku.adjustmentProfit)}
              </div>
            </div>
            <div className="rounded-md bg-slate-50 px-2 py-1.5">
              <div className="text-[9px] font-semibold text-slate-500">
                Итог SKU-распределения
              </div>
              <div
                className={`text-sm font-black tabular-nums ${moneyClass(sku.skuProfitTotal)}`}
              >
                {formatMoney(sku.skuProfitTotal)}
              </div>
            </div>
          </div>
          {showSkuDetail ? (
            <p className="mt-1.5 text-[10px] leading-3.5 text-slate-600">
              Маржа продаж по товарам{" "}
              <span className="font-bold">
                {formatPercent(sku.salesMarginPercent)}
              </span>
              {" = прибыль от продаж / выручка по товарам (без корректировок). "}
              Корректировки без продаж — не «чистая прибыль бизнеса» и не выручка
              недели. Сверка с Dashboard: экономический оборот и чистая прибыль
              бизнеса — в карточках выше.
            </p>
          ) : null}
        </section>

        <section
          id="recommendations"
          className="rounded-xl border border-slate-200/80 bg-white p-2.5 shadow-sm scroll-mt-4"
        >
          <div className="mb-2 flex flex-wrap items-center justify-between gap-1.5">
            <h2 className="text-sm font-black text-slate-900">
              Что требует внимания сегодня
            </h2>
            <button
              type="button"
              onClick={() => setShowAllRecommendations((v) => !v)}
              className="text-[10px] font-bold text-violet-700 hover:underline"
              aria-expanded={showAllRecommendations}
              aria-controls="recommendations-full-list"
            >
              {showAllRecommendations
                ? "Свернуть список"
                : "Смотреть все рекомендации"}
            </button>
          </div>
          <div className="grid gap-1.5 md:grid-cols-2 xl:grid-cols-4">
            {recommendationItems.map((item) => (
              <AttentionCard
                key={item.href}
                href={item.href}
                icon={item.icon}
                tone={item.tone}
                title={item.title}
                body={item.body}
              />
            ))}
          </div>
          {showAllRecommendations ? (
            <div
              id="recommendations-full-list"
              className="mt-2 space-y-1.5 rounded-lg border border-violet-100 bg-violet-50/40 p-2"
            >
              <p className="px-1 text-[10px] font-bold uppercase tracking-wide text-violet-800">
                Полный список рекомендаций
              </p>
              <ol className="space-y-1">
                {recommendationItems.map((item, index) => (
                  <li key={`full-${item.href}`}>
                    <a
                      href={item.href}
                      className="flex items-start gap-2 rounded-lg border border-white bg-white px-2.5 py-2 transition hover:border-violet-200"
                    >
                      <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-violet-100 text-[10px] font-black text-violet-800">
                        {index + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-black text-slate-900">
                          {item.title}
                        </div>
                        <div className="mt-0.5 text-[10px] leading-3.5 text-slate-600">
                          {item.detail}
                        </div>
                      </div>
                      <span className="text-slate-400" aria-hidden>
                        →
                      </span>
                    </a>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
        </section>

        <section className="grid gap-2.5 xl:grid-cols-2">
          <DriversPanel drivers={data.drivers} />
          <ProblemsPanel problems={data.problems} />
        </section>

        <section className="grid gap-2.5 xl:grid-cols-2">
          <SkuRankTable
            id="profit-sku"
            title="ТОП прибыльных SKU"
            rows={data.profitablePreview}
            allRows={data.profitableAll}
            emptyText="Прибыльных SKU с продажами не найдено."
            tone="profit"
          />
          <SkuRankTable
            id="loss-sku"
            title="ТОП убыточных SKU"
            rows={data.lossPreview}
            allRows={data.lossAll}
            emptyText="Убыточных SKU с выручкой не найдено."
            tone="loss"
          />
        </section>

        <AdjustmentsStrip
          summary={data.adjustmentSummary}
          rows={data.adjustments}
        />

        <section className="grid gap-2.5 xl:grid-cols-2">
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

        <p className="pb-2 text-center text-[10px] text-slate-400">
          Источники KPI: канонический Profit WB/Ozon + Finance INCLUDE
          (Dashboard). Детализация товаров и корректировок — SKU-слой. Фото:
          WbProductCard / OzonProduct. Формулы не изменялись.
        </p>
      </div>
    </main>
  );
}
