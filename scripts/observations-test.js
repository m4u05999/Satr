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
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const FILE = path.join(REPO_ROOT, 'docs', 'OBSERVATIONS.md');

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

// ── مرجع الالتزام: من «أي hex» إلى «التزام موجود فعلاً» ──────────────────────
// الشرط القديم قبل **أي** `[0-9a-f]{7,40}` في الكتلة، فسلسلةٌ عابرة تمرّ كأنها
// مرجع. مقيس على `main` (2026-09-04): من 63 منجزة كانت 10 بلا أي hex يطابق
// التزاماً — أوضحها `OBS-060` ومرشّحها الوحيد `ec550b65` وهو **معرّف ملف جلسة**،
// وخمسٌ (‏OBS-028/029/030/032/033) مرّت بمعرّف الجلسة `7ad95229` الوارد في حقل
// دليلها بينما حالتها بلا مرجع أصلاً. الشرط لم يتغيّر — تغيّرت دقّته.
const COMMIT_TOKEN = /[0-9a-f]{7,40}/g;

// الباب المعلن — المرجع الخارجي المشروع.
//
// بعض العلاجات تقع خارج Git هذا المستودع فعلاً: `satr-enterprise` مستودع خاص
// (‏CLAUDE.md: «لا يدخل Git العام»)، و`executor.ps1` ليس في Git أصلاً. حارسٌ
// يرفضها **يكسر السجل بدل أن يحرسه**. فالباب يقبلها بشرط أن تكون الملاحظة قد
// **صرّحت بالسبب في نصّها** — لا قائمة أسماء مدفونة هنا، وإلا انتقل العرف من
// الملاحظة إلى السكربت فلا يقرؤه كاتب الملاحظة القادم.
//
// الشكلان المعلنان (كلاهما مكتوب داخل الملاحظة):
//   `<hex>` في `<مستودع>`  ← التزام في مستودع آخر مسمّى
//   `sha256:<hex>`          ← بصمة نسخة، مصرَّح بأنها ليست رقم التزام
//
// ⚠️ حدّ مُصرَّح به: الباب يتحقق من **وجود التصريح** لا من الكائن الخارجي نفسه —
// لا وصول لهذا الحارس إلى `satr-enterprise`.
const EXTERNAL_REPO = /`[0-9a-f]{7,40}`\s*في\s*`[^`\n]+`/;
const EXTERNAL_DIGEST = /sha256:[0-9a-f]{7,64}/;

/**
 * تدهور رشيق: بيئةٌ بلا git — أو **نسخة سطحية** — لا تُسقط الطقم.
 *
 * ⚠️ هذا ليس احتياطاً نظرياً: `.github/workflows/release.yml` يشغّل `test:full`
 * بـ`actions/checkout@v6` بلا `fetch-depth`، أي نسخة سطحية بالتزام واحد؛ فبلا هذا
 * الفحص كان الحارس سيصبغ بوابة الإصدار حمراء على 53 ملاحظة سليمة.
 */
function gitProbe() {
  try {
    const out = execFileSync('git', ['rev-parse', '--is-shallow-repository'], {
      cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 20000, windowsHide: true,
    }).trim();
    if (out === 'true') return { ok: false, why: 'المستودع نسخة سطحية (shallow) فلا تاريخ يُطابَق' };
    return { ok: true, why: '' };
  } catch {
    return { ok: false, why: 'git غير متاح أو المسار ليس مستودعاً' };
  }
}

/** يحلّ كل المرشّحات في نداء git واحد — مرة لكل مرجع فريد لا لكل ملاحظة. */
function resolveCommits(refs) {
  const resolved = new Set();
  if (!refs.length) return resolved;
  let out;
  try {
    out = execFileSync('git', ['cat-file', '--batch-check'], {
      cwd: REPO_ROOT, input: refs.map((r) => r + '^{commit}').join('\n') + '\n',
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 20000, windowsHide: true,
    });
  } catch {
    return null; // فشل النداء نفسه ⇒ تدهور رشيق لا حكم كاذب
  }
  // `--batch-check` يطبع سطراً لكل مدخل بالترتيب: `<sha> commit <size>` أو `<input> missing`
  const lines = out.split('\n');
  for (let i = 0; i < refs.length; i += 1) {
    const parts = (lines[i] || '').trim().split(/\s+/);
    if (parts[1] === 'commit') resolved.add(refs[i]); // إيجابي صريح: أي شكل آخر يفشل مغلقاً
  }
  return resolved;
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

  // مرور تمهيدي: كل مرشّح فريد في الملف يُحلّ مرة واحدة قبل حلقة الفحص
  const probe = gitProbe();
  const candidates = [...new Set(entries.flatMap(({ block }) => block.match(COMMIT_TOKEN) || []))];
  const resolved = probe.ok ? resolveCommits(candidates) : null;
  if (resolved === null) {
    console.log('observations-test: تنبيه — تعذّر التحقق من مراجع الالتزام ('
      + (probe.why || 'فشل نداء git') + ')؛ الفحص يسقط إلى الشرط الشكلي وحده.');
  }

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
        const found = [...new Set(block.match(COMMIT_TOKEN) || [])];
        const ok = resolved === null
          ? found.length > 0 // تدهور رشيق: الشرط الشكلي القديم حرفياً
          : found.some((ref) => resolved.has(ref))
            || EXTERNAL_REPO.test(block) || EXTERNAL_DIGEST.test(block);
        assert(ok, id + ': المنجزة تحمل مرجع التزام'
          + (resolved === null ? '' : ' يطابق كائناً في Git — '
            + (found.length ? 'مرشّحات لا تطابق التزاماً: ' + found.join('، ')
              : 'لا مرشّح hex أصلاً')
            + ' (والباب المعلن للمرجع الخارجي غير مستعمل)'));
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
console.log('observations-test: ok — ' + checks
  + ' فحصاً (الشكل والأوسمة والأدلة والترقيم ومراجع الالتزام).');
