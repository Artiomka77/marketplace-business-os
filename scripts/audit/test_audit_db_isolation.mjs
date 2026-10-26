import { withReadOnlyTx, assertSafeAuditEntrypoint } from "./audit_db_ro.mjs";

function makeMock(opts = {}) {
  const log = [];
  let inTx = false;
  return {
    log,
    async query(sql) {
      log.push(String(sql).trim());
      if (/^BEGIN READ ONLY/i.test(sql)) {
        inTx = true;
        return { rows: [] };
      }
      if (/^ROLLBACK|^COMMIT/i.test(sql)) {
        inTx = false;
        return { rows: [] };
      }
      if (/SET LOCAL/i.test(sql)) {
        if (!inTx) throw new Error("SET LOCAL outside transaction");
        return { rows: [] };
      }
      if (/SHOW transaction_read_only/i.test(sql)) {
        return { rows: [{ transaction_read_only: opts.forceOff ? "off" : "on" }] };
      }
      if (/SELECT/i.test(sql) && opts.failSelect) throw new Error("SELECT_FAIL");
      return { rows: [{ ok: 1 }] };
    },
  };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const ok = makeMock();
const result = await withReadOnlyTx(ok, async (c) => {
  await c.query("SELECT 1");
  return 42;
});
assert(result === 42, "result");
assert(ok.log[0].startsWith("BEGIN READ ONLY"), "begin first");
assert(ok.log.at(-1) === "ROLLBACK", "rollback");
assert(!ok.log.some((s) => /default_transaction_read_only/i.test(s)), "no session set");

const bad = makeMock({ failSelect: true });
let threw = false;
try {
  await withReadOnlyTx(bad, async (c) => c.query("SELECT boom"));
} catch {
  threw = true;
}
assert(threw, "throw");
assert(bad.log.at(-1) === "ROLLBACK", "rollback on error");

try {
  assertSafeAuditEntrypoint({ name: "legacy", usesWithReadOnlyTx: false });
  throw new Error("should refuse");
} catch (e) {
  assert(/refusing unsafe/.test(String(e.message)), "refuse");
}

console.log(JSON.stringify({ ok: true, successLog: ok.log }, null, 2));
