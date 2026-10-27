# DEPLOY_PLAN_R12 — единый авторитетный план (НЕ ВЫПОЛНЯТЬ на MAIN без OK владельца)

`productionChanged: false`. Deploy/merge/Telegram **не выполнять** в рамках приёмки R12.

Исторические: `DEPLOY_PLAN_R10.md`, `DEPLOY_PLAN_R11.md` — не использовать как операционные.
Единственный entrypoint: `scripts/fin_accept/deploy_entrypoint_R12.sh`.

## Канон недели (не пересчитывать)
| | WB | Ozon | МП | Finance | Бизнес |
|---|---:|---:|---:|---:|---:|
| Петров | 150408.00 | 866136.86 | 1016544.86 | -33931.10 | 982613.76 |
| Лебедева | -1160.77 | 16327.25 | 15166.48 | -3581.77 | 11584.71 |
| ALL | 149247.23 | 882464.11 | 1031711.34 | -37512.87 | **994198.47** |

Ozon display N ALL = **173948.64** (N=G−B−A). partnerPolicy=`OWNER_CONFIRMED_SAME_AS_DISCOUNT_POINTS`.

## Provenance (заполнить из GHA R12 после зелёного run)
- financialSourceCommit: `bf4f8b5690bdbe417afe7a95cc7beca16c043abc`
- build branch: `build/fin-accept-images-20261027_R12`
- buildSourceCommit: см. `evidence/image-meta/BUILD_IDENTITY.txt` (должен совпасть с label образа)
- STAMP: `20261027_R12`
- GHA run id: см. `evidence/GHA_RUN.json`
- Journal: `/var/lib/avorofin/cutover_journal_R12`
- Artifacts dir: `/var/lib/avorofin/fa_images_R12/tars` (SHA256SUMS + `*.tar.gz` + ARTIFACTS_MANIFEST.json)

R11 local tip `73974e7…` = R11 image label. R12 images = новый HEAD после commit R12 (не выдавать R11 ImageId за содержащий R12 код).

## MAIN runtime (уже подтверждено R11; не искать «пропавшие» env-файлы)
- Нет `/opt/avorofin/env/`.
- APP: `/opt/avorofin/.env.production` (не эквивалент Config.Env workers).
- Workers: `Config.Env` контейнера.
- Сравнение ключей без печати секретов: `scripts/fin_accept/compare_main_env_keys_R12.sh captured.env expected.env`

## Последовательность (entrypoint)

```bash
export FA_STATE=/var/lib/avorofin/fa_images_R12
export CUTOVER_JOURNAL_DIR=/var/lib/avorofin/cutover_journal_R12
export CUTOVER_ENV_DIR=/opt/avorofin
export CUTOVER_PRE_SUFFIX=pre-fa-cutover-r12
export GHA_RUN_ID=<green_R12_run_id>
export STAMP=20261027_R12
export DATABASE_URL=...          # secret; not archived
# export V6_READMODEL_TARGET_DATABASE_URL=...  # if distinct

bash scripts/fin_accept/deploy_entrypoint_R12.sh verify-artifacts
# loads from $FA_STATE/tars after: gh run download … -D $FA_STATE/tars
# then: cd $FA_STATE/tars && sha256sum -c SHA256SUMS.txt && docker load …

bash scripts/fin_accept/deploy_entrypoint_R12.sh stop-claims
# docker stop profit → wait RUNNING=0 (PENDING ignored)
# docker stop v6 → wait RUNNING=0
# docker stop dashboard → wait RUNNING=0
# docker stop stock → wait RUNNING=0
# DASHBOARD drain MODE is NOT a claim gate.

# Set EXPECT_* ImageIds from $FA_STATE/tars/ARTIFACTS_MANIFEST.json before switch
bash scripts/fin_accept/deploy_entrypoint_R12.sh switch

# After healthy: workers start sequentially and may claim PENDING left by APP —
# that is intended; stop-claims only required RUNNING=0 before switch.
bash scripts/fin_accept/deploy_entrypoint_R12.sh weekly
bash scripts/fin_accept/deploy_entrypoint_R12.sh verify-week
```

Weekly matrix (exact): dateFrom=`2026-10-19` dateTo=`2026-10-25`; scopes `ИП Петров` / `ИП Лебедева` / `ALL`; formulas WB+OZON Profit + V6 Period V2 + Dashboard V4. Commands: `run_weekly_enqueue_R12.ts` → `wait_weekly_R12.sh` → `verify_week_consumer_R12.ts`. Idempotent via `decideV6JobRebuild` (no blind duplicate SUCCESS).

## Rollback / data-rollback
```bash
# Separate process OK; reads journal backup_name (not a new CUTOVER_PRE_SUFFIX)
bash scripts/fin_accept/deploy_entrypoint_R12.sh rollback

# Exact Ozon ProfitPeriodMetric restore for 19–25 only (not COGS/Finance/whole DB)
export OZON_PERIOD_SNAPSHOT_JSON=/path/to/pre_cutover_ozon_period.json
bash scripts/fin_accept/deploy_entrypoint_R12.sh data-rollback
```
Isolated rehearsal (no MAIN): `node scripts/fin_accept/rehearse_data_rollback_ozon_R12.mjs`.

## Post-switch controls
1. Five roles Running + EXPECT ImageId + `/login`.
2. Consumer: N ALL=173948.64; Business ALL=994198.47; ALL = sum of ИП (±0.01).
3. Stop on proven canon delta; incomplete display shows «н/д», not false 0.
4. Telegram = separate runtime (shared dailyReport code shipped in app image; Telegram deploy out of scope).

## Isolated proofs already required before owner execute
- Cutover mock: `ALL_CUTOVER_ACCEPTANCE_PASS` (incl. missing_backup / foreign_* / crash_*).
- Incomplete display + page + nonzero B/A + dailyReport incomplete.
- Stop-claims isolation (profit SIGTERM gate + interrupted ≠ SUCCESS).
- Weekly enqueue rehearsal (real job-id + decideV6JobRebuild).
