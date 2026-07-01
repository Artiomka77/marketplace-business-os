$ErrorActionPreference = 'Stop'

$project = 'C:\AI-PROJECTS\marketplace-business-os'
$outRoot = Join-Path $project 'server-logs\send-to-chat\wb-profit-calculation-source'
$zipPath = Join-Path $project 'server-logs\send-to-chat\wb-profit-calculation-source.zip'

if (-not (Test-Path $project)) {
  throw "Project folder not found: $project"
}

Remove-Item -Recurse -Force $outRoot -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $outRoot | Out-Null

function Copy-WithStructure {
  param(
    [Parameter(Mandatory=$true)][string]$SourcePath
  )

  if (-not (Test-Path $SourcePath)) {
    Write-Host "SKIP missing: $SourcePath"
    return
  }

  $full = (Resolve-Path $SourcePath).Path
  $relative = $full.Substring($project.Length).TrimStart('\')
  $dest = Join-Path $outRoot $relative
  $destDir = Split-Path $dest -Parent

  New-Item -ItemType Directory -Force $destDir | Out-Null
  Copy-Item -Force $full $dest
  Write-Host "COPIED: $relative"
}

Set-Location $project

$explicitFiles = @(
  'prisma\schema.prisma',
  'lib\analytics\profitAnalytics.ts',
  'app\profit-wb\page.tsx',
  'lib\wb\syncWb.ts',
  'lib\telegram\dailyReport.ts',
  'app\page.tsx'
)

foreach ($file in $explicitFiles) {
  Copy-WithStructure (Join-Path $project $file)
}

$foldersToCopy = @(
  'lib\import',
  'app\api\import',
  'app\import',
  'app\imports',
  'lib\reports',
  'lib\excel'
)

foreach ($folder in $foldersToCopy) {
  $fullFolder = Join-Path $project $folder

  if (Test-Path $fullFolder) {
    Get-ChildItem $fullFolder -Recurse -File |
      Where-Object { $_.Extension -in '.ts', '.tsx', '.js', '.mjs', '.cjs' } |
      ForEach-Object { Copy-WithStructure $_.FullName }
  }
}

$searchPattern = 'retailPrice|wbRealizedAmount|sellerPayout|wbReward|ppvz|acquiring|platform|spp|retail_amount|ppvz_for_pay|ppvz_vw|acquiring_fee|delivery_rub|storage_fee|acceptance|WbSale|WB_SALES|profitAnalytics'

Get-ChildItem -Recurse -Path 'app','lib','prisma' -Include '*.ts','*.tsx','*.prisma' |
  Select-String -Pattern $searchPattern |
  Out-File (Join-Path $outRoot 'wb-profit-calculation-search.txt') -Encoding utf8

Get-ChildItem $outRoot -Recurse -File |
  ForEach-Object { $_.FullName.Substring($outRoot.Length).TrimStart('\') } |
  Sort-Object |
  Out-File (Join-Path $outRoot 'file-list.txt') -Encoding utf8

Remove-Item -Force $zipPath -ErrorAction SilentlyContinue
Compress-Archive -Path (Join-Path $outRoot '*') -DestinationPath $zipPath -Force

Write-Host ''
Write-Host 'DONE'
Write-Host 'Send this ZIP to ChatGPT:'
Write-Host $zipPath

explorer (Split-Path $zipPath -Parent)
