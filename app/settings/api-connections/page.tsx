import Link from "next/link";
import { prisma } from "@/lib/prisma";
import SubmitButton from "./SubmitButton";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type CompanyRow = {
  id: string;
  name: string;
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
  if (status === "CONNECTED") return "bg-emerald-100 text-emerald-700";
  if (status === "ERROR") return "bg-red-100 text-red-700";
  return "bg-slate-100 text-slate-700";
}

export default async function ApiConnectionsPage() {
  const companies = await prisma.$queryRaw<CompanyRow[]>`
    select "id", "name"
    from "Company"
    where "isActive" = true
    order by "name" asc
  `;

  const connections = await prisma.marketplaceApiConnection.findMany({
    orderBy: [{ companyId: "asc" }, { marketplace: "asc" }],
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
        <div className="rounded-3xl bg-white p-8 shadow-sm">
          <h1 className="text-4xl font-bold text-slate-900">
            API-подключения
          </h1>

          <p className="mt-3 max-w-3xl text-slate-500">
            Подключения Wildberries и Ozon для автоматической загрузки данных.
            Новые активные компании из настроек появляются здесь автоматически.
          </p>

          <div className="mt-6 flex flex-wrap gap-3">
            <Link
              href="/settings/companies"
              className="rounded-xl border border-slate-300 bg-white px-4 py-2 font-semibold text-slate-700 transition hover:bg-slate-50 active:scale-95"
            >
              Компании
            </Link>

            <Link
              href="/settings/api-connections"
              className="rounded-xl bg-slate-900 px-4 py-2 font-semibold text-white transition active:scale-95"
            >
              API-подключения
            </Link>
          </div>
        </div>

        <section className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
          <h2 className="text-lg font-bold text-amber-900">
            Безопасность токенов
          </h2>
          <p className="mt-2 text-sm text-amber-800">
            Токены не показываются в открытом виде. Если поле оставить пустым,
            уже сохранённый токен не изменится. Чтобы удалить доступ, используй
            отдельную кнопку удаления.
          </p>
        </section>

        <section className="space-y-8">
          {companies.map((company) => {
            const wb = getConnection(company.id, "WB");
            const ozon = getConnection(company.id, "OZON");

            return (
              <div
                key={company.id}
                className="rounded-3xl bg-white p-8 shadow-sm"
              >
                <div className="mb-6">
                  <h2 className="text-3xl font-bold text-slate-900">
                    {company.name}
                  </h2>
                  <p className="mt-2 text-sm text-slate-500">
                    API-доступы по маркетплейсам для этой компании.
                  </p>
                </div>

                <div className="grid gap-6 xl:grid-cols-2">
                  <form
                    action="/api/settings/api-connections"
                    method="POST"
                    className="rounded-2xl border border-slate-200 p-6"
                  >
                    <input type="hidden" name="companyId" value={company.id} />
                    <input type="hidden" name="marketplace" value="WB" />

                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <h3 className="text-2xl font-bold text-slate-900">
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
                          className="w-full rounded-xl border border-slate-300 px-4 py-3 transition focus:border-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-200"
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
                          <span className="mt-1 block text-xs font-normal text-slate-500">
                            После настройки расписания система будет
                            автоматически обновлять последнюю доступную неделю.
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

                      <div className="rounded-xl border border-blue-100 bg-blue-50 p-4 text-sm text-blue-900">
                        <div className="font-bold">
                          Что делает кнопка «Синхронизировать WB»
                        </div>
                        <p className="mt-2">
                          Загружает финансы WB за последние 14 дней и последний
                          недельный отчёт продаж. Остатки и рекламу позже
                          объединим в один стабильный сценарий.
                        </p>
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
                    className="rounded-2xl border border-slate-200 p-6"
                  >
                    <input type="hidden" name="companyId" value={company.id} />
                    <input type="hidden" name="marketplace" value="OZON" />

                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <h3 className="text-2xl font-bold text-slate-900">
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
                      <div className="rounded-2xl border border-slate-200 p-5">
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
                              className="w-full rounded-xl border border-slate-300 px-4 py-3 transition focus:border-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-200"
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
                              className="w-full rounded-xl border border-slate-300 px-4 py-3 transition focus:border-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-200"
                            />
                            <p className="mt-2 text-xs text-slate-500">
                              Пустые поля не перезаписывают уже сохранённые
                              ключи.
                            </p>
                          </div>
                        </div>
                      </div>

                      <div className="rounded-2xl border border-slate-200 p-5">
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
                              className="w-full rounded-xl border border-slate-300 px-4 py-3 transition focus:border-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-200"
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
                              className="w-full rounded-xl border border-slate-300 px-4 py-3 transition focus:border-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-200"
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
                          <span className="mt-1 block text-xs font-normal text-slate-500">
                            После настройки расписания система будет
                            автоматически обновлять Ozon по API.
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
              </div>
            );
          })}
        </section>
      </div>
    </main>
  );
}