import Link from "next/link";

const items = [
  {
    title: "Dashboard",
    description: "Главная финансовая панель и сводка по бизнесу.",
    href: "/finance",
  },
  {
    title: "Финансовые операции",
    description: "Добавление и просмотр финансовых операций.",
    href: "/finance/operations",
  },
  {
    title: "ОДДС",
    description: "Движение денежных средств по операциям.",
    href: "/finance/cashflow",
  },
  {
    title: "Денежные счета",
    description: "Карты, расчётные счета, наличные и остатки.",
    href: "/finance/accounts",
  },
  {
    title: "Кредиты и займы",
    description: "Долги, платежи, проценты и график погашения.",
    href: "/finance/loans",
  },
  {
    title: "Платёжный календарь",
    description: "Будущие платежи по датам.",
    href: "/finance/calendar",
  },
  {
    title: "Прогноз ликвидности",
    description: "Остатки денег, будущие платежи и кассовые разрывы.",
    href: "/finance/forecast",
  },
  {
    title: "Справочник статей",
    description: "Категории доходов, расходов и личных операций.",
    href: "/finance/categories",
  },
  
];

export default function FinancePage() {
  return (
    <main className="min-h-screen bg-slate-100 p-8">
      <div className="mx-auto max-w-[1400px] space-y-6">
        <div>
          <h1 className="text-4xl font-bold text-slate-900">Финансы</h1>
          <p className="mt-3 text-slate-500">
            Управленческий финансовый модуль Marketplace Business OS.
          </p>
        </div>

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-2xl bg-white p-6 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
            >
              <div className="text-2xl font-bold text-slate-900">
                {item.title}
              </div>

              <p className="mt-3 text-slate-500">{item.description}</p>

              <div className="mt-5 font-semibold text-slate-900">
                Открыть →
              </div>
            </Link>
          ))}
        </section>
      </div>
    </main>
  );
}