import Link from "next/link";

const primaryCards = [
  {
    title: "Прибыль WB",
    subtitle: "Wildberries",
    description:
      "Прибыль по SKU, реклама, себестоимость, налоги, маржинальность и ABC по товарам WB.",
    href: "/profit-wb",
    icon: "WB",
    tone: "bg-violet-50 text-violet-700 ring-violet-100",
    accent: "from-violet-600 to-violet-300",
    metrics: ["SKU", "Прибыль", "ДРР", "ABC"],
  },
  {
    title: "Прибыль Ozon",
    subtitle: "Ozon",
    description:
      "Unit-экономика Ozon: выручка, комиссии, логистика, реклама, себестоимость и прибыль.",
    href: "/profit-ozon",
    icon: "OZ",
    tone: "bg-sky-50 text-sky-700 ring-sky-100",
    accent: "from-sky-500 to-sky-200",
    metrics: ["SKU", "Комиссии", "Реклама", "Налоги"],
  },
  {
    title: "ABC-анализ",
    subtitle: "Ассортимент",
    description:
      "Классификация товаров по прибыли и выручке: какие SKU дают результат, а какие замораживают деньги.",
    href: "/abc",
    icon: "ABC",
    tone: "bg-emerald-50 text-emerald-700 ring-emerald-100",
    accent: "from-emerald-500 to-emerald-200",
    metrics: ["A", "B", "C", "SKU"],
  },
  {
    title: "Остатки",
    subtitle: "Склады",
    description:
      "Текущие остатки WB и Ozon, товары в пути и контроль складских запасов по артикулам.",
    href: "/stocks",
    icon: "▣",
    tone: "bg-amber-50 text-amber-700 ring-amber-100",
    accent: "from-amber-500 to-amber-200",
    metrics: ["WB", "Ozon", "В пути", "Склады"],
  },
];

const quickActions = [
  {
    title: "Центр прибыли",
    description: "Сводка по прибыли, рекламе и проблемным зонам.",
    href: "/insights",
    icon: "◎",
  },
  {
    title: "Связки рекламы",
    description: "Распределить кампании между артикулами.",
    href: "/ads-mapping",
    icon: "↗",
  },
  {
    title: "План / Факт",
    description: "Сравнить фактический результат с планом.",
    href: "/finance/plan-fact",
    icon: "≋",
  },
  {
    title: "Импорт данных",
    description: "Загрузить отчёты WB, Ozon, рекламу и остатки.",
    href: "/import",
    icon: "⇧",
  },
  {
    title: "API-подключения",
    description: "Настроить автоматическую загрузку данных.",
    href: "/settings/api-connections",
    icon: "⚙",
  },
];

const focusItems = [
  {
    title: "Сначала прибыль",
    text: "Начинай с WB/Ozon прибыли по SKU: там видно, какие товары реально зарабатывают.",
    tone: "border-emerald-100 bg-emerald-50/60 text-emerald-700",
  },
  {
    title: "Потом реклама",
    text: "Если ДРР растёт быстрее прибыли, проверь связки рекламных кампаний.",
    tone: "border-violet-100 bg-violet-50/60 text-violet-700",
  },
  {
    title: "Затем остатки",
    text: "Остатки и ABC показывают, где деньги заморожены в товаре.",
    tone: "border-amber-100 bg-amber-50/60 text-amber-700",
  },
];

function ModuleCard({
  card,
}: {
  card: (typeof primaryCards)[number];
}) {
  return (
    <Link
      href={card.href}
      className="group flex min-h-[230px] flex-col rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm shadow-slate-200/50 transition hover:-translate-y-0.5 hover:border-indigo-200 hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-4">
        <div className={`flex h-12 w-12 items-center justify-center rounded-2xl text-sm font-black ring-1 ${card.tone}`}>
          {card.icon}
        </div>

        <div className="rounded-full bg-slate-50 px-3 py-1 text-xs font-black text-slate-400 ring-1 ring-slate-200 transition group-hover:bg-indigo-50 group-hover:text-indigo-700 group-hover:ring-indigo-100">
          Открыть →
        </div>
      </div>

      <div className="mt-5">
        <div className="text-xs font-black uppercase tracking-[0.14em] text-slate-400">
          {card.subtitle}
        </div>

        <h2 className="mt-2 text-2xl font-black tracking-tight text-slate-950">
          {card.title}
        </h2>

        <p className="mt-3 text-sm leading-6 text-slate-500">
          {card.description}
        </p>
      </div>

      <div className="mt-auto pt-5">
        <div className="h-2 overflow-hidden rounded-full bg-slate-100">
          <div className={`h-full w-2/3 rounded-full bg-gradient-to-r ${card.accent}`} />
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {card.metrics.map((metric) => (
            <span
              key={metric}
              className="rounded-full bg-slate-50 px-3 py-1 text-xs font-bold text-slate-500 ring-1 ring-slate-200"
            >
              {metric}
            </span>
          ))}
        </div>
      </div>
    </Link>
  );
}

function QuickAction({
  item,
}: {
  item: (typeof quickActions)[number];
}) {
  return (
    <Link
      href={item.href}
      className="group flex items-center gap-3 rounded-2xl border border-slate-200 bg-white p-3 transition hover:border-indigo-200 hover:bg-indigo-50/30"
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-indigo-50 text-sm font-black text-indigo-700 ring-1 ring-indigo-100">
        {item.icon}
      </div>

      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-black text-slate-950">
          {item.title}
        </div>
        <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500">
          {item.description}
        </p>
      </div>

      <div className="text-base font-black text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-indigo-500">
        →
      </div>
    </Link>
  );
}

export default function AnalyticsPage() {
  return (
    <main className="page-shell">
      <div className="page-container">
        <section className="panel p-5 sm:p-6">
          <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <div className="section-eyebrow">Аналитика</div>
              <h1 className="mt-2 text-3xl font-black tracking-tight text-slate-950 sm:text-4xl">
                Аналитика маркетплейсов
              </h1>
              <p className="mt-3 max-w-3xl text-base leading-7 text-slate-500">
                Единый вход в прибыль по SKU, рекламу, остатки и ABC-анализ.
                Начинай с прибыли, затем проверяй рекламу и ассортимент.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-3 xl:min-w-[560px]">
              <div className="rounded-3xl border border-slate-200 bg-slate-50 p-4">
                <div className="text-xs font-black uppercase tracking-[0.12em] text-slate-400">
                  Главный фокус
                </div>
                <div className="mt-2 text-lg font-black text-slate-950">
                  Прибыль по SKU
                </div>
              </div>

              <div className="rounded-3xl border border-slate-200 bg-slate-50 p-4">
                <div className="text-xs font-black uppercase tracking-[0.12em] text-slate-400">
                  Контроль
                </div>
                <div className="mt-2 text-lg font-black text-slate-950">
                  Реклама / ДРР
                </div>
              </div>

              <div className="rounded-3xl border border-slate-200 bg-slate-50 p-4">
                <div className="text-xs font-black uppercase tracking-[0.12em] text-slate-400">
                  Деньги в товаре
                </div>
                <div className="mt-2 text-lg font-black text-slate-950">
                  Остатки / ABC
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="grid gap-5 xl:grid-cols-[minmax(0,4fr)_minmax(320px,2fr)]">
          <section className="panel min-w-0 p-5 sm:p-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <div className="section-eyebrow">Разделы аналитики</div>
                <h2 className="mt-1 text-2xl font-black tracking-tight text-slate-950">
                  Что смотреть собственнику
                </h2>
              </div>

              <Link href="/" className="secondary-button">
                Вернуться на Dashboard
              </Link>
            </div>

            <div className="mt-5 grid gap-4 md:grid-cols-2">
              {primaryCards.map((card) => (
                <ModuleCard key={card.href} card={card} />
              ))}
            </div>
          </section>

          <aside className="panel min-w-0 p-5 sm:p-6">
            <div>
              <div className="section-eyebrow">Маршрут анализа</div>
              <h2 className="mt-1 text-2xl font-black tracking-tight text-slate-950">
                Что проверить сначала
              </h2>
            </div>

            <div className="mt-5 space-y-3">
              {focusItems.map((item, index) => (
                <div
                  key={item.title}
                  className={`rounded-3xl border p-4 ${item.tone}`}
                >
                  <div className="flex items-start gap-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-2xl bg-white text-sm font-black shadow-sm">
                      {index + 1}
                    </div>

                    <div>
                      <div className="text-sm font-black">{item.title}</div>
                      <p className="mt-1 text-sm leading-6 text-slate-600">
                        {item.text}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-5 rounded-3xl border border-slate-200 bg-white p-4">
              <div className="text-sm font-black text-slate-950">
                Быстрый вывод
              </div>
              <p className="mt-2 text-sm leading-6 text-slate-500">
                Если прибыль просела — не начинай с рекламы вслепую. Сначала
                проверь SKU, потом рекламные связки, затем остатки и ABC.
              </p>
            </div>
          </aside>
        </section>

        <section className="grid gap-5 xl:grid-cols-[minmax(0,4fr)_minmax(320px,2fr)]">
          <section className="panel min-w-0 p-5 sm:p-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <div className="section-eyebrow">Связанные страницы</div>
                <h2 className="mt-1 text-2xl font-black tracking-tight text-slate-950">
                  Быстрый переход к деталям
                </h2>
              </div>
            </div>

            <div className="mt-5 grid gap-3 md:grid-cols-2">
              {quickActions.map((item) => (
                <QuickAction key={item.href + item.title} item={item} />
              ))}
            </div>
          </section>

          <aside className="panel min-w-0 p-5 sm:p-6">
            <div>
              <div className="section-eyebrow">Качество решения</div>
              <h2 className="mt-1 text-2xl font-black tracking-tight text-slate-950">
                Как читать аналитику
              </h2>
            </div>

            <div className="mt-5 space-y-3 text-sm leading-6 text-slate-600">
              <p className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200">
                <span className="font-black text-slate-950">Прибыль</span> —
                главный фильтр. Высокая выручка без прибыли не является хорошим
                результатом.
              </p>

              <p className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200">
                <span className="font-black text-slate-950">ДРР</span> нужно
                смотреть вместе с маржинальностью. Низкий ДРР не спасает товар,
                если себестоимость и логистика съедают прибыль.
              </p>

              <p className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200">
                <span className="font-black text-slate-950">ABC</span> помогает
                не спорить с эмоциями: A — усиливать, C — проверять на заморозку
                денег.
              </p>
            </div>
          </aside>
        </section>
      </div>
    </main>
  );
}
