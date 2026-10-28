# DEPLOY_PLAN_R17 — исполняемый план MAIN + Telegram (не запускать без OK владельца)

`productionChanged: false` / `telegramSent: false` до явного OK владельца.

Скрипты R17; образы R15 (runtime delta только внешняя обвязка — images не пересобирать).

## Provenance
| Kind | Value |
|------|-------|
| financialSourceCommit | `bf4f8b5690bdbe417afe7a95cc7beca16c043abc` |
| imageStamp | `20261028_R15` |
| imageBuildCommit | `33d9461619f0ca0743ebb9477a15ba3698713146` |
| imageGhaRunId | `40653680208` |
| scripts branch | `build/fin-accept-images-20261028_R17` |
| scriptsCommit | *(заполнить из pack RESULT / git HEAD)* |
| isolation workflow | `fin-accept-r17-isolation` |
| financeFixture | `scripts/fin_accept/fixtures/FINANCE_ADAPTER_ROWS.json` SHA256 `48f55d8de6260ff0f59ab6a6d178093c171cf283ce2d438b309ca55fa593242a` |
| financeSourceFull (RO provenance) | SHA256 `4a0b7d2859157bb1833aa3360f5fe02ee88911aa6137e72853138bea00b0c298` |

ImageIds (R15, keep):
- app `sha256:35fe2ecd036d834ff977dd2771720a6d8f4273f5eec8555ea775133c8349c989`
- profit `sha256:10c0ea6922cd1c97dccc367ac1bb9fb1258d766493785c94297cf40ae1a8a0f0`
- v6 `sha256:a37bd78157a2ab509d12831ff64ac5fb624c948ded8cc59b14e37e2e7301d219`
- dashboard `sha256:4f4c512f519d09eccdf7fa28c705f0acbb5a7d9a15099fae7520fc65e7727c4b`
- stock `sha256:d9d47b31b1486c533ba83691adf96976d90172adabb27a228772fa9373b36e37`

State: `/var/lib/avorofin/fa_images_20261028_R17`  
Journal: `/var/lib/avorofin/cutover_journal_R17`  
Backup: `$FA_STATE/backup` (Ozon+WB PPM + SKU + inventory)

## Порядок на MAIN (один entrypoint, stop-on-error)

```bash
export STAMP=20261028_R17
export IMAGE_STAMP=20261028_R15
export IMAGE_BUILD_COMMIT=33d9461619f0ca0743ebb9477a15ba3698713146
export IMAGE_GHA_RUN_ID=40653680208
export GHA_RUN_ID=$IMAGE_GHA_RUN_ID
export FA_STATE=/var/lib/avorofin/fa_images_${STAMP}
export WEEK_BACKUP_DIR=$FA_STATE/backup
export CUTOVER_JOURNAL_DIR=/var/lib/avorofin/cutover_journal_R17
export BUILD_SOURCE_COMMIT=<scriptsCommit>
export SCRIPTS_COMMIT=<scriptsCommit>
# Secrets stay in role env-files / captured runtime — never paste into logs

bash scripts/fin_accept/deploy_entrypoint_R12.sh preflight-artifacts
bash scripts/fin_accept/deploy_entrypoint_R12.sh capture-env
# Expected env = cutover env-file / runtime captured (NOT image Config.Env)
bash scripts/fin_accept/deploy_entrypoint_R12.sh load-runner-env profit
bash scripts/fin_accept/deploy_entrypoint_R12.sh runtime-preflight
bash scripts/fin_accept/deploy_entrypoint_R12.sh compare-env profit
bash scripts/fin_accept/deploy_entrypoint_R12.sh compare-env v6
bash scripts/fin_accept/deploy_entrypoint_R12.sh compare-env dashboard
bash scripts/fin_accept/deploy_entrypoint_R12.sh backup-week
bash scripts/fin_accept/deploy_entrypoint_R12.sh stop-claims
# On ANY fail before switch: restores ALL already-touched roles; container must be stopped
bash scripts/fin_accept/deploy_entrypoint_R12.sh switch
bash scripts/fin_accept/deploy_entrypoint_R12.sh weekly
# profit→wait→v6→wait→dashboard→wait→final (WEEKLY_STAGE=all rejected unless ALLOW_UNSAFE_WEEKLY_ALL=1)
bash scripts/fin_accept/deploy_entrypoint_R12.sh verify-week
# consumer = loadProfitReadModel + computeCheapProfitSourceVersion, enqueueOnMiss=false
```

## Откат runtime / data
```bash
# 1) Runtime images back (workers may overwrite data — stop writers first if restoring data)
bash scripts/fin_accept/deploy_entrypoint_R12.sh stop-claims   # if writers running
bash scripts/fin_accept/deploy_entrypoint_R12.sh data-rollback # WEEK_BACKUP_DIR scoped PPM+SKU; deletes hadRow=false
bash scripts/fin_accept/deploy_entrypoint_R12.sh rollback      # cutover image rollback
# Then start workers only after data restore completes
```

## Telegram (отдельный хост 64.188.63.133 — после MAIN verify PASS)

Observed RO (28.10.2026):
- container `avorofin-telegram-app` (not compose-managed)
- image `avorofin-p0-cogs-telegram:20261014_tg_top_truth`
- imageId `sha256:7f9fee6a7e5f5595d6895d892d37dd218e5e2cb62ebf86a5b048ee15a1132453`
- listeners: Caddy `:443` → bridge `8092` → app `127.0.0.1:3001`; test `8091`
- dailyReport expected SHA `9c800fcc2d9a75fc4940de03c2f87a511f78677210cd83793a33577cf9e58327` (R15 accepted) — confirm in NEW image before cutover

```bash
export TELEGRAM_HOST=64.188.63.133 TELEGRAM_SSH_USER=root
bash scripts/fin_accept/deploy_entrypoint_R12.sh telegram-plan
# Concrete commands written to $FA_STATE/telegram_plan.json:
# 1) capture env-file from running container
# 2) tag current image as rollback_pre_r17
# 3) docker stop/rm + docker run -d --env-file … -p 127.0.0.1:3001:3000 NEW_IMAGE
# 4) curl health 127.0.0.1:3001 — NO telegram send / op 572 / test finance tx
# 5) rollback = same run with rollback_pre_r17 tag
```

## Канон недели (не пересчитывать)
Business ALL **994198.47**. Ozon N ALL **173948.64**. WB Петров **150408.00**.  
Кредит `loan_dfd0049677` OWNER_CONFIRMED_FULLY_REPAID — не переоткрывать.
