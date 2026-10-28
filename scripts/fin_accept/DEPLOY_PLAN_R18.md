# DEPLOY_PLAN_R18 / FIN_CLOSE C01 — один управляющий runner

`productionChanged: false` / `telegramSent: false` до явного OK владельца на **этот** готовый план.

## Provenance
| Kind | Value |
|------|-------|
| scripts branch | `build/fin-accept-images-20261028_R18` |
| scriptsCommit | *(fill from CLOSE_ACCEPTANCE / ASSERT after isolation)* |
| imageStamp | `20261028_R15` |
| imageBuildCommit | `33d9461619f0ca0743ebb9477a15ba3698713146` |
| imageGhaRunId | `40653680208` |
| isolation workflow | `fin-accept-r18-isolation` |
| financeAdapterSha256 | `48f55d8de6260ff0f59ab6a6d178093c171cf283ce2d438b309ca55fa593242a` |
| telegram NEW | `avorofin-p0-cogs-app:fin_accept_20261028_R15` ImageId `sha256:35fe2ecd036d834ff977dd2771720a6d8f4273f5eec8555ea775133c8349c989` |
| telegram NEW tar SHA256 | `cdfcbaa72017f5ed82e8659049faa39a0ded4a31d87cadd5989732cf080a5a7a` |
| telegram OLD | `avorofin-p0-cogs-telegram:20261014_tg_top_truth` ImageId `sha256:7f9fee6a7e5f5595d6895d892d37dd218e5e2cb62ebf86a5b048ee15a1132453` |
| dailyReportSha | `9c800fcc2d9a75fc4940de03c2f87a511f78677210cd83793a33577cf9e58327` |

State: `/var/lib/avorofin/fa_images_20261028_R18`  
Journal: `/var/lib/avorofin/cutover_journal_R18`  
Backup: fresh `run_<stamp>/` under `$FA_STATE/backup` (never wipe prior run dirs)

## Одна команда MAIN (предпочтительно)

```bash
export STAMP=20261028_R18
export IMAGE_STAMP=20261028_R15
export IMAGE_BUILD_COMMIT=33d9461619f0ca0743ebb9477a15ba3698713146
export IMAGE_GHA_RUN_ID=40653680208
export GHA_RUN_ID=$IMAGE_GHA_RUN_ID
export FA_STATE=/var/lib/avorofin/fa_images_${STAMP}
export WEEK_BACKUP_DIR=$FA_STATE/backup
export ENV_CAPTURE_DIR=$FA_STATE/env
export CUTOVER_JOURNAL_DIR=/var/lib/avorofin/cutover_journal_R18
export BUILD_SOURCE_COMMIT=<scriptsCommit_from_CLOSE_ACCEPTANCE>
export SCRIPTS_COMMIT=<scriptsCommit_from_CLOSE_ACCEPTANCE>
# unset RUN_ALL_STOP_AFTER — partial is NOT MAIN_OK

bash scripts/fin_accept/deploy_entrypoint_R12.sh run-all
# Order: preflight → capture-env → load-runner-env → runtime-preflight →
#   compare-env → stop-claims → backup-week → switch → weekly → verify-week
# Pre-switch fail → restore predeploy journal (RUN_ALL_RECOVER_OK)
# Post-switch fail → stop NEW → data-rollback → cutover rollback → restore predeploy
```

Safe env: `safe_load_env_R18.py` (`declare -gx`, no raw `source`).

## Откат
```bash
bash scripts/fin_accept/deploy_entrypoint_R12.sh stop-claims   # if writers up
bash scripts/fin_accept/deploy_entrypoint_R12.sh data-rollback # PPM+SKU+V6 PCM/daily/Dashboard
bash scripts/fin_accept/deploy_entrypoint_R12.sh rollback
```

## Telegram (после MAIN verify PASS)
```bash
export TELEGRAM_HOST=64.188.63.133 TELEGRAM_SSH_USER=root
export TELEGRAM_PLAN_MODE=live
export TELEGRAM_NEW_IMAGE=avorofin-p0-cogs-app:fin_accept_20261028_R15
export TELEGRAM_NEW_IMAGE_ID=sha256:35fe2ecd036d834ff977dd2771720a6d8f4273f5eec8555ea775133c8349c989
export TELEGRAM_OLD_IMAGE=avorofin-p0-cogs-telegram:20261014_tg_top_truth
export TELEGRAM_OLD_IMAGE_ID=sha256:7f9fee6a7e5f5595d6895d892d37dd218e5e2cb62ebf86a5b048ee15a1132453
export TELEGRAM_APP_TAR=/path/to/app_fin_accept_20261028_R15.tar.gz
export TELEGRAM_APP_TAR_SHA256=cdfcbaa72017f5ed82e8659049faa39a0ded4a31d87cadd5989732cf080a5a7a
bash scripts/fin_accept/deploy_entrypoint_R12.sh telegram-plan
# Execute commands_update_AFTER_MAIN_VERIFY from $FA_STATE/telegram_plan.json exactly:
# SHA+docker load+ImageId BEFORE stop → capture env/hostconfig → tag rollback_pre_c01 →
# stop/rm/run → telegram_app_ready_check (webhook + daily-report JSON) → auto-rollback on fail
# No telegram send / op 572 / test finance tx / touch 8091 / c01_isolation_local stub
```

Observed RO runtime: `avorofin-telegram-app` @ `64.188.63.133`,
`127.0.0.1:3001→3000`, Caddy443→8092, test8091 untouched.

## Канон недели (сверка, не подстановка)
Business ALL **994198.47**. Ozon N ALL **173948.64**. WB Петров **150408.00**.  
loan_dfd0049677 OWNER_CONFIRMED_FULLY_REPAID — не переоткрывать.
