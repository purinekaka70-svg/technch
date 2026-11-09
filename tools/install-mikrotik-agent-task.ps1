param(
  [string]$TaskName = 'Jixels MikroTik Agent'
)

$ErrorActionPreference = 'Stop'
$agentPath = Join-Path $PSScriptRoot 'mikrotik-agent.ps1'
if (-not (Test-Path -LiteralPath $agentPath)) { throw "Agent script not found: $agentPath" }
$powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
$action = New-ScheduledTaskAction -Execute $powershell -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$agentPath`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description 'Runs the Jixels MikroTik bridge agent for this Windows account.' -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "Scheduled task '$TaskName' installed and started for $env:USERDOMAIN\$env:USERNAME. Keep this Windows account signed in and the PC powered on."
