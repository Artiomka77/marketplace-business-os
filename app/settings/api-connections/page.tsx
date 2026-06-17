import Link from "next/link";

import { prisma } from "@/lib/prisma";
import SubmitButton from "./SubmitButton";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type CompanyRow = {
  id: string;
  name: string;
};

type SearchParams = Record<string, string | string[] | undefined>;

type ApiConnectionsPageProps = {
  searchParams?: Promise<SearchParams>;
};

type HistoricalGroupRow = {
  companyId: string | null;
  marketplace: string;
  status: string;
  _count: {
    _all: number;
  };
};

function maskSecret(value: string | null | undefined) {
  if (!value) return "Не сохранён";
  if (value.length <= 8) return "********";
  return `${value.slice(0, 4)}********${value.slice(-4)}`;
}

function formatDate(value: Date | null | undefined) {
  if (!value) return "—";

  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}

function getStatusLabel(status: string | null | undefined) {
  if (status === "CONNECTED") return "Подключено";
  if (status === "ERROR") return "Ошибка";
  return "Не подключено";
}

function getStatusClass(status: string | null | undefined) {
  if (status === "CONNECTED") return "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200";
  if (status === "ERROR") return "bg-red-50 text-red-700 ring-1 ring-red-200";
  return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
}

function getParamValue(
  searchParams: SearchParams,
  key: string
): string | null {
  const value = searchParams[key];

  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

function getHistoricalNotice(searchParams: SearchParams) {
  const status = getParamValue(searchParams, "historicalSync");

  if (status === "started") {
    const createdJobs = getParamValue(searchParams, "createdJobs") ?? "0";
    const initialCompleted = getParamValue(searchParams, "initialCompleted") ?? "0";

    return {
      type: "success" as const,
      title: "Историческая загрузка запущена",
      text: `Система поставила данные в обработку. Новых шагов загрузки: ${createdJobs}. Первые шаги уже обработаны: ${initialCompleted}.`,
    };
  }

  if (status === "error") {
    return {
      type: "error" as const,
      title: "Не удалось запустить историческую загрузку",
      text:
        getParamValue(searchParams, "message") ??
        "Проверь API-подключение и попробуй ещё раз.",
    };
  }

  return null;
}

function buildHistoricalStats(
  groups: HistoricalGroupRow[],
  companyId: string
) {
  const companyGroups = groups.filter((group) => group.companyId === companyId);

  const total = companyGroups.reduce(
    (sum, group) => sum + group._count._all,
    0
  );

  const completed = companyGroups
    .filter((group) => group.status === "SUCCESS")
    .reduce((sum, group) => sum + group._count._all, 0);

  const inProgress = companyGroups
    .filter((group) => ["PENDING", "RUNNING"].includes(group.status))
    .reduce((sum, group) => sum + group._count._all, 0);

  const waiting = companyGroups
    .filter((group) => group.status === "RATE_LIMITED")
    .reduce((sum, group) => sum + group._count._all, 0);

  const needsAttention = companyGroups
    .filter((group) => group.status === "ERROR")
    .reduce((sum, group) => sum + group._count._all, 0);

  const ozonTotal = companyGroups
    .filter((group) => group.marketplace === "OZON")
    .reduce((sum, group) => sum + group._count._all, 0);

  const wbTotal = companyGroups
    .filter((group) => group.marketplace === "WB")
    .reduce((sum, group) => sum + group._count._all, 0);

  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;

  let statusLabel = "Не запускалась";
  let statusText =
    "После подключения API можно загрузить старые данные за прошлые периоды.";
  let statusClass = "bg-slate-100 text-slate-700 ring-1 ring-slate-200";

  if (needsAttention > 0) {
    statusLabel = "Нужна проверка";
    statusText =
      "Есть ошибка, которую система не смогла решить сама. Проверь API-ключи и доступы маркетплейса.";
    statusClass = "bg-red-50 text-red-700 ring-1 ring-red-200";
  } else if (waiting > 0) {
    statusLabel = "Ожидаем маркетплейс";
    statusText =
      "Маркетплейс временно ограничил ответ. Система продолжит загрузку автоматически.";
    statusClass = "bg-amber-50 text-amber-700 ring-1 ring-amber-200";
  } else if (inProgress > 0) {
    statusLabel = "Идёт загрузка";
    statusText =
      "Данные поставлены в обработку. Можно продолжать работу, система будет догружать историю.";
    statusClass = "bg-blue-50 text-blue-700 ring-1 ring-blue-200";
  } else if (total > 0 && completed === total) {
    statusLabel = "Завершено";
    statusText =
      "Историческая загрузка по этой компании завершена.";
    statusClass = "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200";
  }

  return {
    total,
    completed,
    inProgress,
    waiting,
    needsAttention,
    ozonTotal,
    wbTotal,
    percent,
    statusLabel,
    statusText,
    statusClass,
  };
}

export default async function ApiConnectionsPage({
  searchParams,
}: ApiConnectionsPageProps) {
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const historicalNotice = getHistoricalNotice(resolvedSearchParams);

  const companies = await prisma.$queryRaw<CompanyRow[]>`
    select "id", "name"
    from "Company"
    where "isActive" = true
    order by "name" asc
  `;

  const connections = await prisma.marketplaceApiConnection.findMany({
    orderBy: [{ companyId: "asc" }, { marketplace: "asc" }],
  });

  const historicalGroups = await prisma.historicalSyncJob.groupBy({
    by: ["companyId", "marketplace", "status"],
    _count: {
      _all: true,
    },
    orderBy: [
      {
        companyId: "asc",
      },
      {
        marketplace: "asc",
      },
      {
        status: "asc",
      },
    ],
  });

  function getConnection(companyId: string, marketplace: string) {
    return connections.find(
      (connection) =>
        connection.companyId === companyId &&
        connection.marketplace === marketplace
    );
  }

  const buttonBase =
    "rounded-xl px-5 py-3 text-sm font-bold shadow-sm transition hover:shadow-md active:scale-95 disabled:cursor-wait disabled:opacity-60";

  return (
    <main className="min-h-screen bg-slate-100 p-8">
      <div className="mx-auto max-w-[1400px] space-y-8">
        <div className="rounded-3xl bg-white p-8 shadow-sm ring-1 ring-slate-200">
          <h1 className="text-4xl font-bold tracking-tight text-slate-950">
            API-подключения
          </h1>

          <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-500">
            Подключения Wildberries и Ozon для автоматической загрузки данных.
            Новые активные компании из настроек появляются здесь автоматически.
          </p>

          <div className="mt-6 flex flex-wrap gap-3">
            <Link
              href="/settings/companies"
              className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 active:scale-95"
            >
              Компании
            </Link>

            <Link
              href="/settings/api-connections"
              className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition active:scale-95"
            >
              API-подключения
            </Link>
          </div>
        </div>

        {historicalNotice ? (
          <section
            className={`rounded-2xl border p-5 ${
              historicalNotice.type === "success"
                ? "border-emerald-200 bg-emerald-50"
                : "border-red-200 bg-red-50"
            }`}
          >
            <h2
              className={`text-lg font-bold ${
                historicalNotice.type === "success"
                  ? "text-emerald-900"
                  : "text-red-900"
              }`}
            >
              {historicalNotice.title}
            </h2>
            <p
              className={`mt-2 text-sm ${
                historicalNotice.type === "success"
                  ? "text-emerald-800"
                  : "text-red-800"
              }`}
            >
              {historicalNotice.text}
            </p>
          </section>
        ) : null}

        <section className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
          <h2 className="text-lg font-bold text-amber-900">
            Безопасность токенов
          </h2>
          <p className="mt-2 text-sm leading-6 text-amber-800">
            Токены не показываются в открытом виде. Если поле оставить пустым,
            уже сохранённый токен не изменится. Чтобы удалить доступ, используй
            отдельную кнопку удаления.
          </p>
        </section>

        <section className="space-y-8">
          {companies.map((company) => {
            const wb = getConnection(company.id, "WB");
            const ozon = getConnection(company.id, "OZON");
            const historicalStats = buildHistoricalStats(
              historicalGroups,
              company.id
            );

            return (
              <div
                key={company.id}
                className="rounded-3xl bg-white p-8 shadow-sm ring-1 ring-slate-200"
              >
                <div className="mb-6 flex flex-col gap-2">
                  <h2 className="text-3xl font-bold tracking-tight text-slate-950">
                    {company.name}
                  </h2>
                  <p className="text-sm text-slate-500">
                    Сначала подключи API маркетплейсов. После этого ниже можно
                    запустить историческую загрузку данных.
                  </p>
                </div>

                <div className="grid gap-6 xl:grid-cols-2">
                  <form
                    action="/api/settings/api-connections"
                    method="POST"
                    className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
                  >
                    <input type="hidden" name="companyId" value={company.id} />
                    <input type="hidden" name="marketplace" value="WB" />

                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <h3 className="text-2xl font-bold text-slate-950">
                          Wildberries
                        </h3>
                        <p className="mt-1 text-sm text-slate-500">
                          Токен WB Seller API.
                        </p>
                      </div>

                      <span
                        className={`shrink-0 rounded-full px-3 py-1 text-sm font-semibold ${getStatusClass(
                          wb?.status
                        )}`}
                      >
                        {getStatusLabel(wb?.status)}
                      </span>
                    </div>

                    <div className="mt-6 space-y-5">
                      <div>
                        <label className="mb-2 block text-sm font-medium text-slate-700">
                          WB Token
                        </label>
                        <input
                          name="wbToken"
                          type="password"
                          placeholder={maskSecret(wb?.wbToken)}
                          className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm transition focus:border-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-200"
                        />
                        <p className="mt-2 text-xs text-slate-500">
                          Оставь пустым, если не хочешь менять сохранённый
                          токен.
                        </p>
                      </div>

                      <label className="flex items-start gap-3 text-sm font-medium text-slate-700">
                        <input
                          type="checkbox"
                          name="isEnabled"
                          defaultChecked={wb?.isEnabled ?? false}
                          className="mt-0.5 h-4 w-4"
                        />
                        <span>
                          <span className="block">Включить автозагрузку</span>
                          <span className="mt-1 block text-xs font-normal leading-5 text-slate-500">
                            Система будет автоматически обновлять последние
                            доступные данные WB.
                          </span>
                        </span>
                      </label>

                      <div className="grid gap-3 rounded-xl bg-slate-50 p-4 text-sm md:grid-cols-2">
                        <div>
                          <div className="text-slate-500">
                            Последняя синхронизация
                          </div>
                          <div className="mt-1 font-semibold text-slate-900">
                            {formatDate(wb?.lastSyncAt)}
                          </div>
                        </div>

                        <div>
                          <div className="text-slate-500">
                            Последняя ошибка
                          </div>
                          <div className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words font-semibold text-slate-900">
                            {wb?.lastError || "—"}
                          </div>
                        </div>
                      </div>

                      <div className="flex flex-wrap gap-3">
                        <SubmitButton
                          name="action"
                          value="save"
                          pendingText="Сохраняем..."
                          className={`${buttonBase} bg-slate-900 text-white`}
                        >
                          Сохранить WB
                        </SubmitButton>

                        <SubmitButton
                          name="action"
                          value="check"
                          pendingText="Проверяем..."
                          className={`${buttonBase} border border-emerald-300 bg-white text-emerald-700`}
                        >
                          Проверить WB
                        </SubmitButton>

                        <SubmitButton
                          formAction="/api/settings/api-connections/sync-wb"
                          formMethod="POST"
                          pendingText="Синхронизируем WB..."
                          className={`${buttonBase} bg-blue-600 text-white`}
                        >
                          Синхронизировать WB
                        </SubmitButton>

                        <SubmitButton
                          name="action"
                          value="delete"
                          pendingText="Удаляем..."
                          className={`${buttonBase} border border-red-300 bg-white text-red-600`}
                        >
                          Удалить WB token
                        </SubmitButton>
                      </div>
                    </div>
                  </form>

                  <form
                    action="/api/settings/api-connections"
                    method="POST"
                    className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
                  >
                    <input type="hidden" name="companyId" value={company.id} />
                    <input type="hidden" name="marketplace" value="OZON" />

                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <h3 className="text-2xl font-bold text-slate-950">
                          Ozon
                        </h3>
                        <p className="mt-1 text-sm text-slate-500">
                          Seller API для финансов, товаров и остатков.
                          Performance API — отдельно для рекламы.
                        </p>
                      </div>

                      <span
                        className={`shrink-0 rounded-full px-3 py-1 text-sm font-semibold ${getStatusClass(
                          ozon?.status
                        )}`}
                      >
                        {getStatusLabel(ozon?.status)}
                      </span>
                    </div>

                    <div className="mt-6 space-y-6">
                      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
                        <h4 className="text-lg font-bold text-slate-900">
                          Ozon Seller API
                        </h4>
                        <p className="mt-1 text-sm text-slate-500">
                          Используется для финансов, товаров, остатков, заказов
                          и возвратов.
                        </p>

                        <div className="mt-4 space-y-4">
                          <div>
                            <label className="mb-2 block text-sm font-medium text-slate-700">
                              Ozon Client-Id
                            </label>
                            <input
                              name="ozonClientId"
                              type="text"
                              autoComplete="off"
                              inputMode="numeric"
                              placeholder={maskSecret(ozon?.ozonClientId)}
                              className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm transition focus:border-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-200"
                            />
                            <p className="mt-2 text-xs text-slate-500">
                              Нужен числовой Client ID из Seller API. Не
                              вставляй сюда Performance Client ID.
                            </p>
                          </div>

                          <div>
                            <label className="mb-2 block text-sm font-medium text-slate-700">
                              Ozon Api-Key
                            </label>
                            <input
                              name="ozonApiKey"
                              type="text"
                              autoComplete="off"
                              placeholder={maskSecret(ozon?.ozonApiKey)}
                              className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm transition focus:border-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-200"
                            />
                            <p className="mt-2 text-xs text-slate-500">
                              Пустые поля не перезаписывают уже сохранённые
                              ключи.
                            </p>
                          </div>
                        </div>
                      </div>

                      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
                        <h4 className="text-lg font-bold text-slate-900">
                          Ozon Performance API
                        </h4>
                        <p className="mt-1 text-sm text-slate-500">
                          Используется только для рекламы Ozon: расходы,
                          показы, клики и кампании.
                        </p>

                        <div className="mt-4 space-y-4">
                          <div>
                            <label className="mb-2 block text-sm font-medium text-slate-700">
                              Ozon Performance Client-Id
                            </label>
                            <input
                              name="ozonPerformanceClientId"
                              type="text"
                              autoComplete="off"
                              placeholder={maskSecret(
                                ozon?.ozonPerformanceClientId
                              )}
                              className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm transition focus:border-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-200"
                            />
                          </div>

                          <div>
                            <label className="mb-2 block text-sm font-medium text-slate-700">
                              Ozon Performance Client Secret
                            </label>
                            <input
                              name="ozonPerformanceClientSecret"
                              type="text"
                              autoComplete="off"
                              placeholder={maskSecret(
                                ozon?.ozonPerformanceClientSecret
                              )}
                              className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm transition focus:border-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-200"
                            />
                            <p className="mt-2 text-xs text-slate-500">
                              Эти поля можно оставить пустыми, пока не
                              подключаем рекламу Ozon.
                            </p>
                          </div>
                        </div>
                      </div>

                      <label className="flex items-start gap-3 text-sm font-medium text-slate-700">
                        <input
                          type="checkbox"
                          name="isEnabled"
                          defaultChecked={ozon?.isEnabled ?? false}
                          className="mt-0.5 h-4 w-4"
                        />
                        <span>
                          <span className="block">Включить автозагрузку</span>
                          <span className="mt-1 block text-xs font-normal leading-5 text-slate-500">
                            Система будет автоматически обновлять Ozon по API.
                          </span>
                        </span>
                      </label>

                      <div className="grid gap-3 rounded-xl bg-slate-50 p-4 text-sm md:grid-cols-2">
                        <div>
                          <div className="text-slate-500">
                            Последняя синхронизация
                          </div>
                          <div className="mt-1 font-semibold text-slate-900">
                            {formatDate(ozon?.lastSyncAt)}
                          </div>
                        </div>

                        <div>
                          <div className="text-slate-500">
                            Последняя ошибка
                          </div>
                          <div className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words font-semibold text-slate-900">
                            {ozon?.lastError || "—"}
                          </div>
                        </div>
                      </div>

                      <div className="flex flex-wrap gap-3">
                        <SubmitButton
                          name="action"
                          value="save"
                          pendingText="Сохраняем..."
                          className={`${buttonBase} bg-slate-900 text-white`}
                        >
                          Сохранить Ozon
                        </SubmitButton>

                        <SubmitButton
                          name="action"
                          value="check"
                          pendingText="Проверяем..."
                          className={`${buttonBase} border border-emerald-300 bg-white text-emerald-700`}
                        >
                          Проверить Ozon
                        </SubmitButton>

                        <SubmitButton
                          formAction="/api/settings/api-connections/sync-ozon-all"
                          formMethod="POST"
                          pendingText="Синхронизируем весь Ozon..."
                          className={`${buttonBase} bg-slate-900 text-white`}
                        >
                          Синхронизировать весь Ozon
                        </SubmitButton>

                        <SubmitButton
                          name="action"
                          value="delete"
                          pendingText="Удаляем..."
                          className={`${buttonBase} border border-red-300 bg-white text-red-600`}
                        >
                          Удалить Ozon ключи
                        </SubmitButton>
                      </div>
                    </div>
                  </form>
                </div>

                <section className="mt-8 rounded-2xl border border-slate-200 bg-slate-50 p-6">
                  <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
                    <div className="max-w-3xl">
                      <div className="flex flex-wrap items-center gap-3">
                        <p className="text-xs font-bold uppercase tracking-[0.2em] text-slate-400">
                          Следующий шаг после API
                        </p>

                        <span
                          className={`rounded-full px-3 py-1 text-xs font-bold ${historicalStats.statusClass}`}
                        >
                          {historicalStats.statusLabel}
                        </span>
                      </div>

                      <h3 className="mt-3 text-2xl font-bold tracking-tight text-slate-950">
                        Историческая загрузка данных
                      </h3>

                      <p className="mt-2 text-sm leading-6 text-slate-600">
                        Подтягивает старые данные по компании после подключения
                        API. Селлеру не нужно управлять паузами, повторами или
                        лимитами маркетплейсов — система делает это внутри.
                      </p>

                      <p className="mt-2 text-sm leading-6 text-slate-500">
                        {historicalStats.statusText}
                      </p>
                    </div>

                    <div className="w-full rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200 xl:w-[320px]">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-sm font-medium text-slate-500">
                          Прогресс
                        </span>
                        <span className="text-xl font-bold text-slate-950">
                          {historicalStats.percent}%
                        </span>
                      </div>

                      <div className="mt-4 h-2 overflow-hidden rounded-full bg-slate-200">
                        <div
                          className="h-full rounded-full bg-slate-900"
                          style={{ width: `${historicalStats.percent}%` }}
                        />
                      </div>

                      <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
                        <div className="rounded-xl bg-slate-50 p-3">
                          <div className="text-slate-500">Завершено</div>
                          <div className="mt-1 text-lg font-bold text-slate-950">
                            {historicalStats.completed}
                          </div>
                        </div>

                        <div className="rounded-xl bg-slate-50 p-3">
                          <div className="text-slate-500">Всего</div>
                          <div className="mt-1 text-lg font-bold text-slate-950">
                            {historicalStats.total}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="mt-6 grid gap-3 text-sm md:grid-cols-4">
                    <div className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
                      <div className="text-slate-500">Ozon</div>
                      <div className="mt-1 text-2xl font-bold text-slate-950">
                        {historicalStats.ozonTotal}
                      </div>
                    </div>

                    <div className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
                      <div className="text-slate-500">Wildberries</div>
                      <div className="mt-1 text-2xl font-bold text-slate-950">
                        {historicalStats.wbTotal}
                      </div>
                    </div>

                    <div className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
                      <div className="text-slate-500">В обработке</div>
                      <div className="mt-1 text-2xl font-bold text-blue-700">
                        {historicalStats.inProgress}
                      </div>
                    </div>

                    <div className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
                      <div className="text-slate-500">Нужна проверка</div>
                      <div className="mt-1 text-2xl font-bold text-red-700">
                        {historicalStats.needsAttention}
                      </div>
                    </div>
                  </div>

                  <form
                    action="/api/historical-sync/start"
                    method="POST"
                    className="mt-6 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200"
                  >
                    <input type="hidden" name="companyId" value={company.id} />

                    <div className="grid gap-4 xl:grid-cols-[1fr_1fr_auto] xl:items-end">
                      <div>
                        <label className="mb-2 block text-sm font-medium text-slate-700">
                          Что загрузить
                        </label>
                        <select
                          name="marketplace"
                          defaultValue="ALL"
                          className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm font-semibold text-slate-900 transition focus:border-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-200"
                        >
                          <option value="ALL">Ozon и Wildberries</option>
                          <option value="OZON">Только Ozon</option>
                          <option value="WB">Только Wildberries</option>
                        </select>
                      </div>

                      <div>
                        <label className="mb-2 block text-sm font-medium text-slate-700">
                          Загрузить историю с даты
                        </label>
                        <input
                          name="dateFrom"
                          type="date"
                          defaultValue="2025-01-01"
                          className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm font-semibold text-slate-900 transition focus:border-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-200"
                        />
                      </div>

                      <SubmitButton
                        pendingText="Запускаем..."
                        className={`${buttonBase} bg-blue-600 text-white`}
                      >
                        Запустить загрузку
                      </SubmitButton>
                    </div>

                    <p className="mt-4 text-xs leading-5 text-slate-500">
                      Дата окончания выбирается автоматически. Если данные за
                      последние периоды уже есть, система не будет загружать их
                      повторно. Временные ошибки маркетплейсов обрабатываются
                      автоматически.
                    </p>

                    {historicalStats.needsAttention > 0 ? (
                      <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm leading-6 text-red-800">
                        Есть данные, которые не удалось загрузить. Обычно это
                        связано с API-ключом или доступами в кабинете
                        маркетплейса. Проверь подключение выше.
                      </div>
                    ) : null}
                  </form>
                </section>
              </div>
            );
          })}
        </section>
      </div>
    </main>
  );
}