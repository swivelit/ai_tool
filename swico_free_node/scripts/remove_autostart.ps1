param()

$ErrorActionPreference = 'Stop'
$TaskName = 'Swico Free Inference Node'
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -eq $task) {
  Write-Host 'PASS Swico Free autostart already absent'
  exit 0
}
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host 'PASS Swico Free autostart removed'
