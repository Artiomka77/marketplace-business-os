import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

import { prisma } from "@/lib/prisma";
import { refreshStockAbcSnapshot } from "@/lib/stocks/stockAbcSnapshots";

function readArg(name: string) {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : "";
}

function getDefaultPeriod() {
  const now = new Date();
  const dateTo = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  const dateFrom = new Date(dateTo);
  dateFrom.setUTCDate(dateFrom.getUTCDate() - 30);

  return {
    dateFrom: dateFrom.toISOString().slice(0, 10),
    dateTo: dateTo.toISOString().slice(0, 10),
  };
}

async function runSingle() {
  const period = getDefaultPeriod();
  const companyScope = readArg("companyScope") || "ALL";
  const marketplace = readArg("marketplace");
  const dateFrom = readArg("dateFrom") || period.dateFrom;
  const dateTo = readArg("dateTo") || period.dateTo;

  if (marketplace !== "WB" && marketplace !== "OZON") {
    throw new Error(`Unsupported marketplace: ${marketplace}`);
  }

  const startedAt = Date.now();
  const result = await refreshStockAbcSnapshot({
    companyScope,
    marketplace,
    dateFrom,
    dateTo,
  });

  console.log(
    JSON.stringify({
      status: "SNAPSHOT_REFRESHED",
      elapsedMs: Date.now() - startedAt,
      ...result,
    })
  );
}

async function runMaster() {
  const period = getDefaultPeriod();
  const dateFrom = readArg("dateFrom") || period.dateFrom;
  const dateTo = readArg("dateTo") || period.dateTo;
  const companies = await prisma.company.findMany({
    where: { isActive: true },
    orderBy: { name: "asc" },
    select: { name: true },
  });
  const scopes = ["ALL", ...companies.map((company) => company.name)];
  const scriptPath = fileURLToPath(import.meta.url);

  await prisma.$disconnect();

  for (const companyScope of scopes) {
    for (const marketplace of ["WB", "OZON"] as const) {
      console.log(
        JSON.stringify({
          status: "STARTING_CHILD",
          companyScope,
          marketplace,
          dateFrom,
          dateTo,
        })
      );

      const child = spawnSync(
        process.execPath,
        [
          "--max-old-space-size=5120",
          "--expose-gc",
          "--import",
          "tsx",
          scriptPath,
          "--single=1",
          `--companyScope=${companyScope}`,
          `--marketplace=${marketplace}`,
          `--dateFrom=${dateFrom}`,
          `--dateTo=${dateTo}`,
        ],
        {
          env: process.env,
          stdio: "inherit",
        }
      );

      if (child.status !== 0) {
        throw new Error(
          `Snapshot child failed for ${marketplace}/${companyScope} with status ${child.status}`
        );
      }
    }
  }

  console.log(
    JSON.stringify({
      status: "ALL_STOCK_ABC_SNAPSHOTS_REFRESHED",
      dateFrom,
      dateTo,
      scopes,
      marketplaces: ["WB", "OZON"],
    })
  );
}

async function main() {
  if (readArg("single") === "1") {
    await runSingle();
    await prisma.$disconnect();
    return;
  }

  await runMaster();
}

main().catch(async (error) => {
  console.error(
    JSON.stringify({
      status: "STOCK_ABC_SNAPSHOT_REFRESH_FAILED",
      error: String(error?.stack || error),
    })
  );

  try {
    await prisma.$disconnect();
  } catch {}

  process.exit(1);
});
