$scriptRoot = $PSScriptRoot -replace '^\\\\\?\\', ''
. "$scriptRoot\shared.ps1"

$repoRoot = Split-Path -Parent $scriptRoot

& node -e "require('node:fs').rmSync(process.argv[1],{recursive:true,force:true})" -- (Join-Path $repoRoot "dist")
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

Invoke-NodeScript -ScriptPath (Join-Path $repoRoot "node_modules/typescript/bin/tsc") -Arguments @(
  "-p",
  (Join-Path $repoRoot "tsconfig.build.json")
)
