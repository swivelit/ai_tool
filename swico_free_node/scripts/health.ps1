$ErrorActionPreference = 'Stop'
$NodeRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $PSScriptRoot 'dotenv.ps1')
Import-SwicoFreeDotEnv (Join-Path $NodeRoot '.env')
$token = $env:SWICO_FREE_NODE_TOKEN
if ([string]::IsNullOrWhiteSpace($token)) { throw 'SWICO_FREE_NODE_TOKEN is missing from .env.' }
$timeout = 90
if ($env:SWICO_FREE_INFERENCE_TIMEOUT_SECONDS) { $timeout = [Math]::Min(120, [Math]::Max(1, [int]$env:SWICO_FREE_INFERENCE_TIMEOUT_SECONDS)) }
Invoke-RestMethod -Uri 'http://127.0.0.1:8765/health' -Headers @{ Authorization = "Bearer $token" } -TimeoutSec $timeout
