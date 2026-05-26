"use client";

import { useState } from "react";

export default function ImportPage() {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);

  async function handleUpload() {
    if (!file) return;

    setLoading(true);

    const formData = new FormData();
    formData.append("file", file);

    try {
      const response = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      });

      const data = await response.json();
      setResult(data);
    } catch (error) {
      console.error(error);
      setResult({ error: "Ошибка загрузки" });
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

            <div className="flex justify-center mb-6">
              <label className="inline-flex items-center gap-4 bg-slate-100 hover:bg-slate-200 transition px-6 py-4 rounded-2xl cursor-pointer border border-slate-300">
                <div className="bg-slate-900 text-white px-5 py-3 rounded-xl text-sm font-medium">
                  Выбрать файл
                </div>

                <div className="text-slate-600 text-sm">
                  {file ? file.name : "Файл не выбран"}
                </div>

                <input
                  type="file"
                  accept=".xlsx,.xls"
                  onChange={(event) => {
                    setFile(event.target.files?.[0] ?? null);
                  }}
                  className="hidden"
                />
              </label>
            </div>

            {file && (
              <div className="mb-8 text-slate-600">
                Выбран файл:{" "}
                <span className="font-semibold">{file.name}</span>
              </div>
            )}

            <button
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
		<div>
 		 Нормализовано строк:{" "}
 		 <span className="font-semibold">
   		 {result.normalizedRows ?? 0}
  		</span>
		</div>
                  <span className="font-semibold">
                    {result.reportType}
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
            <div className="border border-slate-200 rounded-3xl p-6 hover:border-slate-300 transition">
              <div className="flex items-start justify-between">
                <div>
                  <div className="text-2xl font-semibold mb-2">
                  Wildberries — Продажи
                  </div>

                  <div className="text-slate-500 mb-4">
                    Еженедельный отчет реализации
                  </div>

                  <div className="space-y-1 text-sm text-slate-600">
                    <div>
                      <span className="font-medium">Где скачать:</span>{" "}
                      Финансы → Финансовые отчеты → Отчёты реализации → Еженедельные
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

            <div className="border border-slate-200 rounded-3xl p-6 hover:border-slate-300 transition">
              <div className="flex items-start justify-between">
                <div>
                  <div className="text-2xl font-semibold mb-2">
                    Wildberries — Реклама
                  </div>

                  <div className="text-slate-500 mb-4">
                    История рекламных затрат
                  </div>

                  <div className="space-y-1 text-sm text-slate-600">
                    <div>
                      <span className="font-medium">Где скачать:</span>{" "}
                      Продвижение → WB Продвижение → Финансы → История затрат
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

            <div className="border border-slate-200 rounded-3xl p-6 hover:border-slate-300 transition">
              <div className="flex items-start justify-between">
                <div>
                  <div className="text-2xl font-semibold mb-2">
                    Ozon — Экономика магазина
                  </div>

                  <div className="text-slate-500 mb-4">
                    Отчет по товарам
                  </div>

                  <div className="space-y-1 text-sm text-slate-600">
                    <div>
                      <span className="font-medium">Где скачать:</span>{" "}
                      Финансы → Экономика магазина → Скачать отчет → По товарам
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

            <div className="border border-slate-200 rounded-3xl p-6 hover:border-slate-300 transition">
              <div className="flex items-start justify-between">
                <div>
                  <div className="text-2xl font-semibold mb-2">
                    Ozon — Реклама
                  </div>

                  <div className="text-slate-500 mb-4">
                    Аналитика рекламных кампаний
                  </div>

                  <div className="space-y-1 text-sm text-slate-600">
                    <div>
                      <span className="font-medium">Где скачать:</span>{" "}
                      Продвижение → Аналитика продвижения → Скачать отчет → Выбрать период
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
          </div>
        </div>
      </div>
    </main>
  );
}