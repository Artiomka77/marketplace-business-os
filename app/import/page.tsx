"use client";

import { useState } from "react";

export default function ImportPage() {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);

  async function handleUpload() {
    if (!file) return;

    setLoading(true);
    setResult(null);

    const formData = new FormData();
    formData.append("file", file);

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
    <main className="p-10 bg-slate-100 min-h-screen">
      <div className="max-w-6xl mx-auto space-y-8">
        <div className="bg-white rounded-3xl border border-slate-200 p-10 shadow-sm">
          <div className="border-2 border-dashed border-slate-300 rounded-3xl p-16 text-center">
            <h1 className="text-5xl font-bold mb-4">
              Загрузите Excel файл
            </h1>

            <p className="text-slate-500 text-lg mb-10">
              Выберите файл отчета в формате .xlsx или .xls
            </p>

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

            <div className="flex justify-center mb-6">
              <label
                htmlFor="excel-file"
                className="inline-flex items-center gap-4 bg-slate-100 hover:bg-slate-200 transition px-6 py-4 rounded-2xl cursor-pointer border border-slate-300"
              >
                <span className="bg-slate-900 text-white px-5 py-3 rounded-xl text-sm font-medium">
                  Выбрать файл
                </span>

                <span className="text-slate-600 text-sm max-w-md truncate">
                  {file ? file.name : "Файл не выбран"}
                </span>
              </label>
            </div>

            {file && (
              <div className="mb-8 text-slate-600">
                Выбран файл:{" "}
                <span className="font-semibold">{file.name}</span>
              </div>
            )}

            <button
              type="button"
              onClick={handleUpload}
              disabled={loading || !file}
              className="bg-slate-900 hover:bg-slate-800 disabled:bg-slate-400 text-white px-8 py-4 rounded-2xl font-medium transition"
            >
              {loading ? "Загрузка..." : "Загрузить отчет"}
            </button>
          </div>
        </div>

        {result && (
          <div className="bg-white rounded-3xl border border-slate-200 p-10 shadow-sm">
            <h2 className="text-3xl font-bold mb-6">
              Результат импорта
            </h2>

            {result.error ? (
              <div className="text-red-500 font-medium">
                {result.error}
              </div>
            ) : (
              <div className="space-y-4">
                <div>
                  Лист:{" "}
                  <span className="font-semibold">{result.sheet}</span>
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

                <pre className="bg-slate-100 rounded-2xl p-6 overflow-auto text-sm">
                  {JSON.stringify(result.preview, null, 2)}
                </pre>
              </div>
            )}
          </div>
        )}

        <div className="bg-white rounded-3xl border border-slate-200 p-10 shadow-sm">
          <h2 className="text-3xl font-bold mb-2">
            Поддерживаемые отчеты
          </h2>

          <p className="text-slate-500 mb-8">
            Система автоматически определяет тип отчета при загрузке файла
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
                className="border border-slate-200 rounded-3xl p-6 hover:border-slate-300 transition"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <div className="text-2xl font-semibold mb-2">
                      {item.title}
                    </div>

                    <div className="text-slate-500 mb-4">
                      {item.desc}
                    </div>

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

                  <div className="bg-green-100 text-green-700 px-4 py-2 rounded-2xl text-sm font-medium">
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