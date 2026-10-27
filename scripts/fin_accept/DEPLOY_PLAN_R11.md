# DEPLOY_PLAN_R11 — исполнимый план (НЕ ВЫПОЛНЯТЬ на MAIN)

productionChanged: **false**. Deploy/merge/Telegram **не выполнять**.

## Статусы
- Финансы 19–25.10.2026: **994198.47** (без изменений).
- partnerPolicy: `OWNER_CONFIRMED_SAME_AS_DISCOUNT_POINTS` (N=G−B−A).
- Cutover: `ALL_CUTOVER_ACCEPTANCE_PASS` incl. retry_after_partial_restore / exit_after_rename / refuse_unknown.
- Ozon page display: `OZON_PAGE_DISPLAY_R11_PASS` (ALL N=173948.64 on legacy R08 payloads).

## Идентичность (заполнить ImageId из GHA R11 после зелёного run)
- financialSourceCommit: `bf4f8b5690bdbe417afe7a95cc7beca16c043abc`
- build branch: `build/fin-accept-images-20261027_R11`
- buildSourceCommit: _(см. evidence/image-meta/BUILD_IDENTITY.txt)_
- STAMP: `20261027_R11`
- GHA run: _(см. evidence/GHA_RUN.json)_
- Journal path (фиксированный): `/var/lib/avorofin/cutover_journal_R11`
- RepoDigest: null (tar artifacts)

## MAIN runtime (read-only 2026-10-27T20:05Z UTC) — подтверждено
Источник env: **нет** `/opt/avorofin/env/`. APP: `/opt/avorofin/.env.production`. Workers: env в `Config.Env` контейнера.
Cutover R11: при отсутствии файла захватывает `Config.Env` → `$JOURNAL_DIR/<role>.env.captured` (mode 600; не архивировать).

| Role | ImageId (текущий MAIN) | User | Network | Ports | Cmd |
|------|------------------------|------|---------|-------|-----|
| avorofin-app | sha256:7ed8f9a0…d74ea8d | nextjs | bridge | 127.0.0.1:3000:3000 | node server.js |
| profit | sha256:35fe9b67… | "" → `--user 0` | bridge | — | runProfitReadModelWorker.ts |
| v6 | sha256:88b8e683… | "" → `--user 0` | bridge | — | runV6PeriodReadModelWorker.ts |
| dashboard | sha256:4d09f378… | "" → `--user 0` | host | — | runDashboardPeriodSnapshotWorker.ts |
| stock | sha256:648952f6… | 0 | host | — | runDashboardPeriodSnapshotWorker.ts |

Workdir=/app, restart=unless-stopped, entrypoint=docker-entrypoint.sh, mounts=[] — подтверждено inspect.
Полный лог: `evidence/MAIN_RUNTIME_INSPECT_R11.txt`.

Ключевые MODE vars (имена; значения на MAIN не печатать в отчёт):
- profit: `WAVE_B_PROFIT_WORKER_MODE`, `WAVE_B_TARGET_DB_MODE`, `DATABASE_URL`
- v6: `V6_READMODEL_WORKER_MODE`, `V6_READMODEL_TARGET_DATABASE_URL`
- dashboard/stock: `DASHBOARD_SNAPSHOT_WORKER_MODE`, `DASHBOARD_SNAPSHOT_FORMULA_VERSIONS`, `DATABASE_URL`

## Artifacts
```bash
set -euo pipefail
STATE=/var/lib/avorofin/fa_images_R11
mkdir -p "$STATE" && chmod 700 "$STATE"
cd "$STATE"
RUN_ID=REPLACE_WITH_R11_GHA_RUN_ID
gh run download "$RUN_ID" --repo Artiomka77/marketplace-business-os \
  -n fin-accept-image-tarballs-20261027_R11 -D ./tars
cd tars
sha256sum -c SHA256SUMS.txt
for r in app profit v6 dashboard stock; do docker load -i "${r}.tar.gz"; done
# EXPECT_* = ImageId из ARTIFACTS_MANIFEST.json
```

## Остановка claims (проверено по коду; на MAIN не запускать)
`DASHBOARD_SNAPSHOT_WORKER_MODE=drain` **продолжает claim** до опустошения очереди — это не запрет новых claims.
Смена env в shell **не** меняет env уже запущенного контейнера.
WorkerClaimGate **не** установлен.

Фактический механизм запрета новых claims:
1. `docker stop <role>` → SIGTERM → `stopping=true` в worker (profit/v6/dashboard) — после текущего job новых claim нет.
2. Дождаться нуля RUNNING в БД (read-only SQL), затем switch.

```bash
# Пример ожидания (read-only; не выполнять сейчас на MAIN без разрешения):
# Profit / Dashboard jobs:
psql "$DATABASE_URL" -c "SELECT status, count(*) FROM \"DashboardPeriodSnapshotJob\" WHERE status IN ('RUNNING','PENDING') GROUP BY 1;"
# V6:
psql "$DATABASE_URL" -c "SELECT status, count(*) FROM \"DashboardPeriodSnapshotJob\" WHERE \"formulaVersion\"='FINANCIAL_CORE_V6_PERIOD_READMODEL_V2' AND status IN ('RUNNING','PENDING') GROUP BY 1;"
```

Порядок drain перед cutover:
1. `docker stop avorofin-profit-readmodel-worker` → wait no RUNNING for Wave-B formulas  
2. `docker stop avorofin-v6-period-readmodel-worker` → wait V6 RUNNING=0  
3. `docker stop avorofin-dashboard-period-snapshot-worker` → wait dashboard RUNNING=0  
4. `docker stop avorofin-stock-planning-snapshot-worker` → wait stock formula RUNNING=0  
5. APP можно оставить до последнего шага switch (switch сам переключает app last)

Изолированная проверка SIGTERM→stop flag: `scripts/fin_accept/prove_worker_stop_claims_R11.mjs` (без MAIN).

## Switch / rollback
```bash
export CUTOVER_JOURNAL_DIR=/var/lib/avorofin/cutover_journal_R11
export CUTOVER_ENV_DIR=/opt/avorofin
export CUTOVER_PRE_SUFFIX=pre-fa-cutover
# IMAGE_* tags + EXPECT_* ImageIds from R11 ARTIFACTS_MANIFEST.json
bash scripts/deploy/cutover_five_roles.sh switch
# отдельный процесс:
bash scripts/deploy/cutover_five_roles.sh rollback
```
Preflight отказывает при unfinished status / conflict backup / missing container / empty env.
Rollback identity-aware: уже восстановленный original не удаляется; unknown state → ROLLBACK_UNKNOWN_STATE без разрушения.

## Недельный rebuild 2026-10-19…2026-10-25 (после healthy cutover; не GHA)
Scopes: `ИП Петров`, `ИП Лебедева`, `ALL`.

1. Insert/claim Profit Wave-B jobs (OZON + WB) на период → wait SUCCESS.  
2. V6 `FINANCIAL_CORE_V6_PERIOD_READMODEL_V2` для трёх scopes → wait SUCCESS.  
3. Dashboard V4 period snapshot → wait SUCCESS.  
4. Stock `STOCK_PLANNING_SNAPSHOT_V3` при необходимости.  
5. Consumer: Insights/profit-ozon HIT; контроль N ALL=173948.64, Business ALL=994198.47, ALL=сумма ИП.

Стоп при расхождении >0.01 ₽ к принятой таблице / дубликате SUCCESS jobs / rebuildPending.

## Data rollback (совместимость)
Старый образ **не** содержит `resolveOzonNetExpensesForDisplay`. Варианты после container rollback:
1. **Предпочтительно:** пересобрать неделю 19–25 producers на старых образах (ограниченный scope).  
2. Оставить payloads: компоненты G/B/A позволяют пересчёт; старая страница покажет stored `netOzonExpenses` под старой подписью «после баллов» (для legacy G−B это согласовано; для новых G−B−A payloads подпись устареет, но A не вычитается повторно).  
Не делать широкую invalidation / restore всей БД / откат COGS/Finance.

## Критерии будущей приёмки
1. Пять ролей на EXPECT ImageId + user/network/ports/HostIp.  
2. APP `/login`.  
3. RUNNING=0 после drain; нет дублей jobs.  
4. Неделя = 994198.47; display N ALL=173948.64.  
5. Rollback отдельным процессом + retry после partial.  
6. Telegram — отдельный runtime (код совместимости в shared; deploy Telegram вне плана).
