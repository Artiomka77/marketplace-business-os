# AUDIT_DB — unsafe legacy entrypoints

The following historical extract/probe scripts had `SET default_transaction_read_only=on`
removed but were **not** wrapped in `BEGIN READ ONLY` / `withReadOnlyTx`.

They must **not** be executed against production until rewritten:

- extract_comp_partner.mjs
- extract_loans_week.mjs
- extract_ozon_primary_local.mjs
- extract_week_close_ro.mjs
- extract_week_complete.mjs
- probe_cols.mjs
- probe_complete_sources.mjs
- probe_coverage_68.mjs
- probe_wb_finance.mjs
- probe_wb_sessions.mjs

Use `scripts/audit/audit_db_ro.mjs` + `withReadOnlyTx` (see `extract_fin_recon_ro.mjs` pattern)
or the guarded wrappers under `scripts/audit/wrappers/`.

Causal link of prior session SET to Telegram read-only incident: **HYPOTHESIS_NOT_PROVEN**.
