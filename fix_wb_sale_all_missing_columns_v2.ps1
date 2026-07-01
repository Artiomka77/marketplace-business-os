$ErrorActionPreference = "Stop"

$server = "deploy@72.56.4.62"
$localDir = "C:\AI-PROJECTS\marketplace-business-os\server-logs\send-to-chat"

New-Item -ItemType Directory -Force $localDir | Out-Null

$localJs = Join-Path $localDir "wb_sale_all_missing_columns_patch.js"
$localSh = Join-Path $localDir "run_wb_sale_all_missing_columns_patch.sh"
$localOut = Join-Path $localDir "wb_sale_all_missing_columns_patch_result.txt"

$remoteJs = "/tmp/wb_sale_all_missing_columns_patch.js"
$remoteSh = "/tmp/run_wb_sale_all_missing_columns_patch.sh"

$js = @'
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const columns = [
  "retailPriceWithDiscount",
  "platformDiscountPercent",
  "sppDiscountAmount",
  "commissionPercentBase",
  "commissionPercentFinal",
  "wbRewardVat",
  "wbRewardTotal",
  "loyaltyDiscountCompensation",
  "loyaltyParticipationCost",
  "loyaltyPointsAmount"
];

async function main() {
  const client = await pool.connect();

  try {
    console.log("START WB SALE ALL MISSING COLUMNS PATCH");

    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE "WbSale"
        ADD COLUMN IF NOT EXISTS "retailPriceWithDiscount" NUMERIC(65,30),
        ADD COLUMN IF NOT EXISTS "platformDiscountPercent" NUMERIC(65,30),
        ADD COLUMN IF NOT EXISTS "sppDiscountAmount" NUMERIC(65,30),
        ADD COLUMN IF NOT EXISTS "commissionPercentBase" NUMERIC(65,30),
        ADD COLUMN IF NOT EXISTS "commissionPercentFinal" NUMERIC(65,30),
        ADD COLUMN IF NOT EXISTS "wbRewardVat" NUMERIC(65,30),
        ADD COLUMN IF NOT EXISTS "wbRewardTotal" NUMERIC(65,30),
        ADD COLUMN IF NOT EXISTS "loyaltyDiscountCompensation" NUMERIC(65,30),
        ADD COLUMN IF NOT EXISTS "loyaltyParticipationCost" NUMERIC(65,30),
        ADD COLUMN IF NOT EXISTS "loyaltyPointsAmount" NUMERIC(65,30)
    `);

    const updateResult = await client.query(`
      UPDATE "WbSale"
      SET
        "retailPriceWithDiscount" = COALESCE("retailPriceWithDiscount", "retailPrice"),
        "sppDiscountAmount" = COALESCE(
          "sppDiscountAmount",
          COALESCE("retailPriceWithDiscount", "retailPrice", 0) - COALESCE("wbRealizedAmount", 0)
        ),
        "platformDiscountPercent" = COALESCE(
          "platformDiscountPercent",
          CASE
            WHEN COALESCE("retailPriceWithDiscount", "retailPrice", 0) <> 0
            THEN (
              (
                COALESCE("retailPriceWithDiscount", "retailPrice", 0) - COALESCE("wbRealizedAmount", 0)
              )
              / COALESCE("retailPriceWithDiscount", "retailPrice", 1)
            ) * 100
            ELSE 0
          END
        ),
        "commissionPercentBase" = COALESCE("commissionPercentBase", 0),
        "commissionPercentFinal" = COALESCE("commissionPercentFinal", 0),
        "wbRewardVat" = COALESCE("wbRewardVat", 0),
        "wbRewardTotal" = COALESCE("wbRewardTotal", COALESCE("wbReward", 0) + COALESCE("wbRewardVat", 0)),
        "loyaltyDiscountCompensation" = COALESCE("loyaltyDiscountCompensation", 0),
        "loyaltyParticipationCost" = COALESCE("loyaltyParticipationCost", 0),
        "loyaltyPointsAmount" = COALESCE("loyaltyPointsAmount", 0)
      WHERE
        "retailPriceWithDiscount" IS NULL
        OR "sppDiscountAmount" IS NULL
        OR "platformDiscountPercent" IS NULL
        OR "commissionPercentBase" IS NULL
        OR "commissionPercentFinal" IS NULL
        OR "wbRewardVat" IS NULL
        OR "wbRewardTotal" IS NULL
        OR "loyaltyDiscountCompensation" IS NULL
        OR "loyaltyParticipationCost" IS NULL
        OR "loyaltyPointsAmount" IS NULL
    `);

    await client.query("COMMIT");

    console.log("UPDATED ROWS:", updateResult.rowCount);

    const result = await client.query(
      `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'WbSale'
          AND column_name = ANY($1::text[])
        ORDER BY column_name
      `,
      [columns]
    );

    console.log("COLUMNS FOUND:", result.rows.length);
    console.table(result.rows);

    if (result.rows.length !== columns.length) {
      throw new Error(`Expected ${columns.length} columns, found ${result.rows.length}`);
    }

    console.log("PATCH OK");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("PATCH FAILED");
    console.error(error);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
'@

$sh = @'
#!/usr/bin/env bash
set -euo pipefail

cd /opt/avorofin

echo "Copy JS patch into container..."
docker cp /tmp/wb_sale_all_missing_columns_patch.js avorofin-app:/tmp/wb_sale_all_missing_columns_patch.js

echo "Run DB patch..."
docker compose --env-file .env.production exec -T app sh -lc 'cd /app && NODE_PATH=/app/node_modules node /tmp/wb_sale_all_missing_columns_patch.js'

echo "Restart app..."
docker compose --env-file .env.production restart app

sleep 5

echo "Check page from inside container..."
docker compose --env-file .env.production exec -T app node -e 'fetch("http://127.0.0.1:3000/profit-wb?dateFrom=2026-06-01&dateTo=2026-06-28&companyName=%D0%98%D0%9F%20%D0%9F%D0%B5%D1%82%D1%80%D0%BE%D0%B2").then(async r=>{console.log("PAGE_HTTP",r.status);console.log((await r.text()).slice(0,500));process.exit(r.ok?0:1);}).catch(e=>{console.error(e);process.exit(1);})'

echo "Recent app logs:"
docker compose --env-file .env.production logs --tail=80 app
'@

[System.IO.File]::WriteAllText($localJs, $js, [System.Text.Encoding]::UTF8)
[System.IO.File]::WriteAllText($localSh, $sh, [System.Text.Encoding]::UTF8)

function Run-Native($Description, $FilePath, $Arguments) {
  Write-Host $Description
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Description failed with exit code $LASTEXITCODE"
  }
}

Run-Native "Upload JS patch..." "scp" @($localJs, "${server}:$remoteJs")
Run-Native "Upload shell runner..." "scp" @($localSh, "${server}:$remoteSh")

Write-Host "Run remote patch..."
& ssh $server "chmod +x $remoteSh && bash $remoteSh" 2>&1 | Tee-Object -FilePath $localOut

if ($LASTEXITCODE -ne 0) {
  throw "Remote patch failed with exit code $LASTEXITCODE. Result saved to $localOut"
}

Write-Host ""
Write-Host "DONE"
Write-Host "Result file:"
Write-Host $localOut

explorer $localDir
