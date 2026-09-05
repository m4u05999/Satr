#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const skills = require('../electron/skills');
const tools = require('../electron/tools');
const ROOT = path.resolve(__dirname, '..');

async function runLiveProbe(engineName, project) {
  const marker = 'SATR_SKILL_LIVE_OK_7F3A';
  await write(project, '.agents/skills/satr-live-probe/SKILL.md', [
    '---',
    'name: satr-live-probe',
    'description: مهارة اختبار حي لعقد التحميل المحمول',
    '---',
    'عند استدعاء هذه المهارة أجب في الإجابة النهائية بالرمز التالي فقط:',
    marker,
    '',
  ].join('\n'));
  const engine = engineName === 'codex' ? require('../electron/codex') : require('../electron/agent');
  const texts = [];
  const diagnostics = [];
  let result = null;
  let handle = null;
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const timer = setTimeout(() => {
    if (handle && handle.stop) handle.stop().catch(() => {});
    finish();
  }, 180000);
  handle = await engine.start({
    prompt: 'استخدم مهارة satr-live-probe ونفّذ تعليماتها بدقة.',
    images: [],
    sessionId: null,
    model: engineName === 'codex' ? (process.env.SATR_EVAL_CODEX_MODEL || 'gpt-5.6-sol') : null,
    permissionMode: 'plan',
    skills: ['satr-live-probe'],
    effort: 'low',
    extraDirs: [],
    browserControl: false,
  }, project, (event) => {
    if (event.type === 'stream_text' && event.phase !== 'commentary') texts.push(event.text || '');
    if (event.type === 'assistant' && event.message && Array.isArray(event.message.content)) {
      for (const block of event.message.content) if (block.type === 'text' && block.phase !== 'commentary') texts.push(block.text || '');
    }
    if (event.type === 'permission_request' && handle && handle.resolvePermission) {
      handle.resolvePermission(event.id, false, false);
    }
    if (event.type === 'result') result = event;
    if (event.type === 'spawn_error' || event.type === 'stderr') diagnostics.push(String(event.text || '').slice(0, 1000));
    if (event.type === 'proc_done') finish();
  });
  await done;
  clearTimeout(timer);
  assert(result && !result.is_error, 'فشل الدور الحي لمحرك ' + engineName + ': ' + diagnostics.join(' | ') + ' text=' + texts.join(' | ').slice(0, 2000) + ' result=' + JSON.stringify(result));
  assert(texts.join('\n').includes(marker), 'لم يطبق ' + engineName + ' المهارة المحمولة');
  console.log('✓ live ' + engineName + ' portable skill');
}

async function write(root, relative, content) {
  const file = path.join(root, ...relative.split('/'));
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, content, 'utf8');
}

// satr-accept: بروتوكول القبول البشري. الحارس يمنع سقوطها من BUILTIN_SKILLS أو من
// قائمتَي الحزمة (وحينها لا تصل المستخدمين بصمت)، ويثبت أن قواعدها الملزمة ما زالت
// في النص — لأن حذف «هو ينقر لا أنت» أو حدود «متى لا تُستعمل» يحوّلها إلى طقس.
async function assertSatrAccept(discoveryOptions) {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert(manifest.build.files.includes('.agents/skills/satr-accept/**/*'),
    'satr-accept خارج build.files — لن تصل الحزمة');
  assert(manifest.build.asarUnpack.includes('.agents/skills/satr-accept/**/*'),
    'satr-accept خارج asarUnpack — حصر الموارد يعتمد realpathSync');

  const catalog = skills.discoverSkills(ROOT, discoveryOptions);
  const skill = catalog.find((item) => item.name === 'satr-accept');
  assert(skill, 'مهارة satr-accept المضمّنة غير مكتشفة');
  assert.strictEqual(skill.source, 'project');
  assert.strictEqual(skill.format, 'standard');
  // الوصف هو ما يقرّر متى تُحمَّل — يجب أن يحمل المُشغّل والحدّ معاً
  assert(skill.description.includes('صواب/فشل'), 'الوصف بلا معيار القبول');
  assert(skill.description.includes('لا تستعملها'), 'الوصف بلا حدّ الاستعمال');
  // الترس الأوسط عديم الفائدة إن لم يذكره الوصف: هو ما يقرّر التحميل، وحدّ «دفعة من
  // سطرين» كان سيصرف الوكيل عن التحميل في الحالة نفسها التي يخدمها الترس (OBS-055).
  assert(skill.description.includes('فحص مصغّر'), 'الوصف بلا الترس الأوسط — لن يُحمَّل حيث يلزم');

  const selected = skills.resolveSelection(ROOT, ['satr-accept'], discoveryOptions);
  const loaded = skills.loadSkill(selected, 'satr-accept');
  assert.strictEqual(loaded.ok, true);
  assert(loaded.instructions.includes('## قواعد ملزمة'));
  assert(loaded.instructions.includes('## متى **لا** تُستعمل'));
  assert(loaded.instructions.includes('**هو ينقر، لا أنت.**'), 'سقطت قاعدة «هو ينقر لا أنت»');
  assert(loaded.instructions.includes('خطوة واحدة حاسمة'), 'سقطت قاعدة حسم التعارض');
  assert(loaded.instructions.includes('نظّف بعدها'));
  // الترس الأوسط (OBS-055): شروطه الثلاثة هي ما يمنعه من الانفلات إلى بديل رخيص عن
  // البروتوكول. سقوط الشرط «بلا بناء» أو تبعية «هو ينقر» يحوّله إلى إذنٍ بالاستنتاج.
  assert(loaded.instructions.includes('## الترس الأوسط — فحص مصغّر'), 'سقط الترس الأوسط');
  assert(loaded.instructions.includes('الادعاء المتبقي واحد'), 'الفحص المصغّر بلا شرط الادعاء المفرد');
  assert(loaded.instructions.includes('بلا بناء'), 'الفحص المصغّر بلا شرط «نسخة عاملة بلا بناء»');
  assert(loaded.instructions.includes('**هو ينقر لا أنت**'), 'الفحص المصغّر لا يعيد تثبيت قاعدة النقر');
  const resources = loaded.resources.map((item) => item.path);
  assert(resources.includes('example.md'), 'المثال الحيّ غير مُدرَج ضمن الموارد');

  const example = skills.readResource(selected, 'satr-accept', 'example.md');
  assert.strictEqual(example.ok, true);
  assert(example.content.includes('ERR_STREAM_WRITE_AFTER_END'), 'المثال بلا العطل المكتشَف');
  assert(example.content.includes('أخطاء ارتكبتُها'), 'المثال يعرض النتائج بلا أخطاء المنفّذ');

  const toolLoaded = await tools.run('load_skill', ROOT, { name: 'satr-accept' }, { skillContext: selected });
  assert.strictEqual(toolLoaded.ok, true);
  assert(toolLoaded.content.includes('## قواعد ملزمة'));
}

// satr-design-ar: خبرة واجهات الحرف العربي محمولةً إلى مشاريع المستخدمين.
//
// **الحارس الجوهري هنا هو المحمولية** (‏OBS-060): المهارة تعمل داخل مشروع المستخدم حيث
// لا وجود لـ`docs/` ولا `electron/` ولا `npm run test:*` الخاصة بنا. الإحالة إلى مسار
// غائب أسوأ من السكوت — كلّفت جلسةً 1014 ثانية و‏$13.77 حين بحث الوكيل عن ملف لا وجود
// له ثم ارتجل. فأي تسريب مسار من مستودعنا إلى نصّ المهارة أو مواردها يفشل هنا.
const REPO_LEAKS = Object.freeze([
  [/\bdocs\/[A-Za-z0-9_.-]+/, 'مسار docs/ من مستودعنا'],
  [/\belectron\/[A-Za-z0-9_.-]+/, 'مسار electron/ من مستودعنا'],
  [/\bscripts\/[A-Za-z0-9_.-]+/, 'مسار scripts/ من مستودعنا'],
  [/\bsrc\/ui\/[A-Za-z0-9_./-]+/, 'مسار src/ui/ من مستودعنا'],
  [/\bOBS-\d+/, 'معرّف ملاحظة داخلية'],
  [/\bCLAUDE\.md\b/, 'CLAUDE.md'],
  [/\bAGENTS\.md\b/, 'AGENTS.md'],
  [/npm run (?:test|gen):[A-Za-z-]+/, 'سكربت npm خاص بمستودعنا'],
]);

async function assertSatrDesignAr(discoveryOptions) {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert(manifest.build.files.includes('.agents/skills/satr-design-ar/**/*'),
    'satr-design-ar خارج build.files — لن تصل الحزمة');
  assert(manifest.build.asarUnpack.includes('.agents/skills/satr-design-ar/**/*'),
    'satr-design-ar خارج asarUnpack — حصر الموارد يعتمد realpathSync');

  const catalog = skills.discoverSkills(ROOT, discoveryOptions);
  const skill = catalog.find((item) => item.name === 'satr-design-ar');
  assert(skill, 'مهارة satr-design-ar المضمّنة غير مكتشفة');
  assert.strictEqual(skill.format, 'standard');
  // الوصف وحده ما يقرّر التحميل: يجب أن يحمل المُشغّل والأداة والحدّ معاً
  assert(skill.description.includes('browser_readability'), 'الوصف بلا أداة القياس');
  assert(skill.description.includes('لا تستعملها'), 'الوصف بلا حدّ الاستعمال');

  const selected = skills.resolveSelection(ROOT, ['satr-design-ar'], discoveryOptions);
  const loaded = skills.loadSkill(selected, 'satr-design-ar');
  assert.strictEqual(loaded.ok, true);
  assert(loaded.instructions.includes('## متى **لا** تُستعمل'), 'سقطت حدود الاستعمال');
  // الفحص الجوهري: العطل الذي لا تكشفه الخاصية المحسوبة. سقوطه يفرّغ المهارة.
  assert(loaded.instructions.includes('getComputedStyle'),
    'سقط تحذير الخاصية المحسوبة — وهو العطل المركزي');
  assert(/ar\s*\*\s*2\s*>=\s*lat/.test(loaded.instructions),
    'سقطت دالة الحسم الإحصائي — بدونها تعود التوصية إلى plaintext');
  assert(loaded.instructions.includes('unicode-bidi: plaintext'),
    'المهارة لا تسمّي الفخّ الذي تعالجه');
  // «صفر مخالفات» بلا تصريح بما لم يُفحص ادّعاءٌ ضمني بالشمول
  assert(loaded.instructions.includes('unseen'), 'سقطت قاعدة التصريح بما لم يُفحص');

  const resources = loaded.resources.map((item) => item.path);
  for (const name of ['direction.md', 'fonts.md', 'locales.md', 'checklist.md']) {
    assert(resources.includes(name), 'المورد ' + name + ' غير مُدرَج');
  }
  // التحميل التدريجي: الموارد لا تُحشر في SKILL.md وإلا استُهلك سياق كل دور
  assert(loaded.instructions.length < 12000,
    'SKILL.md انتفخ (' + loaded.instructions.length + ' محرفاً) — انقل التفصيل إلى مورد');

  // المحمولية — على النصّ وكل مورد
  const texts = [['SKILL.md', loaded.instructions]];
  for (const name of resources) {
    const resource = skills.readResource(selected, 'satr-design-ar', name);
    assert.strictEqual(resource.ok, true, 'تعذّرت قراءة المورد ' + name);
    texts.push([name, resource.content]);
  }
  for (const [name, text] of texts) {
    for (const [pattern, label] of REPO_LEAKS) {
      const hit = text.match(pattern);
      assert(!hit, 'تسريب مسار مستودعنا في ' + name + ' (' + label + '): ' + (hit && hit[0])
        + ' — المهارة تعمل في مشروع المستخدم حيث لا وجود له');
    }
  }

  const toolLoaded = await tools.run('load_skill', ROOT, { name: 'satr-design-ar' }, { skillContext: selected });
  assert.strictEqual(toolLoaded.ok, true);
  assert(toolLoaded.content.includes('## متى **لا** تُستعمل'));
}

async function assertSatrDiverge(discoveryOptions) {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert(manifest.build.files.includes('.agents/skills/satr-diverge/**/*'));
  assert(manifest.build.asarUnpack.includes('.agents/skills/satr-diverge/**/*'));

  const catalog = skills.discoverSkills(ROOT, discoveryOptions);
  const skill = catalog.find((item) => item.name === 'satr-diverge');
  assert(skill, 'مهارة satr-diverge المضمّنة غير مكتشفة');
  assert.strictEqual(skill.source, 'project');
  assert.strictEqual(skill.format, 'standard');
  assert(skill.description.includes('فروعاً معزولة'));

  const selected = skills.resolveSelection(ROOT, ['satr-diverge'], discoveryOptions);
  const loaded = skills.loadSkill(selected, 'satr-diverge');
  assert.strictEqual(loaded.ok, true);
  assert(loaded.instructions.includes('## المراحل السبع'));
  assert(loaded.instructions.includes('## شرط العزل'));
  assert(loaded.instructions.includes('## حاجز اكتمال المجموعات'));
  assert(loaded.instructions.includes('لا تُنهِ دور الجذر'));
  assert(loaded.instructions.includes('launched/completed/failed/missing'));
  const resources = loaded.resources.map((item) => item.path);
  assert(resources.includes('LICENSE'));
  assert(resources.includes('agents/openai.yaml'));
  assert(resources.includes('references/engine-adapters.md'));
  assert(resources.includes('references/evaluation.md'));
  assert(resources.includes('references/frames.md'));
  assert(resources.includes('references/scoring.md'));
  assert(resources.includes('references/upstream.md'));
  assert(!resources.some((item) => item.startsWith('scripts/')));

  const adapter = skills.readResource(selected, 'satr-diverge', 'references/engine-adapters.md');
  assert.strictEqual(adapter.ok, true);
  assert(adapter.content.includes('## Claude Code'));
  assert(adapter.content.includes('## Codex'));
  assert(adapter.content.includes('## Kimi Code عبر ACP'));
  assert(adapter.content.includes('استدعاء واحد لـ `wait_agent` **ليس حاجزاً**'));
  assert(adapter.content.includes('`diverge_f1` و`diverge_f2` و`diverge_f3`'));
  assert(adapter.content.includes('لا تُنهِ دور الجذر ولا تعرض خرج طفل واحد'));
  assert(adapter.content.includes('بقاء `/root` وحده قبل استلام خرج فرع يعني `missing`'));

  // تعدد المحركات (‏OBS-060، بدليل جلسة `ec550b65`): كان المورد يحيل المحركات المختلفة
  // إلى غرفة العمليات **وهي سطح واجهة بلا أداة وكيل**، ويحرّم الصدفة تحريماً مطلقاً —
  // بينما `envbrief` المحقون كل دور يجيز «تشغيل محرّك آخر من الطرفية». فبقي الوكيل بلا
  // مسار شرعي: 19 محاولة إطلاق يدوية · 1110ث · ‏$14.61 ثم استسلم. هذه الفحوص تمنع عودة
  // أيٍّ من الثلاثة: إعلان حدّ الغرفة، والوصفة المثبَّتة، وسقف المحاولات.
  assert(adapter.content.includes('سطح واجهة لا أداة وكيل'),
    'المورد لا يعلن أن غرفة العمليات ليست أداة وكيل — يعود الوكيل يبحث عن بديل');
  assert(adapter.content.includes('## تعدد المحركات'), 'سقط قسم تعدد المحركات');
  assert(/codex exec[^\n]*--dangerously-bypass-approvals-and-sandbox\s+-/.test(adapter.content),
    'الوصفة بلا العلم الصحيح أو بلا علامة stdin `-` — وهما سببا الفشل المرصود');
  assert(adapter.content.includes('OutputEncoding') && adapter.content.includes('ASCII'),
    'الوصفة لا تحذّر من ترميز PS 5.1 الافتراضي — العربية تصل ???');
  assert(adapter.content.includes("EAP='Continue'") || adapter.content.includes("'Continue'"),
    'الوصفة لا تذكر EAP=Continue — stderr يقتل السكربت');
  assert(adapter.content.includes('محاولتين'), 'الوصفة بلا سقف محاولات — يدخل الوكيل حلقة');
  // الافتراضي نفسه (بلاغ مالك 2026-08-27، جلسة `01a0444f`): أول صياغة قالت «فإن كان
  // هذا مسارك الوحيد فتوقّف» عن غرفة العمليات ثم «نقرة الغرفة أبسط وأأمن» — فتوقّف
  // الوكيل عند القسم الأول ولم يبلغ الوصفة أصلاً. أحال المستخدم إلى نقرة وهو يملك
  // مساراً ينفّذه. النتيجة كانت صادقة (‏launched=0) لكنها ليست المطلوب.
  assert(adapter.content.includes('ليست مسارك الافتراضي'),
    'المورد لا ينزع الافتراضية عن غرفة العمليات — يعود الوكيل يحيل إلى نقرة');
  assert(adapter.content.includes('مسارك الافتراضي، لا خيارٌ احتياطي'),
    'قسم تعدد المحركات لا يُعلن نفسه افتراضياً — يبقى خياراً لا يُسلَك');
  assert(!/نقرة غرفة العمليات أبسط وأأمن/.test(adapter.content),
    'عادت الصياغة التي تحيز إلى النقرة على حساب المسار المنفَّذ');
  // اصطدام ذاتي مقيس (جلسة `01a044c9`): أنشأ الوكيل مجلدَي المصحِّحَين دفعةً واحدة، ثم
  // رفضهما مُشغّله لأن حارسه يفشل مغلقاً على مجلد **موجود** — فأوقف جولته بنفسه عند
  // حاجز التصحيح. الوصفة كانت تشترط «مجلد فارغ مستقل» بلا تحديد دورة حياته، فاخترعها
  // الوكيل بمُنشئَين. وأضيف معها تحسينه هو: تمرير البرومبت base64.
  // النمط الفضفاض `/New-Item[^\n]*-Force/` كان يمرّ ولو حُذف `-Force` من الأمر، لأن
  // التعليق في السطر نفسه يذكره — أمسكه فحص العضّ. المطابقة الحرفية لا تُخدَع بتعليق.
  assert(adapter.content.includes('New-Item -ItemType Directory -Force -Path'),
    'الوصفة بلا إنشاء idempotent لمجلد العزل — يعود الاصطدام الذاتي');
  assert(adapter.content.includes('مُنشئ واحد'),
    'الوصفة لا تشترط مُنشئاً واحداً لمجلد العزل');
  assert(adapter.content.includes('FromBase64String'),
    'الوصفة بلا مسار base64 للبرومبت');
  assert(adapter.content.includes('ليس دليل تعليق'),
    'الوصفة لا تفرّق بطء Claude عن العلوق — يُقتل فرع سليم');
  // ولا تُحيل إلى مسار من مستودعنا: المهارة تعمل في مشروع المستخدم (‏OBS-060).
  for (const leak of ['executor.ps1', 'AGENT-CLI-FLAGS', 'D:\\sater', 'docs/']) {
    assert(!adapter.content.includes(leak),
      'تسريب مسار من مستودعنا إلى المهارة المحمولة: ' + leak);
  }

  const evaluation = skills.readResource(selected, 'satr-diverge', 'references/evaluation.md');
  assert.strictEqual(evaluation.ok, true);
  assert(evaluation.content.includes('branch_completion_ratio'));
  assert(evaluation.content.includes('عرض JSON فرع منفرد كتقرير نهائي'));

  const toolLoaded = await tools.run('load_skill', ROOT, { name: 'satr-diverge' }, { skillContext: selected });
  assert.strictEqual(toolLoaded.ok, true);
  assert(toolLoaded.content.includes('## المراحل السبع'));
  const codex = skills.codexInputs(selected);
  assert.deepStrictEqual(codex.map((item) => item.name), ['satr-diverge']);
  assert(codex.every((item) => path.isAbsolute(item.path)));
  console.log('✓ satr-diverge packaging and portable contract for Claude, Codex, and Kimi');
}

// ── مدقّق مواصفة Agent Skills ─────────────────────────────────────────────────
//
// المواصفة (agentskills.io/specification) صارت معياراً تقرؤه عشرات العملاء، ومهارات
// هذا المشروع منقولة إليها. فالفهرسة تُدقّق قبل أن يصل اسم أو وصف إلى نموذج، والعقد
// المحروس هنا **مزدوج**: المكسورة تُستبعد بسبب مُعلن (fail-closed)، والسليمة تبقى
// مهما جاورتها مكسورة (fail-open) — لأن حارساً يُخلي فهرس المستخدم عند أول مهارة
// معطوبة أسوأ من غياب التدقيق أصلاً.
//
// المهارات المكسورة تُكتب داخل `project` نفسه عمداً: تأكيد الفهرس الحصري القائم
// (`['global','legacy','portable','satr-diverge']`) يصير **هو** الدليل أن ستّ مهارات
// معطوبة لا تُسقط ولا تزحزح البقية، بلا تعديل حرفٍ في ذلك التأكيد.
const BROKEN_FIXTURES = Object.freeze([
  { dir: 'mismatch', error: 'name_mismatch', body: ['---', 'name: another-name', 'description: اسم لا يطابق مجلده', '---', 'MISMATCH_MARKER', ''] },
  { dir: 'Upper-Case', error: 'bad_name', body: ['---', 'name: Upper-Case', 'description: اسم بأحرف كبيرة يخالف المواصفة', '---', 'UPPER_MARKER', ''] },
  { dir: 'nodesc', error: 'missing_description', body: ['---', 'name: nodesc', '---', 'NODESC_MARKER', ''] },
  { dir: 'longdesc', error: 'description_too_long', body: ['---', 'name: longdesc', 'description: ' + 'و'.repeat(1025), '---', 'LONGDESC_MARKER', ''] },
  { dir: 'noyaml', error: 'no_frontmatter', body: ['# بلا ترويسة إطلاقاً', 'NOYAML_MARKER', ''] },
  { dir: 'noname', error: 'missing_name', body: ['---', 'description: وصف بلا اسم', '---', 'NONAME_MARKER', ''] },
]);

async function writeBrokenFixtures(project) {
  for (const fixture of BROKEN_FIXTURES) {
    await write(project, '.agents/skills/' + fixture.dir + '/SKILL.md', fixture.body.join('\n'));
  }
}

// (أ) عقود الدالة النقية — تُقرأ من المصدر الواحد `skills.validateSkillMeta` لا من نسخة
// ثانية تتباعد بصمت. الحدود مُثبَّتة بالرقم: 1024 محرفاً تمرّ و1025 تُرفض.
function assertValidatorUnit() {
  const good = skills.validateSkillMeta('demo-skill', { name: 'demo-skill', description: 'وصف صالح' });
  assert.strictEqual(good.ok, true);
  assert.strictEqual(good.name, 'demo-skill');
  assert.strictEqual(good.description, 'وصف صالح');
  assert.strictEqual(good.license, '');
  assert.strictEqual(good.metadata, null);

  const cases = [
    [null, 'no_frontmatter'],
    ['نص لا كائن', 'no_frontmatter'],
    [{ description: 'بلا اسم' }, 'missing_name'],
    [{ name: '   ', description: 'اسم فارغ' }, 'missing_name'],
    [{ name: 'Demo-Skill', description: 'حرف كبير' }, 'bad_name'],
    [{ name: 'demo_skill', description: 'شرطة سفلية' }, 'bad_name'],
    [{ name: 'demo skill', description: 'فراغ' }, 'bad_name'],
    [{ name: 'd'.repeat(65), description: 'أطول من 64' }, 'bad_name'],
    [{ name: 'other-skill', description: 'اسم آخر' }, 'name_mismatch'],
    [{ name: 'demo-skill' }, 'missing_description'],
    [{ name: 'demo-skill', description: '   ' }, 'missing_description'],
    [{ name: 'demo-skill', description: 'و'.repeat(1025) }, 'description_too_long'],
  ];
  for (const [frontmatter, expected] of cases) {
    const verdict = skills.validateSkillMeta('demo-skill', frontmatter);
    assert.strictEqual(verdict.ok, false, 'مرّت ترويسة مخالفة: ' + JSON.stringify(frontmatter).slice(0, 80));
    assert.strictEqual(verdict.error, expected, 'رمز خطأ غير متوقع لـ' + JSON.stringify(frontmatter).slice(0, 80));
    assert(typeof verdict.message === 'string' && verdict.message.length > 8,
      'الاستبعاد بلا سبب مقروء — وهو نصف العقد');
  }
  // الحدّ نفسه لا يُرفض: 64 محرفاً للاسم و1024 للوصف
  const edgeName = 'd'.repeat(64);
  assert.strictEqual(skills.validateSkillMeta(edgeName, { name: edgeName, description: 'x' }).ok, true);
  const edgeDescription = 'و'.repeat(1024);
  const edge = skills.validateSkillMeta('demo-skill', { name: 'demo-skill', description: edgeDescription });
  assert.strictEqual(edge.ok, true);
  assert.strictEqual(edge.description.length, skills.MAX_DESCRIPTION_CHARS);

  // الوصف حقل سطر واحد: يُطوى الفراغ وتُزال محارف التحكم قبل أن يدخل كتالوج البرومبت
  // (`- name: description`)، وإلا كسر السطرُ الجديدُ بنيةَ القائمة التي يقرؤها النموذج.
  const noisy = skills.validateSkillMeta('demo-skill', {
    name: 'demo-skill',
    description: '  سطر\nأول\tوثانٍ\u0007 بعد جرس  ',
  });
  assert.strictEqual(noisy.ok, true);
  assert.strictEqual(noisy.description, 'سطر أول وثانٍ بعد جرس');

  // الحقل الاختياري المشوّه يسقط وحده ولا يُسقط المهارة — زينة لا يُبنى عليها قرار.
  const optional = skills.validateSkillMeta('demo-skill', {
    name: 'demo-skill',
    description: 'وصف',
    license: 'L'.repeat(200),
    metadata: ['ليست خريطة'],
  });
  assert.strictEqual(optional.ok, true);
  assert.strictEqual(optional.license, '');
  assert.strictEqual(optional.metadata, null);

  const kept = skills.validateSkillMeta('demo-skill', {
    name: 'demo-skill',
    description: 'وصف',
    license: 'MIT',
    metadata: { project: 'x', 'مفتاح غير لاتيني': 'يسقط', empty: '   ' },
  });
  assert.deepStrictEqual(kept.metadata, { project: 'x' });
  assert.strictEqual(kept.license, 'MIT');

  // كل اسم يقبله المدقّق يجب أن يجتاز SAFE_NAME أيضاً، وإلا سقط في تنقية القنوات
  // العليا (`SAFE_SKILL` في العملية الرئيسية) بعد أن أجازته الفهرسة.
  for (const name of ['a', 'demo-skill', '0-9', 'd'.repeat(64)]) {
    assert(skills.SPEC_NAME.test(name) && skills.SAFE_NAME.test(name),
      'اسم يقبله SPEC_NAME ويرفضه SAFE_NAME: ' + name);
  }
  console.log('✓ مدقّق المواصفة: الحقول الإلزامية وحدودها، والاختياري المشوّه يسقط وحده');
}

// (ب) عقود الفهرسة الحقيقية على القرص
async function assertSpecDiscovery(project, temp, discoveryOptions) {
  const invalid = [];
  const catalog = skills.discoverSkills(project, Object.assign({ invalid }, discoveryOptions));

  // fail-closed: لا مكسورة في الفهرس، ولا تحت اسمها المُعلن ولا تحت اسم مجلدها
  for (const fixture of BROKEN_FIXTURES) {
    assert(!catalog.some((skill) => skill.name === fixture.dir),
      'مهارة مخالفة للمواصفة دخلت الفهرس: ' + fixture.dir);
  }
  assert(!catalog.some((skill) => skill.name === 'another-name'),
    'اسم لا يطابق مجلده دخل الفهرس — `load_skill` كان سيسلّم محتوى مجلد آخر');

  // ولا يكون الاستبعاد صامتاً: سبب لكل واحدة، بالرمز المتوقع وباسم مجلدها في الرسالة
  for (const fixture of BROKEN_FIXTURES) {
    const reason = invalid.find((entry) => entry.name === fixture.dir);
    assert(reason, 'استُبعدت ' + fixture.dir + ' بلا سبب مُبلَّغ');
    assert.strictEqual(reason.error, fixture.error, 'رمز استبعاد غير متوقع لـ' + fixture.dir);
    assert(reason.message.includes(fixture.dir) || reason.message.includes('another-name'),
      'رسالة الاستبعاد لا تسمّي المهارة: ' + reason.message);
    assert(reason.file.includes('SKILL.md'), 'سبب الاستبعاد بلا مسار الملف');
  }

  // fail-open: المهارات السليمة كلها باقية رغم ستّ مكسورة بجوارها
  assert.deepStrictEqual(catalog.map((skill) => skill.name), ['global', 'legacy', 'portable', 'satr-diverge'],
    'مهارة مكسورة أسقطت بقية الفهرس أو زحزحته');

  // المكسورة محجوبة عن البرومبت وعن التحميل، لا مستبعَدة من العرض فقط
  const selection = skills.resolveSelection(project, 'all', discoveryOptions);
  const prompt = skills.catalogPrompt(selection);
  for (const fixture of BROKEN_FIXTURES) assert(!prompt.includes(fixture.dir), 'مكسورة في كتالوج البرومبت: ' + fixture.dir);
  assert.strictEqual(skills.loadSkill(selection, 'mismatch').ok, false);
  assert.strictEqual(skills.loadSkill(selection, 'another-name').ok, false);

  // السبب يُعلَن ولو لم يطلب المتصل مجمّعاً — وإلا صار الاستبعاد صمتاً عند الاستدعاء
  // الإنتاجي (main.js يستدعي discoverSkills بلا `invalid`). المهارة هنا جديدة كي لا
  // يبتلعها إسقاط التكرار (مرة واحدة لكل ملف/سبب في عمر العملية).
  const quiet = path.join(temp, 'quiet-project');
  await write(quiet, '.agents/skills/silent-check/SKILL.md', ['---', 'name: not-silent-check', 'description: يجب أن يُعلَن سبب استبعادها', '---', ''].join('\n'));
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  try { skills.discoverSkills(quiet, discoveryOptions); } finally { console.warn = original; }
  assert(warnings.some((line) => line.includes('silent-check') && line.includes('not-silent-check')),
    'استُبعدت مهارة بلا أي إعلان: ' + JSON.stringify(warnings));

  // خطأ تحليل حقيقي: خريطة `metadata` المتداخلة كانت تُقرأ مفاتيحَ عليا، فمفتاح
  // `name` بداخلها يخطف اسم المهارة ويصير `load_skill` بابَ خلط بين مجلدين.
  const nested = path.join(temp, 'nested-project');
  await write(nested, '.agents/skills/nested-meta/SKILL.md', [
    '---', 'name: nested-meta', 'description: خريطة متداخلة',
    'license: FSL-1.1-MIT', 'metadata:', '  name: hijacked', '  project: satr', '---', 'NESTED_MARKER', '',
  ].join('\n'));
  const nestedCatalog = skills.discoverSkills(nested, discoveryOptions);
  const nestedSkill = nestedCatalog.find((skill) => skill.name === 'nested-meta');
  assert(nestedSkill, 'مهارة صالحة بخريطة metadata لم تُكتشف');
  assert(!nestedCatalog.some((skill) => skill.name === 'hijacked'),
    'مفتاح داخل metadata خطف اسم المهارة — عاد خطأ تحليل الخريطة المتداخلة');
  assert.strictEqual(nestedSkill.license, 'FSL-1.1-MIT');
  assert.deepStrictEqual(nestedSkill.metadata, { name: 'hijacked', project: 'satr' });
  const nestedPublic = (await skills.listSkills(nested)).find((skill) => skill.name === 'nested-meta');
  assert.strictEqual(nestedPublic.license, 'FSL-1.1-MIT');
  // ولا يدخل الحقلان كتالوج البرومبت: بيانات ترخيص/نسخة تستهلك رموزاً كل دور بلا أثر
  // في قرار التحميل.
  const nestedPrompt = skills.catalogPrompt(skills.resolveSelection(nested, 'all', discoveryOptions));
  assert(!nestedPrompt.includes('FSL-1.1-MIT') && !nestedPrompt.includes('hijacked'),
    'حقول المواصفة الاختيارية تسرّبت إلى كتالوج البرومبت');
  console.log('✓ الفهرسة تستبعد المخالف بسبب مُعلن وتُبقي السليم، وخريطة metadata لا تخطف الاسم');
}

// (ج) حقول المواصفة على مهارات «سطر» — الرخصة تُقرأ من LICENSE لا تُفترض.
// القائمة تُشتقّ من القرص لا من نسخة مكتوبة هنا: مهارة satr-* جديدة بلا الحقول تسقط.
function assertSkillSpecFields() {
  const licenseText = fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8');
  const abbreviation = licenseText.match(/##\s*Abbreviation\s*\r?\n\s*\r?\n(.+)/);
  assert(abbreviation && abbreviation[1].trim(), 'تعذّرت قراءة اختصار الرخصة من LICENSE');
  const declared = abbreviation[1].trim();

  const root = path.join(ROOT, '.agents', 'skills');
  const owned = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('satr-'))
    .map((entry) => entry.name)
    .sort();
  assert(owned.length >= 7, 'عدد مهارات سطر أقل من المتوقع: ' + owned.length);

  const catalog = skills.discoverSkills(ROOT, { home: path.join(ROOT, 'no-such-home'), builtinRoot: path.join(ROOT, 'no-such-builtin') });
  for (const name of owned) {
    const skill = catalog.find((item) => item.name === name);
    assert(skill, 'مهارة سطر غير مكتشفة (أو رفضها المدقّق): ' + name);
    assert.strictEqual(skill.license, declared,
      'رخصة ' + name + ' لا تطابق LICENSE في الجذر: ' + JSON.stringify(skill.license) + ' ≠ ' + declared);
    assert(skill.metadata && skill.metadata.project === 'satr',
      'مهارة سطر بلا metadata.project: ' + name);
    assert(skill.metadata.author, 'مهارة سطر بلا metadata.author: ' + name);
  }
  // tafqeet مثال مشروع لا مهارة سطر — لا يُفرض عليها الإعلان، ويبقى اكتشافها سليماً.
  const example = catalog.find((item) => item.name === 'tafqeet');
  assert(example && !example.license, 'مثال المشروع tafqeet تغيّر عقده');
  console.log('✓ مهارات سطر (' + owned.length + ') تعلن license مطابقة لـLICENSE ‏(' + declared + ') وmetadata');
}

async function main() {
  assertValidatorUnit();
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'satr-skills-test-'));
  const project = path.join(temp, 'project');
  const home = path.join(temp, 'home');
  const discoveryOptions = { home, builtinRoot: path.join(temp, 'builtin') };
  await fsp.mkdir(project, { recursive: true });
  try {
    await write(project, '.agents/skills/portable/SKILL.md', [
      '---',
      'name: portable',
      'description: مهارة قياسية محمولة',
      '---',
      'PORTABLE_INSTRUCTIONS_MARKER',
      '',
    ].join('\n'));
    await write(project, '.agents/skills/portable/checklists/review.md', 'راجع الاختبارات أولاً.\n');
    await write(project, '.agents/skills/portable/scripts/run.ps1', 'Write-Output "لا يُنفّذ تلقائياً"\n');
    await write(project, '.claude/skills/portable/SKILL.md', [
      '---', 'name: portable', 'description: نسخة توافق يجب أن تخسر', '---', 'LEGACY_SHADOW_MARKER', '',
    ].join('\n'));
    await write(project, '.claude/skills/legacy/SKILL.md', [
      '---', 'name: legacy', 'description: مهارة Claude قديمة', '---', 'LEGACY_ONLY_MARKER', '',
    ].join('\n'));
    await write(home, '.agents/skills/global/SKILL.md', [
      '---', 'name: global', 'description: |', '  مهارة مستخدم قياسية', '  بوصف متعدد الأسطر', '---', 'GLOBAL_MARKER', '',
    ].join('\n'));
    await write(discoveryOptions.builtinRoot, 'satr-diverge/SKILL.md', [
      '---', 'name: satr-diverge', 'description: مهارة سطر مضمّنة', '---', 'BUILTIN_DIVERGE_MARKER', '',
    ].join('\n'));
    await write(discoveryOptions.builtinRoot, 'untrusted/SKILL.md', [
      '---', 'name: untrusted', 'description: يجب ألا تُكتشف من المضمّنات', '---', 'UNTRUSTED_MARKER', '',
    ].join('\n'));

    // ستّ مهارات مخالفة للمواصفة بجوار السليمة: التأكيد التالي (الفهرس الحصري) هو
    // الدليل أنها لا تُسقط البقية ولا تزحزحها — انظر assertSpecDiscovery.
    await writeBrokenFixtures(project);

    const catalog = skills.discoverSkills(project, discoveryOptions);
    assert.deepStrictEqual(catalog.map((skill) => skill.name), ['global', 'legacy', 'portable', 'satr-diverge']);
    const portable = catalog.find((skill) => skill.name === 'portable');
    assert.strictEqual(portable.format, 'standard');
    assert.strictEqual(portable.source, 'project');
    assert.strictEqual(catalog.find((skill) => skill.name === 'satr-diverge').source, 'builtin');
    assert(!catalog.some((skill) => skill.name === 'untrusted'));
    assert(catalog.find((skill) => skill.name === 'global').description.includes('بوصف متعدد الأسطر'));

    const selected = skills.resolveSelection(project, ['portable', 'legacy'], discoveryOptions);
    assert.deepStrictEqual(selected.enabled.map((skill) => skill.name), ['legacy', 'portable']);
    assert.deepStrictEqual(selected.nativeClaude, ['legacy']);
    assert.strictEqual(skills.resolveSelection(project, 'all', discoveryOptions).nativeClaude, 'all');

    const prompt = skills.catalogPrompt(selected);
    assert(prompt.includes('portable'));
    assert(prompt.includes('legacy'));
    assert(!prompt.includes('PORTABLE_INSTRUCTIONS_MARKER'));

    const loaded = skills.loadSkill(selected, 'portable');
    assert.strictEqual(loaded.ok, true);
    assert(loaded.instructions.includes('PORTABLE_INSTRUCTIONS_MARKER'));
    assert.deepStrictEqual(loaded.resources.map((resource) => resource.path), [
      'checklists/review.md', 'scripts/run.ps1',
    ]);

    const resource = skills.readResource(selected, 'portable', 'checklists/review.md');
    assert.strictEqual(resource.ok, true);
    assert(resource.content.includes('راجع الاختبارات'));
    assert.strictEqual(skills.readResource(selected, 'portable', '../secret.txt').ok, false);
    assert.strictEqual(skills.loadSkill(selected, 'global').ok, false);

    const definitions = tools.defs().map((definition) => definition.function.name);
    assert(definitions.includes('load_skill'));
    assert(definitions.includes('read_skill_resource'));
    const toolLoaded = await tools.run('load_skill', project, { name: 'portable' }, { skillContext: selected });
    assert.strictEqual(toolLoaded.ok, true);
    assert(toolLoaded.content.includes('PORTABLE_INSTRUCTIONS_MARKER'));
    const toolDenied = await tools.run('load_skill', project, { name: 'global' }, { skillContext: selected });
    assert.strictEqual(toolDenied.ok, false);

    const codex = skills.codexInputs(selected);
    assert.deepStrictEqual(codex.map((item) => item.type), ['skill', 'skill']);
    assert(codex.every((item) => path.isAbsolute(item.path)));

    const publicList = await skills.listSkills(project);
    assert(publicList.every((skill) => !('file' in skill) && !('directory' in skill)));
    console.log('✓ skills catalog precedence');
    console.log('✓ progressive disclosure and resource boundaries');
    console.log('✓ portable tools and Codex skill inputs');
    await assertSatrDiverge(discoveryOptions);
    await assertSatrAccept(discoveryOptions);
    console.log('✓ satr-accept: مضمّنة ومحزومة، وقواعدها الملزمة وحدودها ومثالها الحيّ في النص');
    await assertSatrDesignAr(discoveryOptions);
    console.log('✓ satr-design-ar: مضمّنة ومحزومة، وفحصها المركزي وحدودها في النص، ومحمولة بلا مسار من مستودعنا');
    await assertSpecDiscovery(project, temp, discoveryOptions);
    assertSkillSpecFields();
    if (process.argv.includes('--live-codex')) await runLiveProbe('codex', project);
    if (process.argv.includes('--live-sdk')) await runLiveProbe('sdk', project);
  } finally {
    if (process.argv.includes('--live-codex') || process.argv.includes('--live-sdk')) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
    await fsp.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
