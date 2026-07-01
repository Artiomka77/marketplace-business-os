$ErrorActionPreference = "Stop"

$project = "C:\AI-PROJECTS\marketplace-business-os"
$outRoot = Join-Path $project "server-logs\send-to-chat\current-sync-source"
$zipPath = Join-Path $project "server-logs\send-to-chat\current-sync-source.zip"

if (-not (Test-Path $project)) {
  throw "Project folder not found: $project"
}

Remove-Item -Recurse -Force $outRoot -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $outRoot | Out-Null

function Copy-WithStructure {
  param(
    [Parameter(Mandatory=$true)][string]$Path
  )

  if (-not (Test-Path $Path)) {
    Write-Host "SKIP missing: $Path"
    return
  }

  $full = (Resolve-Path $Path).Path
  $relative = $full.Substring($project.Length).TrimStart("\")
  $dest = Join-Path $outRoot $relative
  $destDir = Split-Path $dest -Parent

  New-Item -ItemType Directory -Force $destDir | Out-Null
  Copy-Item -Force $full $dest
  Write-Host "COPIED: $relative"
}

Set-Location $project

# Core project metadata without secrets
Copy-WithStructure (Join-Path $project "package.json")
Copy-WithStructure (Join-Path $project "prisma\schema.prisma")

# All cron routes: current sync, historical sync, daily priority sync
if (Test-Path (Join-Path $project "app\api\cron")) {
  Get-ChildItem (Join-Path $project "app\api\cron") -Recurse -File |
    Where-Object { $_.Extension -in ".ts", ".tsx", ".js", ".mjs", ".cjs" } |
    ForEach-Object { Copy-WithStructure $_.FullName }
}

# Debug routes that may already contain WB backfill logic
if (Test-Path (Join-Path $project "app\api\debug")) {
  Get-ChildItem (Join-Path $project "app\api\debug") -Recurse -File |
    Where-Object {
      $_.Extension -in ".ts", ".tsx", ".js", ".mjs", ".cjs" -and
      ($_.FullName -match "wb|wildberries|sync|backfill|daily")
    } |
    ForEach-Object { Copy-WithStructure $_.FullName }
}

# API connection settings page / route if present
foreach ($path in @(
  "app\settings\api-connections",
  "app\api\settings",
  "app\api\api-connections",
  "app\api\marketplace-api-connections"
)) {
  $fullPath = Join-Path $project $path
  if (Test-Path $fullPath) {
    Get-ChildItem $fullPath -Recurse -File |
      Where-Object { $_.Extension -in ".ts", ".tsx", ".js", ".mjs", ".cjs" } |
      ForEach-Object { Copy-WithStructure $_.FullName }
  }
}

# Relevant lib/services files only
if (Test-Path (Join-Path $project "lib")) {
  Get-ChildItem (Join-Path $project "lib") -Recurse -File |
    Where-Object {
      $_.Extension -in ".ts", ".tsx", ".js", ".mjs", ".cjs" -and
      ($_.FullName -match "wb|wildberries|historical|marketplace|sync|api|connection|rate|limiter|retry|telegram|dailyReport")
    } |
    ForEach-Object { Copy-WithStructure $_.FullName }
}

# Relevant scripts if present
if (Test-Path (Join-Path $project "scripts")) {
  Get-ChildItem (Join-Path $project "scripts") -Recurse -File |
    Where-Object {
      $_.Extension -in ".ts", ".tsx", ".js", ".mjs", ".cjs" -and
      ($_.FullName -match "wb|wildberries|historical|sync|backfill|cron")
    } |
    ForEach-Object { Copy-WithStructure $_.FullName }
}

# Useful file list
Get-ChildItem $outRoot -Recurse -File |
  ForEach-Object { $_.FullName.Substring($outRoot.Length).TrimStart("\") } |
  Sort-Object |
  Out-File (Join-Path $outRoot "file-list.txt") -Encoding utf8

Remove-Item -Force $zipPath -ErrorAction SilentlyContinue
Compress-Archive -Path (Join-Path $outRoot "*") -DestinationPath $zipPath -Force

Write-Host ""
Write-Host "DONE"
Write-Host "Send this ZIP to ChatGPT:"
Write-Host $zipPath

explorer (Split-Path $zipPath -Parent)
