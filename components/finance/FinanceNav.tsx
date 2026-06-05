"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const items = [
  { title: "Dashboard", href: "/finance" },
  { title: "Финансовые операции", href: "/finance/operations" },
  { title: "ОДДС", href: "/finance/cashflow" },
  { title: "Счета", href: "/finance/accounts" },
  { title: "Кредиты", href: "/finance/loans" },
  { title: "Платёжный календарь", href: "/finance/calendar" },
  { title: "Прогноз ликвидности", href: "/finance/forecast" },
  { title: "Справочник статей", href: "/finance/categories" },
];

export default function FinanceNav() {
  const pathname = usePathname();

  return (
    <div className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-[1600px] gap-2 overflow-x-auto px-8 py-3">
        {items.map((item) => {
          const isActive =
            item.href === "/finance"
              ? pathname === "/finance"
              : pathname.startsWith(item.href);

          return (
            <Link
              key={item.href}
              href={item.href}
              className={`whitespace-nowrap rounded-xl px-4 py-2 text-sm font-semibold transition ${
                isActive
                  ? "bg-slate-900 text-white"
                  : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
              }`}
            >
              {item.title}
            </Link>
          );
        })}
      </div>
    </div>
  );
}