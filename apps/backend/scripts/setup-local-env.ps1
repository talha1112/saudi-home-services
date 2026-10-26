<#
.SYNOPSIS
  Prepares apps/backend/.env for local development without ever printing a secret.

.DESCRIPTION
  - Creates .env from .env.example if it does not exist (never overwrites an existing file).
  - Replaces JWT_ACCESS_SECRET and OTP_HMAC_SECRET with fresh random values, but only while they
    still contain the CHANGE_ME placeholder. Existing real secrets are left alone.
  - Tells you which values you still have to enter yourself (the PostgreSQL password).

  Run from apps/backend:   .\scripts\setup-local-env.ps1
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root '.env'
$example = Join-Path $root '.env.example'

if (-not (Test-Path $envFile)) {
  Copy-Item $example $envFile
  Write-Host 'Created .env from .env.example'
} else {
  Write-Host '.env already exists; it will not be overwritten.'
}

function New-Secret {
  $bytes = New-Object byte[] 32
  $rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
  $rng.GetBytes($bytes)
  $rng.Dispose()
  return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
}

$lines = Get-Content $envFile
$changed = @()
for ($i = 0; $i -lt $lines.Count; $i++) {
  foreach ($key in 'JWT_ACCESS_SECRET', 'OTP_HMAC_SECRET') {
    if ($lines[$i] -match "^\s*$key\s*=.*CHANGE_ME") {
      $lines[$i] = "$key=$(New-Secret)"
      $changed += $key
    }
  }
}
if ($changed.Count -gt 0) {
  # Write without a BOM so dotenv reads the first line correctly.
  [System.IO.File]::WriteAllLines($envFile, $lines, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host ("Generated new random values for: " + ($changed -join ', ') + ' (not displayed)')
} else {
  Write-Host 'JWT_ACCESS_SECRET and OTP_HMAC_SECRET already have real values.'
}

$pending = @()
foreach ($line in $lines) {
  if ($line -match '^\s*(DATABASE_URL)\s*=.*CHANGE_ME') { $pending += $Matches[1] }
}
if ($pending.Count -gt 0) {
  Write-Host ''
  Write-Host 'YOU MUST STILL SET (open .env in an editor, do not paste it into chat):'
  $pending | ForEach-Object { Write-Host "  - $_  -> replace CHANGE_ME with your PostgreSQL user's password" }
} else {
  Write-Host 'DATABASE_URL no longer contains CHANGE_ME.'
}
Write-Host ''
Write-Host 'Next: npm run check:local'
