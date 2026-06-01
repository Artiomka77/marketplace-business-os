import Link from "next/link";

const cards = [
  {
    title: "Прибыль WB",
    description:
      "Unit-экономика Wildberries, прибыль по артикулам, налоги и маржинальность.",
    href: "/profit",
  },
  {
    title: "Прибыль Ozon",
    description:
      "Unit-экономика Ozon, прибыль по артикулам, реклама и налоги.",
    href: "/profit-ozon",
  },
  {
    title: "Остатки",
    description:
      "Остатки товаров на складах маркетплейсов и в пути.",
    href: "/stocks",
  },
  {
    title: "ABC-анализ",
    description:
      "Классификация товаров по прибыли и выручке.",
    href: "/profit",
  },
];

export default function AnalyticsPage() {
  return (
    <main className="min-h-screen bg-slate-100 p-8">
      <div className="mx-auto max-w-7xl">
        <h1 className="text-4xl font-bold text-slate-900">
          Аналитика
        </h1>

        <p className="mt-3 text-slate-500">
          Основные аналитические инструменты Marketplace OS
        </p>

        <div className="mt-8 grid gap-6 md:grid-cols-2">
          {cards.map((card) => (
            <Link
              key={card.href + card.title}
              href={card.href}
              className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm transition hover:shadow-md"
            >
              <h2 className="text-2xl font-bold text-slate-900">
                {card.title}
              </h2>

              <p className="mt-3 text-slate-500">
                {card.description}
              </p>
            </Link>
          ))}
        </div>
      </div>
    </main>
  );
}