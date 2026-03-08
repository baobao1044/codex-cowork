Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Invoke-NodeScript {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ScriptPath,
    [string[]]$Arguments = @()
  )

  & node $ScriptPath @Arguments
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}
