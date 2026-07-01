$ErrorActionPreference = "Stop"

$project = "C:\AI-PROJECTS\marketplace-business-os"
$sourceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Test-Path $project)) {
  throw "Project folder not found: $project"
}

$backupRoot = Join-Path $project ("server-logs\backups\wb-profit-spp-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
New-Item -ItemType Directory -Force $backupRoot | Out-Null

$files = @(
  "prisma\schema.prisma",
  "prisma\migrations\20260701193000_add_wb_sales_spp_commission_fields\migration.sql",
  "lib\import\normalizers\wbSalesNormalizer.ts",
  "lib\wb\syncWb.ts",
  "lib\analytics\profitAnalytics.ts",
  "app\profit-wb\page.tsx"
)

foreach ($file in $files) {
  $src = Join-Path $sourceRoot $file
  $dst = Join-Path $project $file
  $backup = Join-Path $backupRoot $file

  if (-not (Test-Path $src)) {
    throw "Source file missing: $src"
  }

  if (Test-Path $dst) {
    New-Item -ItemType Directory -Force (Split-Path $backup -Parent) | Out-Null
    Copy-Item -Force $dst $backup
  }

  New-Item -ItemType Directory -Force (Split-Path $dst -Parent) | Out-Null
  Copy-Item -Force $src $dst
  Write-Host "Updated: $file"
}

Write-Host ""
Write-Host "Backup saved to:"
Write-Host $backupRoot
Write-Host ""
Write-Host "Next command:"
Write-Host "cd C:\AI-PROJECTS\marketplace-business-os"
Write-Host "npm run build"
