#!/usr/bin/env node
'use strict';

// مولّد كتالوج أدوات «سطر» لمهارة satr-guide (قرار «معرفة سطر الذاتية» — 2026-07-18).
// مصدر الحقيقة هو **تعريفات الأدوات الفعلية في الكود** لا نص يدوي يتقادم:
//  - codexmcp.buildTools(): طقم المعاينة/المتصفح الكامل (نفس مفردات أدوات محرك SDK).
//  - tools.defs(): أدوات حلقة الوكيل للمحوّلات (قراءة/كتابة/بحث/تحقق/ذاكرة/مهارات).
// التشغيل: npm run gen:satr-guide — يكتب .agents/skills/satr-guide/tools.md.
// الحارس: npm run test:satr-guide يقارن الملف بالمولَّد ويفشل عند أي انحراف،
// فإضافة/تغيير أداة دون إعادة التوليد تكسر الطقم (علاج التقادم آلياً لا بشرياً).

const fs = require('fs');
const path = require('path');
const codexmcp = require('../electron/codexmcp');
const adapterTools = require('../electron/tools');

function line(name, desc) {
  const d = String(desc || '').replace(/\s+/g, ' ').trim();
  return '- **`' + name + '`** — ' + d;
}

function buildMarkdown() {
  // deps وهمية تكفي لبناء القائمة — الأوصاف ثابتة والمعالجات لا تُستدعى هنا
  const preview = codexmcp.buildTools({ preview: {} })
    .map((t) => line(t.name, t.description));
  const adapters = adapterTools.defs()
    .map((d) => (d && d.function) ? d.function : d)
    .filter((f) => f && f.name)
    .map((f) => line(f.name, f.description));
  return [
    '# كتالوج أدوات «سطر» (مولّد آلياً)',
    '',
    '> يولّده `npm run gen:satr-guide` من تعريفات الأدوات الفعلية في الكود — **لا',
    '> تحرّره يدوياً**؛ حارس `npm run test:satr-guide` يفشل عند أي انحراف عنها.',
    '',
    '## أدوات المعاينة والمتصفح المدمج',
    '',
    'متاحة لمحركي Claude وCodex (نفس المفردات). الأفعال المؤثرة تمرّ بمربع الإذن',
    'العربي. مع «وضع تحكم المتصفح» 🖱️ تبقى القراءة حرة، أما الفعل/التنقّل على نطاق',
    'خارجي جديد فيطلب ثقة المستخدم به مرة لهذه الجلسة؛ localhost موثوق دائماً.',
    'الحفظ والنشر والإرسال والحذف والتفويض وbrowser_evaluate تُؤكّد كل مرة حتى على نطاق موثوق.',
    'الأسرار لا تمر كنص: استخدم browser_transfer_field بين الحقول أو browser_request_secret لإدخال المستخدم.',
    '',
    ...preview,
    '',
    '## أدوات حلقة الوكيل للمحوّلات (DeepSeek/Gemini/Qwen/MiniMax…)',
    '',
    'محرك Claude يملك مقابلاتها الأصلية (Read/Grep/Edit/Bash…) مع run_in_terminal',
    'للتنفيذ في الطرفية المرئية؛ الكتابة والتنفيذ خلف مربع الإذن دائماً.',
    '',
    ...adapters,
    '',
  ].join('\n') + '\n';
}

const OUT = path.join(__dirname, '..', '.agents', 'skills', 'satr-guide', 'tools.md');

if (require.main === module) {
  fs.writeFileSync(OUT, buildMarkdown(), 'utf8');
  console.log('كُتب كتالوج الأدوات: ' + OUT);
}

module.exports = { buildMarkdown, OUT };
