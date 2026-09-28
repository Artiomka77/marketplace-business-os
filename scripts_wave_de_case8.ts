import { loadProfitReadModelPack, WaveDEConsumerUnavailableError } from '@/lib/consumers/waveDE';
async function main() {
  // WB should HIT for this period; OZON must fail-closed (finality mismatch / missing opposite marketplace)
  let wbHit = false;
  try {
    const wb = await loadProfitReadModelPack({ marketplace: 'WB', companyScope: 'ALL', dateFrom: '2026-09-20', dateTo: '2026-09-20' });
    wbHit = wb.meta.dataMode === 'FINAL' && wb.meta.formulaVersion.includes('PROFIT_WB');
  } catch { wbHit = false; }
  let ozonUnavailable = false;
  let reason = null;
  try {
    await loadProfitReadModelPack({ marketplace: 'OZON', companyScope: 'ALL', dateFrom: '2026-09-20', dateTo: '2026-09-20' });
  } catch (e: any) {
    ozonUnavailable = e instanceof WaveDEConsumerUnavailableError;
    reason = e?.reason ?? null;
  }
  const pass = wbHit && ozonUnavailable;
  console.log(JSON.stringify({
    id: 8,
    name: 'wb_ozon_finality_mismatch',
    input: { dateFrom: '2026-09-20', dateTo: '2026-09-20', companyScope: 'ALL', wbMustHit: true, ozonMustMiss: true },
    exercised: 'loadProfitReadModelPack WB HIT + OZON MISS on same period',
    expected: 'WB FINAL HIT and OZON WaveDEConsumerUnavailableError',
    pass,
    actual: { wbHit, ozonUnavailable, reason },
  }, null, 2));
  if (!pass) process.exitCode = 1;
}
main().catch(e=>{console.log(JSON.stringify({pass:false,error:String(e)}));process.exitCode=1;});
