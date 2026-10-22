"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  buildReadModelStatusUrl,
  isWaitingSourceReason,
  nextPollDelayMs,
  normalizeReadinessKey,
  sameReadinessKey,
  type ReadinessPollStatus,
} from "@/lib/readModel/pollingPolicy";

type StatusPayload = {
  status?: ReadinessPollStatus;
  isReady?: boolean;
  surface?: string;
  dateFrom?: string;
  dateTo?: string;
  companyScope?: string;
  marketplace?: string;
  reason?: string | null;
  updatedAt?: string | null;
};

function formatClock(value: Date | null) {
  if (!value) return "—";
  return value.toLocaleTimeString("ru-RU", { hour12: false });
}

export function ReadModelPendingAutoRefresh({
  surface,
  dateFrom,
  dateTo,
  companyScope = "ALL",
  marketplace = "ALL",
  initialStatus = "PENDING",
  reason,
  variant = "page",
}: {
  surface: string;
  dateFrom: string;
  dateTo: string;
  companyScope?: string;
  marketplace?: string;
  initialStatus?: "PENDING" | "ERROR";
  reason?: string;
  variant?: "page" | "banner";
}) {
  const router = useRouter();
  const key = useMemo(
    () =>
      normalizeReadinessKey({
        surface,
        dateFrom,
        dateTo,
        companyScope,
        marketplace,
      }),
    [surface, dateFrom, dateTo, companyScope, marketplace]
  );

  const [phase, setPhase] = useState<"wait" | "waiting_source" | "ready" | "error">(
    initialStatus === "ERROR"
      ? "error"
      : isWaitingSourceReason(reason)
        ? "waiting_source"
        : "wait"
  );
  const [allowPoll, setAllowPoll] = useState(initialStatus !== "ERROR");
  const [cycle, setCycle] = useState(0);
  const [lastCheckAt, setLastCheckAt] = useState<Date | null>(null);
  const [lastReason, setLastReason] = useState(reason ?? "");
  const refreshedRef = useRef(false);
  const startedAtRef = useRef(Date.now());

  const checkOnce = useCallback(
    async (
      signal: AbortSignal
    ): Promise<"ready" | "error" | "wait" | "waiting_source"> => {
      const response = await fetch(buildReadModelStatusUrl(key), {
        method: "GET",
        cache: "no-store",
        signal,
      });
      if (!response.ok) {
        throw new Error(`status_http_${response.status}`);
      }
      const payload = (await response.json()) as StatusPayload;
      const echoed = normalizeReadinessKey({
        surface: payload.surface ?? key.surface,
        dateFrom: payload.dateFrom ?? "",
        dateTo: payload.dateTo ?? "",
        companyScope: payload.companyScope,
        marketplace: payload.marketplace,
      });
      if (!sameReadinessKey(key, echoed)) {
        return "wait";
      }
      setLastCheckAt(new Date());
      if (payload.reason) setLastReason(payload.reason);
      if (payload.isReady || payload.status === "READY") {
        setPhase("ready");
        if (!refreshedRef.current) {
          refreshedRef.current = true;
          window.setTimeout(() => {
            router.refresh();
          }, 400);
        }
        return "ready";
      }
      if (payload.status === "ERROR") {
        setPhase("error");
        return "error";
      }
      if (
        payload.status === "WAITING_SOURCE" ||
        isWaitingSourceReason(payload.reason)
      ) {
        setPhase("waiting_source");
        return "waiting_source";
      }
      setPhase("wait");
      return "wait";
    },
    [key, router]
  );

  useEffect(() => {
    refreshedRef.current = false;
    startedAtRef.current = Date.now();
    if (!allowPoll) {
      setPhase("error");
      return;
    }
    setPhase("wait");

    const abort = new AbortController();
    let timer: number | null = null;

    const schedule = (delay: number) => {
      timer = window.setTimeout(run, delay);
    };

    const run = async () => {
      if (abort.signal.aborted) return;
      let outcome: "ready" | "error" | "wait" | "waiting_source" = "wait";
      try {
        outcome = await checkOnce(abort.signal);
      } catch (error) {
        if (abort.signal.aborted) return;
        if ((error as { name?: string }).name === "AbortError") return;
        setLastCheckAt(new Date());
      }
      if (abort.signal.aborted || refreshedRef.current || outcome === "error") return;
      const hidden = document.visibilityState === "hidden";
      const elapsed = Date.now() - startedAtRef.current;
      // Source-waiting polls slower than active build; still auto-recovers.
      const delay =
        outcome === "waiting_source"
          ? hidden
            ? 60_000
            : 20_000
          : nextPollDelayMs(elapsed, hidden);
      schedule(delay);
    };

    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (refreshedRef.current) return;
      void checkOnce(abort.signal);
    };

    void run();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      abort.abort();
      if (timer != null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [allowPoll, checkOnce, cycle, key]);

  const retryNow = () => {
    refreshedRef.current = false;
    startedAtRef.current = Date.now();
    setPhase("wait");
    setAllowPoll(true);
    setCycle((value) => value + 1);
  };

  const title =
    phase === "ready"
      ? "Данные готовы. Обновляем…"
      : phase === "error"
        ? "Не удалось получить готовый snapshot."
        : phase === "waiting_source"
          ? "Ожидаем закрытый источник WB. Страница обновится автоматически, когда отчёт появится."
          : "Данные пересчитываются. Страница обновится автоматически после готовности.";

  const boxClass =
    variant === "banner"
      ? "mt-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
      : "mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900";

  return (
    <div
      className={boxClass}
      data-readmodel-auto-refresh="true"
      data-readmodel-surface={key.surface}
      data-readmodel-phase={phase}
      data-readmodel-readiness={
        phase === "waiting_source"
          ? "WAITING_SOURCE"
          : phase === "ready"
            ? "READY"
            : phase === "error"
              ? "ERROR"
              : "BUILD_PENDING"
      }
    >
      <div className="flex items-center gap-2 font-semibold">
        <span
          className={`inline-block h-2.5 w-2.5 rounded-full ${
            phase === "ready"
              ? "bg-emerald-500"
              : phase === "error"
                ? "bg-red-500"
                : "animate-pulse bg-amber-500"
          }`}
        />
        <span>{title}</span>
      </div>
      <div className="mt-1 text-xs text-amber-800">
        Проверяем готовность… Последняя проверка: {formatClock(lastCheckAt)}
        {lastReason ? ` · ${lastReason}` : ""}
      </div>
      <button
        type="button"
        onClick={retryNow}
        className="mt-2 rounded-xl border border-amber-300 bg-white px-3 py-1 text-xs font-bold text-amber-900"
      >
        {phase === "error" ? "Повторить проверку" : "Проверить сейчас"}
      </button>
    </div>
  );
}
