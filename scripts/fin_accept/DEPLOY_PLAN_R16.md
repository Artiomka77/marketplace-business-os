# DEPLOY_PLAN_R16 — исполняемый план MAIN + Telegram (не запускать без OK владельца)

`productionChanged: false` до явного OK. Скрипты R16; образы R15 (доказано: runtime в образах не менялся).

## Provenance
| Kind | Value |
|------|-------|
| financialSourceCommit | `bf4f8b5690bdbe417afe7a95cc7beca16c043abc` |
| imageStamp | `20261028_R15` |
| imageBuildCommit | `33d9461619f0ca0743ebb9477a15ba3698713146` |
| imageGhaRunId | `40653680208` |
| scripts branch | `build/fin-accept-images-20261028_R16` |
| scriptsCommit | *(заполнить из pack RESULT / git HEAD)* |
| isolation GHA | `fin-accept-r16-isolation` |

ImageIds (R15):
- app `sha256:35fe2ecd036d834ff977dd2771720a6d8f4273f5eec8555ea775133c8349c989`
- profit `sha256:10c0ea6922cd1c97dccc367ac1bb9fb1258d766493785c94297cf40ae1a8a0f0`
- v6 `sha256:a37bd78157a2ab509d12831ff64ac5fb624c948ded8cc59b14e37e2e7301d219`
- dashboard `sha256:4f4c512f519d09eccdf7fa28c705f0acbb5a7d9a15099fae7520fc65e7727c4b`
- stock `sha256:d9d47b31b1486c533ba83691adf96976d90172adabb27a228772fa9373b36e37`

State: `/var/lib/avorofin/fa_images_20261028_R16`  
Journal: `/var/lib/avorofin/cutover_journal_R16`  
Scripts bundle on host: checkout scriptsCommit under `/opt/avorofin` **or** sync `scripts/fin_accept/*` from pack `changed_files/` (не смешивать с другим commit).

## Порядок на MAIN (один entrypoint)

```bash
export STAMP=20261028_R16
export IMAGE_STAMP=20261028_R15
export IMAGE_BUILD_COMMIT=33d9461619f0ca0743ebb9477a15ba3698713146
export IMAGE_GHA_RUN_ID=40653680208
export GHA_RUN_ID=$IMAGE_GHA_RUN_ID
export FA_STATE=/var/lib/avorofin/fa_images_${STAMP}
export CUTOVER_JOURNAL_DIR=/var/lib/avorofin/cutover_journal_R16
export BUILD_SOURCE_COMMIT=<scriptsCommit>
export SCRIPTS_COMMIT=<scriptsCommit>
# DATABASE_URL already in role env — do not paste secrets into the plan log

bash scripts/fin_accept/deploy_entrypoint_R12.sh preflight-artifacts
bash scripts/fin_accept/deploy_entrypoint_R12.sh capture-env
bash scripts/fin_accept/deploy_entrypoint_R12.sh compare-env profit
bash scripts/fin_accept/deploy_entrypoint_R12.sh compare-env v6
bash scripts/fin_accept/deploy_entrypoint_R12.sh compare-env dashboard
bash scripts/fin_accept/deploy_entrypoint_R12.sh backup-week
# OZON_PERIOD_SNAPSHOT_JSON path written to $FA_STATE/OZON_PERIOD_SNAPSHOT_JSON.path
bash scripts/fin_accept/deploy_entrypoint_R12.sh stop-claims
bash scripts/fin_accept/deploy_entrypoint_R12.sh switch
bash scripts/fin_accept/deploy_entrypoint_R12.sh weekly
bash scripts/fin_accept/deploy_entrypoint_R12.sh verify-week
```

Остановка на любой ошибке. `stop-claims` при timeout RUNNING восстанавливает прежний container start — switch не выполнять.

## Откат
```bash
bash scripts/fin_accept/deploy_entrypoint_R12.sh rollback
# data (полный Ozon PPM snapshot из backup-week):
bash scripts/fin_accept/deploy_entrypoint_R12.sh data-rollback
# путь берётся из $FA_STATE/OZON_PERIOD_SNAPSHOT_JSON.path при отсутствии env
```

## Telegram (отдельный хост, после MAIN verify-week PASS)
```bash
export TELEGRAM_HOST=64.188.63.133
export TELEGRAM_SSH_USER=root
export TELEGRAM_REMOTE_ROOT=/opt/avorofin
bash scripts/fin_accept/deploy_entrypoint_R12.sh telegram-plan
# затем по $FA_STATE/telegram_plan.json:
# 1) сверить dailyReport sha с 9c800fcc… / APP image
# 2) load/pull тот же app или TG image provenance
# 3) compose up с сохранённым env
# 4) health only — НЕ отправлять отчёты / op 572
# 5) rollback: предыдущий image из journal
```

## Канон недели (не пересчитывать)
Business ALL **994198.47**. Ozon N ALL **173948.64**. WB Петров **150408.00**.  
Кредит `loan_dfd0049677` OWNER_CONFIRMED_FULLY_REPAID — не переоткрывать.
