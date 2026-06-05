"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const items = [
  {
    title: "Dashboard",
    href: "/",
  },
  {
    title: "Аналитика",
    href: "/analytics",
  },
  {
    title: "Финансы",
    href: "/finance",
  },
  {
    title: "Импорт",
    href: "/import",
  },
  {
    title: "Настройки",
    href: "/settings/companies",
  },
];

export default function AppNav() {
  const pathname = usePathname();

  return (
    <div className="sticky top-0 z-50 border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-[1800px] gap-2 overflow-x-auto px-8 py-3">
        {items.map((item) => {
          const isActive =
            item.href === "/"
              ? pathname === "/"
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