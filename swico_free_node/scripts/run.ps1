$ErrorActionPreference = 'Stop'
$NodeRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $NodeRoot
if (-not (Test-Path '.env')) { throw 'Create swico_free_node\.env before starting.' }
. (Join-Path $PSScriptRoot 'dotenv.ps1')
Import-SwicoFreeDotEnv (Join-Path $NodeRoot '.env')
$NodeHost = $env:SWICO_FREE_NODE_HOST
$NodePort = $env:SWICO_FREE_NODE_PORT
if ([string]::IsNullOrWhiteSpace($NodeHost)) { $NodeHost = '127.0.0.1' }
if ($NodeHost -ne '127.0.0.1') { throw 'SWICO_FREE_NODE_HOST must remain 127.0.0.1.' }
if ([string]::IsNullOrWhiteSpace($NodePort)) { $NodePort = '8765' }
& .\.venv\Scripts\python.exe -m uvicorn app:app --host $NodeHost --port ([int]$NodePort) --workers 1
