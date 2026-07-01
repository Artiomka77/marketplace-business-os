import Link from "next/link";
import type { Prisma } from "@prisma/client";

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
  dataType: string;
  status: string;
  _count: {
    _all: number;
  };
};

type CompanyCountRow = {
  companyId: string | null;
  _count: {
    _all: number;
  };
};

type HistoricalSpeedSnapshot = {
  completedLastHour: number;
  completedLast6Hours: number;
  completedLast24Hours: number;
  stuckRunningJobs: number;
};

type HistoricalJobPreviewRow = {
  companyId: string | null;
  companyName: string;
  marketplace: string;
  dataType: string;
  status: string;
  dateFrom: Date;
  dateTo: Date;
  cursorOffset: number | null;
  cursorReportNumber: string | null;
  retryCount: number;
  lastError: string | null;
  lastAttemptAt: Date | null;
  finishedAt: Date | null;
  updatedAt: Date;
};

type HistoricalDataTypeStats = {
  marketplace: "OZON" | "WB";
  dataType: "FINANCE" | "ADS" | "PRODUCTS" | "SALES";
  title: string;
  total: number;
  completed: number;
  queued: number;
  running: number;
  waiting: number;
  errors: number;
  remaining: number;
  percent: number;
  statusLabel: string;
  statusClass: string;
};

const STUCK_RUNNING_MINUTES = 60;

const visibleHistoricalJobsWhere: Prisma.HistoricalSyncJobWhereInput = {
  NOT: [
    {
      marketplace: "WB",
      dataType: "SALES",
      cursorReportNumber: null,
    },
  ],
};

const historicalItems: {
  marketplace: "OZON" | "WB";
  dataType: "FINANCE" | "ADS" | "PRODUCTS" | "SALES";
  title: string;
}[] = [
  { marketplace: "OZON", dataType: "FINANCE", title: "Финансы" },
  { marketplace: "OZON", dataType: "ADS", title: "Реклама" },
  { marketplace: "OZON", dataType: "PRODUCTS", title: "Товары" },
  { marketplace: "WB", dataType: "FINANCE", title: "Финансы" },
  { marketplace: "WB", dataType: "SALES", title: "Продажи" },
  { marketplace: "WB", dataType: "ADS", title: "Реклама" },
];

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

function formatShortDate(value: Date | null | undefined) {
  if (!value) return "—";

  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
  }).format(value);
}

function formatPeriod(
  dateFrom: Date | null | undefined,
  dateTo: Date | null | undefined
) {
  return `${formatShortDate(dateFrom)} — ${formatShortDate(dateTo)}`;
}

function getStatusLabel(status: string | null | undefined) {
  if (status === "CONNECTED") return "Подключено";
  if (status === "ERROR") return "Ошибка";
  return "Не подключено";
}

function getStatusClass(status: string | null | undefined) {
  if (status === "CONNECTED") {
    return "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200";
  }

  if (status === "ERROR") {
    return "bg-red-50 text-red-700 ring-1 ring-red-200";
  }

  return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
}

function getParamValue(searchParams: SearchParams, key: string): string | null {
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
    const initialCompleted =
      getParamValue(searchParams, "initialCompleted") ?? "0";

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

function simplifyApiError(value: string | null | undefined) {
  if (!value) return "—";

  const text = value.toLowerCase();

  if (
    text.includes("ozon") &&
    (text.includes("429") ||
      text.includes("rate limit") ||
      text.includes("rate exceeded"))
  ) {
    return "Ozon временно ограничил запросы. Система повторит загрузку позже. Не запускай ручную синхронизацию, пока идёт историческая загрузка.";
  }

  if (
    text.includes("wb") &&
    (text.includes("429") ||
      text.includes("too many requests") ||
      text.includes("rate limit") ||
      text.includes("limited by global limiter"))
  ) {
    return "Wildberries временно ограничил запросы. Система подождёт и продолжит загрузку автоматически.";
  }

  if (text.includes("fetch failed")) {
    return "Временный сетевой сбой при обращении к API. Обычно проходит при следующей автоматической попытке.";
  }

  return value;
}

function roundNumber(value: number, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function formatJobsPerHour(value: number) {
  if (value <= 0) return "—";
  return `${roundNumber(value, 1)}/ч`;
}

function getEstimatedDurationText(hours: number | null) {
  if (hours === null) {
    return "—";
  }

  if (hours <= 1) {
    return "меньше 1 ч";
  }

  if (hours < 24) {
    return `${Math.ceil(hours)} ч`;
  }

  return `${Math.ceil(hours / 24)} дн`;
}

function getCompanyCount(rows: CompanyCountRow[], companyId: string) {
  return rows.find((row) => row.companyId === companyId)?._count._all ?? 0;
}

function getStuckRunningBeforeDate() {
  return new Date(Date.now() - STUCK_RUNNING_MINUTES * 60 * 1000);
}

function countStatus(
  groups: HistoricalGroupRow[],
  marketplace: string,
  dataType: string,
  statuses?: string[]
) {
  return groups
    .filter((group) => {
      const statusMatches = statuses ? statuses.includes(group.status) : true;

      return (
        group.marketplace === marketplace &&
        group.dataType === dataType &&
        statusMatches
      );
    })
    .reduce((sum, group) => sum + group._count._all, 0);
}

function getDataTypeStatus(item: {
  total: number;
  completed: number;
  queued: number;
  running: number;
  waiting: number;
  errors: number;
}) {
  if (item.total === 0) {
    return {
      statusLabel: "Не запускалось",
      statusClass: "bg-slate-100 text-slate-600 ring-1 ring-slate-200",
    };
  }

  if (item.errors > 0) {
    return {
      statusLabel: "Проверить",
      statusClass: "bg-red-50 text-red-700 ring-1 ring-red-200",
    };
  }

  if (item.waiting > 0) {
    return {
      statusLabel: "Ожидание",
      statusClass: "bg-amber-50 text-amber-700 ring-1 ring-amber-200",
    };
  }

  if (item.running > 0) {
    return {
      statusLabel: "Идёт",
      statusClass: "bg-blue-50 text-blue-700 ring-1 ring-blue-200",
    };
  }

  if (item.queued > 0) {
    return {
      statusLabel: "В очереди",
      statusClass: "bg-blue-50 text-blue-700 ring-1 ring-blue-200",
    };
  }

  if (item.completed === item.total) {
    return {
      statusLabel: "Готово",
      statusClass: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
    };
  }

  return {
    statusLabel: "В работе",
    statusClass: "bg-blue-50 text-blue-700 ring-1 ring-blue-200",
  };
}

function buildHistoricalStats(
  groups: HistoricalGroupRow[],
  companyId: string,
  speed: HistoricalSpeedSnapshot
) {
  const companyGroups = groups.filter((group) => group.companyId === companyId);

  const dataTypeStats: HistoricalDataTypeStats[] = historicalItems.map((item) => {
    const total = countStatus(companyGroups, item.marketplace, item.dataType);

    const completed = countStatus(
      companyGroups,
      item.marketplace,
      item.dataType,
      ["SUCCESS"]
    );

    const queued = countStatus(
      companyGroups,
      item.marketplace,
      item.dataType,
      ["PENDING"]
    );

    const running = countStatus(
      companyGroups,
      item.marketplace,
      item.dataType,
      ["RUNNING"]
    );

    const waiting = countStatus(
      companyGroups,
      item.marketplace,
      item.dataType,
      ["RATE_LIMITED"]
    );

    const errors = countStatus(
      companyGroups,
      item.marketplace,
      item.dataType,
      ["ERROR"]
    );

    const remaining = queued + running + waiting + errors;
    const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
    const status = getDataTypeStatus({
      total,
      completed,
      queued,
      running,
      waiting,
      errors,
    });

    return {
      ...item,
      total,
      completed,
      queued,
      running,
      waiting,
      errors,
      remaining,
      percent,
      statusLabel: status.statusLabel,
      statusClass: status.statusClass,
    };
  });

  const total = dataTypeStats.reduce((sum, item) => sum + item.total, 0);
  const completed = dataTypeStats.reduce((sum, item) => sum + item.completed, 0);
  const queued = dataTypeStats.reduce((sum, item) => sum + item.queued, 0);
  const running = dataTypeStats.reduce((sum, item) => sum + item.running, 0);
  const waiting = dataTypeStats.reduce((sum, item) => sum + item.waiting, 0);
  const needsAttention = dataTypeStats.reduce(
    (sum, item) => sum + item.errors,
    0
  );

  const remaining = queued + running + waiting + needsAttention;

  const ozonTotal = dataTypeStats
    .filter((item) => item.marketplace === "OZON")
    .reduce((sum, item) => sum + item.total, 0);

  const wbTotal = dataTypeStats
    .filter((item) => item.marketplace === "WB")
    .reduce((sum, item) => sum + item.total, 0);

  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;

  const averageJobsPerHourBy6Hours =
    speed.completedLast6Hours > 0 ? speed.completedLast6Hours / 6 : 0;

  const averageJobsPerHourBy24Hours =
    speed.completedLast24Hours > 0 ? speed.completedLast24Hours / 24 : 0;

  const averageJobsPerHour =
    averageJobsPerHourBy6Hours > 0
      ? averageJobsPerHourBy6Hours
      : averageJobsPerHourBy24Hours;

  const estimatedHoursRemaining =
    averageJobsPerHour > 0
      ? roundNumber(remaining / averageJobsPerHour, 1)
      : null;

  const problemsCount = needsAttention + waiting + speed.stuckRunningJobs;

  let statusLabel = "Не запускалась";
  let statusText =
    "После подключения API можно загрузить старые данные за прошлые периоды.";
  let statusClass = "bg-slate-100 text-slate-700 ring-1 ring-slate-200";

  if (problemsCount > 0) {
    statusLabel = "Нужна проверка";
    statusText =
      "Есть ошибки, лимиты API или зависшие задачи. Система часть проблем решит сама, но блок стоит держать под контролем.";
    statusClass = "bg-red-50 text-red-700 ring-1 ring-red-200";
  } else if (running > 0) {
    statusLabel = "Идёт загрузка";
    statusText =
      "Одна из задач выполняется прямо сейчас. Можно продолжать работу.";
    statusClass = "bg-blue-50 text-blue-700 ring-1 ring-blue-200";
  } else if (queued > 0) {
    statusLabel = "В очереди";
    statusText =
      "Данные поставлены в очередь. Система постепенно догружает историю по расписанию.";
    statusClass = "bg-blue-50 text-blue-700 ring-1 ring-blue-200";
  } else if (total > 0 && completed === total) {
    statusLabel = "Завершено";
    statusText = "Историческая загрузка по этой компании завершена.";
    statusClass = "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200";
  }

  return {
    total,
    completed,
    queued,
    running,
    waiting,
    needsAttention,
    problemsCount,
    stuckRunningJobs: speed.stuckRunningJobs,
    remaining,
    ozonTotal,
    wbTotal,
    percent,
    statusLabel,
    statusText,
    statusClass,
    dataTypeStats,
    speed: {
      completedLastHour: speed.completedLastHour,
      completedLast6Hours: speed.completedLast6Hours,
      completedLast24Hours: speed.completedLast24Hours,
      averageJobsPerHour: roundNumber(averageJobsPerHour, 2),
      estimatedHoursRemaining,
      estimatedDurationText: getEstimatedDurationText(estimatedHoursRemaining),
    },
  };
}

function getCompanyLatestJobs(jobs: HistoricalJobPreviewRow[], companyId: string) {
  const companyJobs = jobs.filter((job) => job.companyId === companyId);

  return {
    lastSuccess: companyJobs.find((job) => job.status === "SUCCESS") ?? null,
    lastIssue:
      companyJobs.find((job) =>
        ["ERROR", "RATE_LIMITED"].includes(job.status)
      ) ?? null,
  };
}

function getMarketplaceTitle(marketplace: string) {
  if (marketplace === "WB") return "Wildberries";
  if (marketplace === "OZON") return "Ozon";
  return marketplace;
}

function getDataTypeTitle(dataType: string) {
  if (dataType === "FINANCE") return "Финансы";
  if (dataType === "ADS") return "Реклама";
  if (dataType === "PRODUCTS") return "Товары";
  if (dataType === "SALES") return "Продажи";
  return dataType;
}

function HistoricalProgressRow({ item }: { item: HistoricalDataTypeStats }) {
  return (
    <div className="grid grid-cols-[88px_1fr_86px_74px_96px] items-center gap-3 border-b border-slate-100 px-4 py-2.5 text-sm last:border-b-0">
      <div className="font-semibold text-slate-500">
        {getMarketplaceTitle(item.marketplace)}
      </div>

      <div>
        <div className="font-bold text-slate-950">{item.title}</div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-200">
          <div
            className="h-full rounded-full bg-slate-900"
            style={{ width: `${item.percent}%` }}
          />
        </div>
      </div>

      <div className="text-right font-bold text-slate-950">
        {item.completed}
        <span className="font-semibold text-slate-400"> / {item.total}</span>
      </div>

      <div className="text-right font-bold text-slate-950">
        {item.percent}%
      </div>

      <div className="text-right">
        <span
          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-bold ${item.statusClass}`}
        >
          {item.statusLabel}
        </span>
      </div>
    </div>
  );
}

function HistoricalJobLine({
  title,
  job,
  tone,
}: {
  title: string;
  job: HistoricalJobPreviewRow | null;
  tone: "success" | "warning";
}) {
  if (!job) {
    return null;
  }

  const toneClass =
    tone === "success"
      ? "border-emerald-200 bg-emerald-50 text-emerald-900"
      : "border-amber-200 bg-amber-50 text-amber-900";

  return (
    <div className={`rounded-2xl border p-4 ${toneClass}`}>
      <div className="text-xs font-bold uppercase tracking-[0.16em] opacity-70">
        {title}
      </div>

      <div className="mt-2 text-sm font-bold">
        {getMarketplaceTitle(job.marketplace)} · {getDataTypeTitle(job.dataType)}
      </div>

      <div className="mt-1 text-sm opacity-80">
        {formatPeriod(job.dateFrom, job.dateTo)}
      </div>

      {job.cursorReportNumber ? (
        <div className="mt-1 text-xs opacity-70">
          Отчёт WB: {job.cursorReportNumber}
        </div>
      ) : null}

      {job.cursorOffset !== null && job.status !== "SUCCESS" ? (
        <div className="mt-1 text-xs opacity-70">
          Пачка кампаний: offset {job.cursorOffset}
        </div>
      ) : null}

      {job.lastError ? (
        <div className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap break-words text-xs opacity-80">
          {simplifyApiError(job.lastError)}
        </div>
      ) : null}

      <div className="mt-2 text-xs opacity-70">
        Обновлено: {formatDate(job.updatedAt)}
      </div>
    </div>
  );
}

export default async function ApiConnectionsPage({
  searchParams,
}: ApiConnectionsPageProps) {
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const historicalNotice = getHistoricalNotice(resolvedSearchParams);

  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60 * 1000);
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const stuckRunningBefore = getStuckRunningBeforeDate();

  const companies = await prisma.$queryRaw<CompanyRow[]>`
    select "id", "name"
    from "Company"
    where "isActive" = true
    order by "name" asc
  `;

  const connections = await prisma.marketplaceApiConnection.findMany({
    orderBy: [{ companyId: "asc" }, { marketplace: "asc" }],
  });

  const [
    historicalGroups,
    historicalLatestJobs,
    completedLastHourRows,
    completedLast6HoursRows,
    completedLast24HoursRows,
    stuckRunningRows,
  ] = await Promise.all([
    prisma.historicalSyncJob.groupBy({
      by: ["companyId", "marketplace", "dataType", "status"],
      where: visibleHistoricalJobsWhere,
      _count: {
        _all: true,
      },
      orderBy: [
        { companyId: "asc" },
        { marketplace: "asc" },
        { dataType: "asc" },
        { status: "asc" },
      ],
    }),
    prisma.historicalSyncJob.findMany({
      where: {
        ...visibleHistoricalJobsWhere,
        status: {
          in: ["SUCCESS", "ERROR", "RATE_LIMITED"],
        },
      },
      orderBy: [{ updatedAt: "desc" }],
      take: 100,
      select: {
        companyId: true,
        companyName: true,
        marketplace: true,
        dataType: true,
        status: true,
        dateFrom: true,
        dateTo: true,
        cursorOffset: true,
        cursorReportNumber: true,
        retryCount: true,
        lastError: true,
        lastAttemptAt: true,
        finishedAt: true,
        updatedAt: true,
      },
    }),
    prisma.historicalSyncJob.groupBy({
      by: ["companyId"],
      where: {
        ...visibleHistoricalJobsWhere,
        status: "SUCCESS",
        finishedAt: {
          gte: oneHourAgo,
        },
      },
      _count: {
        _all: true,
      },
    }),
    prisma.historicalSyncJob.groupBy({
      by: ["companyId"],
      where: {
        ...visibleHistoricalJobsWhere,
        status: "SUCCESS",
        finishedAt: {
          gte: sixHoursAgo,
        },
      },
      _count: {
        _all: true,
      },
    }),
    prisma.historicalSyncJob.groupBy({
      by: ["companyId"],
      where: {
        ...visibleHistoricalJobsWhere,
        status: "SUCCESS",
        finishedAt: {
          gte: twentyFourHoursAgo,
        },
      },
      _count: {
        _all: true,
      },
    }),
    prisma.historicalSyncJob.groupBy({
      by: ["companyId"],
      where: {
        ...visibleHistoricalJobsWhere,
        status: "RUNNING",
        OR: [
          {
            lastAttemptAt: {
              lte: stuckRunningBefore,
            },
          },
          {
            lastAttemptAt: null,
            updatedAt: {
              lte: stuckRunningBefore,
            },
          },
        ],
      },
      _count: {
        _all: true,
      },
    }),
  ]);

  function getConnection(companyId: string, marketplace: string) {
    return connections.find(
      (connection) =>
        connection.companyId === companyId &&
        connection.marketplace === marketplace
    );
  }

  function getHistoricalSpeedSnapshot(companyId: string): HistoricalSpeedSnapshot {
    return {
      completedLastHour: getCompanyCount(completedLastHourRows, companyId),
      completedLast6Hours: getCompanyCount(completedLast6HoursRows, companyId),
      completedLast24Hours: getCompanyCount(completedLast24HoursRows, companyId),
      stuckRunningJobs: getCompanyCount(stuckRunningRows, companyId),
    };
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
              company.id,
              getHistoricalSpeedSnapshot(company.id)
            );

            const latestJobs = getCompanyLatestJobs(
              historicalLatestJobs,
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
                          Оставь пустым, если не хочешь менять сохранённый токен.
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
                          <div className="text-slate-500">Последняя ошибка</div>
                          <div className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words font-semibold text-slate-900">
                            {simplifyApiError(wb?.lastError)}
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
                          formAction="/api/settings/api-connections/sync-wb-product-cards"
                          formMethod="POST"
                          pendingText="Обновляем карточки WB..."
                          className={`${buttonBase} border border-violet-300 bg-violet-50 text-violet-700`}
                        >
                          Обновить карточки WB
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
                              Пустые поля не перезаписывают уже сохранённые ключи.
                            </p>
                          </div>
                        </div>
                      </div>

                      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
                        <h4 className="text-lg font-bold text-slate-900">
                          Ozon Performance API
                        </h4>
                        <p className="mt-1 text-sm text-slate-500">
                          Используется только для рекламы Ozon: расходы, показы,
                          клики и кампании.
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
                              Эти поля можно оставить пустыми, пока не подключаем
                              рекламу Ozon.
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
                          <div className="text-slate-500">Последняя ошибка</div>
                          <div className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words font-semibold text-slate-900">
                            {simplifyApiError(ozon?.lastError)}
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

                <section className="mt-8 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-3">
                        <p className="text-xs font-bold uppercase tracking-[0.18em] text-slate-400">
                          Историческая загрузка
                        </p>

                        <span
                          className={`rounded-full px-3 py-1 text-xs font-bold ${historicalStats.statusClass}`}
                        >
                          {historicalStats.statusLabel}
                        </span>
                      </div>

                      <div className="mt-2 flex flex-wrap items-end gap-x-4 gap-y-1">
                        <h3 className="text-xl font-bold tracking-tight text-slate-950">
                          Прогресс загрузки старых данных
                        </h3>

                        <p className="text-sm text-slate-500">
                          {historicalStats.statusText}
                        </p>
                      </div>

                      <div className="mt-3 flex flex-wrap gap-2 text-xs font-semibold text-slate-600">
                        <span className="rounded-full bg-white px-3 py-1 ring-1 ring-slate-200">
                          Ozon задач: {historicalStats.ozonTotal}
                        </span>
                        <span className="rounded-full bg-white px-3 py-1 ring-1 ring-slate-200">
                          WB задач: {historicalStats.wbTotal}
                        </span>
                        <span className="rounded-full bg-white px-3 py-1 ring-1 ring-slate-200">
                          За 1 час: {historicalStats.speed.completedLastHour}
                        </span>
                        <span className="rounded-full bg-white px-3 py-1 ring-1 ring-slate-200">
                          За 24 часа: {historicalStats.speed.completedLast24Hours}
                        </span>
                      </div>
                    </div>

                    <div className="grid shrink-0 grid-cols-2 gap-2 rounded-2xl bg-white p-3 shadow-sm ring-1 ring-slate-200 md:grid-cols-3 xl:grid-cols-6">
                      <div className="min-w-[92px] rounded-xl bg-slate-50 px-3 py-2">
                        <div className="text-[11px] text-slate-500">
                          Прогресс
                        </div>
                        <div className="mt-1 text-lg font-black text-slate-950">
                          {historicalStats.percent}%
                        </div>
                      </div>

                      <div className="min-w-[92px] rounded-xl bg-slate-50 px-3 py-2">
                        <div className="text-[11px] text-slate-500">
                          Готово
                        </div>
                        <div className="mt-1 text-lg font-black text-slate-950">
                          {historicalStats.completed}
                          <span className="text-xs font-bold text-slate-400">
                            {" "}
                            / {historicalStats.total}
                          </span>
                        </div>
                      </div>

                      <div className="min-w-[92px] rounded-xl bg-slate-50 px-3 py-2">
                        <div className="text-[11px] text-slate-500">
                          Осталось
                        </div>
                        <div className="mt-1 text-lg font-black text-blue-700">
                          {historicalStats.remaining}
                        </div>
                      </div>

                      <div className="min-w-[92px] rounded-xl bg-slate-50 px-3 py-2">
                        <div className="text-[11px] text-slate-500">
                          Скорость
                        </div>
                        <div className="mt-1 text-lg font-black text-slate-950">
                          {formatJobsPerHour(
                            historicalStats.speed.averageJobsPerHour
                          )}
                        </div>
                      </div>

                      <div className="min-w-[92px] rounded-xl bg-slate-50 px-3 py-2">
                        <div className="text-[11px] text-slate-500">
                          Прогноз
                        </div>
                        <div className="mt-1 text-lg font-black text-slate-950">
                          {historicalStats.speed.estimatedDurationText}
                        </div>
                      </div>

                      <div className="min-w-[92px] rounded-xl bg-slate-50 px-3 py-2">
                        <div className="text-[11px] text-slate-500">
                          Проблемы
                        </div>
                        <div
                          className={`mt-1 text-lg font-black ${
                            historicalStats.problemsCount > 0
                              ? "text-red-700"
                              : "text-emerald-700"
                          }`}
                        >
                          {historicalStats.problemsCount}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-200">
                    <div
                      className="h-full rounded-full bg-slate-900"
                      style={{ width: `${historicalStats.percent}%` }}
                    />
                  </div>

                  <div className="mt-3 grid gap-2 text-xs font-semibold text-slate-600 md:grid-cols-4">
                    <div className="rounded-xl bg-white px-3 py-2 ring-1 ring-slate-200">
                      В очереди:{" "}
                      <span className="font-black text-blue-700">
                        {historicalStats.queued}
                      </span>
                    </div>
                    <div className="rounded-xl bg-white px-3 py-2 ring-1 ring-slate-200">
                      Выполняется:{" "}
                      <span className="font-black text-slate-950">
                        {historicalStats.running}
                      </span>
                    </div>
                    <div className="rounded-xl bg-white px-3 py-2 ring-1 ring-slate-200">
                      Лимиты API:{" "}
                      <span className="font-black text-amber-700">
                        {historicalStats.waiting}
                      </span>
                    </div>
                    <div className="rounded-xl bg-white px-3 py-2 ring-1 ring-slate-200">
                      Зависшие:{" "}
                      <span className="font-black text-red-700">
                        {historicalStats.stuckRunningJobs}
                      </span>
                    </div>
                  </div>

                  <div className="mt-4 overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
                    <div className="grid grid-cols-[88px_1fr_86px_74px_96px] gap-3 border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-xs font-bold uppercase tracking-[0.12em] text-slate-400">
                      <div>Площадка</div>
                      <div>Данные</div>
                      <div className="text-right">Готово</div>
                      <div className="text-right">%</div>
                      <div className="text-right">Статус</div>
                    </div>

                    {historicalStats.dataTypeStats.map((item) => (
                      <HistoricalProgressRow
                        key={`${item.marketplace}-${item.dataType}`}
                        item={item}
                      />
                    ))}
                  </div>

                  <div className="mt-4 grid gap-3 xl:grid-cols-2">
                    <HistoricalJobLine
                      title="Последнее успешно загружено"
                      job={latestJobs.lastSuccess}
                      tone="success"
                    />

                    <HistoricalJobLine
                      title="Последнее ожидание или ошибка"
                      job={latestJobs.lastIssue}
                      tone="warning"
                    />
                  </div>

                  <form
                    action="/api/historical-sync/start"
                    method="POST"
                    className="mt-4 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200"
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

                    <p className="mt-3 text-xs leading-5 text-slate-500">
                      Повторный запуск не создаёт уже существующие задачи за тот
                      же период. Временные ошибки маркетплейсов система
                      обрабатывает автоматически. Прогноз времени считается по
                      текущей скорости загрузки и может меняться.
                    </p>

                    {historicalStats.problemsCount > 0 ? (
                      <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm leading-6 text-red-800">
                        Есть данные, которые требуют внимания: ошибки, лимиты API
                        или зависшие задачи. Обычно временные лимиты система
                        переждёт сама, но если ошибка повторяется — проверь
                        подключение выше.
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