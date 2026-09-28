$ErrorActionPreference = "Stop"

$server = "deploy@72.56.4.62"
$projectDir = "/opt/avorofin"
$localDir = "C:\AI-PROJECTS\marketplace-business-os\server-logs\send-to-chat"

New-Item -ItemType Directory -Force $localDir | Out-Null

$localJs = Join-Path $localDir "fix_wb_sale_spp_columns.js"
$localOut = Join-Path $localDir "fix_wb_sale_spp_columns_result.txt"
$remoteJs = "/tmp/fix_wb_sale_spp_columns.js"

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
  "wbRewardVat",
  "wbRewardTotal",
  "loyaltyDiscountCompensation",
  "loyaltyParticipationCost",
  "loyaltyPointsAmount"
];

async function main() {
  const client = await pool.connect();

  try {
    console.log("START WB SALE SPP COLUMN PATCH");

    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE "WbSale"
        ADD COLUMN IF NOT EXISTS "retailPriceWithDiscount" NUMERIC(65,30),
        ADD COLUMN IF NOT EXISTS "platformDiscountPercent" NUMERIC(65,30),
        ADD COLUMN IF NOT EXISTS "sppDiscountAmount" NUMERIC(65,30),
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
        "wbRewardVat" = COALESCE("wbRewardVat", 0),
        "wbRewardTotal" = COALESCE("wbRewardTotal", COALESCE("wbReward", 0) + COALESCE("wbRewardVat", 0)),
        "loyaltyDiscountCompensation" = COALESCE("loyaltyDiscountCompensation", 0),
        "loyaltyParticipationCost" = COALESCE("loyaltyParticipationCost", 0),
        "loyaltyPointsAmount" = COALESCE("loyaltyPointsAmount", 0)
      WHERE
        "retailPriceWithDiscount" IS NULL
        OR "sppDiscountAmount" IS NULL
        OR "platformDiscountPercent" IS NULL
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

[System.IO.File]::WriteAllText($localJs, $js, [System.Text.Encoding]::UTF8)

function Run-Native($Description, $FilePath, $Arguments) {
  Write-Host $Description
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Description failed with exit code $LASTEXITCODE"
  }
}

Run-Native "Upload JS patch to server..." "scp" @($localJs, "${server}:$remoteJs")

$remoteCommand = @"
cd $projectDir &&
docker cp $remoteJs avorofin-app:/tmp/fix_wb_sale_spp_columns.js &&
docker compose --env-file .env.production exec -T app node /tmp/fix_wb_sale_spp_columns.js &&
docker compose --env-file .env.production restart app &&
sleep 5 &&
docker compose --env-file .env.production exec -T app node -e 'const url="http://127.0.0.1:3000/profit-wb?dateFrom=2026-06-01&dateTo=2026-06-28&companyName=%D0%98%D0%9F+%D0%9F%D0%B5%D1%82%D1%80%D0%BE%D0%B2"; fetch(url).then(async r=>{console.log("PAGE_HTTP", r.status); const t=await r.text(); console.log(t.slice(0,500)); process.exit(r.ok?0:1);}).catch(e=>{console.error(e); process.exit(1);})'
"@

Write-Host "Run patch on server..."
& ssh $server $remoteCommand 2>&1 | Tee-Object -FilePath $localOut
if ($LASTEXITCODE -ne 0) {
  throw "Remote patch failed with exit code $LASTEXITCODE. Result saved to $localOut"
}

Write-Host ""
Write-Host "DONE"
Write-Host "Result file:"
Write-Host $localOut

explorer $localDir
