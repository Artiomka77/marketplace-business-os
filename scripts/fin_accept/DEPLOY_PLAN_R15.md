# DEPLOY_PLAN_R15 — авторитетный план (НЕ выполнять на MAIN без OK)

`productionChanged: false` в рамках R15. Entrypoint: `scripts/fin_accept/deploy_entrypoint_R12.sh` (стадии R15).

## Канон недели (не пересчитывать)
Business ALL **994198.47**. Ozon N ALL **173948.64**. WB Петров **150408.00**.
Кредит `loan_dfd0049677` OWNER_CONFIRMED_FULLY_REPAID; WB удержание 683951.53 уже вне операционной прибыли.

## Provenance (после зелёного GHA R15)
- financialSourceCommit: `bf4f8b5690bdbe417afe7a95cc7beca16c043abc`
- build branch: `build/fin-accept-images-20261028_R15`
- buildSourceCommit / ImageIds / run id: заполнить из `evidence/image-meta/BUILD_IDENTITY.txt` и `ARTIFACTS_MANIFEST`
- Journal: `/var/lib/avorofin/cutover_journal_R15`
- State: `/var/lib/avorofin/fa_images_20261028_R15`

## Обязательный порядок (entrypoint)
```bash
export STAMP=20261028_R15
export FA_STATE=/var/lib/avorofin/fa_images_${STAMP}
export CUTOVER_JOURNAL_DIR=/var/lib/avorofin/cutover_journal_R15
export GHA_RUN_ID=<green_R15_run>
export BUILD_SOURCE_COMMIT=<head_sha>
export DATABASE_URL=...   # secret, not archived

bash scripts/fin_accept/deploy_entrypoint_R12.sh preflight-artifacts   # BOTH tar+meta BEFORE stop
bash scripts/fin_accept/deploy_entrypoint_R12.sh compare-env profit captured.env expected.env
bash scripts/fin_accept/deploy_entrypoint_R12.sh stop-claims          # RUNNING=0 only
bash scripts/fin_accept/deploy_entrypoint_R12.sh switch
bash scripts/fin_accept/deploy_entrypoint_R12.sh weekly               # profit→wait→v6→wait→dash→wait
bash scripts/fin_accept/deploy_entrypoint_R12.sh verify-week          # WB+Ozon+Finance+business
```

Rollback:
```bash
bash scripts/fin_accept/deploy_entrypoint_R12.sh rollback
# data (full ProfitPeriodMetric contract snapshot only):
export OZON_PERIOD_SNAPSHOT_JSON=/path/to/full_ozon_period_snapshot.json
bash scripts/fin_accept/deploy_entrypoint_R12.sh data-rollback
```

## Post-switch gates
1. Five roles Running + EXPECT ImageId + `/login`
2. Consumer: WB/Ozon/Finance/Business match WEEK_RESULT (±0.01); ALL = sum ИП
3. Telegram shared code in APP image; Telegram host update = separate step (no send in R15)
4. Stop on proven canon delta

## Telegram runtime
Separate server. New MAIN app image does **not** auto-update Telegram. Plan Telegram image/pull as follow-up after MAIN week verify.
