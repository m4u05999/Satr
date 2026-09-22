param()
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$target = Join-Path $root 'electron/main.js'
$test = Join-Path $root 'scripts/saved-task-execution-test.js'
$outDir = Join-Path $root 'dist/saved-task-execution-bites'
[IO.Directory]::CreateDirectory($outDir) | Out-Null
$originalBytes = [IO.File]::ReadAllBytes($target)
$originalHash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
$source = [Text.Encoding]::UTF8.GetString($originalBytes)
$needle = "if (savedTaskHost.isReserved()) return { error: 'task_busy' };"
$mutant = "if (false) return { error: 'task_busy' };"
$beforeOriginal = ([regex]::Matches($source, [regex]::Escape($needle))).Count
$beforeMutant = ([regex]::Matches($source, [regex]::Escape($mutant))).Count
if ($beforeOriginal -ne 1 -or $beforeMutant -ne 0) { throw 'bite anchor mismatch' }
$mutated = $source.Replace($needle, $mutant)
[IO.File]::WriteAllText($target, $mutated, [Text.UTF8Encoding]::new($false))
$after = [IO.File]::ReadAllText($target)
$afterOriginal = ([regex]::Matches($after, [regex]::Escape($needle))).Count
$afterMutant = ([regex]::Matches($after, [regex]::Escape($mutant))).Count
try {
  $ErrorActionPreference = 'Continue'
  $lines = & node $test 2>&1
  $exitCode = $LASTEXITCODE
} finally {
  [IO.File]::WriteAllBytes($target, $originalBytes)
}
$restoredHash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
if ($exitCode -eq 0) { throw 'guard did not bite' }
if ($restoredHash -ne $originalHash) { throw 'restore hash mismatch' }
$failure = ($lines | Select-Object -First 8) -join [Environment]::NewLine
$report = @(
  "زرع: استبدال guard satr:send المحجوز بـ if (false) في electron/main.js",
  "قبل/بعد: $beforeOriginal → $afterOriginal (الأصل) · $beforeMutant → $afterMutant (المتحور)",
  "فشل الحارس: $failure",
  "استعادة: WriteAllBytes(originalBytes)",
  "SHA256: $originalHash = $restoredHash"
) -join [Environment]::NewLine
[IO.File]::WriteAllText((Join-Path $outDir 'send-reservation.txt'), $report, [Text.UTF8Encoding]::new($false))
Write-Output $report
