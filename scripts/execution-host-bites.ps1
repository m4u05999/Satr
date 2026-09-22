param(
  [ValidateSet('all','owner_rebind','control_replay','early_result_done','partial_verify','config_recheck')]
  [string]$Mutation='all'
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repoRoot=Split-Path -Parent $PSScriptRoot
$sourcePath=Join-Path $repoRoot 'electron/execution-host.js'
$testPath=Join-Path $repoRoot 'scripts/execution-host-test.js'
$evidenceRoot=Join-Path $repoRoot 'dist/execution-host-bites'
$backupPath=Join-Path $evidenceRoot 'execution-host-frozen.js'
$utf8=New-Object System.Text.UTF8Encoding($false)
$lf=[string][char]10
New-Item -ItemType Directory -Path $evidenceRoot -Force|Out-Null
[IO.File]::Copy($sourcePath,$backupPath,$true)
$originalHash=(Get-FileHash -LiteralPath $backupPath -Algorithm SHA256).Hash
function Count-Literal([string]$Text,[string]$Needle){
  $count=0;$offset=0
  while(($found=$Text.IndexOf($Needle,$offset,[StringComparison]::Ordinal))-ge 0){$count+=1;$offset=$found+$Needle.Length}
  return $count
}
$mutations=@(
 [pscustomobject]@{Name='owner_rebind';Old='active.run_id || !owner';New='false || !owner';Count=1},
 [pscustomobject]@{Name='control_replay';Old='if (active.consumedControls.has(key) || active.controls.has(key)) return;';New='if (false || active.controls.has(key)) return;';Count=1},
 [pscustomobject]@{Name='early_result_done';Old='        noteControl(raw);';New="        if (raw && raw.type === 'result') active.done = true;$lf        Reflect.apply(noteControl, null, [raw]);";Count=1},
 [pscustomobject]@{Name='partial_verify';Old='&& result.aborted === false && exact';New='&& result.aborted === false && true';Count=1},
 [pscustomobject]@{Name='config_recheck';Old="if (!stillMatches()) return { ok: false, error: 'verification_changed' };";New="if (false && !stillMatches()) return { ok: false, error: 'verification_changed' };";Count=2}
)
$selected=if($Mutation-eq'all'){$mutations}else{$mutations|Where-Object Name -eq $Mutation}
if(-not $selected){throw "Unknown mutation: $Mutation"}
foreach($item in $selected){
 $reportPath=Join-Path $evidenceRoot ($item.Name+'.txt')
 $original=[IO.File]::ReadAllText($backupPath)
 $oldBefore=Count-Literal $original $item.Old
 $newBefore=Count-Literal $original $item.New
 if($oldBefore-ne$item.Count-or$newBefore-ne 0){throw "$($item.Name): unexpected pre-count old=$oldBefore new=$newBefore"}
 $mutated=$original.Replace($item.Old,$item.New)
 $oldAfter=Count-Literal $mutated $item.Old
 $newAfter=Count-Literal $mutated $item.New
 if($oldAfter-ne 0-or$newAfter-ne$item.Count){throw "$($item.Name): mutation count failed old=$oldAfter new=$newAfter"}
 try{
  [IO.File]::WriteAllText($sourcePath,$mutated,$utf8)
  $savedErrorPreference=$ErrorActionPreference
  $ErrorActionPreference='Continue'
  $output=(& node $testPath 2>&1|Out-String)
  $exitCode=$LASTEXITCODE
  $ErrorActionPreference=$savedErrorPreference
 }finally{[IO.File]::Copy($backupPath,$sourcePath,$true)}
 $restoredHash=(Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash
 if($restoredHash-ne$originalHash){throw "$($item.Name): byte restoration hash mismatch"}
 if($exitCode-eq 0){throw "$($item.Name): guard did not fail"}
 $plantCommand="& '$PSScriptRoot/execution-host-bites.ps1' -Mutation '$($item.Name)'"
 $restoreCommand="[IO.File]::Copy('$backupPath', '$sourcePath', "+'$true'+")"
 $report=@(
  "mutation: $($item.Name)",
  "plant: $plantCommand",
  "before: old=$oldBefore new=$newBefore",
  "after: old=$oldAfter new=$newAfter",
  "guard_exit: $exitCode",
  "guard_failure:",
  $output.TrimEnd(),
  "restore: $restoreCommand",
  "restore_sha256: $restoredHash"
 )-join$lf
 [IO.File]::WriteAllText($reportPath,$report+$lf,$utf8)
 Write-Host "$($item.Name): bite passed; exit=$exitCode; restored=$restoredHash"
}
[IO.File]::Copy($backupPath,$sourcePath,$true)
$global:LASTEXITCODE=0
