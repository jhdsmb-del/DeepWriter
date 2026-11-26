param(
  [Parameter(Mandatory = $true)][string]$Script,
  [string[]]$ScriptArgs = @()
)

$log = Join-Path $env:RUNNER_TEMP ('release-' + $Script.Replace(':', '-') + '.log')
npm run $Script @ScriptArgs 2>&1 | Tee-Object -FilePath $log
$code = $LASTEXITCODE
$details = @{ script = $Script; errors = @(); tail = @() }
if ($code -ne 0) {
  $lines = @(Get-Content $log)
  $details.errors = @($lines | Where-Object { $_ -match '^\s*(FAIL|not ok|[✖×])|\b(Error|TimeoutError|TypeError):|执行异常|E2E 执行失败|\[closeApp\] FAIL|E2E fatal' } | Select-Object -Last 12 | ForEach-Object { $_.Substring(0, [Math]::Min($_.Length, 400)) })
  $details.tail = @($lines | Select-Object -Last 25 | ForEach-Object { $_.Substring(0, [Math]::Min($_.Length, 400)) })
}
"details=$($details | ConvertTo-Json -Compress)" | Add-Content $env:GITHUB_OUTPUT
exit $code
