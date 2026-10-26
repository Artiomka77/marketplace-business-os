#!/usr/bin/env node
/** Legacy audit entrypoint — refuse before any DB client (AUDIT_DB). */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { assertSafeAuditEntrypoint } = require(
  path.join(__dirname, "..", "audit_db_ro.mjs"),
);
try {
  assertSafeAuditEntrypoint({
    name: "probe_wb_sessions.mjs",
    usesWithReadOnlyTx: false,
  });
} catch (err) {
  console.error(
    JSON.stringify(
      {
        error: "AUDIT_DB_REFUSED",
        script: "probe_wb_sessions.mjs",
        reason: String(err?.message || err),
        use: "scripts/audit/audit_db_ro.mjs withReadOnlyTx",
      },
      null,
      2,
    ),
  );
  process.exit(2);
}
process.exit(2);
