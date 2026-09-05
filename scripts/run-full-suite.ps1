# مشغّل الطقم الكامل في PowerShell خارجية — قرار مالك عند `OBS-107` (2026-09-05).
#
# العلّة: تشغيل `npm run test:full` من داخل «سطر» أسقط جلسة الوكيل نفسها التي أمرت به —
# الطقم نجح 93/93 وسقطت الجلسة وهي تقرأ خاتمته. القرينتان المقيستان: اختبارات Electron
# حيّة ثقيلة بالتوازي مع نسخة Electron العاملة (‏`test:preview-member-live` وحدها 246ث)،
# وتزاحمٌ مرصود على مجلد كاش GPU بين النسختين.
#
# المكسب الفعليّ لهذا المسار: الطقم في كونسول مستقل، فإن سقطت جلسة الوكيل **يكمل** الطقم
# ويكتب خاتمته — أي أن العطل لم يعد يضرب الخطوة التي تثبت النجاح.
#
# الاستعمال:
#   npm run test:full:external      # في الكونسول الحالي — ورمز الخروج رمز الطقم صادقاً
#   Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass',
#     '-File',"$PWD\scripts\run-full-suite.ps1"   # كونسول مستقل يعيش بعد موت الجلسة
#
# ⚠️ **يبقى هذا الملف UTF-8 بعلامة BOM.** ‏PowerShell 5.1 يقرأ سكربتاً بلا BOM بصفحة ANSI
#    (‏`1252` على جهاز التطوير)، فتتشوّه نصوصه العربية: قِيس حيّاً أن
#    `"نجحت المجموعات كلها"` تُطبع `Ù†Ø¬Ø­Øª Ø§ÙÙ…Ø¬Ù…ÙˆØ¹Ø§Øª`. والحارس الذاتي أدناه يعلن
#    الفقد بدل أن يُشحن سجلّ مشوَّه صامتاً.

# المسارات من موضع السكربت لا مثبَّتة نصّياً: الملف يعيش في `<repo>\scripts\` فيصحّ في أي
# شجرة عمل بلا تحرير — والمنفّذون يعملون في شجرات متوازية أصلاً (‏`OBS-120`: أمرٌ نُفّذ في
# الشجرة الخطأ يبدو ناجحاً تماماً كأمرٍ نُفّذ في الصحيحة).
param(
  [string]$Repo = (Split-Path -Parent $PSScriptRoot),
  [string]$Log  = ''
)

$ErrorActionPreference = 'Continue'
if (-not $Log) { $Log = Join-Path $Repo 'dist\full-suite-external.log' }

# حارس ذاتي لعلامة BOM: إن فُقدت صارت الحروف العربية أعلاه ومعها كل نصّ يطبعه هذا
# السكربت مشوَّهة. الفحص على **طول السلسلة** أولاً لا على `[char]` مباشرةً: بلا BOM يصير
# `'ن'` سلسلتين (‏`Ù†`) فيرمي `[char]` استثناء صبّ غامضاً بدل رسالة تُقرأ — مقيس.
# ورسالة الحارس بالإنجليزية عمداً: هي الحالة الوحيدة التي تكون فيها العربية غير مقروءة.
$bomProbe = 'ن'
if ($bomProbe.Length -ne 1 -or [int]$bomProbe[0] -ne 0x0646) {
  Write-Warning 'run-full-suite.ps1: BOM lost - Arabic literals are mojibake. Re-save this file as UTF-8 WITH BOM.'
}

# ── الترميز: علّتان متتاليتان، كلتاهما مقيسة على سجلّ حقيقي ──────────────────────
# ① **فكّ الترميز**: خرج npm بايتاتٌ UTF-8، وPowerShell يفكّها بترميز الكونسول. وكونسول
#    `Start-Process` **جديد** يرث صفحة النظام الافتراضية لا صفحة الكونسول الذي أطلقه؛
#    فسجلّ 2026-09-05 يحمل حرفياً `┘å╪¼╪¡╪¬ ╪º┘ä┘à╪¼┘à┘ê╪╣╪º╪¬ ┘â┘ä┘ç╪º ΓÇö 94/94` بدل
#    «نجحت المجموعات كلها — 94/94» — وهو UTF-8 مقروء بـCP437 (‏`0xD9`→`┘`، `0x86`→`å`).
#    الضبط أدناه يجعل الفكّ UTF-8 مهما كان الكونسول الذي وُلد فيه السكربت.
# ② **التشفير**: `Tee-Object` في PowerShell 5.1 **لا يقبل `-Encoding`** ويكتب UTF-16LE
#    دائماً، فيلزم كلَّ قارئ أن يعرف ذلك مسبقاً (‏`iconv -f UTF-16LE`). فاستُبدل
#    بـ`StreamWriter` بـUTF-8 بلا BOM: السجلّ يُقرأ بـ`cat` و`Get-Content` وأي أداة
#    بلا وسيط ولا معرفة سابقة.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
try {
  [Console]::OutputEncoding = $utf8NoBom
  $OutputEncoding = $utf8NoBom
} catch {
  # عملية بلا كونسول مرفق: الضبط يرمي. لا يُسقط التشغيل — لكن يُعلَن، فالتشويه الصامت
  # هو بالضبط ما تعالجه هذه الدفعة.
  Write-Warning "run-full-suite.ps1: تعذّر ضبط ترميز الكونسول إلى UTF-8 ($($_.Exception.Message)) — قد يظهر النثر العربي مشوَّهاً في السجلّ."
}

$logDir = Split-Path -Parent $Log
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
if (Test-Path $Log) { Remove-Item -Force $Log }

# ⚠️ خطأ ترتيب وقع فعلاً: مُعايِنٌ بدأ **قبل** المشغّل فرأى `.done` من تشغيل سابق وخرج
#    فوراً، قارئاً خاتمةً بائتة على أنها خاتمة هذا التشغيل. فتُمسح العلامة أوّلَ شيء:
#    غيابها يعني «يعمل»، ووجودها يعني «بلغ نهايته فعلاً».
$doneMark = $Log + '.done'
if (Test-Path $doneMark) { Remove-Item -Force $doneMark }

$writer = New-Object System.IO.StreamWriter($Log, $false, $utf8NoBom)
$writer.AutoFlush = $true
function Emit([string]$line) {
  Write-Host $line
  $writer.WriteLine($line)
}

Set-Location $Repo
$head    = (& git rev-parse --short HEAD)
$branch  = (& git rev-parse --abbrev-ref HEAD)
$started = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'

Emit '=== SATR FULL SUITE (external console) ==='
Emit "repo=$Repo"
Emit "branch=$branch"
Emit "head=$head"
Emit "started=$started"
Emit '========================================='

# رمز خروج npm يُقرأ من `$LASTEXITCODE` بعد الأنبوب — لا من `$?`: على ويندوز يضبط
# `2>&1` على أمرٍ أصليّ العلمَ `$?` إلى false حتى مع رمز خروج 0 (‏`NativeCommandError`).
& npm run test:full 2>&1 | ForEach-Object { Emit ([string]$_) }
$code = $LASTEXITCODE
if ($null -eq $code) { $code = 1 }

$ended = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
Emit ''
Emit "=== SUITE_EXIT=$code ==="
Emit "ended=$ended"
$writer.Close()

# العلامة ASCII عمداً: رقمٌ يُقرأ بأي أداة بلا سؤال ترميز، ومحتواها رمز الخروج نفسه.
"$code" | Out-File -FilePath $doneMark -Encoding ascii

exit $code
