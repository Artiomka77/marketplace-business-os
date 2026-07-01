Current Priority Sync — full completed weeks version.

Approved rules:
- Priority mode: 8 full completed WB weeks, Monday-Sunday.
- Recheck mode: 12 full completed WB weeks, Monday-Sunday.
- Current unfinished week is not loaded as WB weekly Finance/Sales.
- Existing WbFinance reportNumber is not reloaded.
- Existing WbSale reportNumber is not reloaded.
- Existing HistoricalSyncJob for the same reportNumber is reused/adopted; no duplicate job is created.
- WB Sales detail worker processes max 1 report per run.
- RATE_LIMIT cooldown is 90 minutes.
- Historical jobs outside current priority are paused.

Files:
- lib/wb/syncWb.ts
- lib/currentPrioritySync/syncCurrentPriorityData.ts
- app/api/cron/current-priority-sync/route.ts
- apply_current_priority_sync_weeks_files.ps1
