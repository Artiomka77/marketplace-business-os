import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  const wb = await prisma.marketplace.upsert({
    where: { code: "WB" },
    update: {},
    create: {
      code: "WB",
      name: "Wildberries",
    },
  });

  const ozon = await prisma.marketplace.upsert({
    where: { code: "OZON" },
    update: {},
    create: {
      code: "OZON",
      name: "Ozon",
    },
  });

  const petrov = await prisma.company.create({
    data: {
      name: "ИП Петров",
    },
  });

  const lebedeva = await prisma.company.create({
    data: {
      name: "ИП Лебедева",
    },
  });

  await prisma.marketplaceAccount.createMany({
    data: [
      {
        name: "ИП Петров — Wildberries",
        companyId: petrov.id,
        marketplaceId: wb.id,
      },
      {
        name: "ИП Петров — Ozon",
        companyId: petrov.id,
        marketplaceId: ozon.id,
      },
      {
        name: "ИП Лебедева — Wildberries",
        companyId: lebedeva.id,
        marketplaceId: wb.id,
      },
      {
        name: "ИП Лебедева — Ozon",
        companyId: lebedeva.id,
        marketplaceId: ozon.id,
      },
    ],
  });

  console.log("Seed completed successfully");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });