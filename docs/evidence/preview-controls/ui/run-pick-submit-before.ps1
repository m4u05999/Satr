$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$repo = (Get-Location).Path
$evidenceDir = Join-Path $repo 'docs\evidence\preview-controls\ui'
$source = Join-Path $repo 'dist\preview-controls-pick-submit\before.js'
$guard = Join-Path $repo 'scripts\preview-controls-ui-test.js'
$recipe = Get-Content -LiteralPath (Join-Path $evidenceDir 'pick-submit-replay.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$currentPath = Join-Path $repo 'src\ui\components\preview-panel.js'
if ((Get-FileHash -LiteralPath $currentPath).Hash.ToLowerInvariant() -ne $recipe.afterSHA256) { throw 'Current source differs from the recorded fixed version' }
$beforeText = [IO.File]::ReadAllText($currentPath, [Text.Encoding]::UTF8)
foreach ($pair in @(@($recipe.stateAfter, $recipe.stateBefore), @($recipe.submitAfter, $recipe.submitBefore))) {
  if (($beforeText.Split(@([string]$pair[0]), [StringSplitOptions]::None)).Length -ne 2) { throw 'Expected exactly one fixed source block' }
  $beforeText = $beforeText.Replace([string]$pair[0], [string]$pair[1])
}
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($source)) | Out-Null
[IO.File]::WriteAllText($source, $beforeText, (New-Object Text.UTF8Encoding($false)))
if ((Get-FileHash -LiteralPath $source).Hash.ToLowerInvariant() -ne $recipe.beforeSHA256) { throw 'Reconstructed source differs from the actual before-fix snapshot' }
$results = @()
foreach ($case in @('cancel', 'close', 'native-close', 'new-pick')) {
  $command = 'node_modules\.bin\electron.cmd scripts/preview-controls-ui-test.js --preview dist/preview-controls-pick-submit/before.js --pick-submit-case ' + $case
  Write-Output ('RUN ' + $command)
  $lines = @(& node_modules\.bin\electron.cmd scripts/preview-controls-ui-test.js --preview dist/preview-controls-pick-submit/before.js --pick-submit-case $case 2>&1)
  $exitCode = $LASTEXITCODE
  $log = Join-Path $evidenceDir ('pick-submit-before-' + $case + '.log')
  [IO.File]::WriteAllText($log, ($lines -join [Environment]::NewLine), (New-Object Text.UTF8Encoding($false)))
  $failure = ($lines | ForEach-Object { $_.ToString() } | Where-Object { $_ -match 'AssertionError|Uncaught|TypeError|preview-controls-ui: timeout' }) -join [Environment]::NewLine
  Write-Output ('EXIT ' + $exitCode + ' CASE ' + $case)
  Write-Output $failure
  $results += [pscustomobject]@{ case = $case; command = $command; exitCode = $exitCode; log = [IO.Path]::GetFileName($log); failure = $failure }
}
$report = [pscustomobject]@{
  recordedAt = [DateTime]::UtcNow.ToString('o')
  type = 'actual production source before fix; controlled deferred screenshot boundary'
  sourcePath = 'dist/preview-controls-pick-submit/before.js'
  sourceSHA256 = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
  guardSHA256 = (Get-FileHash -LiteralPath $guard -Algorithm SHA256).Hash.ToLowerInvariant()
  reconstructedSourceMatchesActualBeforeSHA256 = ((Get-FileHash -LiteralPath $source).Hash.ToLowerInvariant() -eq $recipe.beforeSHA256)
  results = $results
}
[IO.File]::WriteAllText((Join-Path $evidenceDir 'pick-submit-before.json'), ($report | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding($false)))