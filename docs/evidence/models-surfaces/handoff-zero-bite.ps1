# إعادة عضّة حدود الحجب في نسخة مستقلة؛ لا تعديل في ملفات الإنتاج.
param()
$taskRepo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$taskDist = [IO.Path]::GetFullPath((Join-Path $taskRepo 'dist'))
$taskName = 'handoff-zero-bite-' + [Guid]::NewGuid().ToString('N').Substring(0, 12)
$taskRoot = [IO.Path]::GetFullPath((Join-Path $taskDist $taskName))
if (-not $taskRoot.StartsWith($taskDist + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid isolated path' }
if (Test-Path -LiteralPath $taskRoot) { throw 'Isolated path already exists' }
$taskFiles = @(
  'src/ui/app.js', 'src/ui/components/preview-panel.js', 'src/ui/lib/sheet.js',
  'src/ui/lib/panel.css.js', 'src/ui/lib/media-recorder.js', 'src/styles/base.css',
  'src/vendor/fonts.css', 'scripts/handoff-bar-live-test.js',
  'scripts/fixtures/handoff-bar-live.html', 'scripts/fixtures/handoff-bar-live-page.js',
  'scripts/full-suite.js', 'package.json'
)
foreach ($taskFile in $taskFiles) {
  $taskTarget = Join-Path $taskRoot $taskFile
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($taskTarget)) | Out-Null
  Copy-Item -LiteralPath (Join-Path $taskRepo $taskFile) -Destination $taskTarget -ErrorAction Stop
}
Copy-Item -LiteralPath (Join-Path $taskRepo 'src/vendor/fonts') -Destination (Join-Path $taskRoot 'src/vendor/fonts') -Recurse -ErrorAction Stop
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'handoff-zero-bite.cjs') -Destination (Join-Path $taskRoot 'mutate.cjs') -ErrorAction Stop
$taskPanel = Join-Path $taskRoot 'src/ui/components/preview-panel.js'
Copy-Item -LiteralPath $taskPanel -Destination (Join-Path $taskRoot 'preview-panel.original.js') -ErrorAction Stop
$taskTestFile = Join-Path $taskRoot 'scripts/handoff-bar-live-test.js'
$taskTest = [IO.File]::ReadAllText($taskTestFile).Replace('const ROOT =', "app.setPath('userData', path.resolve(__dirname, '../profile'));" + [char]10 + 'const ROOT =')
[IO.File]::WriteAllText($taskTestFile, $taskTest, (New-Object Text.UTF8Encoding($false)))
$taskMutator = Join-Path $taskRoot 'mutate.cjs'
$taskElectron = Join-Path $taskRepo 'node_modules/.bin/electron.cmd'
$taskLog = Join-Path $taskRoot 'guard.log'
$taskGuardExit = $null
$taskConsoleEncoding = [Console]::OutputEncoding
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
Push-Location $taskRepo
try {
  & node $taskMutator plant
  if ($LASTEXITCODE -ne 0) { throw 'Mutation did not apply' }
  # السجل UTF-16LE عند تشغيله في Windows PowerShell 5؛ يبقى خرج الاختبار ظاهراً.
  & $taskElectron $taskTestFile 2>&1 | Tee-Object -FilePath $taskLog
  $taskGuardExit = $LASTEXITCODE
} finally {
  & node $taskMutator restore
  Pop-Location
  [Console]::OutputEncoding = $taskConsoleEncoding
}
$taskRestored = (Get-FileHash -LiteralPath $taskPanel).Hash -eq (Get-FileHash -LiteralPath (Join-Path $taskRoot 'preview-panel.original.js')).Hash
if (-not $taskRestored) { throw 'Isolated source was not restored' }
if ($taskGuardExit -ne 1) { throw ('Expected assertion exit 1, received ' + $taskGuardExit) }
if (-not (Select-String -LiteralPath $taskLog -SimpleMatch 'holdForDialog سرّب مستطيل العرض أثناء الحوار.' -Quiet)) { throw 'Expected assertion was not printed' }
Write-Output ('guard_exit=' + $taskGuardExit)
Write-Output ('isolated_evidence=' + $taskRoot)
# لا حذف آلياً: يبقى السجل والنسخة المستعادة لمراجعة الدليل.
