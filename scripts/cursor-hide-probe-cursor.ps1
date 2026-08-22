# محرّك المؤشر لمسبار إخفاء المؤشر — يتحرك عبر SetCursorPos في user32.dll
# التشغيل: powershell -NoProfile -File scripts/cursor-hide-probe-cursor.ps1
# البروتوكول: كل سطر يحتوي "x y" يحرّك المؤشر، أو "exit" للإنهاء.

Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);' -Name Cursor -Namespace WinAPI

$inputStream = [Console]::In
while ($true) {
  $line = $inputStream.ReadLine()
  if ($line -eq 'exit') { break }
  $parts = $line -split '\s+'
  if ($parts.Length -ge 2) {
    [void][WinAPI.Cursor]::SetCursorPos([int]$parts[0], [int]$parts[1])
  }
}
