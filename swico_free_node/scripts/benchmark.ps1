$ErrorActionPreference = 'Stop'
$NodeRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $NodeRoot
if (-not (Test-Path '.env')) { throw 'Create swico_free_node\.env before benchmarking.' }
. (Join-Path $PSScriptRoot 'dotenv.ps1')
Import-SwicoFreeDotEnv (Join-Path $NodeRoot '.env')
& .\.venv\Scripts\python.exe .\scripts\benchmark.py
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
