import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as any);
async function main() {
  const wb = await prisma.$queryRawUnsafe(`
    select to_char("dateFrom",'YYYY-MM-DD') df, to_char("dateTo",'YYYY-MM-DD') dt, "companyScope"
    from "ProfitPeriodMetric"
    where "marketplace"='WB' and "dataMode"='FINAL' and "coverageStatus"='COMPLETE' and "companyScope"='ALL'
    order by "dateTo" desc limit 40
  `);
  const oz = await prisma.$queryRawUnsafe(`
    select to_char("dateFrom",'YYYY-MM-DD') df, to_char("dateTo",'YYYY-MM-DD') dt, "companyScope"
    from "ProfitPeriodMetric"
    where "marketplace"='OZON' and "dataMode"='FINAL' and "coverageStatus"='COMPLETE' and "companyScope"='ALL'
  `);
  const ozSet = new Set((oz as any[]).map(r => `${r.df}|${r.dt}`));
  const mismatch = (wb as any[]).filter(r => !ozSet.has(`${r.df}|${r.dt}`));
  console.log(JSON.stringify({ mismatch: mismatch.slice(0, 10), wbSample: (wb as any[]).slice(0, 5), ozCount: (oz as any[]).length }, null, 2));
}
main().catch(e=>{console.log(JSON.stringify({error:String(e)}));process.exitCode=1;})
  .finally(async()=>{await prisma.$disconnect().catch(()=>{});await pool.end().catch(()=>{});});
