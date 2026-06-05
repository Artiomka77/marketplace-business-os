"use client";

import { useState } from "react";

const companies = ["ИП Петров", "ИП Лебедева"];

export default function ImportPage() {
  const [file, setFile] = useState<File | null>(null);
  const [companyName, setCompanyName] = useState(companies[0]);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);

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
    <main className="min-h-screen bg-slate-100 p-10">
      <div className="mx-auto max-w-6xl space-y-8">
        <div className="rounded-3xl border border-slate-200 bg-white p-10 shadow-sm">
          <div className="rounded-3xl border-2 border-dashed border-slate-300 p-16 text-center">
            <h1 className="mb-4 text-5xl font-bold">Загрузите Excel файл</h1>

            <p className="mb-10 text-lg text-slate-500">
              Выберите компанию и файл отчёта в формате .xlsx или .xls.
            </p>

            <div className="mx-auto mb-6 max-w-md text-left">
              <label className="mb-2 block text-sm font-medium text-slate-700">
                Компания
              </label>

              <select
                value={companyName}
                onChange={(event) => setCompanyName(event.target.value)}
                className="w-full rounded-xl border border-slate-300 px-4 py-3"
              >
                {companies.map((company) => (
                  <option key={company} value={company}>
                    {company}
                  </option>
                ))}
              </select>

              <p className="mt-2 text-xs text-slate-500">
                Перед загрузкой любого отчёта выберите компанию, к которой относится файл.
                Данные хранятся раздельно по компаниям.
              </p>
            </div>

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

            <div className="mb-6 flex justify-center">
              <label
                htmlFor="excel-file"
                className="inline-flex cursor-pointer items-center gap-4 rounded-2xl border border-slate-300 bg-slate-100 px-6 py-4 transition hover:bg-slate-200"
              >
                <span className="rounded-xl bg-slate-900 px-5 py-3 text-sm font-medium text-white">
                  Выбрать файл
                </span>

                <span className="max-w-md truncate text-sm text-slate-600">
                  {file ? file.name : "Файл не выбран"}
                </span>
              </label>
            </div>

            {file && (
              <div className="mb-8 text-slate-600">
                Выбран файл: <span className="font-semibold">{file.name}</span>
              </div>
            )}

            <button
              type="button"
              onClick={handleUpload}
              disabled={loading || !file || !companyName}
              className="rounded-2xl bg-slate-900 px-8 py-4 font-medium text-white transition hover:bg-slate-800 disabled:bg-slate-400"
            >
              {loading ? "Загрузка..." : "Загрузить отчёт"}
            </button>
          </div>
        </div>

        {result && (
          <div className="rounded-3xl border border-slate-200 bg-white p-10 shadow-sm">
            <h2 className="mb-6 text-3xl font-bold">Результат импорта</h2>

            {result.error ? (
              <div className="font-medium text-red-500">{result.error}</div>
            ) : (
              <div className="space-y-4">
                <div>
                  Компания:{" "}
                  <span className="font-semibold">
                    {result.companyName ?? "Не указана"}
                  </span>
                </div>

                <div>
                  Маркетплейс:{" "}
                  <span className="font-semibold">
                    {result.marketplace ?? "—"}
                  </span>
                </div>

                <div>
                  Лист: <span className="font-semibold">{result.sheet}</span>
                </div>

                <div>
                  Строк найдено:{" "}
                  <span className="font-semibold">{result.rows}</span>
                </div>

                <div>
                  Тип отчета:{" "}
                  <span className="font-semibold">{result.reportType}</span>
                </div>

                <div>
                  Нормализовано строк:{" "}
                  <span className="font-semibold">
                    {result.normalizedRows ?? 0}
                  </span>
                </div>

                <pre className="overflow-auto rounded-2xl bg-slate-100 p-6 text-sm">
                  {JSON.stringify(result.preview, null, 2)}
                </pre>
              </div>
            )}
          </div>
        )}

        <div className="rounded-3xl border border-slate-200 bg-white p-10 shadow-sm">
          <h2 className="mb-2 text-3xl font-bold">Поддерживаемые отчеты</h2>

          <p className="mb-8 text-slate-500">
            Система автоматически определяет тип отчета при загрузке файла.
          </p>

          <div className="space-y-5">
            {[
              {
                title: "Wildberries — Продажи",
                desc: "Еженедельный отчет реализации",
                path: "Финансы → Финансовые отчеты → Отчёты реализации → Еженедельные",
              },
              {
                title: "Wildberries — Реклама",
                desc: "История рекламных затрат",
                path: "Продвижение → WB Продвижение → Финансы → История затрат",
              },
              {
                title: "Wildberries — Остатки",
                desc: "Остатки, товары в пути и возвраты",
                path: "Товары → Остатки → Скачать отчет",
              },
              {
                title: "Ozon — Экономика магазина",
                desc: "Отчет по товарам",
                path: "Финансы → Экономика магазина → Скачать отчет → По товарам",
              },
              {
                title: "Ozon — Реклама",
                desc: "Аналитика рекламных кампаний",
                path: "Продвижение → Аналитика продвижения → Скачать отчет → Выбрать период",
              },
            ].map((item) => (
              <div
                key={item.title}
                className="rounded-3xl border border-slate-200 p-6 transition hover:border-slate-300"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <div className="mb-2 text-2xl font-semibold">
                      {item.title}
                    </div>

                    <div className="mb-4 text-slate-500">{item.desc}</div>

                    <div className="space-y-1 text-sm text-slate-600">
                      <div>
                        <span className="font-medium">Где скачать:</span>{" "}
                        {item.path}
                      </div>

                      <div>
                        <span className="font-medium">Формат:</span> .xlsx
                      </div>
                    </div>
                  </div>

                  <div className="rounded-2xl bg-green-100 px-4 py-2 text-sm font-medium text-green-700">
                    Supported
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}