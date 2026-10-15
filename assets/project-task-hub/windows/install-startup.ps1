param([switch]$Apply, [string]$TaskName = 'ProjectTaskHub')
$ErrorActionPreference = 'Stop'
$hubRoot = Split-Path -Parent $PSScriptRoot
$nodePath = (Get-Command node.exe).Source
$runner = Join-Path $PSScriptRoot 'run-hub.ps1'
$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $runner + '"'
if (-not $Apply) {
    [pscustomobject]@{ TaskName=$taskName; Command='powershell.exe'; Arguments=$arguments; Schedule='Hourly fallback while signed in; hidden window'; Hub=$hubRoot } | ConvertTo-Json
    exit 0
}
@{ node=$nodePath } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $hubRoot '.local\runtime.json') -Encoding UTF8
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments -WorkingDirectory $hubRoot
$trigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddHours(1)) -RepetitionInterval (New-TimeSpan -Hours 1)
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing -and $existing.Actions.Arguments -ne $arguments) { throw 'A different existing task has the same name; preserved.' }
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Local .tasks to YouGile sync for explicitly enabled Project Task Hub projects.' -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName,State | ConvertTo-Json
