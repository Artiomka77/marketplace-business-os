
import { loadProfitReadModelPack, WaveDEConsumerUnavailableError } from "@/lib/consumers/waveDE";
async function main() {
  const hit = await loadProfitReadModelPack({ marketplace: "WB", companyScope: "ALL", dateFrom: "2026-09-07", dateTo: "2026-09-13" });
  let missOk = false; let missReason = null;
  try {
    await loadProfitReadModelPack({ marketplace: "WB", companyScope: "ALL", dateFrom: "2019-01-01", dateTo: "2019-01-07" });
  } catch (e: any) {
    missOk = e instanceof WaveDEConsumerUnavailableError;
    missReason = e?.reason ?? null;
  }
  console.log(JSON.stringify({
    HIT: { PASS: hit.meta.heavyFinancialCoreCalls === 0 && hit.meta.dataMode === "FINAL", meta: hit.meta, sku: (hit.skuRows||[]).length },
    MISS: { PASS: missOk, reason: missReason },
    PASS: hit.meta.heavyFinancialCoreCalls === 0 && hit.meta.dataMode === "FINAL" && missOk,
  }));
}
main().catch((e)=>{console.log(JSON.stringify({PASS:false,error:String(e)})); process.exitCode=1;});
