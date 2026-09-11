$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$repo = (Get-Location).Path
$evidenceDir = Join-Path $repo 'docs\evidence\preview-controls\ui'
$guard = Join-Path $repo 'scripts\preview-controls-ui-test.js'
$source = Join-Path $repo 'src\ui\components\preview-panel.js'
$command = 'node_modules\.bin\electron.cmd scripts/preview-controls-ui-test.js'
Write-Output ('RUN ' + $command)
$lines = @(& node_modules\.bin\electron.cmd scripts/preview-controls-ui-test.js 2>&1)
$exitCode = $LASTEXITCODE
$log = Join-Path $evidenceDir 'pick-submit-after.log'
[IO.File]::WriteAllText($log, ($lines -join [Environment]::NewLine), (New-Object Text.UTF8Encoding($false)))
$lines | Select-Object -Last 28 | ForEach-Object { Write-Output $_.ToString() }
$report = [pscustomobject]@{
  recordedAt = [DateTime]::UtcNow.ToString('o')
  type = 'actual production source after pick submission fix'
  sourcePath = 'src/ui/components/preview-panel.js'
  sourceSHA256 = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
  guardSHA256 = (Get-FileHash -LiteralPath $guard -Algorithm SHA256).Hash.ToLowerInvariant()
  command = $command
  exitCode = $exitCode
  log = 'pick-submit-after.log'
}
[IO.File]::WriteAllText((Join-Path $evidenceDir 'pick-submit-after.json'), ($report | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding($false)))
if ($exitCode -eq 0) { Copy-Item -LiteralPath (Join-Path $repo 'dist\preview-controls-ui-evidence.json') -Destination (Join-Path $evidenceDir 'result.json') }
exit $exitCode