# Wave B Model Binding (current implementation)

Reuses prior `MODEL_DECISION.md` from AVOROFIN_SNAPSHOT_WAVE_B_PROFIT_READINESS_AUDIT_20260904.

## Implemented
- `ProfitPeriodMetric` + `ProfitSkuPeriodMetric` (additive Prisma + SQL)
- formulaVersions:
  - `FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1`
  - `FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1`
- Producer calls existing `getProfitAnalytics` / `getProfitAnalyticsOzon` (no formula duplication)
- Consumer HIT → render payload; MISS/PENDING/UNAVAILABLE → fail-soft; heavyFcCalls=0
- Live FC fallback only if `WAVE_B_PROFIT_LIVE_FALLBACK=1` (rollback)

## Drift vs audit
- UNCHANGED minimum model set
- EVOLVED_COMPATIBLY: analyticsPayload column stores full page analytics blob for exact UI contract
