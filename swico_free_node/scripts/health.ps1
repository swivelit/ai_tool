$ErrorActionPreference = 'Stop'
$NodeRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$token = (Get-Content (Join-Path $NodeRoot '.env') | Where-Object { $_ -match '^SWICO_FREE_NODE_TOKEN=' } | Select-Object -First 1) -replace '^SWICO_FREE_NODE_TOKEN=', ''
Invoke-RestMethod -Uri 'http://127.0.0.1:8765/health' -Headers @{ Authorization = "Bearer $token" }
