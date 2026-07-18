'use strict';

// حارس مهارة satr-guide («معرفة سطر الذاتية» — 2026-07-18): يثبت أن المهارة مكتشفة
// عبر فهرس المهارات الفعلي، وأن قواعد الإجابة (حاجز الهلوسة والإحالة للموارد) قائمة،
// وأن كتالوج الأدوات tools.md **متزامن** مع تعريفات الأدوات الفعلية في الكود —
// أي إضافة/تغيير أداة دون `npm run gen:satr-guide` تُفشل هذا الاختبار (علاج التقادم).
// التشغيل: npm run test:satr-guide (بلا شبكة ولا Electron).

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const gen = require('./gen-satr-guide');
const skills = require('../electron/skills');

let passed = 0;
function ok(cond, name) { assert.ok(cond, name); passed++; console.log('✓ ' + name); }
// git على ويندوز قد يسحب الملف CRLF — التطبيع قبل المقارنة (درس update-csp المثبّت)
const lf = (s) => String(s).replace(/\r\n/g, '\n');

(async () => {
  const root = path.join(__dirname, '..');
  const dir = path.join(root, '.agents', 'skills', 'satr-guide');

  // 1) الاكتشاف عبر فهرس المهارات الفعلي (skills.js — لا فحص ملفات يدوي)
  const list = await skills.listSkills(root);
  const guide = list.find((s) => s.name === 'satr-guide');
  ok(!!guide, 'فهرس المهارات يكتشف satr-guide');
  ok(/سطر/.test(guide.description) && /كيف|ميزات/.test(guide.description),
    'وصف المهارة يذكر «سطر» والأسئلة الإجرائية (شرط الاستدعاء عند السؤال)');

  // 2) SKILL.md: حاجز الهلوسة + الإحالة للموردين + تمييز مساري التنفيذ
  const skillMd = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  ok(/لا أعرف/.test(skillMd) && /لا تخمّن/.test(skillMd), 'SKILL.md يحوي تعليمة مضادة للهلوسة صريحة');
  ok(/features\.md/.test(skillMd) && /tools\.md/.test(skillMd), 'SKILL.md يحيل إلى features.md وtools.md');
  ok(/read_skill_resource/.test(skillMd), 'SKILL.md يوجّه للتحميل التدريجي عبر read_skill_resource');
  ok(Buffer.byteLength(skillMd) <= skills.MAX_SKILL_BYTES, 'SKILL.md ضمن سقف حجم المهارة');

  // 3) features.md: دليل مستخدم فعلي، بلا إحالة لوثائق التطوير الداخلية
  const feat = fs.readFileSync(path.join(dir, 'features.md'), 'utf8');
  ok(feat.length > 2000, 'features.md دليل فعلي لا ملف فارغ');
  ok(!/CLAUDE\.md|docs\/PLAN|ROADMAP/.test(feat), 'features.md لا يحيل لوثائق التطوير الداخلية');
  ok(Buffer.byteLength(feat) <= skills.MAX_RESOURCE_BYTES, 'features.md ضمن سقف حجم المورد');

  // 4) tools.md متزامن مع تعريفات الأدوات الفعلية (جوهر الحارس)
  const disk = fs.readFileSync(gen.OUT, 'utf8');
  ok(lf(disk) === lf(gen.buildMarkdown()),
    'tools.md متزامن مع الكود — انحراف يعني أداة تغيّرت: شغّل npm run gen:satr-guide');

  // 5) الكتالوج يشمل أدوات جوهرية من الطقمين (معاينة + محوّلات)
  ['open_preview', 'browser_handoff', 'browser_snapshot', 'search_code', 'verify_project', 'run_command']
    .forEach((n) => ok(disk.includes('`' + n + '`'), 'الكتالوج يشمل ' + n));

  // 6) موردا المهارة قابلان للقراءة عبر عقد read_skill_resource الفعلي (سقوف ومسارات)
  const ctx = skills.resolveSelection(root, 'all');
  for (const res of ['features.md', 'tools.md']) {
    const r = skills.readResource(ctx, 'satr-guide', res);
    ok(r && r.ok && r.content.length > 200, 'readResource يقرأ ' + res + ' ضمن الحدود');
  }

  console.log('\nنجح ' + passed + ' تحقّقاً.');
})().catch((e) => { console.error('فشل:', e.message); process.exit(1); });
