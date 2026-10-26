/**
 * AUDIT_DB isolation helper — transaction-local READ ONLY only.
 * Never SET default_transaction_read_only / SESSION CHARACTERISTICS / ALTER ROLE|DATABASE.
 */
export async function withReadOnlyTx(client, fn, opts = {}) {
  const timeoutMs = opts.statementTimeoutMs ?? 120000;
  const lockMs = opts.lockTimeoutMs ?? 5000;
  await client.query("BEGIN READ ONLY");
  try {
    await client.query(`SET LOCAL statement_timeout = ${Number(timeoutMs)}`);
    await client.query(`SET LOCAL lock_timeout = ${Number(lockMs)}`);
    const mode = await client.query("SHOW transaction_read_only");
    const transaction_read_only = String(mode.rows?.[0]?.transaction_read_only ?? "");
    if (transaction_read_only !== "on") {
      throw new Error(`expected transaction_read_only=on, got ${transaction_read_only}`);
    }
    const result = await fn(client, { transaction_read_only });
    await client.query("ROLLBACK");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  }
}

export async function connectDedicatedClient(Client, application_name) {
  const c = new Client({
    connectionString: process.env.DATABASE_URL,
    application_name: application_name || "audit_ro",
  });
  await c.connect();
  return c;
}

/** Refuse legacy entrypoints that still lack BEGIN READ ONLY wrapping. */
export function assertSafeAuditEntrypoint(meta) {
  if (!meta?.usesWithReadOnlyTx) {
    throw new Error(
      `AUDIT_DB: refusing unsafe entrypoint ${meta?.name || "unknown"} — wrap SQL in withReadOnlyTx`
    );
  }
}
