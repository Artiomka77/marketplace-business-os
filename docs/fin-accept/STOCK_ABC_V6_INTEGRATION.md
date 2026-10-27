# FIN_ACCEPT stockAbc V6 integration (narrow)

## Why
Worker entrypoint `runDashboardPeriodSnapshotWorker.ts` imports
`prepareStockAbcSnapshot` / `persistPreparedStockAbcSnapshot` /
`STOCK_PLANNING_SNAPSHOT_FORMULA_VERSION` from `lib/stocks/stockAbcSnapshots.ts`.

The protected candidate file at bf4f8b5 only exported
`refreshStockAbcSnapshot` / `readStockAbcSnapshots` and could not run stock/dashboard
workers. A previous packaging step copied MAIN-compatible runtime **after**
`financial-core:verify`, which broke the protected-hash contract.

## What changed
1. Promoted MAIN-compatible runtime (former `overlays/fin-accept/stockAbcSnapshots.runtime.ts`)
   into active `lib/stocks/stockAbcSnapshots.ts` **and**
   `financial-core/v6/snapshot/lib/stocks/stockAbcSnapshots.ts`.
2. Updated `financial-core/v6/manifest.json` protected entry hashes/size/role to match.
3. Removed post-verify `COPY overlays/...` from `Dockerfile.workers`.
4. `npm run financial-core:verify` now runs on the **final** tree contents (PASS locally).

## Hashes
- previous (bf4f8b5 candidate): `dbfd30746f90334082a394edb60f4b51cf0ce4adb3d51602701066096b89922c`
- new active=snapshot: `982bab4f3d0b4e790fc889e7fa3c14dfc116345c4472310e97479cf7166db191`

## Guarantees retained
- PRELIMINARY analytics must not produce a successful FINAL stock snapshot
  (`assertOzonProfitSafeForStockPlanningSnapshot` / existing guards).
- Canonical analytics modules remain the accepted finance functions; this file is
  stock planning integration, not a second finance engine.
- Historical V5 snapshots were not rewritten.

## Origin
Runtime APIs match production stock/dashboard worker needs observed on MAIN
(prepare/persist/claim helpers). Analytics still dynamic-import accepted
`getProfitAnalytics` / `getProfitAnalyticsOzon`.
