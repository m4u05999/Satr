$ErrorActionPreference = 'Stop'
$taskRoot = 'D:\sater\satr-2'
$sourcePath = Join-Path $taskRoot 'src\ui\app.js'
$outputRoot = Join-Path $taskRoot 'dist\models-surfaces-evidence\model-mutations'
[IO.Directory]::CreateDirectory($outputRoot) | Out-Null
$source = [IO.File]::ReadAllText($sourcePath).Replace("`r`n", "`n")
$sourceHash = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash
$utf8 = New-Object Text.UTF8Encoding($false)
$cases = @(
  @{ id = 'gate-ready'; old = '    refreshEngineModels(); // يبدأ الجلب بعد حسم الجاهزية، ولو بقي المحرك المختار نفسه.'; new = '    void 0; // MUTANT gate readiness omitted' },
  @{ id = 'before-ready'; old = '    if (gated || !GATED_ENGINES.includes(engine)) return Promise.resolve();'; new = '    if (!GATED_ENGINES.includes(engine)) return Promise.resolve(); // MUTANT premature request' },
  @{ id = 'single-flight'; old = '    if (engineModelsRequests.has(engine)) return engineModelsRequests.get(engine);'; new = '    void 0; // MUTANT duplicate concurrent request' },
  @{ id = 'declared-default'; old = '          isDefault: model.isDefault === true,'; new = '          isDefault: false, // MUTANT declared default discarded' },
  @{ id = 'saved-selection'; old = '    if (!saved) {
      const declaredDefault'; new = '    if (true) { // MUTANT ignores user selection
      const declaredDefault' },
  @{ id = 'late-failure'; old = '    if (fetched || codexDynamicModels.length || $(''engine'').value !== ''codex'') return;'; new = '    if (fetched || codexDynamicModels.length) return; // MUTANT stale failure' },
  @{ id = 'cancel-retry'; old = '      clearTimeout(codexModelsRetryTimer);'; new = '      void 0; // MUTANT pending retry survives' },
  @{ id = 'restore-current'; old = '      refreshEngineModels(record.engine);'; new = '      void 0; // MUTANT restored conversation catalog omitted' },
  @{ id = 'resume-codex'; old = '    applyEngineCommands(''codex'');
    refreshEngineModels(''codex'');'; new = '    applyEngineCommands(''codex'');
    void 0; // MUTANT resumed catalog omitted' }
)
function Count-Literal([string]$value, [string]$pattern) { return $value.Split(@($pattern), [StringSplitOptions]::None).Count - 1 }
$records = @()
foreach ($case in $cases) {
  $originalPattern = $case.old.Replace("`r`n", "`n")
  $mutantPattern = $case.new.Replace("`r`n", "`n")
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
  $output = & node (Join-Path $taskRoot 'scripts\model-boot-test.js') --source $mutantPath 2>&1
  $exitCode = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  $lines = @($output | ForEach-Object { $_.ToString() })
  [IO.File]::WriteAllText((Join-Path $outputRoot ($case.id + '.log')), ($lines -join "`n"), $utf8)
  Copy-Item -LiteralPath $sourcePath -Destination $mutantPath -Force
  if ($exitCode -eq 0) { throw ('Guard survived mutation: ' + $case.id) }
  $failure = ($lines | Where-Object { $_ -match 'AssertionError|model-boot-test: FAIL' } | Select-Object -First 1)
  if (-not $failure) { throw ('Failure was not an assertion: ' + $case.id) }
  $restored = [IO.File]::ReadAllText($mutantPath).Replace("`r`n", "`n")
  $record = [ordered]@{
    id = $case.id
    source = $sourcePath
    mutant = $mutantPath
    originalPattern = $originalPattern
    mutantPattern = $mutantPattern
    plantCommand = '[IO.File]::WriteAllText($mutantPath, $source.Replace($originalPattern, $mutantPattern), $utf8)'
    originalBefore = $originalBefore
    originalAfter = $originalAfter
    mutantBefore = $mutantBefore
    mutantAfter = $mutantAfter
    guardCommand = ('node scripts/model-boot-test.js --source ' + $mutantPath)
    exitCode = $exitCode
    failure = $failure
    restoreCommand = 'Copy-Item -LiteralPath $sourcePath -Destination $mutantPath -Force'
    restoredOriginal = (Count-Literal $restored $originalPattern)
    restoredMutant = (Count-Literal $restored $mutantPattern)
  }
  $records += $record
  Write-Output ($case.id + ': original ' + $originalBefore + ' -> ' + $originalAfter + '; mutant ' + $mutantBefore + ' -> ' + $mutantAfter + '; exit=' + $exitCode)
  Write-Output $failure
}
if ((Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash -ne $sourceHash) { throw 'Production source changed during mutation run' }
[IO.File]::WriteAllText((Join-Path $outputRoot 'evidence.json'), ($records | ConvertTo-Json -Depth 8), $utf8)
Write-Output ('Model mutations: ' + $records.Count + '/' + $cases.Count + ' rejected; production hash unchanged')