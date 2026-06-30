"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";

const SIDEBAR_STORAGE_KEY = "marketplace-os-sidebar-collapsed";

type NavChild = {
  title: string;
  href: string;
  description?: string;
};

type NavSection = {
  title: string;
  href: string;
  icon: string;
  activePrefix?: string;
  children?: NavChild[];
};

const sections: NavSection[] = [
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
    activePrefix: "/analytics",
    icon: "▦",
    children: [
      {
        title: "Общая аналитика",
        href: "/analytics",
      },
      {
        title: "Прибыль WB",
        href: "/profit-wb",
      },
      {
        title: "Прибыль Ozon",
        href: "/profit-ozon",
      },
      {
        title: "ABC-анализ",
        href: "/abc",
      },
      {
        title: "Остатки",
        href: "/stocks",
      },
    ],
  },
  {
    title: "Реклама",
    href: "/ads-mapping",
    activePrefix: "/ads-mapping",
    icon: "↗",
    children: [
      {
        title: "Связки кампаний",
        href: "/ads-mapping",
      },
    ],
  },
  {
    title: "Финансы",
    href: "/finance",
    activePrefix: "/finance",
    icon: "₽",
    children: [
      {
        title: "Финансовый Dashboard",
        href: "/finance",
      },
      {
        title: "Операции",
        href: "/finance/operations",
      },
      {
        title: "ОДДС",
        href: "/finance/cashflow",
      },
      {
        title: "План / Факт",
        href: "/finance/plan-fact",
      },
      {
        title: "Платёжный календарь",
        href: "/finance/calendar",
      },
      {
        title: "Прогноз ликвидности",
        href: "/finance/forecast",
      },
      {
        title: "Счета",
        href: "/finance/accounts",
      },
      {
        title: "Кредиты",
        href: "/finance/loans",
      },
      {
        title: "Бюджет",
        href: "/finance/budget",
      },
      {
        title: "Статьи / категории",
        href: "/finance/categories",
      },
    ],
  },
  {
    title: "Импорт",
    href: "/import",
    activePrefix: "/import",
    icon: "⇧",
    children: [
      {
        title: "Загрузка файлов",
        href: "/import",
      },
      {
        title: "История импортов",
        href: "/imports",
      },
    ],
  },
  {
    title: "Настройки",
    href: "/settings/companies",
    activePrefix: "/settings",
    icon: "⚙",
    children: [
      {
        title: "Компании",
        href: "/settings/companies",
      },
      {
        title: "API-подключения",
        href: "/settings/api-connections",
      },
    ],
  },
];

function isExactOrNested(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function isChildActive(pathname: string, child: NavChild) {
  return isExactOrNested(pathname, child.href);
}

function isSectionActive(pathname: string, section: NavSection) {
  if (section.href === "/") return pathname === "/";

  const childActive = section.children?.some((child) =>
    isChildActive(pathname, child)
  );

  if (childActive) return true;

  if (section.activePrefix) {
    return pathname === section.href || pathname.startsWith(section.activePrefix);
  }

  return isExactOrNested(pathname, section.href);
}

function getActiveSectionTitles(pathname: string) {
  return sections
    .filter((section) => isSectionActive(pathname, section))
    .map((section) => section.title);
}

function flattenSections() {
  return sections.flatMap((section) => [
    {
      title: section.title,
      href: section.href,
    },
    ...(section.children ?? []),
  ]);
}

export default function AppNav() {
  const pathname = usePathname();
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({});

  const activeSectionTitles = useMemo(
    () => getActiveSectionTitles(pathname),
    [pathname]
  );

  const isLoginPage = pathname === "/login";
  const authHref = isLoginPage ? "/login" : "/auth/sign-out";
  const authLabel = isLoginPage ? "\u0412\u043e\u0439\u0442\u0438" : "\u0412\u044b\u0439\u0442\u0438";

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

  useEffect(() => {
    setOpenSections((current) => {
      const next = { ...current };

      for (const title of activeSectionTitles) {
        next[title] = true;
      }

      return next;
    });
  }, [activeSectionTitles]);

  const toggleSection = (title: string) => {
    setOpenSections((current) => ({
      ...current,
      [title]: !current[title],
    }));
  };

  const mobileLinks = flattenSections();

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
            title={isCollapsed ? (isAuthenticated ? "\u238b" : "\u21aa") : authLabel}
          >
            <span className="text-base">{isCollapsed ? (isAuthenticated ? "\u238b" : "\u21aa") : authLabel}</span>
            {!isCollapsed ? <span>Скрыть меню</span> : null}
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-5">
          <div className="space-y-1">
            {sections.map((section) => {
              const active = isSectionActive(pathname, section);
              const hasChildren = Boolean(section.children?.length);
              const isOpen = Boolean(openSections[section.title]);

              return (
                <div key={section.title}>
                  <div
                    className={`group flex items-center rounded-2xl text-sm font-bold transition ${
                      active
                        ? "bg-indigo-50 text-indigo-700 shadow-sm ring-1 ring-indigo-100"
                        : "text-slate-600 hover:bg-slate-50 hover:text-slate-950"
                    }`}
                  >
                    <Link
                      href={section.href}
                      title={section.title}
                      className={`flex min-w-0 flex-1 items-center px-3 py-3 ${
                        isCollapsed ? "justify-center" : "gap-3"
                      }`}
                    >
                      <span
                        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-sm transition ${
                          active
                            ? "bg-white text-indigo-700 shadow-sm"
                            : "bg-slate-100 text-slate-500 group-hover:bg-white group-hover:text-slate-950"
                        }`}
                      >
                        {section.icon}
                      </span>

                      {!isCollapsed ? (
                        <span className="truncate">{section.title}</span>
                      ) : null}
                    </Link>

                    {!isCollapsed && hasChildren ? (
                      <button
                        type="button"
                        onClick={() => toggleSection(section.title)}
                        className="mr-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-slate-400 transition hover:bg-white hover:text-indigo-700"
                        title={isOpen ? "Свернуть раздел" : "Раскрыть раздел"}
                        aria-label={isOpen ? "Свернуть раздел" : "Раскрыть раздел"}
                      >
                        <span
                          className={`text-xs transition-transform ${
                            isOpen ? "rotate-90" : ""
                          }`}
                        >
                          ›
                        </span>
                      </button>
                    ) : null}
                  </div>

                  {!isCollapsed && hasChildren && isOpen ? (
                    <div className="ml-[30px] mt-1 space-y-1 border-l border-slate-100 pl-4">
                      {section.children?.map((child) => {
                        const childActive = isChildActive(pathname, child);

                        return (
                          <Link
                            key={child.href}
                            href={child.href}
                            className={`group flex items-center justify-between gap-3 rounded-2xl px-3 py-2 text-xs font-bold transition ${
                              childActive
                                ? "bg-white text-indigo-700 shadow-sm ring-1 ring-indigo-100"
                                : "text-slate-500 hover:bg-white hover:text-slate-950"
                            }`}
                          >
                            <span className="truncate">{child.title}</span>
                            <span
                              className={`text-sm transition ${
                                childActive
                                  ? "text-indigo-500"
                                  : "text-slate-300 group-hover:text-indigo-400"
                              }`}
                            >
                              →
                            </span>
                          </Link>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </nav>

        <div className="border-t border-slate-100 p-4">
          {!isCollapsed ? (
            <div className="rounded-3xl bg-slate-50 p-4 ring-1 ring-slate-200">
              <div className="text-sm font-black text-slate-950">
                Быстрая навигация
              </div>
              <p className="mt-1 text-xs leading-5 text-slate-500">
                Разделы раскрываются в меню. Технические страницы открываются из
                своих модулей.
              </p>
            </div>
          ) : null}

          <a
            href={authHref}
            className={`mt-3 flex items-center justify-center rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-600 transition hover:bg-slate-50 hover:text-slate-950 ${
              isCollapsed ? "px-0" : ""
            }`}
            title={authLabel}
          >
            {isCollapsed ? (isAuthenticated ? "\u238b" : "\u21aa") : authLabel}
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
            href={authHref}
            className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-slate-600"
          >
            {authLabel}
          </a>
        </div>

        <nav className="flex gap-2 overflow-x-auto px-4 pb-3">
          {mobileLinks.map((item) => {
            const active = isExactOrNested(pathname, item.href);

            return (
              <Link
                key={`${item.href}-${item.title}`}
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
