# DEPLOY_PLAN_R18 / FIN_CLOSE C01 — один управляющий runner

`productionChanged: false` / `telegramSent: false` до явного OK владельца на **этот** готовый план.

## Provenance
| Kind | Value |
|------|-------|
| scripts branch | `build/fin-accept-images-20261028_R18` |
| scriptsCommit | `c736efa7` (fill exact from RESULT/ASSERT after isolation) |
| imageStamp | `20261028_R15` |
| imageBuildCommit | `33d9461619f0ca0743ebb9477a15ba3698713146` |
| imageGhaRunId | `40653680208` |
| isolation workflow | `fin-accept-r18-isolation` |
| financeAdapterSha256 | `48f55d8de6260ff0f59ab6a6d178093c171cf283ce2d438b309ca55fa593242a` |
| telegramIsolationImage | `avorofin-p0-cogs-telegram:c01_isolation_local` (ImageId from REHEARSAL_SUMMARY) |
| dailyReportSha | `9c800fcc2d9a75fc4940de03c2f87a511f78677210cd83793a33577cf9e58327` |

State: `/var/lib/avorofin/fa_images_20261028_R18`  
Journal: `/var/lib/avorofin/cutover_journal_R18`  
Backup: `$FA_STATE/backup` after stop-claims

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

bash scripts/fin_accept/deploy_entrypoint_R12.sh run-all
# Order inside run-all:
#   preflight → capture-env → safe load-runner-env (declare -gx) → runtime-preflight →
#   compare-env → stop-claims → backup-week → switch → weekly → verify-week
# On failure before switch: restore ALL touched roles (RUN_ALL_RECOVER_OK)
```

Safe env: `safe_load_env_R18.py` (`declare -gx`, no raw `source`).  
`with_runner_env` / backup-week auto-load `$FA_STATE/runner.env` across process boundaries.

## Откат
```bash
bash scripts/fin_accept/deploy_entrypoint_R12.sh stop-claims   # if writers up
bash scripts/fin_accept/deploy_entrypoint_R12.sh data-rollback # PPM+SKU+V6/Dashboard (absent keys deleted)
bash scripts/fin_accept/deploy_entrypoint_R12.sh rollback
```

## Telegram (после MAIN verify PASS)
```bash
export TELEGRAM_HOST=64.188.63.133 TELEGRAM_SSH_USER=root
export TELEGRAM_NEW_IMAGE=avorofin-p0-cogs-telegram:c01_isolation_local
export TELEGRAM_NEW_IMAGE_ID=<ImageId_from_isolation_REHEARSAL_SUMMARY>
bash scripts/fin_accept/deploy_entrypoint_R12.sh telegram-plan
# Execute commands from $FA_STATE/telegram_plan.json exactly:
# image inspect BEFORE stop → capture env/hostconfig → tag rollback_pre_c01 →
# stop/rm/run → health without || true → automatic rollback on health fail
# No telegram send / op 572 / test finance tx / touch 8091
```

Observed RO runtime: `avorofin-telegram-app` @ `64.188.63.133`,
`127.0.0.1:3001→3000`, Caddy443→8092, test8091 untouched.

## Канон недели (сверка, не подстановка)
Business ALL **994198.47**. Ozon N ALL **173948.64**. WB Петров **150408.00**.  
loan_dfd0049677 OWNER_CONFIRMED_FULLY_REPAID — не переоткрывать.
