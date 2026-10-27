# DEPLOY_PLAN_R10 — подготовка внедрения (НЕ ВЫПОЛНЯТЬ)

## Статусы
- Финансовый итог недели 19–25.10.2026: **994 198,47 ₽** (без изменений).
- partnerPolicy: `OWNER_CONFIRMED_SAME_AS_DISCOUNT_POINTS` (N=G−B−A; Profit=E−G−K−T=R−N−K−T).
- productionChanged: **false**. Deploy/merge/Telegram **не выполнять** в этом плане.
- Images: заполнить ImageId/tarSha256 из `image-meta/ARTIFACTS_MANIFEST.json` успешного GHA run после сборки R10.

## Идентичность
- financialSourceCommit: `bf4f8b5690bdbe417afe7a95cc7beca16c043abc`
- build branch: `build/fin-accept-images-20261027_R10`
- STAMP: `20261027_R10`
- platform: linux/amd64
- RepoDigest: null (NOT_PUSHED — доставка tar artifact)

## Контроль Ozon (представление)
| | Петров | Лебедева | ALL |
|--|--|--|--|
| N=G−B−A | 170858.17 | 3090.47 | 173948.64 |
| Ozon profit | 866136.86 | 16327.25 | 882464.11 |
| Business | 982613.76 | 11584.71 | **994198.47** |

Запрещены R+A−N и E−N. Старый payload с representation `G_MINUS_B` не читать как `G_MINUS_B_MINUS_A`; пересчитывать из G/B/A.

## Получение artifacts (на хосте внедрения, после разрешения)
```bash
set -euo pipefail
STATE_DIR="${HOME}/fa-cutover-20261027_R10"
mkdir -p "$STATE_DIR" && chmod 700 "$STATE_DIR"
cd "$STATE_DIR"
RUN_ID=REPLACE_AFTER_GHA   # fin-accept-images-build-only R10
gh run download "$RUN_ID" --repo Artiomka77/marketplace-business-os \
  -n "fin-accept-image-tarballs-20261027_R10" -D ./fa-images
SUMS=$(find ./fa-images -name SHA256SUMS.txt | head -n1)
cd "$(dirname "$SUMS")"
sha256sum -c SHA256SUMS.txt
for role in app profit v6 dashboard stock; do docker load -i "${role}.tar.gz"; done
```

## Runtime (MAIN read-only baseline; перепроверить inspect перед cutover)
| Role | User | Network | Ports |
|------|------|---------|-------|
| avorofin-app | nextjs | bridge | 127.0.0.1:3000:3000 |
| profit | ""→`--user 0` | bridge | — |
| v6 | ""→`--user 0` | bridge | — |
| dashboard | ""→`--user 0` | host | — |
| stock | 0 | host | — |

Env sources: `/opt/avorofin/env/<role>.env` (APP may use `.env.production`). Preflight **refuses** missing env before first rename. Secrets: mode 600, never archive values.

## Switch / rollback
Script: `scripts/deploy/cutover_five_roles.sh`
- Journal: `CUTOVER_JOURNAL_DIR` (default `/tmp/avorofin_cutover_journal`) — **не** обнуляется rollback-процессом.
- Switch order: profit → v6 → dashboard → stock → **app last**.
- Rollback: reverse of switched roles; verifies old ImageId; `ROLLBACK_FAILED` on error (nonzero exit).
- Acceptance: `scripts/deploy/test_cutover_plan_mock.sh all` → `ALL_CUTOVER_ACCEPTANCE_PASS`.

```bash
export CUTOVER_JOURNAL_DIR=/var/lib/avorofin/cutover_journal_R10
export CUTOVER_ENV_DIR=/opt/avorofin
export IMAGE_APP=avorofin-p0-cogs-app:fin_accept_20261027_R10
# ... IMAGE_PROFIT/V6/DASHBOARD/STOCK + EXPECT_* ImageIds from manifest
bash scripts/deploy/cutover_five_roles.sh switch
# separate process:
bash scripts/deploy/cutover_five_roles.sh rollback
```

## Остановка выдачи jobs / drain (из кода, не WorkerClaimGate)
- Dashboard/stock: `DASHBOARD_SNAPSHOT_WORKER_MODE=drain` затем stop.
- Profit: `WAVE_B_PROFIT_WORKER_MODE=queue-once` / stop service; wait no RUNNING in `DashboardPeriodSnapshotJob` for Wave-B formulas.
- V6: stop queue service; wait no RUNNING for `FINANCIAL_CORE_V6_PERIOD_READMODEL_V2`.
- Ozon accrual launcher/cron: **не менять** в этом задании; на время cutover — пауза по существующему ops-процессу владельца.

## Обновление недельных read models (после healthy cutover)
Период `2026-10-19`…`2026-10-25`, scopes: `ИП Петров`, `ИП Лебедева`, `ALL`.

Порядок:
1. Profit Wave-B producers (`FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1`, `…_OZON_…`) — queue jobs.
2. V6 period readmodel (`FINANCIAL_CORE_V6_PERIOD_READMODEL_V2`) — после profit.
3. Dashboard V4 snapshot (`FINANCIAL_CORE_V4_PERIOD_SNAPSHOT_V1`).
4. Stock `STOCK_PLANNING_SNAPSHOT_V3` — собственный fixture/finality; не подменять нулевым PnL.
5. Consumer Insights/Dashboard читает готовые snapshots.

Это **не** повторный GHA rebuild образов.

## Совместимость read models при откате контейнеров
- Новые записи с `netOzonExpensesRepresentation=G_MINUS_B_MINUS_A` и `partnerTaxPolicy=OWNER_CONFIRMED_…` старый код может показать с устаревшей подписью «после баллов» (G−B), но **нельзя** вычитать A повторно из уже N′.
- При откате образов: пересобрать неделю 19–25 producers на старых образах **или** оставить payloads и читать через `resolveOzonNetExpensesForDisplay` (компоненты G/B/A).
- Не делать широкую invalidation / restore backup на этапе подготовки.

## Критерии будущей приёмки
1. Пять ролей на ожидаемых ImageId + user/network/ports.
2. APP `/login` доступен.
3. Jobs не дублируются; drain пустой RUNNING.
4. Неделя согласована с таблицей 994198.47 и ALL=сумма ИП.
5. Нет скрытого rebuildPending.
6. Rollback отдельным процессом проверен.
7. Telegram — отдельный runtime; при несовместимости текста «после баллов» обновить отдельно (не в этом cutover).
