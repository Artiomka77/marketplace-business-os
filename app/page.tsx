import { prisma } from "@/lib/prisma";
export default async function HomePage() {
  const companies = await prisma.company.findMany({
    include: {
      marketplaceAccounts: {
        include: {
          marketplace: true,
        },
      },
    },
    orderBy: {
      name: "asc",
    },
  });
const wbSales = await prisma.wbSale.findMany();

const totalRevenue = wbSales.reduce(
  (sum, item) => sum + Number(item.wbRealizedAmount ?? 0),
  0
);

const totalPayout = wbSales.reduce(
  (sum, item) => sum + Number(item.sellerPayout ?? 0),
  0
);

const totalLogistics = wbSales.reduce(
  (sum, item) => sum + Number(item.logisticsCost ?? 0),
  0
);

const salesCount = wbSales.reduce(
  (sum, item) => sum + Number(item.quantity ?? 0),
  0
);

const formatCurrency = (value: number) =>
  new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0,
  }).format(value);
  return (
    <main className="min-h-screen bg-slate-100 flex">
      {/* Sidebar */}
      <aside className="w-72 bg-white border-r border-slate-200 p-6 flex flex-col">
        <div className="mb-10">
          <h1 className="text-3xl font-bold tracking-tight">
            Marketplace OS
          </h1>

          <p className="text-slate-500 mt-2 text-sm">
            Analytics Platform
          </p>
        </div>

        <nav className="space-y-2">
          <div className="bg-slate-900 text-white rounded-xl px-5 py-4 font-medium">
            Dashboard
          </div>

          <div className="hover:bg-slate-100 rounded-xl px-5 py-4 text-slate-700 cursor-pointer transition">
            Финансы
          </div>

          <div className="hover:bg-slate-100 rounded-xl px-5 py-4 text-slate-700 cursor-pointer transition">
            Реклама
          </div>

          <div className="hover:bg-slate-100 rounded-xl px-5 py-4 text-slate-700 cursor-pointer transition">
            Остатки
          </div>

          <div className="hover:bg-slate-100 rounded-xl px-5 py-4 text-slate-700 cursor-pointer transition">
            ABC-анализ
          </div>

          <div className="hover:bg-slate-100 rounded-xl px-5 py-4 text-slate-700 cursor-pointer transition">
            Импорт отчетов
          </div>
        </nav>

        <div className="mt-auto pt-10">
          <div className="bg-slate-100 rounded-2xl p-5">
            <div className="text-sm text-slate-500 mb-2">
              Активная компания
            </div>

            <div className="font-semibold">
              ИП Петров
            </div>

            <div className="text-sm text-slate-500 mt-1">
              Wildberries / Ozon
            </div>
          </div>
        </div>
      </aside>

      {/* Main */}
      <section className="flex-1 p-10">
        {/* Header */}
        <div className="flex items-center justify-between mb-10">
          <div>
            <h2 className="text-4xl font-bold tracking-tight">
              Dashboard
            </h2>

            <p className="text-slate-500 mt-2">
              Полная оцифровка бизнеса маркетплейсов
            </p>
          </div>

          <button className="bg-slate-900 text-white px-6 py-3 rounded-xl font-medium hover:bg-slate-800 transition">
            Импортировать отчет
          </button>
        </div>

        {/* KPI */}
        <div className="grid grid-cols-4 gap-6 mb-10">
          <div className="bg-white rounded-3xl p-7 shadow-sm border border-slate-200">
            <div className="text-slate-500 text-sm mb-3">
              Выручка
            </div>

            <div className="text-4xl font-bold tracking-tight">
              {formatCurrency(totalRevenue)}
            </div>

            <div className="text-green-600 text-sm mt-3">
              +0% к прошлой неделе
            </div>
          </div>

          <div className="bg-white rounded-3xl p-7 shadow-sm border border-slate-200">
            <div className="text-slate-500 text-sm mb-3">
              Чистая прибыль
            </div>

            <div className="text-4xl font-bold tracking-tight">
              {formatCurrency(totalPayout)}
            </div>

            <div className="text-green-600 text-sm mt-3">
              +0% к прошлой неделе
            </div>
          </div>

          <div className="bg-white rounded-3xl p-7 shadow-sm border border-slate-200">
            <div className="text-slate-500 text-sm mb-3">
              ДРР
            </div>

            <div className="text-4xl font-bold tracking-tight">
              0%
            </div>

            <div className="text-slate-500 text-sm mt-3">
              Реклама
            </div>
          </div>

          <div className="bg-white rounded-3xl p-7 shadow-sm border border-slate-200">
            <div className="text-slate-500 text-sm mb-3">
              Остатки
            </div>

            <div className="text-4xl font-bold tracking-tight">
              {salesCount} шт
            </div>

            <div className="text-slate-500 text-sm mt-3">
              На складах
            </div>
          </div>
        </div>

        {/* Reports */}
        <div className="bg-white rounded-3xl border border-slate-200 shadow-sm p-8">
          <div className="flex items-center justify-between mb-8">
            <div>
              <h3 className="text-2xl font-bold">
                Последние отчеты
              </h3>

              <p className="text-slate-500 mt-2">
                Последние импортированные данные
              </p>
            </div>

            <button className="border border-slate-300 px-5 py-3 rounded-xl hover:bg-slate-100 transition">
              Смотреть все
            </button>
          </div>

          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-200 text-slate-500">
                <th className="text-left py-4 font-medium">
                  Компания
                </th>

                <th className="text-left py-4 font-medium">
                  Маркетплейс
                </th>

                <th className="text-left py-4 font-medium">
                  Период
                </th>

                <th className="text-left py-4 font-medium">
                  Выручка
                </th>

                <th className="text-left py-4 font-medium">
                  Прибыль
                </th>
              </tr>
            </thead>

<tbody>
  {companies.map((company) =>
    company.marketplaceAccounts.map((account) => (
      <tr
        key={account.id}
        className="border-b border-slate-100 hover:bg-slate-50 transition"
      >
        <td className="py-5 font-medium">
          {company.name}
        </td>

        <td>
          {account.marketplace.name}
        </td>

        <td>
          Нет данных
        </td>

        <td className="font-semibold">
          ₽ 0
        </td>

        <td className="font-semibold">
          ₽ 0
        </td>
      </tr>
    ))
  )}
</tbody>
          </table>
        </div>
      </section>
    </main>
  );
}