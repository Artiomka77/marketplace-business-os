import { prisma } from "@/lib/prisma";
import { notFound } from "next/navigation";

type Props = {
  params: Promise<{
    id: string;
  }>;
};

export default async function ImportDetailsPage({
  params,
}: Props) {
  const { id } = await params;

  const item = await prisma.importSession.findUnique({
    where: {
      id,
    },
  });

  if (!item) {
    notFound();
  }

  return (
    <main className="min-h-screen bg-slate-100 p-10">
      <div className="max-w-6xl mx-auto space-y-8">
        <div>
          <h1 className="text-4xl font-bold">
            Детали импорта
          </h1>

          <p className="text-slate-500 mt-3">
            Информация о загруженном отчете
          </p>
        </div>

        <div className="bg-white rounded-3xl border border-slate-200 p-8 grid grid-cols-2 gap-6">
          <div>
            <div className="text-slate-500 text-sm">
              Marketplace
            </div>

            <div className="font-semibold text-lg mt-1">
              {item.marketplace}
            </div>
          </div>

          <div>
            <div className="text-slate-500 text-sm">
              Тип отчета
            </div>

            <div className="font-semibold text-lg mt-1">
              {item.reportType}
            </div>
          </div>

          <div>
            <div className="text-slate-500 text-sm">
              Файл
            </div>

            <div className="font-semibold text-lg mt-1 break-all">
              {item.fileName}
            </div>
          </div>

          <div>
            <div className="text-slate-500 text-sm">
              Строк
            </div>

            <div className="font-semibold text-lg mt-1">
              {item.rowsCount}
            </div>
          </div>

          <div>
            <div className="text-slate-500 text-sm">
              Лист
            </div>

            <div className="font-semibold text-lg mt-1">
              {item.sheetName}
            </div>
          </div>

          <div>
            <div className="text-slate-500 text-sm">
              Header row
            </div>

            <div className="font-semibold text-lg mt-1">
              {item.headerRow}
            </div>
          </div>
        </div>

        <div className="bg-white rounded-3xl border border-slate-200 p-8">
          <h2 className="text-2xl font-bold mb-6">
            Preview данных
          </h2>

          <pre className="bg-slate-100 rounded-2xl p-6 overflow-auto text-sm">
            {JSON.stringify(item.previewJson, null, 2)}
          </pre>
        </div>
      </div>
    </main>
  );
}