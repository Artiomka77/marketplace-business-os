$ErrorActionPreference = "Stop"

$ProjectPath = "C:\AI-PROJECTS\marketplace-business-os"
$SourceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

$TargetFile = Join-Path $ProjectPath "src\lib\analytics\profitAnalyticsOzon.ts"
$SourceFile = Join-Path $SourceRoot "files\src\lib\analytics\profitAnalyticsOzon.ts"

if (!(Test-Path $ProjectPath)) {
  throw "Project folder not found: $ProjectPath"
}

if (!(Test-Path $SourceFile)) {
  throw "Source file not found: $SourceFile"
}

if (Test-Path $TargetFile) {
  $BackupFile = "$TargetFile.bak.$(Get-Date -Format 'yyyyMMdd_HHmmss')"
  Copy-Item $TargetFile $BackupFile -Force
  Write-Host "Backup created: $BackupFile"
}

Copy-Item $SourceFile $TargetFile -Force
Write-Host "Updated: $TargetFile"
