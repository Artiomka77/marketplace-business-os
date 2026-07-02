$ErrorActionPreference = "Stop"

$project = "C:\AI-PROJECTS\marketplace-business-os"
$source = Join-Path $project "server-logs\ozon-realization-update\ozon_realization_update\files"

if (!(Test-Path $project)) {
  throw "Project folder not found: $project"
}

Write-Host "Apply Ozon realization/points files..."

Copy-Item -Force (Join-Path $source "prisma\schema.prisma") (Join-Path $project "prisma\schema.prisma")

New-Item -ItemType Directory -Force (Join-Path $project "scripts") | Out-Null
Copy-Item -Force (Join-Path $source "scripts\patch_ozon_realization_tables.js") (Join-Path $project "scripts\patch_ozon_realization_tables.js")
Copy-Item -Force (Join-Path $source "scripts\import_ozon_realization_and_points.js") (Join-Path $project "scripts\import_ozon_realization_and_points.js")
Copy-Item -Force (Join-Path $source "scripts\diagnose_ozon_realization_vs_finance.js") (Join-Path $project "scripts\diagnose_ozon_realization_vs_finance.js")

Write-Host "Done."
Write-Host ""
Write-Host "Next:"
Write-Host "cd C:\AI-PROJECTS\marketplace-business-os"
Write-Host "npm run build"
