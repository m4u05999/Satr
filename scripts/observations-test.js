#!/usr/bin/env node
/**
 * سطر — حارس سجل الملاحظات المؤجَّلة (`docs/OBSERVATIONS.md`).
 *
 * قاعدة مالك (2026-08-13): الملاحظة أثناء دفعة جارية **تُسجَّل ولا تُنفَّذ**، ثم تُسحب
 * في دفعة يناسبها وسمها. الملف بلا حارس يتعفّن — وهذا درس مثبّت في هذا المشروع:
 * الإرشاد بلا حارس يموت (حدث حرفياً مع التوجيه اللغوي، وهو OBS-001 نفسه).
 *
 * ⚠️ **حدّ هذا الحارس، مُصرَّح به عمداً**: لا يستطيع أن يعرف أن ملاحظةً لوحظت ولم
 * تُسجَّل. هو يحرس **صحة الملف وعدم تعفّنه** لا اكتمال التسجيل. ادّعاء غير ذلك يكون
 * بالضبط «الحارس الأخضر الكاذب» الذي كلّف المشروع عطله الثامن (§5.5.5).
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const FILE = path.resolve(__dirname, '..', 'docs', 'OBSERVATIONS.md');

// قوائم مغلقة: وسمٌ خارجها يعني ملاحظة لا يجدها أحد حين يسحب دفعته
const TAGS = new Set(['mobile', 'ui', 'ops-room', 'engines', 'preview', 'generation',
  'security', 'process', 'docs', 'perf']);
const TYPES = new Set(['تراجع أمني', 'عطل', 'تحسين', 'صقل']);
const STATES = new Set(['مفتوحة', 'منجزة', 'مرفوضة']);

let checks = 0;
const failures = [];

function assert(condition, message) {
  checks += 1;
  if (!condition) failures.push(message);
}

/** يقرأ قيمة حقل من كتلة ملاحظة: `- **الاسم**: القيمة` */
function field(block, name) {
  const match = block.match(new RegExp('^- \\*\\*' + name + '\\*\\*:\\s*(.+)$', 'm'));
  return match ? match[1].trim() : null;
}

function parse(source) {
  // العناوين وحدها تفصل الملاحظات؛ الرأس قبل أول `## OBS-` ليس ملاحظة
  const parts = source.split(/^## (OBS-\d{3})\b/m);
  const entries = [];
  for (let i = 1; i < parts.length; i += 2) {
    entries.push({ id: parts[i], block: parts[i + 1] || '' });
  }
  return entries;
}

function run() {
  assert(fs.existsSync(FILE), 'الملف موجود: docs/OBSERVATIONS.md');
  if (failures.length) return;
  const source = fs.readFileSync(FILE, 'utf8');

  // الرأس يجب أن يشرح القاعدة، وإلا صار الملف قائمة بلا عقد
  assert(/سجّل ولا تنفّذ/.test(source), 'الرأس يذكر القاعدة «سجّل ولا تنفّذ»');
  assert(/CLAUDE\.md/.test(source), 'الرأس يحيل إلى العقد الكامل في CLAUDE.md');
  assert(/لا تُحذف ملاحظة أبداً/.test(source), 'الرأس ينصّ على عدم الحذف');

  const entries = parse(source);
  assert(entries.length > 0, 'الملف يحوي ملاحظة واحدة على الأقل');

  const seen = new Set();
  for (const { id, block } of entries) {
    // التفرّد: معرّفان متطابقان يجعلان الإحالة في رسالة الالتزام غامضة
    assert(!seen.has(id), 'المعرّف فريد: ' + id);
    seen.add(id);

    const tag = field(block, 'الوسم');
    const type = field(block, 'النوع');
    const state = field(block, 'الحالة');
    const evidence = field(block, 'الدليل');

    assert(tag !== null, id + ': حقل الوسم موجود');
    assert(type !== null, id + ': حقل النوع موجود');
    assert(state !== null, id + ': حقل الحالة موجود');

    if (tag !== null) {
      const clean = tag.replace(/[`\s]/g, '');
      assert(TAGS.has(clean), id + ': الوسم من القائمة المغلقة — وجد «' + clean + '»');
    }
    if (type !== null) assert(TYPES.has(type), id + ': النوع معلن — وجد «' + type + '»');
    if (state !== null) {
      const head = state.split(/[\s(—-]/)[0];
      assert(STATES.has(head), id + ': الحالة معلنة — وجد «' + head + '»');

      // منجزة بلا مرجع التزام = ادّعاء إنجاز لا يمكن التحقق منه
      if (head === 'منجزة') {
        assert(/[0-9a-f]{7,40}/.test(state) || /[0-9a-f]{7,40}/.test(block),
          id + ': المنجزة تحمل مرجع التزام');
      }
      // مرفوضة بلا سبب = قرار يُعاد فتحه بعد أشهر بلا ذاكرة
      if (head === 'مرفوضة') {
        assert(state.length > 'مرفوضة'.length + 4 || /السبب/.test(block),
          id + ': المرفوضة تحمل سبباً');
      }
    }

    // الدليل هو ما يفرّق الملاحظة عن الرأي بعد شهر من تسجيلها
    assert(evidence !== null && evidence.length >= 10, id + ': حقل الدليل موجود وغير فارغ');
  }

  // الترقيم المتسلسل يمنع تصادم معرّفين يُكتبان في دفعتين متوازيتين
  const numbers = [...seen].map((id) => Number(id.slice(4))).sort((a, b) => a - b);
  for (let i = 0; i < numbers.length; i += 1) {
    assert(numbers[i] === i + 1, 'الترقيم متسلسل بلا فجوة عند OBS-' + String(i + 1).padStart(3, '0'));
  }
}

run();

if (failures.length) {
  console.error('observations-test: FAIL');
  for (const failure of failures) console.error('  - ' + failure);
  process.exit(1);
}
console.log('observations-test: ok — ' + checks + ' فحصاً (الشكل والأوسمة والأدلة والترقيم).');
