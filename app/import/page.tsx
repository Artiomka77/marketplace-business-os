"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";

const companies = ["ИП Петров", "ИП Лебедева"];

type ImportResult = {
  success?: boolean;
  error?: string;
  companyName?: string;
  marketplace?: string;
  sheet?: string;
  rows?: number;
  reportType?: string;
  normalizedRows?: number;
  skippedRows?: number;
  preview?: unknown;
};

const supportedReports = [
  {
    title: "Финансовые операции",
    desc: "Поступления, расходы, кредиты, вывод собственника и переводы.",
    path: "Заполнить шаблон Excel → загрузить файл на этой странице",
    tag: "Finance",
    reportType: "FINANCE_TRANSACTIONS",
    templateHref: "/api/templates/finance-transactions",
  },
  {
    title: "Wildberries — Продажи",
    desc: "Еженедельный отчет реализации",
    path: "Финансы → Финансовые отчеты → Отчёты реализации → Еженедельные",
    tag: "WB",
  },
  {
    title: "Wildberries — Реклама",
    desc: "История рекламных затрат",
    path: "Продвижение → WB Продвижение → Финансы → История затрат",
    tag: "WB",
  },
  {
    title: "Wildberries — Остатки",
    desc: "Остатки, товары в пути и возвраты",
    path: "Товары → Остатки → Скачать отчет",
    tag: "WB",
  },
  {
    title: "Ozon — Экономика магазина",
    desc: "Отчет по товарам",
    path: "Финансы → Экономика магазина → Скачать отчет → По товарам",
    tag: "Ozon",
  },
  {
    title: "Ozon — Реклама",
    desc: "Аналитика рекламных кампаний",
    path: "Продвижение → Аналитика продвижения → Скачать отчет → Выбрать период",
    tag: "Ozon",
  },
  {
    title: "Ozon — Планирование поставок",
    desc: "Доступность товаров, рекомендации Ozon и потребность по кластерам.",
    path: "Ozon → FBO → Планирование поставок → Скачать файл доступности товаров",
    tag: "Ozon",
    reportType: "OZON_SUPPLY_RECOMMENDATION",
  },
  {
    title: "Ozon — Наш склад",
    desc: "Остатки товаров на вашем складе для распределения поставок по кластерам.",
    path: "Скачать шаблон → заполнить артикулы и остатки → загрузить файл",
    tag: "Supply",
    reportType: "OZON_WAREHOUSE_STOCK",
    templateHref: "/api/templates/ozon-warehouse-stock",
  },
];

function getReportTypeLabel(reportType?: string) {
  if (reportType === "FINANCE_TRANSACTIONS") return "Финансовые операции";
  if (reportType === "WB_SALES") return "WB продажи";
  if (reportType === "WB_FINANCE") return "WB финансы";
  if (reportType === "WB_ADS_STATS") return "WB реклама";
  if (reportType === "WB_STOCK") return "WB остатки";
  if (reportType === "OZON_FINANCE") return "Ozon финансы";
  if (reportType === "OZON_ADS") return "Ozon реклама";
  if (reportType === "OZON_STOCK") return "Ozon остатки";
  if (reportType === "OZON_PRODUCT") return "Ozon товары";
  if (reportType === "OZON_SUPPLY_RECOMMENDATION")
    return "Ozon планирование поставок";
  if (reportType === "OZON_WAREHOUSE_STOCK") return "Ozon наш склад";
  if (reportType === "PRODUCT_COST") return "Себестоимость";
  return reportType ?? "—";
}

function ImportPageFallback() {
  return (
    <main className="page-shell">
      <div className="page-container">
        <section className="panel p-6">
          <div className="h-6 w-40 animate-pulse rounded-full bg-slate-100" />
          <div className="mt-5 h-10 w-80 animate-pulse rounded-2xl bg-slate-100" />
          <div className="mt-4 h-5 max-w-2xl animate-pulse rounded-2xl bg-slate-100" />
        </section>

        <section className="panel p-6">
          <div className="rounded-[28px] border-2 border-dashed border-slate-200 bg-slate-50/70 p-12 text-center">
            <div className="mx-auto h-16 w-16 animate-pulse rounded-3xl bg-white ring-1 ring-slate-200" />
            <div className="mx-auto mt-5 h-8 w-64 animate-pulse rounded-2xl bg-slate-100" />
            <div className="mx-auto mt-4 h-5 max-w-xl animate-pulse rounded-2xl bg-slate-100" />
          </div>
        </section>
      </div>
    </main>
  );
}

function ImportPageContent() {
  const searchParams = useSearchParams();
  const requestedReportType = searchParams.get("reportType") ?? "";
  const isFinanceImport = requestedReportType === "FINANCE_TRANSACTIONS";
  const requestedReport = supportedReports.find(
    (report) => report.reportType === requestedReportType
  );
  const requestedTemplateHref = requestedReport?.templateHref ?? null;

  const [file, setFile] = useState<File | null>(null);
  const [companyName, setCompanyName] = useState(companies[0]);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  const title = isFinanceImport
    ? "Загрузка финансовых операций"
    : requestedReport
      ? `Загрузка: ${requestedReport.title}`
      : "Импорт Excel-файлов";

  const description = isFinanceImport
    ? "Загрузите заполненный Excel-шаблон с поступлениями, расходами, кредитами, выводами и переводами."
    : requestedReport
      ? requestedReport.desc
      : "Выберите компанию и загрузите Excel-отчёт. Система сама определит тип файла и сохранит данные.";

  const highlightedReports = useMemo(() => {
    if (!requestedReportType) return supportedReports;

    return supportedReports.sort((a, b) => {
      if (a.reportType === requestedReportType) return -1;
      if (b.reportType === requestedReportType) return 1;
      return 0;
    });
  }, [requestedReportType]);

  async function handleUpload() {
    if (!file) return;

    setLoading(true);
    setResult(null);

    const formData = new FormData();
    formData.append("file", file);
    formData.append("companyName", companyName);

    try {
      const response = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      });

      const data = await response.json();

      if (!response.ok) {
        setResult({
          error: data?.error ?? "Ошибка загрузки файла",
        });
        return;
      }

      setResult(data);
    } catch (error) {
      console.error(error);
      setResult({ error: "Ошибка загрузки файла" });
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="page-shell">
      <div className="page-container">
        <section className="panel p-5 sm:p-6">
          <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
            <div>
              <div className="inline-flex rounded-full bg-violet-50 px-3 py-1 text-xs font-black uppercase tracking-[0.12em] text-violet-700 ring-1 ring-violet-100">
                Импорт данных
              </div>

              <h1 className="mt-3 text-3xl font-black tracking-tight text-slate-950 sm:text-4xl">
                {title}
              </h1>

              <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-500">
                {description}
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              {requestedTemplateHref ? (
                <a
                  href={requestedTemplateHref}
                  className="inline-flex items-center gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-black text-emerald-700 shadow-sm transition hover:bg-emerald-100"
                >
                  ⇩ Скачать шаблон
                </a>
              ) : null}

              <Link
                href="/finance/operations"
                className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-black text-slate-700 shadow-sm transition hover:bg-slate-50"
              >
                ← Финансовые операции
              </Link>
            </div>
          </div>
        </section>

        <section className="grid gap-5 xl:grid-cols-[minmax(0,4fr)_minmax(340px,2fr)]">
          <section className="panel p-5 sm:p-6">
            <div className="rounded-[28px] border-2 border-dashed border-slate-200 bg-slate-50/70 p-8 text-center sm:p-12">
              <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-3xl bg-white text-2xl shadow-sm ring-1 ring-slate-200">
                ⇧
              </div>

              <h2 className="mt-5 text-2xl font-black tracking-tight text-slate-950">
                Выберите Excel-файл
              </h2>

              <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-slate-500">
                Перед загрузкой выберите компанию. Для финансовых операций можно
                заполнить колонку “Компания” внутри файла, но выбранная компания
                будет резервным значением.
              </p>

              <div className="mx-auto mt-6 grid max-w-2xl gap-4 text-left sm:grid-cols-[220px_minmax(0,1fr)]">
                <label className="block">
                  <span className="text-xs font-black uppercase tracking-[0.12em] text-slate-400">
                    Компания
                  </span>
                  <select
                    value={companyName}
                    onChange={(event) => setCompanyName(event.target.value)}
                    className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-700 outline-none transition focus:border-violet-200 focus:ring-4 focus:ring-violet-50"
                  >
                    {companies.map((company) => (
                      <option key={company} value={company}>
                        {company}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="block">
                  <span className="text-xs font-black uppercase tracking-[0.12em] text-slate-400">
                    Файл
                  </span>

                  <input
                    id="excel-file"
                    type="file"
                    accept=".xlsx,.xls"
                    onChange={(event) => {
                      const selectedFile = event.target.files?.[0] ?? null;
                      setFile(selectedFile);
                    }}
                    className="hidden"
                  />

                  <label
                    htmlFor="excel-file"
                    className="mt-2 flex cursor-pointer items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-600 transition hover:bg-slate-50"
                  >
                    <span className="truncate">
                      {file ? file.name : "Файл не выбран"}
                    </span>
                    <span className="shrink-0 rounded-xl bg-slate-950 px-3 py-1.5 text-xs font-black text-white">
                      Выбрать
                    </span>
                  </label>
                </label>
              </div>

              <button
                type="button"
                onClick={handleUpload}
                disabled={loading || !file || !companyName}
                className="mt-7 rounded-2xl bg-slate-950 px-8 py-4 text-sm font-black text-white shadow-lg shadow-slate-300 transition hover:bg-slate-800 disabled:bg-slate-400"
              >
                {loading ? "Загрузка..." : "Загрузить файл"}
              </button>
            </div>
          </section>

          <aside className="panel p-5 sm:p-6">
            <h2 className="text-2xl font-black tracking-tight text-slate-950">
              Порядок загрузки
            </h2>

            <div className="mt-5 space-y-3">
              <div className="rounded-2xl bg-violet-50 p-4 ring-1 ring-violet-100">
                <div className="text-sm font-black text-violet-700">
                  1. Скачать шаблон
                </div>
                <p className="mt-1 text-sm font-semibold leading-5 text-violet-600">
                  Для финансовых операций используйте готовый шаблон Excel.
                </p>
              </div>

              <div className="rounded-2xl bg-blue-50 p-4 ring-1 ring-blue-100">
                <div className="text-sm font-black text-blue-700">
                  2. Заполнить операции
                </div>
                <p className="mt-1 text-sm font-semibold leading-5 text-blue-600">
                  Дата, тип операции, статья и сумма обязательны.
                </p>
              </div>

              <div className="rounded-2xl bg-emerald-50 p-4 ring-1 ring-emerald-100">
                <div className="text-sm font-black text-emerald-700">
                  3. Загрузить файл
                </div>
                <p className="mt-1 text-sm font-semibold leading-5 text-emerald-600">
                  Операции появятся в журнале и попадут в финансовую модель.
                </p>
              </div>
            </div>
          </aside>
        </section>

        {result ? (
          <section className="panel p-5 sm:p-6">
            <h2 className="text-2xl font-black tracking-tight text-slate-950">
              Результат импорта
            </h2>

            {result.error ? (
              <div className="mt-5 rounded-2xl bg-red-50 p-4 text-sm font-black text-red-700 ring-1 ring-red-100">
                {result.error}
              </div>
            ) : (
              <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-5">
                <div className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200">
                  <div className="text-xs font-black uppercase tracking-[0.12em] text-slate-400">
                    Компания
                  </div>
                  <div className="mt-2 text-lg font-black text-slate-950">
                    {result.companyName ?? "Не указана"}
                  </div>
                </div>

                <div className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200">
                  <div className="text-xs font-black uppercase tracking-[0.12em] text-slate-400">
                    Тип
                  </div>
                  <div className="mt-2 text-lg font-black text-slate-950">
                    {getReportTypeLabel(result.reportType)}
                  </div>
                </div>

                <div className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200">
                  <div className="text-xs font-black uppercase tracking-[0.12em] text-slate-400">
                    Строк найдено
                  </div>
                  <div className="mt-2 text-lg font-black text-slate-950">
                    {result.rows ?? 0}
                  </div>
                </div>

                <div className="rounded-2xl bg-emerald-50 p-4 ring-1 ring-emerald-100">
                  <div className="text-xs font-black uppercase tracking-[0.12em] text-emerald-500">
                    Сохранено
                  </div>
                  <div className="mt-2 text-lg font-black text-emerald-700">
                    {result.normalizedRows ?? 0}
                  </div>
                </div>

                <div className="flex items-center">
                  {result.reportType === "FINANCE_TRANSACTIONS" ? (
                    <Link
                      href="/finance/operations"
                      className="w-full rounded-2xl bg-slate-950 px-5 py-3 text-center text-sm font-black text-white shadow-lg shadow-slate-300"
                    >
                      Открыть операции
                    </Link>
                  ) : null}
                </div>
              </div>
            )}

            {!result.error ? (
              <pre className="mt-5 max-h-[360px] overflow-auto rounded-2xl bg-slate-950 p-5 text-xs text-slate-100">
                {JSON.stringify(result.preview, null, 2)}
              </pre>
            ) : null}
          </section>
        ) : null}

        <section className="panel p-5 sm:p-6">
          <h2 className="text-2xl font-black tracking-tight text-slate-950">
            Поддерживаемые файлы
          </h2>

          <p className="mt-2 text-sm leading-6 text-slate-500">
            Система автоматически определяет тип отчёта по колонкам и названию
            листа.
          </p>

          <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {highlightedReports.map((item) => (
              <div
                key={item.title}
                className={`rounded-[26px] border p-5 transition ${
                  item.reportType === requestedReportType
                    ? "border-violet-200 bg-violet-50/60 ring-1 ring-violet-100"
                    : "border-slate-200 bg-white hover:border-slate-300"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-lg font-black text-slate-950">
                      {item.title}
                    </div>
                    <div className="mt-2 text-sm font-semibold leading-5 text-slate-500">
                      {item.desc}
                    </div>
                  </div>

                  <div className="rounded-2xl bg-slate-100 px-3 py-1 text-xs font-black text-slate-600">
                    {item.tag}
                  </div>
                </div>

                <div className="mt-4 text-xs font-semibold leading-5 text-slate-500">
                  <span className="font-black text-slate-700">Где взять: </span>
                  {item.path}
                </div>

                {item.templateHref ? (
                  <a
                    href={item.templateHref}
                    className="mt-4 inline-flex rounded-2xl bg-emerald-50 px-4 py-2 text-sm font-black text-emerald-700 ring-1 ring-emerald-100"
                  >
                    Скачать шаблон
                  </a>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}


export default function ImportPage() {
  return (
    <Suspense fallback={<ImportPageFallback />}>
      <ImportPageContent />
    </Suspense>
  );
}
