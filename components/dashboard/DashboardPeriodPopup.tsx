"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef } from "react";

type PresetPeriod = {
  key: string;
  shortLabel: string;
  description: string;
  href: string;
};

type CustomForm = {
  companyName: string;
  marketplaceCompanyName: string;
  chartPreset: string;
  dateFrom: string;
  dateTo: string;
};

export function DashboardPeriodPopup({
  appliedLabel,
  appliedPeriodKey,
  presets,
  customForm,
}: {
  appliedLabel: string;
  appliedPeriodKey: string;
  presets: PresetPeriod[];
  customForm: CustomForm;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const summaryRef = useRef<HTMLElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const resetDraft = useCallback(() => {
    const form = formRef.current;
    if (!form) return;
    const dateFrom = form.elements.namedItem("dateFrom");
    const dateTo = form.elements.namedItem("dateTo");
    if (dateFrom instanceof HTMLInputElement) {
      dateFrom.value = customForm.dateFrom;
    }
    if (dateTo instanceof HTMLInputElement) {
      dateTo.value = customForm.dateTo;
    }
  }, [customForm.dateFrom, customForm.dateTo]);

  const closeWithoutApply = useCallback(() => {
    const details = detailsRef.current;
    if (!details?.open) return;
    details.open = false;
    resetDraft();
    summaryRef.current?.focus();
  }, [resetDraft]);

  useEffect(() => {
    const details = detailsRef.current;
    if (!details) return;

    const onToggle = () => {
      if (!details.open) resetDraft();
    };
    details.addEventListener("toggle", onToggle);

    const isInsidePopup = (event: Event) => {
      const path = typeof event.composedPath === "function" ? event.composedPath() : [];
      return path.some((node) => node instanceof Node && details.contains(node));
    };

    const onPointerDown = (event: PointerEvent) => {
      if (!details.open) return;
      if (isInsidePopup(event)) return;
      closeWithoutApply();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (!details.open) return;
      event.preventDefault();
      closeWithoutApply();
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      details.removeEventListener("toggle", onToggle);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [closeWithoutApply, resetDraft]);

  return (
    <details
      ref={detailsRef}
      className="group/period relative"
      data-period-popup="true"
    >
      <summary
        ref={summaryRef}
        className="inline-flex cursor-pointer list-none items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 shadow-sm transition hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700"
      >
        <span>Период: {appliedLabel}</span>
        <span className="text-slate-400 transition group-open/period:rotate-180">↓</span>
      </summary>

      <div
        className="absolute left-0 top-full z-50 mt-2 w-[760px] max-w-[92vw] rounded-[28px] border border-slate-200 bg-white p-4 shadow-2xl shadow-slate-300/40"
        data-period-popup-panel="true"
      >
        <div className="grid gap-2 sm:grid-cols-3">
          {presets.map((period) => {
            const isActive = appliedPeriodKey === period.key;

            return (
              <Link
                key={period.key}
                href={period.href}
                className={`rounded-2xl border p-3 transition active:scale-[0.99] ${
                  isActive
                    ? "border-indigo-600 bg-indigo-600 text-white"
                    : "border-slate-200 bg-slate-50 text-slate-800 hover:bg-white"
                }`}
              >
                <div className="text-sm font-black">{period.shortLabel}</div>
                <div
                  className={`mt-1 text-xs leading-5 ${
                    isActive ? "text-indigo-100" : "text-slate-500"
                  }`}
                >
                  {period.description}
                </div>
              </Link>
            );
          })}
        </div>

        <form
          ref={formRef}
          action="/"
          className="mt-4 rounded-3xl bg-slate-50 p-4 ring-1 ring-slate-200"
        >
          <input type="hidden" name="period" value="custom" />
          <input type="hidden" name="companyName" value={customForm.companyName} />
          <input
            type="hidden"
            name="marketplaceCompanyName"
            value={customForm.marketplaceCompanyName}
          />
          <input type="hidden" name="chartPreset" value={customForm.chartPreset} />

          <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <label className="text-sm font-medium text-slate-500">
              Дата от
              <input
                type="date"
                name="dateFrom"
                defaultValue={customForm.dateFrom}
                className="filter-control mt-1"
              />
            </label>

            <label className="text-sm font-medium text-slate-500">
              Дата до
              <input
                type="date"
                name="dateTo"
                defaultValue={customForm.dateTo}
                className="filter-control mt-1"
              />
            </label>

            <button type="submit" className="primary-button h-11">
              Применить
            </button>
          </div>
        </form>
      </div>
    </details>
  );
}
