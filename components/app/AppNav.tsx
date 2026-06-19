"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

const SIDEBAR_STORAGE_KEY = "marketplace-os-sidebar-collapsed";

const items = [
  {
    title: "Главная",
    href: "/",
    icon: "⌂",
  },
  {
    title: "Центр прибыли",
    href: "/insights",
    icon: "◎",
  },
  {
    title: "Аналитика",
    href: "/analytics",
    icon: "▦",
  },
  {
    title: "Финансы",
    href: "/finance",
    icon: "₽",
  },
  {
    title: "Реклама",
    href: "/ads-mapping",
    icon: "↗",
  },
  {
    title: "Остатки",
    href: "/stocks",
    icon: "▣",
  },
  {
    title: "ABC / ассортимент",
    href: "/abc",
    icon: "◔",
  },
  {
    title: "Импорт",
    href: "/import",
    icon: "⇧",
  },
  {
    title: "Настройки",
    href: "/settings/companies",
    activePrefix: "/settings",
    icon: "⚙",
  },
];

function isItemActive(pathname: string, item: (typeof items)[number]) {
  if (item.href === "/") return pathname === "/";
  return pathname.startsWith(item.activePrefix ?? item.href);
}

export default function AppNav() {
  const pathname = usePathname();
  const [isCollapsed, setIsCollapsed] = useState(false);

  useEffect(() => {
    const savedValue = window.localStorage.getItem(SIDEBAR_STORAGE_KEY);
    const nextCollapsed = savedValue === "true";

    setIsCollapsed(nextCollapsed);
    document.documentElement.dataset.sidebar = nextCollapsed
      ? "collapsed"
      : "expanded";
  }, []);

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(isCollapsed));
    document.documentElement.dataset.sidebar = isCollapsed
      ? "collapsed"
      : "expanded";
  }, [isCollapsed]);

  return (
    <>
      <aside
        className={`fixed inset-y-0 left-0 z-[80] hidden flex-col border-r border-slate-200 bg-white/90 shadow-xl shadow-slate-200/40 backdrop-blur-xl transition-[width] duration-300 lg:flex ${
          isCollapsed ? "w-20" : "w-72"
        }`}
      >
        <div
          className={`flex h-20 items-center border-b border-slate-100 px-4 ${
            isCollapsed ? "justify-center" : "gap-3"
          }`}
        >
          <Link
            href="/"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-indigo-600 text-lg font-black text-white shadow-lg shadow-indigo-200"
            aria-label="Marketplace OS"
          >
            OS
          </Link>

          {!isCollapsed ? (
            <div className="min-w-0">
              <div className="truncate text-base font-black leading-tight tracking-tight text-slate-950">
                Marketplace OS
              </div>
              <div className="mt-1 truncate text-xs font-semibold text-slate-500">
                Аналитика бизнеса
              </div>
            </div>
          ) : null}
        </div>

        <div className="border-b border-slate-100 px-4 py-3">
          <button
            type="button"
            onClick={() => setIsCollapsed((value) => !value)}
            className={`flex w-full items-center rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-bold text-slate-600 shadow-sm transition hover:bg-slate-50 hover:text-slate-950 ${
              isCollapsed ? "justify-center" : "justify-between gap-3"
            }`}
            title={isCollapsed ? "Показать меню" : "Скрыть меню"}
          >
            <span className="text-base">{isCollapsed ? "→" : "←"}</span>
            {!isCollapsed ? <span>Скрыть меню</span> : null}
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-5">
          <div className="space-y-1">
            {items.map((item) => {
              const active = isItemActive(pathname, item);

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  title={item.title}
                  className={`group flex items-center rounded-2xl px-3 py-3 text-sm font-bold transition ${
                    isCollapsed ? "justify-center" : "gap-3"
                  } ${
                    active
                      ? "bg-indigo-50 text-indigo-700 shadow-sm ring-1 ring-indigo-100"
                      : "text-slate-600 hover:bg-slate-50 hover:text-slate-950"
                  }`}
                >
                  <span
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-sm transition ${
                      active
                        ? "bg-white text-indigo-700 shadow-sm"
                        : "bg-slate-100 text-slate-500 group-hover:bg-white group-hover:text-slate-950"
                    }`}
                  >
                    {item.icon}
                  </span>
                  {!isCollapsed ? <span className="truncate">{item.title}</span> : null}
                </Link>
              );
            })}
          </div>
        </nav>

        <div className="border-t border-slate-100 p-4">
          {!isCollapsed ? (
            <div className="rounded-3xl bg-slate-50 p-4 ring-1 ring-slate-200">
              <div className="text-sm font-black text-slate-950">
                Нужна помощь?
              </div>
              <p className="mt-1 text-xs leading-5 text-slate-500">
                Открой настройки, импорт или финансовые разделы из меню слева.
              </p>
            </div>
          ) : null}

          <a
            href="/auth/sign-out"
            className={`mt-3 flex items-center justify-center rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-600 transition hover:bg-slate-50 hover:text-slate-950 ${
              isCollapsed ? "px-0" : ""
            }`}
            title="Выйти"
          >
            {isCollapsed ? "⎋" : "Выйти"}
          </a>
        </div>
      </aside>

      <header className="sticky top-0 z-[80] border-b border-slate-200 bg-white/90 backdrop-blur-xl lg:hidden">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <Link href="/" className="flex items-center gap-2">
            <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-indigo-600 text-sm font-black text-white">
              OS
            </span>
            <span className="text-sm font-black text-slate-950">
              Marketplace OS
            </span>
          </Link>

          <a
            href="/auth/sign-out"
            className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-slate-600"
          >
            Выйти
          </a>
        </div>

        <nav className="flex gap-2 overflow-x-auto px-4 pb-3">
          {items.map((item) => {
            const active = isItemActive(pathname, item);

            return (
              <Link
                key={item.href}
                href={item.href}
                className={`whitespace-nowrap rounded-2xl px-4 py-2 text-sm font-bold ${
                  active
                    ? "bg-indigo-50 text-indigo-700 ring-1 ring-indigo-100"
                    : "bg-slate-50 text-slate-600"
                }`}
              >
                {item.title}
              </Link>
            );
          })}
        </nav>
      </header>
    </>
  );
}
