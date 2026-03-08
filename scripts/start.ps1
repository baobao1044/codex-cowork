$scriptRoot = $PSScriptRoot -replace '^\\\\\?\\', ''
. "$scriptRoot\shared.ps1"

$repoRoot = Split-Path -Parent $scriptRoot

Invoke-NodeScript -ScriptPath (Join-Path $repoRoot "dist/index.js")
