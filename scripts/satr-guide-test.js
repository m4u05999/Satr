'use strict';

// حارس مهارة satr-guide («معرفة سطر الذاتية» — 2026-07-18): يثبت أن المهارة مكتشفة
// عبر فهرس المهارات الفعلي، وأن قواعد الإجابة (حاجز الهلوسة والإحالة للموارد) قائمة،
// وأن كتالوج الأدوات tools.md **متزامن** مع تعريفات الأدوات الفعلية في الكود —
// أي إضافة/تغيير أداة دون `npm run gen:satr-guide` تُفشل هذا الاختبار (علاج التقادم).
// التشغيل: npm run test:satr-guide (بلا شبكة ولا Electron).

const fs = require('fs');
const path = require('path');
const os = require('os');
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
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-guide-test-'));
  const project = path.join(temp, 'project');
  const home = path.join(temp, 'home');
  const builtinRoot = path.join(root, '.agents', 'skills');
  const packageJson = require('../package.json');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  // 1) الاكتشاف عبر فهرس المهارات الفعلي (skills.js — لا فحص ملفات يدوي)
  const list = await skills.listSkills(root);
  const guide = list.find((s) => s.name === 'satr-guide');
  ok(!!guide, 'فهرس المهارات يكتشف satr-guide');
  ok(/سطر/.test(guide.description) && /كيف|ميزات/.test(guide.description),
    'وصف المهارة يذكر «سطر» والأسئلة الإجرائية (شرط الاستدعاء عند السؤال)');

  let builtinContext;
  try {
    const builtinCatalog = skills.discoverSkills(project, { home, builtinRoot });
    const builtinGuide = builtinCatalog.find((s) => s.name === 'satr-guide');
    ok(!!builtinGuide && builtinGuide.source === 'builtin', 'المشروع الفارغ يكتشف satr-guide من المصدر المضمّن');
    // تُشتقّ من `BUILTIN_SKILLS` لا من نسخة مكرّرة — وهو الدرس نفسه الذي بُني عليه فحص
    // `features.md` أدناه: قائمةٌ ثانية تتباعد بصمت، ثم تُكتشف بالمصادفة.
    const expectedBuiltin = [...skills.BUILTIN_SKILLS].sort().join(',');
    ok(builtinCatalog.map((s) => s.name).join(',') === expectedBuiltin
      && !builtinCatalog.some((s) => s.name === 'tafqeet'),
    'المصدر المضمّن مقصور على مهارات سطر الرسمية (' + skills.BUILTIN_SKILLS.size
      + ') ولا يشحن مثال tafqeet');

    const overrideDir = path.join(project, '.agents', 'skills', 'satr-guide');
    fs.mkdirSync(overrideDir, { recursive: true });
    fs.writeFileSync(path.join(overrideDir, 'SKILL.md'), [
      '---',
      'name: satr-guide',
      'description: تخصيص المشروع يفوز',
      '---',
      'PROJECT_OVERRIDE',
      '',
    ].join('\n'), 'utf8');
    const overridden = skills.discoverSkills(project, { home, builtinRoot }).find((s) => s.name === 'satr-guide');
    ok(overridden && overridden.source === 'project' && overridden.description === 'تخصيص المشروع يفوز',
      'تخصيص المشروع يغلب satr-guide المضمّنة بالاسم نفسه');

    const bundlePattern = '.agents/skills/satr-guide/**/*';
    const divergePattern = '.agents/skills/satr-diverge/**/*';
    ok(packageJson.build.files.includes(bundlePattern) && packageJson.build.files.includes(divergePattern)
      && !packageJson.build.files.some((p) => /tafqeet/.test(p)),
    'build.files يحزم مهارتي سطر الرسميتين دون tafqeet');
    ok(Array.isArray(packageJson.build.asarUnpack) && packageJson.build.asarUnpack.includes(bundlePattern)
      && packageJson.build.asarUnpack.includes(divergePattern),
    'asarUnpack يطابق نمطي المهارتين المضمّنتين');
    const bundledFiles = fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile());
    const bundledBytes = bundledFiles.reduce((total, entry) => total + fs.statSync(path.join(dir, entry.name)).size, 0);
    // السقف حارس ضد التضخم/الثنائي لا ضد نمو النثر مع الميزات — بلغ 32KiB حده عند
    // توثيق «المسار الموجّه» (ب‑3) فرُفع بهامش صغير؛ يبقى هامشياً بمعيار الحزمة.
    //
    // ورُفع ثانيةً 40KiB ⇒ 64KiB بقرار مالك صريح (2026-09-05، ‏`OBS-114`) بعد أن بلغ
    // المتبقي **55 بايتاً**. الحجّة مكتوبة لأن `CLAUDE.md` كان ينصّ «شدّ النثر لا رفع
    // السقف»، والقرار يبطله بالأسباب الأربعة الآتية:
    //   1. حارس التضخم الفعليّ هو `length === 3` و`every('.md')` أدناه — هما ما يمسك
    //      ثنائياً مُقحَماً أو ملفاً رابعاً؛ أما مجموع البايتات فمقياس انضباط لا أمان.
    //   2. **حجم الحزمة ليس كلفة كل دور**: التحميل التدريجي يجعل الفهرس يقرأ رأس
    //      `SKILL.md` وحده (وكتالوج metadata مسقوف بـ16KiB مستقلاً)، و`features.md`
    //      و`tools.md` لا يُقرآن إلا باستدعاء `read_skill_resource`. فالسقف كان يضغط
    //      حيث لا كلفة، ويترك الكلفة الحقيقية بلا حارس محلي — وهو ما يعالجه فحص
    //      `SKILL.md` المضاف بعده.
    //   3. `tools.md` **مولَّد آلياً** وينمو مع كل أداة (‏29 بايتاً لأداة كاملة، مقيس
    //      في `#36`). فسقفٌ يشتعل بنموّه يعاقب إضافة الأدوات — وهي اتجاه المنتج —
    //      ويحيل الثمن إلى نثرٍ بشري لا علاقة له بالنمو (‏`features.md`).
    //   4. كلفة التوزيع: 40KiB داخل مثبّت ‏~80م.ب = 0.05%.
    ok(bundledFiles.length === 3 && bundledFiles.every((entry) => entry.name.endsWith('.md')) && bundledBytes < 64 * 1024,
      'المهارة المضمّنة ثلاثة ملفات Markdown وحجمها هامشي');
    builtinContext = skills.resolveSelection(path.join(temp, 'empty-project'), 'all', { home, builtinRoot });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }

  // 2) SKILL.md: حاجز الهلوسة + الإحالة للموردين + تمييز مساري التنفيذ
  const skillMd = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  ok(/لا أعرف/.test(skillMd) && /لا تخمّن/.test(skillMd), 'SKILL.md يحوي تعليمة مضادة للهلوسة صريحة');
  ok(/features\.md/.test(skillMd) && /tools\.md/.test(skillMd), 'SKILL.md يحيل إلى features.md وtools.md');
  ok(/read_skill_resource/.test(skillMd), 'SKILL.md يوجّه للتحميل التدريجي عبر read_skill_resource');
  ok(Buffer.byteLength(skillMd) <= skills.MAX_SKILL_BYTES, 'SKILL.md ضمن سقف حجم المهارة');
  // نقل الانضباط إلى حيث تقع الكلفة فعلاً (‏`OBS-114`): `MAX_SKILL_BYTES` ‏128KiB سقفُ
  // المُحمِّل لا سقفُ ذوق، و`SKILL.md` هو **الوحيد** الذي يُقرأ كاملاً عند كل
  // `load_skill` — أي كلّما سأل المستخدم عن «سطر». فالسقف المحلي هنا يشتعل حيث يهمّ،
  // بينما سقف الحزمة أعلاه صار يقيس التوزيع وحده.
  ok(Buffer.byteLength(skillMd) <= 4 * 1024, 'SKILL.md ضمن سقف كلفة التحميل المحلي (4KiB)');

  // 3) features.md: دليل مستخدم فعلي، بلا إحالة لوثائق التطوير الداخلية
  const feat = fs.readFileSync(path.join(dir, 'features.md'), 'utf8');
  ok(feat.length > 2000, 'features.md دليل فعلي لا ملف فارغ');
  ok(!/CLAUDE\.md|docs\/PLAN|ROADMAP/.test(feat), 'features.md لا يحيل لوثائق التطوير الداخلية');
  ok(Buffer.byteLength(feat) <= skills.MAX_RESOURCE_BYTES, 'features.md ضمن سقف حجم المورد');

  // 3ب) كل مهارة مضمّنة مذكورة بالاسم في features.md.
  //
  // **لماذا هذا الحارس**: نصف الدليل محروس ونصفه لا. `tools.md` مولَّد ويفشل عند أي
  // انحراف، بينما `features.md` نثرٌ بشري يتقادم **بصمت**. ولا يمكن اشتقاق نثر
  // المستخدم من الكود، لكن **أسماء المهارات المضمّنة** قابلة للاشتقاق — وهي أكثر ما
  // يتغيّر. سقوط `satr-generate` و`satr-design-ar` من الدليل (‏2026-08-27) لم يكشفه
  // شيء حتى سأل المالك؛ هذا يمنع تكراره.
  //
  // **حدّه المُعلَن**: يحرس **الذكر** لا **الدقة** — مهارة مذكورة بوصف متقادم تمرّ.
  // ولا يغطّي بقية الميزات إطلاقاً؛ تلك تبقى على المراجعة البشرية.
  const undocumented = [...skills.BUILTIN_SKILLS]
    .filter((name) => name !== 'satr-guide' && !feat.includes(name));
  ok(undocumented.length === 0,
    'features.md يذكر كل مهارة مضمّنة' + (undocumented.length ? ' — الناقص: ' + undocumented.join(' · ') : ''));

  // 4) tools.md متزامن مع تعريفات الأدوات الفعلية (جوهر الحارس)
  const disk = fs.readFileSync(gen.OUT, 'utf8');
  ok(lf(disk) === lf(gen.buildMarkdown()),
    'tools.md متزامن مع الكود — انحراف يعني أداة تغيّرت: شغّل npm run gen:satr-guide');

  // 5) الكتالوج يشمل أدوات جوهرية من الطقمين (معاينة + محوّلات)
  ['open_preview', 'browser_handoff', 'browser_snapshot', 'search_code', 'verify_project', 'run_command']
    .forEach((n) => ok(disk.includes('`' + n + '`'), 'الكتالوج يشمل ' + n));

  // 6) موردا المهارة قابلان للقراءة عبر عقد read_skill_resource الفعلي (سقوف ومسارات)
  for (const res of ['features.md', 'tools.md']) {
    const r = skills.readResource(builtinContext, 'satr-guide', res);
    ok(r && r.ok && r.content.length > 200, 'readResource يقرأ ' + res + ' ضمن الحدود');
  }

  console.log('\nنجح ' + passed + ' تحقّقاً.');
})().catch((e) => { console.error('فشل:', e.message); process.exit(1); });
