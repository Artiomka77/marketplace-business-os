#!/usr/bin/env node
/**
 * Drop-in guard for the ten legacy audit extractors.
 * Exits non-zero instead of running unprotected SQL.
 */
const name = process.argv[2] || "legacy_audit_script";
console.error(
  JSON.stringify(
    {
      error: "AUDIT_DB_REFUSED",
      script: name,
      reason:
        "Session SET was removed but BEGIN READ ONLY / withReadOnlyTx was never added. Refusing execution.",
      use: "scripts/audit/audit_db_ro.mjs withReadOnlyTx pattern (see extract_fin_recon_ro.mjs)",
    },
    null,
    2
  )
);
process.exit(2);
