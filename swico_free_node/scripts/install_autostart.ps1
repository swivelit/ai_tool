param()

$ErrorActionPreference = 'Stop'
$TaskName = 'Swico Free Inference Node'
$NodeRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$RunScript = (Resolve-Path (Join-Path $PSScriptRoot 'run.ps1')).Path
$Python = Join-Path $NodeRoot '.venv\Scripts\python.exe'

if (-not (Test-Path -LiteralPath $RunScript -PathType Leaf)) {
  throw 'The node run script is missing. Restore the repository and retry.'
}
if (-not (Test-Path -LiteralPath (Join-Path $NodeRoot '.env') -PathType Leaf)) {
  throw 'Create swico_free_node\.env before installing autostart.'
}
if (-not (Test-Path -LiteralPath $Python -PathType Leaf)) {
  throw 'The node .venv is missing. Run .\scripts\install.ps1 first.'
}

$arguments = '-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $RunScript
$action = New-ScheduledTaskAction -Execute 'PowerShell.exe' -Argument $arguments -WorkingDirectory $NodeRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew

# Register-ScheduledTask -Force updates the existing task, so rerunning this
# script never creates a duplicate and never puts the secret on the command line.
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Start the local Swico Free inference node after this user logs in.' -Force | Out-Null
Write-Host 'PASS Swico Free autostart installed'
Write-Host 'Next: sign out and back in, then run .\scripts\doctor.ps1 and .\scripts\smoke.ps1.'
