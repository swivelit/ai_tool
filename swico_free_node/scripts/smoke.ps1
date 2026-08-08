$ErrorActionPreference = 'Stop'
$NodeRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $NodeRoot
if (-not (Test-Path '.env')) { throw 'Create swico_free_node\.env before smoke testing.' }
. (Join-Path $PSScriptRoot 'dotenv.ps1')
Import-SwicoFreeDotEnv (Join-Path $NodeRoot '.env')
$token = $env:SWICO_FREE_NODE_TOKEN
if ([string]::IsNullOrWhiteSpace($token)) { throw 'SWICO_FREE_NODE_TOKEN is missing from .env.' }
$timeout = 90
if ($env:SWICO_FREE_INFERENCE_TIMEOUT_SECONDS) { $timeout = [Math]::Min(120, [Math]::Max(1, [int]$env:SWICO_FREE_INFERENCE_TIMEOUT_SECONDS)) }
$headers = @{ Authorization = "Bearer $token" }
$failed = $false

function Check-Node($Name, $Script) {
  try {
    & $Script
    Write-Host "PASS $Name"
  } catch {
    Write-Host "FAIL $Name"
    $script:failed = $true
  }
}

Check-Node '/health' {
  $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8765/health' -Headers $headers -TimeoutSec $timeout
  if ($health.ready -ne $true) { throw 'not ready' }
}
Check-Node '/v1/embed' {
  $body = @{ texts = @('swico free smoke'); modes = @('query') } | ConvertTo-Json -Compress
  $embed = Invoke-RestMethod -Uri 'http://127.0.0.1:8765/v1/embed' -Method Post -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec $timeout
  if ($embed.dimensions -ne 384 -or $embed.vectors.Count -ne 1 -or $embed.vectors[0].Count -ne 384) { throw 'unexpected embedding dimensions' }
}
Check-Node '/v1/generate' {
  $body = @{ messages = @(@{ role = 'user'; content = 'Reply with exactly OK.' }); max_output_tokens = 8 } | ConvertTo-Json -Compress
  $generation = Invoke-RestMethod -Uri 'http://127.0.0.1:8765/v1/generate' -Method Post -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec $timeout
  if ([string]::IsNullOrWhiteSpace($generation.text)) { throw 'empty generation' }
}

if ($failed) { exit 1 }
Write-Host 'Swico Free local smoke test passed.'
