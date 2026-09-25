# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS base

WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/*

FROM base AS deps

COPY package.json package-lock.json ./

RUN npm ci

FROM base AS builder

ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV DATABASE_URL="postgresql://REDACTED"
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY

# Fail-closed: Ozon /by-day route must remain in source packages.
RUN test -f app/api/cron/sync-ozon-accruals/route.ts \
  && test -f lib/ozon/accrualByDay.ts \
  && test -f lib/ozon/syncOzonAccrualByDay.ts \
  && grep -q "syncOzonAccrualByDayOverlay" lib/ozon/syncOzon.ts

RUN npx prisma generate && npm run build

# Fail-closed: compiled Next.js output must contain the route.
RUN test -e .next/server/app/api/cron/sync-ozon-accruals/route.js \
  || test -d .next/server/app/api/cron/sync-ozon-accruals

FROM builder AS stock-abc-worker

ENV NODE_ENV=production

CMD ["node", "--import", "tsx", "scripts/stocks/refreshStockAbcSnapshots.ts"]

FROM builder AS dashboard-period-snapshot-worker

ENV NODE_ENV=production

RUN test -f scripts/dashboard/runDashboardPeriodSnapshotWorker.ts \
  && test -f lib/dashboard/periodSnapshot.ts

CMD ["node", "--import", "tsx", "scripts/dashboard/runDashboardPeriodSnapshotWorker.ts"]

FROM builder AS v6-period-readmodel-worker

ENV NODE_ENV=production

RUN test -f scripts/dashboard/runV6PeriodReadModelWorker.ts \
  && test -f lib/dashboard/v6PeriodReadModel/producer.ts

CMD ["node", "--import", "tsx", "scripts/dashboard/runV6PeriodReadModelWorker.ts"]

FROM builder AS profit-readmodel-worker

ENV NODE_ENV=production

RUN test -f scripts/dashboard/runProfitReadModelWorker.ts \
  && test -f lib/profitReadModel/index.ts \
  && test -f lib/profitReadModel/producer.ts \
  && test -f lib/profitReadModel/consumer.ts

CMD ["node", "--import", "tsx", "scripts/dashboard/runProfitReadModelWorker.ts"]

FROM builder AS financial-repair-runner

ENV NODE_ENV=production

RUN test -f scripts/financialRepair/runOzonHistoricalFinancialRepair.ts \
  && test -f scripts/financialRepair/resolveProductionWrapperBinding.ts \
  && test -f scripts/financialRepair/pollRepairWorkerDrain.ts \
  && test -f lib/ozon/syncOzonAccrualByDay.ts \
  && test -f lib/ozon/historicalRepairInvalidationPolicy.ts \
  && test -f lib/ozon/accrualByDay.ts \
  && test -f lib/ozon/ownerApprovalBinding.ts \
  && test -f lib/ozon/financialRepairProductionAdapters.ts \
  && grep -q "runProductionAdapterReadinessGate" scripts/financialRepair/runOzonHistoricalFinancialRepair.ts \
  && grep -q "createProductionMutationAdapters" scripts/financialRepair/runOzonHistoricalFinancialRepair.ts

# Non-root when possible; tsx import remains available via builder node_modules.
RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 repair \
  && chown -R repair:nodejs /app
USER repair

CMD ["node", "--import", "tsx", "scripts/financialRepair/runOzonHistoricalFinancialRepair.ts"]

FROM base AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
ENV NEXT_TELEMETRY_DISABLED=1

RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma

USER nextjs

EXPOSE 3000

CMD ["node", "server.js"]
