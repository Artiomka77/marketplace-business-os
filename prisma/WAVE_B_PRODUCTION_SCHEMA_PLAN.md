# Wave B Production Schema Plan (PREPARE ONLY — do not execute in this task)

## Preconditions
1. Marketplace Orders V4 natural verify CLOSED.
2. Fresh owner approval for exact Wave B patch + images + this SQL.
3. Production `_prisma_migrations` is NOT trusted — use additive SQL only.
4. Confirm tables absent via `information_schema` before create (SQL already gated).

## Action order
1. Backup note / rollback baseline (runtime previous APP/WORKER images).
2. Apply `WAVE_B_PRODUCTION_SCHEMA.sql` exactly (additive IF NOT EXISTS).
3. Verify tables + unique indexes exist.
4. Deploy WORKER/producer capability (queue family Wave B formulaVersions).
5. Seed/rebuild only owner-approved closed-week scopes.
6. Prove parity.
7. Switch Profit WB consumer (`WAVE_B_PROFIT_READMODEL_FIRST=1`).
8. Observe.
9. Switch Profit Ozon consumer.
10. Keep `WAVE_B_PROFIT_LIVE_FALLBACK` unset / `0`.

## Forbidden
- `prisma migrate deploy` blind
- DROP / TRUNCATE / destructive ALTER
- Data backfill without owner approval
- Simultaneous blind WB+Ozon switch if staged plan still required

## Rollback
- Revert APP/WORKER images / unset read-model-first flag
- Tables may remain additive and inert
- No destructive schema rollback by default
