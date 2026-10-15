param([string]$HubRoot = (Split-Path -Parent $PSScriptRoot))
$ErrorActionPreference = 'Stop'
$runtime = Get-Content -LiteralPath (Join-Path $HubRoot '.local\runtime.json') -Raw | ConvertFrom-Json
& $runtime.node (Join-Path $HubRoot 'cli.mjs') tick --apply *> $null
exit $LASTEXITCODE
