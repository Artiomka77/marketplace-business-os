/** Host runner DB preflight — real prisma module import (not fragile -e ESM). */
import { prisma } from "@/lib/prisma";

async function main() {
  const n = await prisma.$queryRawUnsafe<{ n: number }[]>("select 1 as n");
  console.log("PRISMA_DB_OK", JSON.stringify(n));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
