$scriptRoot = $PSScriptRoot -replace '^\\\\\?\\', ''
. "$scriptRoot\shared.ps1"

$repoRoot = Split-Path -Parent $scriptRoot

Invoke-NodeScript -ScriptPath (Join-Path $repoRoot "node_modules/vitest/vitest.mjs") -Arguments @()
