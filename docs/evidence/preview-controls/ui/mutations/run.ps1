$ErrorActionPreference = 'Stop'
$taskRoot = 'D:\sater\satr-2'
$sourcePath = Join-Path $taskRoot 'src\ui\components\preview-panel.js'
$outputRoot = Join-Path $taskRoot 'dist\preview-controls-ui-mutations'
$source = [IO.File]::ReadAllText($sourcePath).Replace("`r`n", "`n")
$sourceHash = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash
$utf8 = New-Object Text.UTF8Encoding($false)
$cases = @(
  @{ id = 'device-intent'; old = '      viewportResetPending = true;'; new = '      viewportResetPending = false; // MUTANT discards device intent' },
  @{ id = 'same-rectangle'; old = '      if (key === lastBoundsKey && !viewportResetPending) return;'; new = '      if (key === lastBoundsKey) return; // MUTANT drops same rectangle intent' },
  @{ id = 'ordinary-bounds'; old = '      const resetViewport = viewportResetPending;'; new = '      const resetViewport = true; // MUTANT resets ordinary bounds' },
  @{ id = 'network-disabled'; old = '      netBtn.disabled = true;'; new = '      netBtn.disabled = false; // MUTANT permits concurrent network requests' },
  @{ id = 'network-failed-label'; old = '        if (r && r.ok) { netIdx = next; paintNetwork(); }'; new = '        if (r) { netIdx = next; paintNetwork(); } // MUTANT paints failed network result' },
  @{ id = 'stale-pick'; old = '      if (request !== pickRequest || generation !== previewGeneration) return;'; new = '      void 0; // MUTANT accepts cancelled pick result' },
  @{ id = 'native-close'; old = '      if (ev.type === ''closed'') {'; new = '      if (ev.type === ''never_closed'') { // MUTANT ignores native close' },
  @{ id = 'restart-finally'; old = '      finally { restartServerBtn.disabled = false; }'; new = '      finally { restartServerBtn.disabled = true; } // MUTANT retains disabled restart' }
)
function Count-Literal([string]$value, [string]$pattern) { return $value.Split(@($pattern), [StringSplitOptions]::None).Count - 1 }
$records = @()
foreach ($case in $cases) {
  $originalPattern = $case.old
  $mutantPattern = $case.new
  $mutantPath = Join-Path $outputRoot ($case.id + '.js')
  $originalBefore = Count-Literal $source $originalPattern
  $mutantBefore = Count-Literal $source $mutantPattern
  if ($originalBefore -ne 1 -or $mutantBefore -ne 0) { throw ('Unexpected pattern counts for ' + $case.id) }
  [IO.File]::WriteAllText($mutantPath, $source.Replace($originalPattern, $mutantPattern), $utf8)
  $mutated = [IO.File]::ReadAllText($mutantPath)
  $originalAfter = Count-Literal $mutated $originalPattern
  $mutantAfter = Count-Literal $mutated $mutantPattern
  if ($originalAfter -ne 0 -or $mutantAfter -ne 1) { throw ('Mutation did not apply: ' + $case.id) }
  $ErrorActionPreference = 'Continue'
  $output = & (Join-Path $taskRoot 'node_modules\.bin\electron.cmd') (Join-Path $taskRoot 'scripts\preview-controls-ui-test.js') --preview $mutantPath 2>&1
  $exitCode = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  $lines = @($output | ForEach-Object { $_.ToString() })
  [IO.File]::WriteAllText((Join-Path $outputRoot ($case.id + '.log')), ($lines -join "`n"), $utf8)
  Copy-Item -LiteralPath $sourcePath -Destination $mutantPath -Force
  if ($exitCode -eq 0) { throw ('Guard survived mutation: ' + $case.id) }
  $failure = ($lines | Where-Object { $_ -match 'AssertionError' } | Select-Object -First 1)
  if (-not $failure) { throw ('Failure was not an assertion: ' + $case.id) }
  $restored = [IO.File]::ReadAllText($mutantPath).Replace("`r`n", "`n")
  $records += [ordered]@{
    id = $case.id; source = $sourcePath; mutant = $mutantPath
    originalPattern = $originalPattern; mutantPattern = $mutantPattern
    plantCommand = '[IO.File]::WriteAllText($mutantPath, $source.Replace($originalPattern, $mutantPattern), $utf8)'
    originalBefore = $originalBefore; originalAfter = $originalAfter
    mutantBefore = $mutantBefore; mutantAfter = $mutantAfter
    guardCommand = ('node_modules\.bin\electron.cmd scripts/preview-controls-ui-test.js --preview ' + $mutantPath)
    exitCode = $exitCode; failure = $failure
    restoreCommand = 'Copy-Item -LiteralPath $sourcePath -Destination $mutantPath -Force'
    restoredOriginal = (Count-Literal $restored $originalPattern); restoredMutant = (Count-Literal $restored $mutantPattern)
  }
  [IO.File]::WriteAllText((Join-Path $outputRoot 'evidence.json'), ($records | ConvertTo-Json -Depth 8), $utf8)
  Write-Output ($case.id + ': original ' + $originalBefore + ' -> ' + $originalAfter + '; mutant ' + $mutantBefore + ' -> ' + $mutantAfter + '; exit=' + $exitCode)
  Write-Output $failure
}
if ((Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash -ne $sourceHash) { throw 'Production source changed during mutation run' }
Write-Output ('Preview controls mutations: ' + $records.Count + '/' + $cases.Count + ' rejected; production hash unchanged')