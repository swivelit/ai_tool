param()

$ErrorActionPreference = 'Stop'
$Failures = 0
$NodeRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

function Report-Check {
  param(
    [bool]$Passed,
    [string]$Name,
    [string]$Next
  )
  if ($Passed) {
    Write-Host "PASS $Name"
  } else {
    $script:Failures++
    Write-Host "FAIL $Name"
    Write-Host "Next: $Next"
  }
}

Report-Check ($env:OS -eq 'Windows_NT') 'Windows environment' 'Run this script on the Windows laptop.'

$python311 = $false
$py = Get-Command py.exe -ErrorAction SilentlyContinue
if ($null -ne $py) {
  try {
    $version = (& $py.Source -3.11 --version 2>&1 | Out-String)
    $python311 = ($LASTEXITCODE -eq 0 -and $version -match 'Python 3\.11\.')
  } catch { $python311 = $false }
}
Report-Check $python311 'Python' 'Install Python 3.11, reopen Git Bash, and run ./scripts/doctor.sh again.'

$venvPath = Join-Path $NodeRoot '.venv'
$envPath = Join-Path $NodeRoot '.env'
Report-Check (Test-Path -LiteralPath $venvPath -PathType Container) '.venv' './scripts/install.sh'
$envExists = Test-Path -LiteralPath $envPath -PathType Leaf
Report-Check $envExists '.env exists' 'Copy .env.example to .env, edit the local model paths and token, then rerun ./scripts/doctor.sh.'

$loaded = $false
if ($envExists) {
  try {
    . (Join-Path $PSScriptRoot 'dotenv.ps1')
    Import-SwicoFreeDotEnv $envPath
    $loaded = $true
  } catch {
    Report-Check $false '.env dotenv syntax' 'Use KEY=value lines; quoted values such as TOKEN="secret" are supported.'
  }
}

$required = @(
  'SWICO_FREE_NODE_TOKEN',
  'SWICO_FREE_QWEN_GGUF_PATH',
  'SWICO_FREE_E5_MODEL_PATH',
  'SWICO_FREE_NODE_HOST',
  'SWICO_FREE_NODE_PORT'
)
foreach ($name in $required) {
  $value = if ($loaded) { [Environment]::GetEnvironmentVariable($name, 'Process') } else { $null }
  Report-Check (-not [string]::IsNullOrWhiteSpace($value)) "$name present" "Add $name to swico_free_node/.env and rerun ./scripts/doctor.sh."
}

$token = if ($loaded) { $env:SWICO_FREE_NODE_TOKEN } else { $null }
$tokenValid = (-not [string]::IsNullOrWhiteSpace($token)) -and $token.Length -ge 32 -and -not ($token -match '\s')
Report-Check $tokenValid 'SWICO_FREE_NODE_TOKEN strength' 'Use a random non-empty token of at least 32 characters; it will not be printed.'

$qwenPath = if ($loaded) { $env:SWICO_FREE_QWEN_GGUF_PATH } else { $null }
$e5Path = if ($loaded) { $env:SWICO_FREE_E5_MODEL_PATH } else { $null }
$qwenExists = (-not [string]::IsNullOrWhiteSpace($qwenPath)) -and (Test-Path -LiteralPath $qwenPath -PathType Leaf)
$e5Exists = (-not [string]::IsNullOrWhiteSpace($e5Path)) -and (Test-Path -LiteralPath $e5Path -PathType Container)
Report-Check $qwenExists 'Qwen GGUF path exists' 'Set SWICO_FREE_QWEN_GGUF_PATH to the existing custom .gguf file.'
Report-Check $e5Exists 'E5 model directory exists' 'Set SWICO_FREE_E5_MODEL_PATH to the existing local E5 model directory.'
Report-Check ($qwenExists -and $e5Exists) 'models' 'Fix both local model paths, then rerun ./scripts/doctor.sh.'

$portListening = $false
try {
  $portListening = @(Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue).Count -gt 0
} catch { $portListening = $false }
Report-Check $portListening 'node port 8765' './scripts/run.sh in another Git Bash terminal.'

$tailscale = Get-Command tailscale.exe -ErrorAction SilentlyContinue
Report-Check ($null -ne $tailscale) 'Tailscale' 'Install Tailscale, sign in, and reopen Git Bash.'
$funnelReady = $false
if ($null -ne $tailscale) {
  try {
    & $tailscale.Source funnel status 2>$null | Out-Null
    $funnelReady = ($LASTEXITCODE -eq 0)
  } catch { $funnelReady = $false }
}
Report-Check $funnelReady 'Funnel' 'Run tailscale funnel --bg 8765, then run tailscale funnel status.'

if ($Failures -gt 0) {
  Write-Host "Doctor found $Failures issue(s). Complete the Next actions above and rerun ./scripts/doctor.sh."
  exit 1
}
Write-Host 'PASS Swico Free node doctor'
