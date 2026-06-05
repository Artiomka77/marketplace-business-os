import Link from "next/link";
import { prisma } from "@/lib/prisma";
import MarketplaceNav from "@/components/marketplaces/MarketplaceNav";

function formatNumber(value: number) {
  return value.toLocaleString("ru-RU");
}

function extractStockDate(fileName?: string | null, fallback?: Date) {
  const match = fileName?.match(/\d{4}_\d{1,2}_\d{1,2}/)?.[0];

  if (match) {
    const [year, month, day] = match.split("_");
    return `${day}.${month}.${year}`;
  }

  return fallback ? fallback.toLocaleDateString("ru-RU") : "Нет данных";
}

export default async function StocksPage() {
  const latestStockImport = await prisma.importSession.findFirst({
    where: { reportType: "WB_STOCK" },
    orderBy: { createdAt: "desc" },
  });

  const stocks = latestStockImport
    ? await prisma.wbStock.findMany({
        where: {
          importSessionId: latestStockImport.id,
          warehouseName: "__TOTAL__",
        },
        orderBy: [{ vendorCode: "asc" }, { size: "asc" }],
      })
    : [];

  const totalStock = stocks.reduce(
    (sum, item) => sum + Number(item.totalStock ?? 0),
    0
  );

  const totalTransitToCustomer = stocks.reduce(
    (sum, item) => sum + Number(item.inTransitToCustomer ?? 0),
    0
  );

  const totalTransitReturns = stocks.reduce(
    (sum, item) => sum + Number(item.inTransitReturns ?? 0),
    0
  );

  const grandTotal =
    totalStock + totalTransitToCustomer + totalTransitReturns;

  const stockDate = extractStockDate(
    latestStockImport?.fileName,
    latestStockImport?.createdAt
  );

  return (
    <main className="min-h-screen bg-slate-100">
  <MarketplaceNav />

  <div className="p-8">
      <div className="max-w-7xl mx-auto space-y-8">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-4xl font-bold tracking-tight">
              Остатки WB
            </h1>

            <p className="text-slate-500 mt-3">
              Срез остатков на дату: {stockDate}
            </p>
          </div>

          <Link
            href="/"
            className="bg-slate-900 text-white px-6 py-4 rounded-2xl font-semibold"
          >
            Назад в Dashboard
          </Link>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
          <div className="bg-white rounded-3xl border border-slate-200 p-7 shadow-sm">
            <div className="text-slate-500 text-sm mb-3">
              Всего на складах
            </div>
            <div className="text-3xl font-bold">
              {formatNumber(totalStock)} шт
            </div>
          </div>

          <div className="bg-white rounded-3xl border border-slate-200 p-7 shadow-sm">
            <div className="text-slate-500 text-sm mb-3">
              В пути к покупателям
            </div>
            <div className="text-3xl font-bold">
              {formatNumber(totalTransitToCustomer)} шт
            </div>
          </div>

          <div className="bg-white rounded-3xl border border-slate-200 p-7 shadow-sm">
            <div className="text-slate-500 text-sm mb-3">
              Возвраты в пути
            </div>
            <div className="text-3xl font-bold">
              {formatNumber(totalTransitReturns)} шт
            </div>
          </div>

          <div className="bg-white rounded-3xl border border-slate-200 p-7 shadow-sm">
            <div className="text-slate-500 text-sm mb-3">
              Итого товарных единиц
            </div>
            <div className="text-3xl font-bold">
              {formatNumber(grandTotal)} шт
            </div>
          </div>
        </div>

        <div className="bg-white rounded-3xl border border-slate-200 shadow-sm p-8">
          <h2 className="text-2xl font-bold mb-6">
            Остатки по артикулам и размерам
          </h2>

          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-200 text-slate-500">
                <th className="text-left py-4">Артикул</th>
                <th className="text-left py-4">Баркод</th>
                <th className="text-left py-4">Размер</th>
                <th className="text-left py-4">На складах</th>
                <th className="text-left py-4">К покупателям</th>
                <th className="text-left py-4">Возвраты</th>
                <th className="text-left py-4">Итого</th>
              </tr>
            </thead>

            <tbody>
              {stocks.map((item) => {
                const rowTotal =
                  Number(item.totalStock ?? 0) +
                  Number(item.inTransitToCustomer ?? 0) +
                  Number(item.inTransitReturns ?? 0);

                return (
                  <tr
                    key={item.id}
                    className="border-b border-slate-100 hover:bg-slate-50"
                  >
                    <td className="py-4 font-medium">
                      {item.vendorCode ?? "—"}
                    </td>
                    <td>{item.barcode ?? "—"}</td>
                    <td>{item.size ?? "—"}</td>
                    <td>{formatNumber(Number(item.totalStock ?? 0))}</td>
                    <td>
                      {formatNumber(Number(item.inTransitToCustomer ?? 0))}
                    </td>
                    <td>{formatNumber(Number(item.inTransitReturns ?? 0))}</td>
                    <td className="font-semibold">
                      {formatNumber(rowTotal)}
                    </td>
                  </tr>
                );
              })}

              {stocks.length === 0 && (
                <tr>
                  <td
                    colSpan={7}
                    className="py-10 text-center text-slate-500"
                  >
                    WB Остатки пока не загружены
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

    </div>
    </main>
  );
}