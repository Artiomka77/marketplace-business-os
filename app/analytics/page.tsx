import Link from "next/link";
import MarketplaceNav from "@/components/marketplaces/MarketplaceNav";

const cards = [
  {
    title: "Прибыль по SKU WB",
    description:
      "Unit-экономика Wildberries, прибыль по артикулам, налоги и маржинальность.",
    href: "/profit-wb",
  },
  {
    title: "Прибыль по SKU Ozon",
    description:
      "Unit-экономика Ozon, прибыль по артикулам, реклама и налоги.",
    href: "/profit-ozon",
  },
  {
    title: "Остатки WB",
    description:
      "Остатки товаров на складах Wildberries и товары в пути.",
    href: "/stocks",
  },
  {
    title: "ABC-анализ",
    description:
      "Классификация товаров по прибыли и выручке.",
    href: "/abc",
  },
  {
    title: "Связки рекламы",
    description:
      "Распределение рекламных кампаний между артикулами.",
    href: "/ads-mapping",
  },
];

export default function AnalyticsPage() {
  return (
    <main className="min-h-screen bg-slate-100">
      <MarketplaceNav />

      <div className="mx-auto max-w-7xl p-8">
        <h1 className="text-4xl font-bold text-slate-900">
          Аналитика маркетплейсов
        </h1>

        <p className="mt-3 text-slate-500">
          Основные инструменты анализа продаж, рекламы и прибыли.
        </p>

        <div className="mt-8 grid gap-6 md:grid-cols-2 xl:grid-cols-3">
          {cards.map((card) => (
            <Link
              key={card.href}
              href={card.href}
              className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm transition hover:shadow-md"
            >
              <h2 className="text-2xl font-bold text-slate-900">
                {card.title}
              </h2>

              <p className="mt-3 text-slate-500">
                {card.description}
              </p>

              <div className="mt-5 font-semibold text-slate-900">
                Открыть →
              </div>
            </Link>
          ))}
        </div>
      </div>
    </main>
  );
}