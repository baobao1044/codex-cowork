$scriptRoot = $PSScriptRoot -replace '^\\\\\?\\', ''
. "$scriptRoot\shared.ps1"

$repoRoot = Split-Path -Parent $scriptRoot

Invoke-NodeScript -ScriptPath (Join-Path $repoRoot "node_modules/tsx/dist/cli.mjs") -Arguments @(
  (Join-Path $repoRoot "src/index.ts")
)
