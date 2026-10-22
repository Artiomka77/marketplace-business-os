"use client";

import Link from "next/link";

import type { AnalyticsSurface } from "@/lib/db/logAnalyticsDbUnavailable";

const TITLES: Record<AnalyticsSurface, string> = {
  dashboard: "Дашборд временно недоступен",
  "profit-wb": "Прибыль WB временно недоступна",
  "profit-ozon": "Прибыль Ozon временно недоступна",
  sentinel: "Аналитика временно недоступна",
};

export function reloadCurrentDocument(): void {
  window.location.reload();
}

export function AnalyticsTemporarilyUnavailable(props: {
  surface: AnalyticsSurface;
  safeCode?: string;
}) {
  return (
    <section className="mx-auto max-w-3xl px-4 py-10">
      <div className="rounded-3xl border border-amber-200 bg-amber-50 p-6 shadow-sm">
        <p className="text-xs font-black uppercase tracking-[0.16em] text-amber-700">
          Временная техническая недоступность
        </p>
        <h1 className="mt-2 text-2xl font-black text-slate-950">
          {TITLES[props.surface]}
        </h1>
        <p className="mt-3 text-sm font-medium leading-6 text-slate-700">
          Не удалось получить данные из базы. Финансовые показатели сейчас не
          рассчитываются и не показываются как ноль. Это не означает нулевую
          выручку, налог или прибыль.
        </p>
        <p className="mt-2 text-sm font-medium text-slate-600">
          Обновите страницу через минуту. Навигация по системе сохранена.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={reloadCurrentDocument}
            className="rounded-2xl bg-slate-950 px-4 py-2 text-sm font-black text-white"
          >
            Повторить
          </button>
          <Link
            href="/"
            className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-black text-slate-800"
          >
            На дашборд
          </Link>
        </div>
      </div>
    </section>
  );
}
