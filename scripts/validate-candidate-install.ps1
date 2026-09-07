# فحص التثبيت والترقية بملفّي NSIS على عدّاء GitHub نظيف؛ لا يُشغّل على جهاز المالك.
# يبقى هذا الملف UTF-8 مع BOM كي يقرأ PowerShell 5.1 التعليقات العربية سليمة.
# لا إلغاء تثبيت بين النسختين. إعادة التشغيل بعد العضّة تقبل النسخة السابقة وحدها.
# إثبات الإقلاع نافذة القشرة المملوكة ولو كانت مخفية، وليس فحص DOM أو قبولاً بصرياً أو اختبار APPX.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$PreviousInstaller,
  [Parameter(Mandatory = $true)][string]$CandidateInstaller,
  [Parameter(Mandatory = $true)][string]$ExpectedVersion,
  [string]$PreviousVersion = '2.16.20',
  [Parameter(Mandatory = $true)][string]$ReportDir
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'CI_ONLY: GITHUB_ACTIONS must equal true.' }
if ($env:OS -ne 'Windows_NT') { throw 'WINDOWS_ONLY: this check requires Windows.' }

$productCode = 'be4b5aae-94c3-5c0d-bec7-9e26b831dbed'
$script:stage = 'preflight'
$script:ownedApp = $null
$script:installedPath = $null
$reportPath = $null
$exitCode = 1
$report = [ordered]@{
  schema_version = 1
  started_at = [DateTime]::UtcNow.ToString('o')
  finished_at = $null
  status = 'running'
  previous_version = $PreviousVersion
  expected_version = $ExpectedVersion
  product_code = $productCode
  checks = [Collections.Generic.List[object]]::new()
  installers = [Collections.Generic.List[object]]::new()
  initial_arp = @()
  previous_arp = @()
  candidate_arp = @()
  exe_product_version = $null
  locale_files = @()
  startup = [ordered]@{ proof = 'none'; pid = $null; window_handle = $null; class_name = $null; title_matches_shell = $false; visible = $null; observed_ms = 0; stable_ms = 0; dom_checked = $false }
  cleanup = [ordered]@{ stopped_pids = [Collections.Generic.List[int]]::new(); failure = $null }
  failure = $null
}

function Assert-Check([bool]$Condition, [string]$Name, [string]$FailureMessage) {
  $report.checks.Add([ordered]@{ name = $Name; passed = $Condition })
  if (-not $Condition) { throw $FailureMessage }
  Write-Host "PASS $Name"
}

function Get-NormalPath([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value) -or $Value -match '[\x00-\x1f"]') {
    throw 'Invalid filesystem path.'
  }
  return [IO.Path]::GetFullPath($Value).TrimEnd([IO.Path]::DirectorySeparatorChar)
}

function Test-Within([string]$Path, [string]$Root) {
  return $Path.StartsWith($Root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

function Resolve-Installer([string]$Value, [string]$Name) {
  $item = Get-Item -LiteralPath $Value -ErrorAction Stop
  Assert-Check (-not $item.PSIsContainer -and $item.Extension -ieq '.exe') "$Name.exe" 'Installer path must name an existing EXE file.'
  Assert-Check (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) "$Name.regular_file" 'Installer must not be a reparse point.'
  $resolved = Get-NormalPath $item.FullName
  Assert-Check ((Test-Within $resolved $script:runnerRoot) -or (Test-Within $resolved $script:workspaceRoot)) "$Name.ci_path" 'Installer path must be inside RUNNER_TEMP or GITHUB_WORKSPACE.'
  return $resolved
}

function Get-SatrArp {
  $roots = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKCU:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
  )
  foreach ($root in $roots) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    foreach ($key in Get-ChildItem -LiteralPath $root -ErrorAction Stop) {
      $entry = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction Stop
      $nameProperty = $entry.PSObject.Properties['DisplayName']
      $displayName = if ($null -ne $nameProperty) { [string]$nameProperty.Value } else { '' }
      $code = $key.PSChildName.Trim([char[]]'{}').ToLowerInvariant()
      if ($code -ne $productCode -and $displayName -notmatch '(?i)\bSatr\b') { continue }
      $versionProperty = $entry.PSObject.Properties['DisplayVersion']
      # NSIS يكتب المسار في Software\{ProductCode} منفصلاً عن مدخل إزالة التثبيت.
      $installKey = $root -replace 'Microsoft\\Windows\\CurrentVersion\\Uninstall$', $code
      $pathProperty = $null
      if (Test-Path -LiteralPath $installKey) {
        $installInfo = Get-ItemProperty -LiteralPath $installKey -ErrorAction Stop
        $pathProperty = $installInfo.PSObject.Properties['InstallLocation']
      }
      [pscustomobject]@{
        ProductCode = $code
        RegistryPath = $key.Name
        InstallRegistryPath = $installKey
        IsCurrentUser = $root.StartsWith('HKCU:', [StringComparison]::OrdinalIgnoreCase)
        DisplayVersion = if ($null -ne $versionProperty) { [string]$versionProperty.Value } else { '' }
        InstallLocation = if ($null -ne $pathProperty) { [string]$pathProperty.Value } else { '' }
      }
    }
  }
}

function Assert-Arp([object[]]$Entries, [string]$Version, [string]$Phase) {
  Assert-Check ($Entries.Count -eq 1) "$Phase.arp.single" "ARP entry count mismatch: phase=$Phase expected=1 actual=$($Entries.Count)"
  $entry = $Entries[0]
  Assert-Check ($entry.ProductCode -eq $productCode) "$Phase.arp.product_code" "ARP ProductCode mismatch: phase=$Phase"
  Assert-Check $entry.IsCurrentUser "$Phase.arp.current_user" "ARP scope mismatch: phase=$Phase"
  $versionError = if ($Phase -eq 'upgrade') { 'Upgrade ARP version mismatch' } else { "ARP version mismatch: phase=$Phase" }
  Assert-Check ($entry.DisplayVersion -eq $Version) "$Phase.arp.version" "$versionError expected=$Version actual=$($entry.DisplayVersion)"
  $location = Get-NormalPath $entry.InstallLocation
  Assert-Check ($location -ieq $script:expectedInstallPath) "$Phase.arp.install_path" "ARP install path mismatch: phase=$Phase"
  Assert-Check (Test-Path -LiteralPath (Join-Path $location 'Satr.exe') -PathType Leaf) "$Phase.exe.exists" "Installed Satr.exe missing: phase=$Phase"
  return $location
}

# MainWindowHandle يستبعد النافذة المخفية؛ نقرأ نوافذ PID المملوك دون تغيير ظهورها.
# الفئة والعنوان الثابتان يميّزان القشرة من نوافذ Electron المساعدة، ولا نحفظ عناوين أخرى.
function Initialize-OwnedShellWindowProbe {
  if ('SatrCandidateOwnedShellWindow' -as [type]) { return }
  $nativeWindowSource = @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public sealed class SatrCandidateShellWindow {
  public long Handle { get; set; }
  public uint ProcessId { get; set; }
  public string ClassName { get; set; }
  public bool TitleMatchesShell { get; set; }
  public bool Visible { get; set; }
}

public static class SatrCandidateOwnedShellWindow {
  [return: MarshalAs(UnmanagedType.Bool)]
  private delegate bool EnumWindowsCallback(IntPtr window, IntPtr parameter);

  [DllImport("user32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr parameter);

  [DllImport("user32.dll", SetLastError = true)]
  private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

  [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
  private static extern int GetClassNameW(IntPtr window, StringBuilder value, int capacity);

  [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
  private static extern int GetWindowTextW(IntPtr window, StringBuilder value, int capacity);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool IsWindow(IntPtr window);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool IsWindowVisible(IntPtr window);

  public static SatrCandidateShellWindow Find(uint ownedProcessId) {
    SatrCandidateShellWindow found = null;
    EnumWindowsCallback callback = delegate(IntPtr window, IntPtr parameter) {
      if (found != null) return true;
      uint processId;
      if (GetWindowThreadProcessId(window, out processId) == 0 || processId != ownedProcessId) return true;
      StringBuilder className = new StringBuilder(256);
      if (GetClassNameW(window, className, className.Capacity) == 0 ||
          !String.Equals(className.ToString(), "Chrome_WidgetWin_1", StringComparison.Ordinal)) return true;
      StringBuilder title = new StringBuilder(512);
      if (GetWindowTextW(window, title, title.Capacity) == 0 ||
          !String.Equals(title.ToString(), "\u0633\u0637\u0631 \u2014 Satr", StringComparison.Ordinal)) return true;
      if (!IsWindow(window) ||
          GetWindowThreadProcessId(window, out processId) == 0 || processId != ownedProcessId) return true;
      found = new SatrCandidateShellWindow {
        Handle = window.ToInt64(),
        ProcessId = processId,
        ClassName = className.ToString(),
        TitleMatchesShell = true,
        Visible = IsWindowVisible(window)
      };
      return true;
    };
    bool completed = EnumWindows(callback, IntPtr.Zero);
    int error = Marshal.GetLastWin32Error();
    GC.KeepAlive(callback);
    if (!completed) throw new Win32Exception(error, "Owned shell window enumeration failed.");
    return found;
  }
}
"@
  Add-Type -TypeDefinition $nativeWindowSource -Language CSharp
}

function Stop-OwnedProcess([Diagnostics.Process]$Process) {
  if ($null -eq $Process) { return }
  $Process.Refresh()
  if (-not $Process.HasExited) {
    # مقبض العملية المملوك هو الحد؛ لا taskkill ولا قتل بالاسم ولا شجرة عمليات عامة.
    $Process.Kill()
    if (-not $Process.WaitForExit(10000)) { throw 'Owned process did not exit after termination.' }
    $report.cleanup.stopped_pids.Add($Process.Id)
  }
}

function Stop-InstalledSatr([string]$Location) {
  foreach ($process in @(Get-Process -Name Satr -ErrorAction SilentlyContinue)) {
    try { $path = $process.Path } catch { continue }
    if ([string]::IsNullOrWhiteSpace($path)) { continue }
    $resolved = Get-NormalPath $path
    if (-not (Test-Within $resolved $Location)) { continue }
    Stop-OwnedProcess $process
  }
}

function Invoke-Installer([string]$Path, [string]$Phase) {
  $script:stage = "install.$Phase"
  $record = [ordered]@{ phase = $Phase; sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash; pid = $null; exit_code = $null; timed_out = $false; duration_ms = 0 }
  $report.installers.Add($record)
  $timer = [Diagnostics.Stopwatch]::StartNew()
  $process = $null
  try {
    $process = Start-Process -FilePath $Path -ArgumentList @('/S', '/currentuser') -WindowStyle Hidden -PassThru
    $record.pid = $process.Id
    if (-not $process.WaitForExit(120000)) {
      $record.timed_out = $true
      Stop-OwnedProcess $process
      throw "Installer timed out: phase=$Phase timeout_ms=120000"
    }
    $process.WaitForExit()
    $process.Refresh()
    $record.exit_code = $process.ExitCode
    Assert-Check ($null -ne $record.exit_code -and $record.exit_code -eq 0) "$Phase.installer.exit" "Installer exit mismatch: phase=$Phase actual=$($record.exit_code)"
    Write-Host "INSTALL phase=$Phase exit=$($record.exit_code) pid=$($record.pid)"
  } finally {
    $timer.Stop()
    $record.duration_ms = $timer.ElapsedMilliseconds
    if ($null -ne $process) { $process.Dispose() }
  }
}

try {
  $script:runnerRoot = Get-NormalPath $env:RUNNER_TEMP
  $script:workspaceRoot = Get-NormalPath $env:GITHUB_WORKSPACE
  $resolvedReportDir = Get-NormalPath $ReportDir
  Assert-Check ((Test-Within $resolvedReportDir $script:runnerRoot) -or (Test-Within $resolvedReportDir $script:workspaceRoot)) 'report.ci_path' 'ReportDir must be a child of RUNNER_TEMP or GITHUB_WORKSPACE.'
  New-Item -ItemType Directory -Path $resolvedReportDir -Force | Out-Null
  $candidateReportPath = Join-Path $resolvedReportDir 'report.json'
  if (Test-Path -LiteralPath $candidateReportPath) { throw 'Report already exists; use a fresh ReportDir for each run.' }
  $reportPath = $candidateReportPath

  Assert-Check ($ExpectedVersion -match '^\d+\.\d+\.\d+$' -and $PreviousVersion -match '^\d+\.\d+\.\d+$') 'versions.format' 'Versions must use major.minor.patch.'
  Assert-Check ([version]$ExpectedVersion -gt [version]$PreviousVersion) 'versions.upgrade' 'ExpectedVersion must be newer than PreviousVersion.'
  $PreviousInstaller = Resolve-Installer $PreviousInstaller 'previous'
  $CandidateInstaller = Resolve-Installer $CandidateInstaller 'candidate'
  Assert-Check ($PreviousInstaller -ine $CandidateInstaller) 'installers.distinct_paths' 'Installer inputs must use distinct paths.'
  $script:expectedInstallPath = Get-NormalPath (Join-Path $env:LOCALAPPDATA 'Programs\Satr')

  $initial = @(Get-SatrArp)
  $report.initial_arp = $initial
  Assert-Check ($initial.Count -le 1) 'initial.arp.single_or_absent' 'Initial ARP contains duplicate Satr entries.'
  if ($initial.Count -eq 1) {
    # العضّة السابقة قد تترك النسخة السابقة مثبتة؛ نعلن الحالة ونرفض أي تثبيت آخر.
    $script:installedPath = Assert-Arp $initial $PreviousVersion 'initial'
    Stop-InstalledSatr $script:installedPath
    Write-Host 'INITIAL previous_install_present=true'
  } else {
    Assert-Check (-not (Test-Path -LiteralPath $script:expectedInstallPath)) 'initial.install_path_absent' 'Unregistered Satr installation already exists.'
    Write-Host 'INITIAL previous_install_present=false'
  }

  Invoke-Installer -Path $PreviousInstaller -Phase 'previous'
  $script:stage = 'previous.arp'
  $previous = @(Get-SatrArp)
  $report.previous_arp = $previous
  $script:installedPath = Assert-Arp $previous $PreviousVersion 'previous'
  Stop-InstalledSatr $script:installedPath

  # سطر العضّة الوحيد: استبدال وسيط المرشح بالسابق يجب أن يسقط فحص إصدار ARP أدناه.
  Invoke-Installer -Path $CandidateInstaller -Phase 'candidate' # CANDIDATE_INSTALL_STEP

  $script:stage = 'upgrade.arp'
  $candidate = @(Get-SatrArp)
  $report.candidate_arp = $candidate
  $candidatePath = Assert-Arp $candidate $ExpectedVersion 'upgrade'
  Assert-Check ($candidatePath -ieq $script:installedPath) 'upgrade.same_path' 'Upgrade install location changed.'
  Assert-Check ($candidate[0].ProductCode -eq $previous[0].ProductCode -and $candidate[0].RegistryPath -ieq $previous[0].RegistryPath) 'upgrade.same_arp_key' 'Upgrade ARP registration changed.'
  Assert-Check (@($candidate | Where-Object { $_.DisplayVersion -eq $PreviousVersion }).Count -eq 0) 'upgrade.old_entry_absent' 'Old ARP version remains after upgrade.'
  Stop-InstalledSatr $script:installedPath

  $script:stage = 'candidate.files'
  $installedExe = Join-Path $candidatePath 'Satr.exe'
  $report.exe_product_version = [Diagnostics.FileVersionInfo]::GetVersionInfo($installedExe).ProductVersion
  # مورد الإصدار في EXE رباعي الأجزاء؛ رقم الحزمة الثلاثي يقابله جزء مراجعة صفري.
  $expectedExeVersion = $ExpectedVersion + '.0'
  Assert-Check ($report.exe_product_version -eq $expectedExeVersion) 'candidate.exe_product_version' "EXE ProductVersion mismatch expected=$expectedExeVersion actual=$($report.exe_product_version)"
  $localeDir = Join-Path $candidatePath 'locales'
  Assert-Check (Test-Path -LiteralPath $localeDir -PathType Container) 'candidate.locales_directory' 'Installed locales directory missing.'
  $localeEntries = @(Get-ChildItem -LiteralPath $localeDir -Force | Sort-Object Name)
  $report.locale_files = @($localeEntries | ForEach-Object { $_.Name })
  Assert-Check ($localeEntries.Count -eq 2 -and @($localeEntries | Where-Object { $_.PSIsContainer }).Count -eq 0 -and ($report.locale_files -join ',') -ceq 'ar.pak,en-US.pak') 'candidate.locales_exact' "Locale files mismatch actual=$($report.locale_files -join ',')"

  $script:stage = 'candidate.startup'
  Initialize-OwnedShellWindowProbe
  $profilePath = Join-Path $script:runnerRoot ('satr-candidate-profile-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $profilePath | Out-Null
  $launchArgs = @(('--user-data-dir="' + $profilePath + '"'), '--lang=ar')
  $script:ownedApp = Start-Process -FilePath $installedExe -ArgumentList $launchArgs -WindowStyle Hidden -PassThru
  $report.startup.pid = $script:ownedApp.Id
  $startupTimer = [Diagnostics.Stopwatch]::StartNew()
  $windowFirstSeen = $null
  $stableWindowHandle = $null
  while ($startupTimer.ElapsedMilliseconds -lt 120000) {
    $script:ownedApp.Refresh()
    if ($script:ownedApp.HasExited) { throw "Installed app exited during startup: exit=$($script:ownedApp.ExitCode)" }
    $shellWindow = [SatrCandidateOwnedShellWindow]::Find([uint32]$script:ownedApp.Id)
    if ($null -ne $shellWindow) {
      # لا تُجمع مدة نافذتين؛ تغيير HWND يبدأ فترة الثبات من جديد.
      if ($stableWindowHandle -ne $shellWindow.Handle) {
        $stableWindowHandle = $shellWindow.Handle
        $windowFirstSeen = $startupTimer.ElapsedMilliseconds
      }
      $report.startup.window_handle = $shellWindow.Handle
      $report.startup.class_name = $shellWindow.ClassName
      $report.startup.title_matches_shell = $shellWindow.TitleMatchesShell
      $report.startup.visible = $shellWindow.Visible
      $report.startup.stable_ms = $startupTimer.ElapsedMilliseconds - $windowFirstSeen
      if ($report.startup.stable_ms -ge 5000) { break }
    } else {
      $windowFirstSeen = $null
      $stableWindowHandle = $null
      $report.startup.window_handle = $null
      $report.startup.class_name = $null
      $report.startup.title_matches_shell = $false
      $report.startup.visible = $null
      $report.startup.stable_ms = 0
    }
    Start-Sleep -Milliseconds 250
  }
  $startupTimer.Stop()
  $report.startup.observed_ms = $startupTimer.ElapsedMilliseconds
  Assert-Check ($null -ne $windowFirstSeen -and $null -ne $report.startup.window_handle -and $report.startup.title_matches_shell -and $report.startup.stable_ms -ge 5000) 'candidate.owned_shell_window' 'Installed app did not keep the same owned shell window for 5000 ms within 120000 ms.'
  $report.startup.proof = 'owned_shell_window_alive_5000ms'
  Write-Host "STARTUP pid=$($report.startup.pid) owned_shell_window=$($report.startup.window_handle) visible=$($report.startup.visible) stable_ms=$($report.startup.stable_ms) dom_checked=false"
  $report.status = 'passed'
  $exitCode = 0
} catch {
  $report.status = 'failed'
  $report.failure = [ordered]@{ stage = $script:stage; message = $_.Exception.Message }
  $asciiError = $_.Exception.Message -replace '[^\x20-\x7E]', '?'
  Write-Host "FAIL stage=$($script:stage) message=$asciiError"
} finally {
  try {
    Stop-OwnedProcess $script:ownedApp
    if ($null -ne $script:installedPath) { Stop-InstalledSatr $script:installedPath }
  } catch {
    $report.cleanup.failure = $_.Exception.Message
    $report.status = 'failed'
    $exitCode = 1
    Write-Host 'FAIL stage=cleanup message=Could not stop an owned installed process.'
  }
  if ($null -ne $script:ownedApp) { $script:ownedApp.Dispose() }
  $report.finished_at = [DateTime]::UtcNow.ToString('o')
  if ($null -ne $reportPath) {
    [IO.File]::WriteAllText($reportPath, ($report | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
  }
  Write-Host "RESULT status=$($report.status) exit=$exitCode dom_checked=false"
}
exit $exitCode
