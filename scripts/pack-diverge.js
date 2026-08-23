#!/usr/bin/env node
'use strict';

/**
 * حزمة نقل satr-diverge — تُولَّد ولا تُنسخ يدوياً.
 *
 * الغاية: أخذ المنهج وأداة قياسه إلى أي مشروع آخر (بـ«سطر» أو بـClaude Code وحده)
 * دون أن تتقادم النسخة. أعد تشغيل السكربت بعد أي تعديل على المهارة فتتحدّث الحزمة.
 *
 * التشغيل:
 *   node scripts/pack-diverge.js                 ⇐ الوجهة الافتراضية ../portable-diverge
 *   node scripts/pack-diverge.js <مسار الوجهة>
 */

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const SKILL_SRC = path.join(REPO, '.agents', 'skills', 'satr-diverge');
const TOOL_SRC = path.join(REPO, 'scripts', 'attribution-audit.js');

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) count += copyDir(src, dst);
    else if (entry.isFile()) { fs.copyFileSync(src, dst); count++; }
  }
  return count;
}

const README = `# satr-diverge — حزمة نقل

منهج قرار متباعد + أداة قياس إسناد، جاهزان للنقل إلى أي مشروع.
مولَّدة من مستودع «سطر» بـ\`scripts/pack-diverge.js\` — لا تحرّرها هنا، حرّر المصدر
وأعد التوليد. الترخيص MIT (انظر \`skills/satr-diverge/LICENSE\`).

## التركيب

انسخ مجلد المهارة إلى أحد موضعين:

| الموضع | الأثر |
|---|---|
| \`<مشروعك>/.claude/skills/satr-diverge/\` | لهذا المشروع وحده |
| \`~/.claude/skills/satr-diverge/\` | لكل مشاريعك على الجهاز |

أو استعمل \`install.ps1\` (ويندوز):

\`\`\`powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Project C:\\path\\to\\project
\`\`\`

يقبل المعيار الأحدث \`.agents/skills/\` أيضاً. الأولوية: مشروع ← مستخدم ← مضمّن، فنسختك
في المشروع تغلب أي نسخة أخرى.

**داخل «سطر» لا تحتاج تركيباً** — المهارة مضمّنة في التطبيق ومتاحة في كل مشروع.

## الاستعمال

في المحادثة: «استخدم satr-diverge لهذا القرار» أو «ADHD mode».

المنهج **للقرارات المفتوحة عالية الأثر** ذات عدة حلول معقولة — لا للأسئلة المرجعية
ولا للأخطاء ذات السبب المعروف ولا للطلبات السريعة.

## أداة قياس الإسناد

\`tools/attribution-audit.js\` مستقلة تماماً: بلا اعتماديات، ولا تحتاج المهارة ولا
«سطر». تفحص أن ادعاءات تقرير ما مسنَدة إلى مراجع **تُفتح فعلاً**:

\`\`\`
node tools/attribution-audit.js claims.json
node tools/attribution-audit.js --compare قبل.json بعد.json
\`\`\`

الجذر الافتراضي هو مجلد العمل الحالي؛ غيّره بـ\`--root\`. شكل المدخل موثّق في
\`skills/satr-diverge/references/scoring.md\` تحت «سجل الأدلة».

المقياس الحاسم \`verifiableRate\`: نسبة الوقائع **المؤثرة** المستندة إلى مرجع ملف حيّ.
و\`observed\` لا يُحتسب فيه لأنه غير قابل للتحقق الخارجي.

## ما ثبت وما لم يثبت — اقرأ هذا قبل أن تعتمد المنهج كاملاً

قِيس المنهج على ست مسائل حقيقية (‏13 جولة، محرك Codex، 2026-08-23):

| الجزء | الحالة |
|---|---|
| **تدقيق الأدلة** (المرحلة 4) | ✅ أثر واضح — الإسناد من \`0%\` إلى \`72.7%\` |
| **المواجهة المجهّلة** (المرحلة 6) | ✅ أنتجت تسعة تراجعات حقيقية |
| **إيصالات المصادر** | ✅ رخيصة وتمنع الادعاء بلا مرجع |
| **الفروع المعزولة** (المرحلة 2) | ❌ **لم تثبت** — خفّضت النتيجة \`3.5\` نقطة في أول قياس حقيقي (‏\`n=1\`) |

وحُذّر من عطلين مرصودين: النموذج قد **يدّعي عزلاً لم يقع** ويكتب له عدّاداً كاملاً،
وقد **يطبّق المنهج دون قراءة ملفه**. عولج الاثنان في هذه النسخة بـ«إيصال العزل»
و«خطوة صفر»، فلا تحذفهما.

**أخفّ استعمال يشتري معظم القيمة المقاسة** — بلا مهارة أصلاً:

> «قبل أن تقرّر: افتح الملفات وتحقّق من كل ادّعاء مؤثر، واذكر لكل واحد \`مسار:سطر\`.
> وما لا تستطيع إسناده، سمِّه تخميناً ولا تبنِ عليه.»
`;

const INSTALL = `# تركيب satr-diverge في مشروع
param(
  [Parameter(Mandatory = $true)][string]$Project,
  [ValidateSet('claude', 'agents')][string]$Layout = 'claude',
  [switch]$User
)
$ErrorActionPreference = 'Stop'
$src = Join-Path $PSScriptRoot 'skills\\satr-diverge'
if (-not (Test-Path $src)) { throw "لم يُعثر على مجلد المهارة: $src" }
$root = if ($User) { $HOME } else { $Project }
if (-not (Test-Path $root)) { throw "المسار غير موجود: $root" }
$dir = if ($Layout -eq 'agents') { '.agents\\skills' } else { '.claude\\skills' }
$dest = Join-Path $root (Join-Path $dir 'satr-diverge')
New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
if (Test-Path $dest) {
  Write-Host "موجودة مسبقاً وسيُستبدل محتواها: $dest"
  Remove-Item -Recurse -Force $dest
}
Copy-Item -Recurse -Force $src $dest
Write-Host "تم التركيب: $dest"
Write-Host "الاستعمال: قل في المحادثة «استخدم satr-diverge لهذا القرار»."
`;

function main() {
  const dest = path.resolve(process.argv[2] || path.join(REPO, '..', 'portable-diverge'));
  if (!fs.existsSync(SKILL_SRC)) { console.error('لم يُعثر على المهارة: ' + SKILL_SRC); process.exit(2); }
  if (!fs.existsSync(TOOL_SRC)) { console.error('لم يُعثر على الأداة: ' + TOOL_SRC); process.exit(2); }

  fs.mkdirSync(dest, { recursive: true });
  const skillCount = copyDir(SKILL_SRC, path.join(dest, 'skills', 'satr-diverge'));
  fs.mkdirSync(path.join(dest, 'tools'), { recursive: true });
  fs.copyFileSync(TOOL_SRC, path.join(dest, 'tools', 'attribution-audit.js'));
  fs.writeFileSync(path.join(dest, 'README.md'), README, 'utf8');
  // BOM إلزامي لملف .ps1 فيه عربية: PowerShell 5.1 يقرأ السكربت بلا BOM بترميز ANSI
  // فتتحوّل الحروف إلى بايتات مشوّهة وتكسر الاقتباسات — رُصد حياً عند اختبار الحزمة،
  // وهو الدرس نفسه المثبَّت في executor.ps1.
  fs.writeFileSync(path.join(dest, 'install.ps1'), '﻿' + INSTALL, 'utf8');

  console.log('حزمة النقل جاهزة: ' + dest);
  console.log('  ملفات المهارة: ' + skillCount + ' · الأداة: 1 · README + install.ps1');
}

if (require.main === module) main();
module.exports = { copyDir };
