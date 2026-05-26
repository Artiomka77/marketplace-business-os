import { prisma } from "@/lib/prisma";

export default async function ImportsPage() {
  const imports = await prisma.importSession.findMany({
    orderBy: {
      createdAt: "desc",
    },
    take: 50,
  });

  return (
    <main className="min-h-screen bg-slate-100 p-10">
      <div className="max-w-7xl mx-auto">
        <div className="mb-10">
          <h1 className="text-4xl font-bold tracking-tight">
            История импортов
          </h1>

          <p className="text-slate-500 mt-3">
            Последние загруженные отчеты WB и Ozon
          </p>
        </div>

        <div className="bg-white rounded-3xl border border-slate-200 shadow-sm p-8">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-200 text-slate-500">
                <th className="text-left py-4 font-medium">Дата</th>
                <th className="text-left py-4 font-medium">Marketplace</th>
                <th className="text-left py-4 font-medium">Тип отчета</th>
                <th className="text-left py-4 font-medium">Файл</th>
                <th className="text-left py-4 font-medium">Строк</th>
                <th className="text-left py-4 font-medium">Статус</th>
              </tr>
            </thead>

            <tbody>
              {imports.map((item) => (
                <tr
                  key={item.id}
                  className="border-b border-slate-100 hover:bg-slate-50 transition"
                >
                  <td className="py-5">
                    {new Date(item.createdAt).toLocaleString("ru-RU")}
                  </td>

                  <td className="py-5 font-medium">
                    {item.marketplace}
                  </td>

                  <td className="py-5">
                    {item.reportType}
                  </td>

                  <td className="py-5 max-w-md truncate">
                    {item.fileName}
                  </td>

                  <td className="py-5">
                    {item.rowsCount}
                  </td>

                  <td className="py-5">
                    <span className="bg-green-100 text-green-700 px-3 py-1 rounded-xl text-sm font-medium">
                      {item.status}
                    </span>
                  </td>
                </tr>
              ))}

              {imports.length === 0 && (
                <tr>
                  <td
                    colSpan={6}
                    className="py-10 text-center text-slate-500"
                  >
                    Пока нет импортов
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}