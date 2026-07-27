#!/usr/bin/env bash
set -u -o pipefail

PROJECT="$(cd "$(dirname "$0")/../.." && pwd)"
AUDIT_IMAGE="avorofin-financial-audit-builder:v3"
PRODUCTION_CONTAINER="avorofin-app"
OUTPUT_DIR="${FINANCIAL_CORE_REGRESSION_OUTPUT:-/tmp/avorofin-financial-core-v1-regression}"
CASE_SCRIPT="$PROJECT/scripts/financial-core/run-financial-core-regression-v1-case.ts"
AGGREGATE_SCRIPT="$PROJECT/scripts/financial-core/aggregate-financial-core-regression-v1.ts"
RUN_LOG="$OUTPUT_DIR/financial-core-v1-regression.run.txt"

mkdir -p "$OUTPUT_DIR/cases" "$OUTPUT_DIR/logs"
chmod -R 777 "$OUTPUT_DIR"
rm -f \
  "$OUTPUT_DIR/financial-core-v1-regression.json" \
  "$OUTPUT_DIR/financial-core-v1-regression.summary.txt" \
  "$RUN_LOG"

echo "[]" > "$OUTPUT_DIR/case-failures.json"

PRODUCTION_DATABASE_URL="$(
  docker exec "$PRODUCTION_CONTAINER" node -e '
    const value = process.env.DATABASE_URL || "";
    if (!value) process.exit(2);
    process.stdout.write(value);
  '
)" || exit 1

export DATABASE_URL="$PRODUCTION_DATABASE_URL"

DB_HOST="$(
  docker exec "$PRODUCTION_CONTAINER" node -e '
    const url = new URL(process.env.DATABASE_URL);
    process.stdout.write(url.hostname);
  '
)" || exit 1

DB_HOST_IP="$(
  docker exec "$PRODUCTION_CONTAINER" sh -lc \
    "getent ahostsv4 '$DB_HOST' 2>/dev/null | awk 'NR==1 {print \$1}'" \
    || true
)"

NETWORK_ARGS=(--network host)

if [[ -n "$DB_HOST_IP" ]]; then
  NETWORK_ARGS+=(--add-host "${DB_HOST}:${DB_HOST_IP}")
fi

run_case() {
  local case_id="$1"
  local mode="$2"
  local date_from="$3"
  local date_to="$4"
  local company_name="$5"
  local case_log="$OUTPUT_DIR/logs/${case_id}.log"

  echo "CASE_START $case_id" | tee -a "$RUN_LOG"

  timeout --signal=TERM --kill-after=20s 900s \
    docker run --rm \
      "${NETWORK_ARGS[@]}" \
      --env-file "$PROJECT/.env.production" \
      -e DATABASE_URL \
      -e NODE_OPTIONS="--max-old-space-size=4096" \
      -e AUDIT_MODE="$mode" \
      -e CASE_ID="$case_id" \
      -e DATE_FROM="$date_from" \
      -e DATE_TO="$date_to" \
      -e COMPANY_NAME="$company_name" \
      -v "$PROJECT/lib/analytics/profitAnalytics.ts:/app/lib/analytics/profitAnalytics.ts:ro" \
      -v "$PROJECT/lib/analytics/profitAnalyticsOzon.ts:/app/lib/analytics/profitAnalyticsOzon.ts:ro" \
      -v "$PROJECT/lib/analytics/dataReadiness.ts:/app/lib/analytics/dataReadiness.ts:ro" \
      -v "$PROJECT/lib/finance/financeMetrics.ts:/app/lib/finance/financeMetrics.ts:ro" \
      -v "$PROJECT/lib/telegram/dailyReport.ts:/app/lib/telegram/dailyReport.ts:ro" \
      -v "$PROJECT/scripts/financial-core/run-financial-core-regression-v1-case.ts:/app/scripts/financial-core/run-financial-core-regression-v1-case.ts:ro" \
      -v "$OUTPUT_DIR:/regression-output" \
      -w /app \
      "$AUDIT_IMAGE" \
      ./node_modules/.bin/tsx \
      /app/scripts/financial-core/run-financial-core-regression-v1-case.ts \
      > "$case_log" 2>&1

  local exit_code=$?
  cat "$case_log" >> "$RUN_LOG"

  if [[ "$exit_code" -eq 0 ]] &&
     [[ -s "$OUTPUT_DIR/cases/${case_id}.json" ]]; then
    echo "CASE_DONE $case_id" | tee -a "$RUN_LOG"
    return 0
  fi

  echo "CASE_FAILED $case_id exit=$exit_code" | tee -a "$RUN_LOG"

  docker run --rm \
    -e CASE_ID="$case_id" \
    -e EXIT_CODE="$exit_code" \
    -v "$OUTPUT_DIR:/regression-output" \
    "$AUDIT_IMAGE" \
    node -e '
      const fs = require("node:fs");
      const file = "/regression-output/case-failures.json";
      const rows = JSON.parse(fs.readFileSync(file, "utf8"));
      rows.push({
        caseId: process.env.CASE_ID,
        exitCode: Number(process.env.EXIT_CODE),
      });
      fs.writeFileSync(file, JSON.stringify(rows, null, 2));
    ' \
    >/dev/null 2>&1

  return 0
}

run_case "direct-day8-petrov" "direct" "2026-07-08" "2026-07-08" "ИП Петров"
run_case "direct-day12-petrov" "direct" "2026-07-12" "2026-07-12" "ИП Петров"
run_case "direct-q2-petrov" "direct" "2026-04-01" "2026-06-30" "ИП Петров"
run_case "direct-q2-lebedeva" "direct" "2026-04-01" "2026-06-30" "ИП Лебедева"
run_case "readiness-ytd-petrov" "readiness" "2026-01-01" "2026-07-12" "ИП Петров"
run_case "readiness-ytd-lebedeva" "readiness" "2026-01-01" "2026-07-12" "ИП Лебедева"
run_case "report-day12" "report" "2026-07-12" "2026-07-12" ""
run_case "product-cost" "product-cost" "" "" ""

docker run --rm \
  -e NODE_OPTIONS="--max-old-space-size=1536" \
  -v "$AGGREGATE_SCRIPT:/app/scripts/financial-core/aggregate-financial-core-regression-v1.ts:ro" \
  -v "$OUTPUT_DIR:/regression-output" \
  -w /app \
  "$AUDIT_IMAGE" \
  ./node_modules/.bin/tsx \
  /app/scripts/financial-core/aggregate-financial-core-regression-v1.ts \
  >> "$RUN_LOG" 2>&1

aggregate_code=$?

cat "$OUTPUT_DIR/financial-core-v1-regression.summary.txt"

exit "$aggregate_code"
