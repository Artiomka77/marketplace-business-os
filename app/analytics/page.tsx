import Link from "next/link";

const analyticsModules = [
  {
    title: "Прибыль по SKU WB",
    subtitle: "Wildberries",
    description:
      "Какие товары зарабатывают, а какие убыточны на Wildberries.",
    href: "/profit-wb",
    icon: "WB",
    tone: "bg-violet-50 text-violet-700 ring-violet-100",
    buttonTone:
      "border-violet-200 bg-violet-50 text-violet-700 hover:bg-violet-100",
    checks: [
      "Unit-экономика по SKU",
      "Маржинальность и налоги",
      "Детализация по заказам и складам",
    ],
  },
  {
    title: "Прибыль по SKU Ozon",
    subtitle: "Ozon",
    description:
      "Где прибыль съедают комиссии, логистика и реклама на Ozon.",
    href: "/profit-ozon",
    icon: "OZ",
    tone: "bg-sky-50 text-sky-700 ring-sky-100",
    buttonTone: "border-sky-200 bg-sky-50 text-sky-700 hover:bg-sky-100",
    checks: [
      "Unit-экономика по SKU",
      "Комиссии, логистика, реклама",
      "Маржинальность и прибыль",
    ],
  },
  {
    title: "ABC-анализ",
    subtitle: "Ассортимент",
    description:
      "Классификация товаров по прибыли и выручке для управленческих решений.",
    href: "/abc",
    icon: "ABC",
    tone: "bg-emerald-50 text-emerald-700 ring-emerald-100",
    buttonTone:
      "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100",
    checks: [
      "ABC по прибыли и выручке",
      "Доля в прибыли и выручке",
      "Рекомендации по ассортименту",
    ],
  },
  {
    title: "Остатки",
    subtitle: "Склады",
    description:
      "Где деньги заморожены в товаре и какие запасы требуют внимания.",
    href: "/stocks",
    icon: "▣",
    tone: "bg-orange-50 text-orange-700 ring-orange-100",
    buttonTone:
      "border-orange-200 bg-orange-50 text-orange-700 hover:bg-orange-100",
    checks: [
      "Остатки по складам и маркетплейсам",
      "Товары в пути",
      "Оборачиваемость и заморозка",
    ],
  },
];

const routeSteps = [
  {
    number: "1",
    title: "Сначала прибыль",
    text:
      "Найдите прибыльные и убыточные SKU. Проверьте маржинальность, налоги и себестоимость.",
    tone: "border-emerald-100 bg-emerald-50/70",
    numberTone: "text-emerald-700",
  },
  {
    number: "2",
    title: "Потом реклама",
    text:
      "Оцените эффективность рекламы. Проверьте ДРР и связки кампаний с артикулами.",
    tone: "border-indigo-100 bg-indigo-50/70",
    numberTone: "text-indigo-700",
  },
  {
    number: "3",
    title: "Затем остатки и ABC",
    text:
      "Проверьте остатки и оборачиваемость. Используйте ABC для решений по ассортименту.",
    tone: "border-orange-100 bg-orange-50/70",
    numberTone: "text-orange-700",
  },
];

const nextActions = [
  {
    title: "Рекламные связки",
    description: "Проверьте распределение кампаний по артикулам.",
    href: "/ads-mapping",
    icon: "🔗",
    tone: "bg-violet-50 text-violet-700 ring-violet-100",
  },
  {
    title: "Сравнить периоды",
    description: "Оцените динамику выручки и прибыли.",
    href: "/analytics",
    icon: "↗",
    tone: "bg-sky-50 text-sky-700 ring-sky-100",
  },
  {
    title: "План / Факт",
    description: "Сравните плановые и фактические показатели.",
    href: "/finance/plan-fact",
    icon: "▦",
    tone: "bg-emerald-50 text-emerald-700 ring-emerald-100",
  },
  {
    title: "Импорт данных",
    description: "Загрузите новые отчёты WB, Ozon и других систем.",
    href: "/import",
    icon: "⇧",
    tone: "bg-orange-50 text-orange-700 ring-orange-100",
  },
  {
    title: "API-подключения",
    description: "Настройте и проверьте подключения к API.",
    href: "/settings/api-connections",
    icon: "⚙",
    tone: "bg-slate-100 text-slate-700 ring-slate-200",
  },
];

const decisionRules = [
  {
    title: "Выручка без прибыли — не результат.",
    text: "Смотрите на чистую прибыль и маржинальность, а не только на оборот.",
    icon: "✓",
    tone: "bg-emerald-50 text-emerald-700 ring-emerald-100",
  },
  {
    title: "ДРР смотреть только вместе с маржинальностью.",
    text: "Высокий ДРР допустим, если он окупается прибылью.",
    icon: "↗",
    tone: "bg-sky-50 text-sky-700 ring-sky-100",
  },
  {
    title: "ABC использовать для решений по ассортименту.",
    text: "A — усиливать, B — поддерживать, C — распродавать или пересматривать.",
    icon: "▣",
    tone: "bg-orange-50 text-orange-700 ring-orange-100",
  },
];

function CheckItem({ children }: { children: string }) {
  return (
    <li className="flex items-start gap-3 text-sm leading-6 text-slate-600">
      <span className="mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-50 text-xs font-black text-indigo-700 ring-1 ring-indigo-100">
        ✓
      </span>
      <span>{children}</span>
    </li>
  );
}

function AnalyticsModuleCard({
  item,
}: {
  item: (typeof analyticsModules)[number];
}) {
  return (
    <article className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm shadow-slate-200/50">
      <div className="flex items-start gap-4">
        <div
          className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-3xl text-base font-black ring-1 ${item.tone}`}
        >
          {item.icon}
        </div>

        <div className="min-w-0">
          <div className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">
            {item.subtitle}
          </div>
          <h2 className="mt-2 text-xl font-black tracking-tight text-slate-950">
            {item.title}
          </h2>
          <p className="mt-2 text-sm leading-6 text-slate-500">
            {item.description}
          </p>
        </div>
      </div>

      <ul className="mt-5 space-y-2">
        {item.checks.map((check) => (
          <CheckItem key={check}>{check}</CheckItem>
        ))}
      </ul>

      <Link
        href={item.href}
        className={`mt-5 inline-flex items-center justify-center rounded-2xl border px-4 py-2 text-sm font-black transition ${item.buttonTone}`}
      >
        Открыть раздел →
      </Link>
    </article>
  );
}

function NextActionCard({ item }: { item: (typeof nextActions)[number] }) {
  return (
    <Link
      href={item.href}
      className="group flex min-h-[150px] flex-col rounded-3xl border border-slate-200 bg-white p-4 shadow-sm shadow-slate-200/40 transition hover:-translate-y-0.5 hover:border-indigo-200 hover:shadow-md"
    >
      <div
        className={`flex h-11 w-11 items-center justify-center rounded-2xl text-sm font-black ring-1 ${item.tone}`}
      >
        {item.icon}
      </div>

      <div className="mt-4 text-sm font-black text-slate-950">
        {item.title}
      </div>
      <p className="mt-2 text-xs leading-5 text-slate-500">
        {item.description}
      </p>

      <div className="mt-auto pt-3 text-right text-base font-black text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-indigo-500">
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
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(520px,0.85fr)] xl:items-center">
            <div>
              <div className="section-eyebrow">Аналитика</div>
              <h1 className="mt-2 text-3xl font-black tracking-tight text-slate-950 sm:text-4xl">
                Аналитика маркетплейсов
              </h1>
              <p className="mt-4 max-w-3xl text-base leading-7 text-slate-500">
                Выберите, что хотите проверить: прибыль, рекламу, ассортимент
                или остатки. Начните с главного, затем углубляйтесь в детали.
              </p>
            </div>

            <div className="grid gap-3 rounded-[28px] border border-slate-200 bg-white p-3 shadow-sm md:grid-cols-3">
              <div className="flex items-center gap-3 rounded-3xl bg-slate-50 p-4 ring-1 ring-slate-200">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-violet-50 text-xl text-violet-700 ring-1 ring-violet-100">
                  ↗
                </div>
                <div>
                  <div className="text-sm font-black text-slate-950">
                    Прибыль
                  </div>
                  <div className="mt-1 text-xs leading-5 text-slate-500">
                    Что приносит прибыль
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-3 rounded-3xl bg-slate-50 p-4 ring-1 ring-slate-200">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-sky-50 text-xl text-sky-700 ring-1 ring-sky-100">
                  📣
                </div>
                <div>
                  <div className="text-sm font-black text-slate-950">
                    Реклама
                  </div>
                  <div className="mt-1 text-xs leading-5 text-slate-500">
                    Эффективность кампаний
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-3 rounded-3xl bg-slate-50 p-4 ring-1 ring-slate-200">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-emerald-50 text-xl text-emerald-700 ring-1 ring-emerald-100">
                  ◇
                </div>
                <div>
                  <div className="text-sm font-black text-slate-950">
                    Остатки и ABC
                  </div>
                  <div className="mt-1 text-xs leading-5 text-slate-500">
                    Деньги в товаре
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="grid gap-5 xl:grid-cols-[minmax(0,4fr)_minmax(340px,2fr)]">
          <section className="panel min-w-0 p-5 sm:p-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <div className="section-eyebrow">Основные разделы аналитики</div>
                <h2 className="mt-1 text-2xl font-black tracking-tight text-slate-950">
                  Что смотреть собственнику
                </h2>
              </div>

              <Link
                href="/"
                className="inline-flex items-center justify-center rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-black text-slate-700 shadow-sm transition hover:bg-slate-50 hover:text-slate-950"
              >
                Вернуться на Dashboard
              </Link>
            </div>

            <div className="mt-5 grid gap-4 md:grid-cols-2">
              {analyticsModules.map((item) => (
                <AnalyticsModuleCard key={item.href} item={item} />
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
              {routeSteps.map((step) => (
                <div
                  key={step.number}
                  className={`rounded-3xl border p-4 ${step.tone}`}
                >
                  <div className="flex items-start gap-3">
                    <div
                      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-white text-sm font-black shadow-sm ${step.numberTone}`}
                    >
                      {step.number}
                    </div>

                    <div>
                      <div className={`text-sm font-black ${step.numberTone}`}>
                        {step.title}
                      </div>
                      <p className="mt-1 text-sm leading-6 text-slate-600">
                        {step.text}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-4 rounded-3xl border border-slate-200 bg-white p-4 shadow-sm shadow-slate-200/40">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-slate-100 text-slate-600 ring-1 ring-slate-200">
                  ⚙
                </div>
                <div>
                  <div className="text-sm font-black text-slate-950">
                    Главная цель
                  </div>
                  <p className="mt-1 text-sm leading-6 text-slate-500">
                    Максимизировать прибыль, управляя рекламой, ассортиментом и
                    запасами.
                  </p>
                </div>
              </div>
            </div>
          </aside>
        </section>

        <section className="grid gap-5 xl:grid-cols-[minmax(0,4fr)_minmax(340px,2fr)]">
          <section className="panel min-w-0 p-5 sm:p-6">
            <div>
              <div className="section-eyebrow">Следующий шаг</div>
              <h2 className="mt-1 text-2xl font-black tracking-tight text-slate-950">
                Что сделать дальше
              </h2>
            </div>

            <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5 xl:grid-cols-5">
              {nextActions.map((item) => (
                <NextActionCard key={item.href + item.title} item={item} />
              ))}
            </div>
          </section>

          <aside className="panel min-w-0 p-5 sm:p-6">
            <div>
              <div className="section-eyebrow">Правила принятия решений</div>
              <h2 className="mt-1 text-2xl font-black tracking-tight text-slate-950">
                Как читать аналитику
              </h2>
            </div>

            <div className="mt-5 space-y-3">
              {decisionRules.map((rule) => (
                <div
                  key={rule.title}
                  className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm shadow-slate-200/40"
                >
                  <div className="flex items-start gap-3">
                    <div
                      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl text-sm font-black ring-1 ${rule.tone}`}
                    >
                      {rule.icon}
                    </div>

                    <div>
                      <div className="text-sm font-black text-slate-950">
                        {rule.title}
                      </div>
                      <p className="mt-1 text-sm leading-6 text-slate-500">
                        {rule.text}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </aside>
        </section>
      </div>
    </main>
  );
}
