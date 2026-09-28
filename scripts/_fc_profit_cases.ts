
import { loadProfitReadModelPack, WaveDEConsumerUnavailableError } from "@/lib/consumers/waveDE";
async function unavail(id: number, name: string, fn: () => Promise<any>) {
  try { await fn(); return { id, name, pass: false, actual: "NO_THROW" }; }
  catch (e: any) {
    return { id, name, pass: e instanceof WaveDEConsumerUnavailableError, actual: { name: e?.name, reason: e?.reason, message: e?.message, code: e?.code } };
  }
}
async function main() {
  const cases = [
    await unavail(1, "missing_profit_read_model_row", () => loadProfitReadModelPack({ marketplace: "WB", companyScope: "ALL", dateFrom: "2019-01-01", dateTo: "2019-01-07" })),
    await unavail(2, "formula_version_or_identity_mismatch_proxy", () => loadProfitReadModelPack({ marketplace: "WB", companyScope: "NO_SUCH_COMPANY_WAVE_DE", dateFrom: "2026-09-07", dateTo: "2026-09-13" })),
    await unavail(6, "cross_company_row_mismatch", () => loadProfitReadModelPack({ marketplace: "WB", companyScope: "OTHER_CO_LEAK", dateFrom: "2026-09-07", dateTo: "2026-09-13" })),
    await unavail(8, "wb_ozon_finality_mismatch_proxy", () => loadProfitReadModelPack({ marketplace: "OZON", companyScope: "ALL", dateFrom: "2026-09-20", dateTo: "2026-09-20" })),
  ];
  console.log(JSON.stringify({ cases, PASS: cases.every(c => c.pass) }));
}
main().catch(e => { console.log(JSON.stringify({ PASS: false, error: String(e) })); process.exitCode = 1; });
