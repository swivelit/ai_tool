param(
  [string]$FunnelUrl = ''
)

$ErrorActionPreference = 'Stop'
$NodeRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not (Test-Path -LiteralPath (Join-Path $NodeRoot '.env'))) {
  Write-Host 'FAIL configuration_missing_env'
  Write-Host 'Next: create swico_free_node/.env and set SWICO_FREE_NODE_TOKEN.'
  exit 2
}
. (Join-Path $PSScriptRoot 'dotenv.ps1')
Import-SwicoFreeDotEnv (Join-Path $NodeRoot '.env')

$token = $env:SWICO_FREE_NODE_TOKEN
$tokenValid = (-not [string]::IsNullOrWhiteSpace($token)) -and $token.Length -ge 32 -and -not ($token -match '\s')
if (-not $tokenValid) {
  Write-Host 'FAIL invalid_token_configuration'
  Write-Host 'Next: set a random token of at least 32 characters in .env.'
  exit 2
}

$base = if ([string]::IsNullOrWhiteSpace($FunnelUrl)) { $env:SWICO_FREE_INFERENCE_BASE_URL } else { $FunnelUrl }
$uri = $null
if ([string]::IsNullOrWhiteSpace($base) -or -not [Uri]::TryCreate($base.TrimEnd('/'), [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -ne 'https' -or $null -ne $uri.UserInfo -and $uri.UserInfo -ne '' -or $uri.Query -or $uri.Fragment) {
  Write-Host 'FAIL invalid_https_url'
  Write-Host 'Next: set SWICO_FREE_INFERENCE_BASE_URL to the HTTPS Tailscale Funnel URL or pass -FunnelUrl.'
  exit 2
}

$timeout = 90
if ($env:SWICO_FREE_INFERENCE_TIMEOUT_SECONDS) {
  $timeout = [Math]::Min(120, [Math]::Max(1, [int]$env:SWICO_FREE_INFERENCE_TIMEOUT_SECONDS))
}
try {
  $health = Invoke-RestMethod -Uri "$($uri.AbsoluteUri.TrimEnd('/'))/health" -Headers @{ Authorization = "Bearer $token" } -TimeoutSec $timeout
  if ($health.ready -ne $true) {
    Write-Host 'FAIL health_not_ready'
    Write-Host 'Next: start the node with ./scripts/run.sh and verify its local /health endpoint.'
    exit 1
  }
  Write-Host 'PASS Funnel /health'
  exit 0
} catch {
  $category = 'connection_failed'
  $status = $null
  try { $status = [int]$_.Exception.Response.StatusCode.value__ } catch { $status = $null }
  if ($status -eq 401) { $category = 'http_401_auth_failed' }
  elseif ($status -eq 404) { $category = 'http_404_endpoint_missing' }
  elseif ($status -eq 502) { $category = 'http_502_upstream_unavailable' }
  elseif ($status -eq 503) { $category = 'http_503_unavailable' }
  elseif ($_.Exception -is [System.Net.WebException] -and $_.Exception.Status -eq 'Timeout') { $category = 'request_timeout' }
  Write-Host "FAIL Funnel /health $category"
  Write-Host 'Next: run ./scripts/health.sh locally, then run tailscale funnel status and confirm the Funnel URL in Render configuration.'
  exit 1
}
