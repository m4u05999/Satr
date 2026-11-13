// حارس عزل التصيير (الدفعة 8 من docs/PROMO-DIRECTOR-PLAN.md، §10).
// القاعدة: الوكيل يقترح والإنسان يصدّر. لا مسار برمجي من أدوات الوكيل إلى التصيير أو الكتابة النهائية.
//
// ما يحرسه: (1) قنوات التصدير والاعتماد غير مذكورة في أي ملف يعرّف أدوات وكيل، (2) أدوات promo_*
// لا تستدعي كاتب التصدير ولا تعتمد الخطة، (3) المسار غير المباشر: سطح ويندوز يحجب نوافذ سطر
// نفسها، وأدوات المتصفح لا تُوجَّه إلى نافذة التطبيق، (4) أذونات أداتي التسجيل لم تتغير.
// حدّه: فحص نصي وسلوكي لوحدات معزولة؛ لا يشغّل وكيلاً حياً يحاول الالتفاف.
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks += 1; };
const eq = (actual, expected, message) => { assert.deepStrictEqual(actual, expected, message); checks += 1; };

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const electronFiles = fs.readdirSync(path.join(root, 'electron')).filter((name) => name.endsWith('.js'));
const adapterDir = path.join(root, 'electron', 'adapters');
const adapterFiles = fs.existsSync(adapterDir) ? fs.readdirSync(adapterDir).filter((name) => name.endsWith('.js')).map((name) => 'adapters/' + name) : [];

// ── (1) قنوات التصدير والاعتماد: main وpreload والكاتب فقط ──
const EXPORT_TOKENS = ['promoExportBegin', 'promoExportChunk', 'promoExportFinish', 'promoExportAbort', 'satr:promoExport', "require('./promoexport')", 'promoexport.'];
const APPROVE_TOKENS = ['approveAdPlan', 'promoAdPlanApprove', 'satr:promoAdPlanApprove'];
const allowedExport = new Set(['main.js', 'preload.js', 'promoexport.js']);
const allowedApprove = new Set(['main.js', 'preload.js', 'promostudio.js']);
for (const name of [...electronFiles, ...adapterFiles]) {
  const source = read('electron/' + name);
  for (const token of EXPORT_TOKENS) {
    if (!allowedExport.has(name)) assert.ok(!source.includes(token), 'electron/' + name + ' يذكر ' + token + ' — قناة التصدير خرجت من main/preload');
  }
  for (const token of APPROVE_TOKENS) {
    if (!allowedApprove.has(name)) assert.ok(!source.includes(token), 'electron/' + name + ' يذكر ' + token + ' — اعتماد الخطة خرج من main/preload');
  }
}
checks += 1;
ok(electronFiles.length > 40, 'فُحصت ملفات electron كلها (' + electronFiles.length + ' + ' + adapterFiles.length + ' محوّلاً)');

// ملفات تعريف الأدوات بالاسم: لا تصدير ولا اعتماد ولا مصيّر
for (const name of ['agent.js', 'codexmcp.js', 'kimi.js', 'tools.js', 'looprunner.js', 'envbrief.js', 'autogate.js', 'desktop.js', 'preview.js', 'promocapture.js']) {
  if (!fs.existsSync(path.join(root, 'electron', name))) continue;
  const source = read('electron/' + name);
  for (const token of [...EXPORT_TOKENS, ...APPROVE_TOKENS, 'renderStoryboard', 'exportStoryboard', 'promo-export/']) {
    ok(!source.includes(token), 'electron/' + name + ' لا يذكر ' + token);
  }
}

// ── (2) كتالوج أدوات البرومو مغلق: ست أدوات، لا أداة تصيير ──
const agent = read('electron/agent.js'), codex = read('electron/codexmcp.js');
const promoToolNames = (source) => [...new Set((source.match(/'promo_[a-z_]+'/g) || []).map((item) => item.slice(1, -1)))].sort();
const EXPECTED = ['promo_get_ad_plan', 'promo_list_segments', 'promo_plan_ad', 'promo_propose_storyboard', 'promo_record_start', 'promo_record_stop'];
eq(promoToolNames(agent), EXPECTED, 'أدوات البرومو في محرك Claude');
eq(promoToolNames(codex), EXPECTED, 'أدوات البرومو في محرك Codex');
for (const [label, source] of [['agent.js', agent], ['codexmcp.js', codex]]) {
  ok(!/promo_(render|export|publish|upload|approve|finish)/.test(source), label + ': لا أداة تصيير أو نشر أو اعتماد');
}
// معالجات الأدوات الجديدة لا تستدعي إلا planAd / adPlanState / propose
const handlerOf = (source, name) => {
  const at = source.indexOf("'" + name + "'");
  return at < 0 ? '' : source.slice(at, at + 3200).split(/\n    (?:const \w+Tool = sdk\.tool\(|\{\n      name: ')/)[0];
};
for (const [label, source] of [['agent.js', agent], ['codexmcp.js', codex]]) {
  const plan = handlerOf(source, 'promo_plan_ad'), get = handlerOf(source, 'promo_get_ad_plan'), propose = handlerOf(source, 'promo_propose_storyboard');
  // النص المعاد للوكيل يحوي «approved: false»؛ المحظور نداء دالة اعتماد أو تصدير، لا الكلمة.
  ok(/\.planAd\(/.test(plan) && !/approveAdPlan|\.approve\w*\(|promoexport|renderStoryboard|exportStoryboard/.test(plan), label + ': promo_plan_ad يقترح فقط');
  ok(/\.adPlanState\(/.test(get) && !/approve\w*\(|planAd\(/.test(get), label + ': promo_get_ad_plan يقرأ فقط');
  ok(/\.propose\(/.test(propose) && !/export|renderStoryboard/.test(propose), label + ': promo_propose_storyboard يقترح فقط');
}
// القراءة حرّة والتسجيل بإذن في كل مرة — كما كان
ok(/const PROMO_READ_TOOLS = new Set\(\[[^\]]*promo_list_segments[^\]]*promo_propose_storyboard[^\]]*promo_plan_ad[^\]]*promo_get_ad_plan[^\]]*\]\)/.test(agent), 'أدوات القراءة الأربع في PROMO_READ_TOOLS');
ok(!/PROMO_READ_TOOLS = new Set\(\[[^\]]*promo_record/.test(agent), 'التسجيل ليس في أدوات القراءة');
ok(/const NEVER_ALWAYS_TOOLS = new Set\(\[[^\]]*PROMO_START_TOOL, PROMO_STOP_TOOL/.test(agent), 'أداتا التسجيل باقيتان في NEVER_ALWAYS_TOOLS');
ok(/const NEVER_TURN_TOOLS = new Set\(\[[\s\S]{0,260}PROMO_START_TOOL, PROMO_STOP_TOOL/.test(agent), 'وباقيتان في NEVER_TURN_TOOLS');
for (const name of ['promo_record_start', 'promo_record_stop']) {
  ok(new RegExp("name: '" + name + "', access: 'exec', neverAlways: true").test(codex), name + ' في Codex: exec + neverAlways');
}
for (const name of ['promo_plan_ad', 'promo_get_ad_plan', 'promo_propose_storyboard', 'promo_list_segments']) {
  ok(new RegExp("name: '" + name + "', access: 'read'").test(codex), name + ' في Codex: قراءة');
}

// ── سلوكياً: أدوات الوكيل لا تعتمد الخطة ولا تكتب ملفاً ──
const studio = require('../electron/promostudio');
const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-promo-isolation-'));
try {
  const clip = path.join(downloads, 'clip.mp4');
  fs.writeFileSync(clip, 'x');
  const events = [];
  const controller = studio.create({ downloadsPath: downloads, emit: (event) => events.push(event) });
  const plan = { goal: 'إبراز الحجز السريع', duration_s: 30, scenes: [{ purpose: 'الخطّاف', steps_to_perform: ['افتح الصفحة الرئيسية'], caption_ar: 'احجز في ثوانٍ', duration_s: 5 }] };
  const before = fs.readdirSync(downloads).sort();
  eq(controller.planAd(plan).approved, false, 'planAd لا يعتمد');
  eq(controller.adPlanState().approved, false, 'الحالة: غير معتمدة');
  eq(events.map((event) => event.type), ['ad_plan_proposed'], 'planAd يبث البطاقة فقط');
  // مهما كرر الوكيل أو زوّر الحقول، الاعتماد لا يأتي من planAd
  eq(controller.planAd({ ...plan, approved: true, approved_at: 1 }).approved, false, 'حقل approved في مدخل الوكيل يُهمل');
  eq(controller.adPlanState().approved, false, 'ما زالت غير معتمدة');
  eq(controller.approveAdPlan({ ...plan, goal: 'هدف عدّله المستخدم' }).approved, true, 'الاعتماد من مسار الواجهة');
  eq([controller.adPlanState().approved, controller.adPlanState().plan.goal], [true, 'هدف عدّله المستخدم'], 'الوكيل يقرأ نسخة المستخدم');
  eq(controller.planAd(plan).approved, false, 'خطة جديدة من الوكيل تُسقط الاعتماد السابق');
  eq(controller.propose({ scenes: studio.proposalScenes([{ asset: clip, duration_ms: 3000 }]) }).ok, true, 'propose');
  eq(fs.readdirSync(downloads).sort(), before, 'لا أداة وكيل كتبت ملفاً في Downloads');
  eq(Object.keys(controller).sort().filter((key) => /export|render|finish|chunk|begin/i.test(key)), [], 'متحكم الاستوديو بلا دوال تصدير');
} finally {
  fs.rmSync(downloads, { recursive: true, force: true });
}

// ── (3) المسار غير المباشر ──
// سطح ويندوز: نوافذ سطر (إنتاجاً وتطويراً) محجوبة بالاسم، والنسخة نفسها برقم العملية.
const guard = require('../electron/desktopguard');
for (const processName of ['Satr', 'Satr.exe', 'satr', 'electron', 'electron.exe', 'ELECTRON']) {
  ok(guard.isBlockedTarget({ targetId: 'w1', pid: 4242, processName, title: 'سطر', rect: { x: 0, y: 0, w: 800, h: 600 } }).blocked, 'سطح ويندوز يحجب نافذة ' + processName);
}
ok(!guard.isBlockedTarget({ targetId: 'w2', pid: 4243, processName: 'notepad', title: 'x', rect: { x: 0, y: 0, w: 800, h: 600 } }).blocked, 'ونافذة أخرى غير محجوبة (الفحص ليس حجباً شاملاً)');
ok(/selfPid = Number\.isInteger\(options\.selfPid\) \? options\.selfPid : process\.pid/.test(read('electron/desktop.js')), 'desktop.js يستثني النسخة نفسها برقم العملية');
// أدوات المتصفح: هدفها نافذة الالتقاط التي يملكها promocapture أو لوحة المعاينة، لا نافذة التطبيق.
const main = read('electron/main.js'), capture = read('electron/promocapture.js');
ok(/preview\.setExternalTargetProvider\(\(\) => promocapture\.currentWebContents\(\)/.test(main), 'هدف أدوات المتصفح الخارجي = نافذة الالتقاط');
ok(/return ownsCaptureWindow && captureWindow && !captureWindow\.isDestroyed\(\) \? captureWindow\.webContents : null;/.test(capture), 'تسجيل نافذة التطبيق نفسها لا يعرّضها لأدوات المتصفح');
ok(!/setExternalTargetProvider\([^)]*mainWindow/.test(main), 'نافذة التطبيق لا تُمرَّر هدفاً لأدوات المتصفح');

// ── (4) الواجهة: التصدير والاعتماد أفعال مستخدم ──
const studioUi = read('src/ui/components/promo-studio.js'), planUi = read('src/ui/components/promo-plan.js');
ok(/root\.getElementById\('render'\)\.addEventListener\('click'/.test(studioUi), 'التصدير يبدأ بنقرة زر «صيّر»');
ok(/if \(!this\.approved \|\| this\.rendering\) throw new Error\('approval_required'\)/.test(studioUi), 'ولا يبدأ بلا اعتماد الخط الزمني');
ok(!/onPromoCapture\([\s\S]{0,600}\.render\(\)/.test(studioUi), 'لا حدث من main يستدعي render');
ok(!/storyboard_proposed[^\n]*approved = true/.test(studioUi), 'اقتراح الوكيل لا يعتمد الخط الزمني');
ok(/getElementById\('approve'\)\.addEventListener\('click'/.test(planUi) && !/ad_plan_proposed[^\n]*approve\(/.test(planUi), 'اعتماد الخطة بنقرة، لا بحدث');
const app = read('src/ui/app.js');
ok(/promo-plan-approved[\s\S]{0,220}insertPrompt\(/.test(app) && !/promo-plan-approved[\s\S]{0,220}\.send\(/.test(app), 'الاعتماد يجهّز رسالة في المؤلّف ولا يرسلها');

// المهارة تنص على القاعدة
const skill = read('.agents/skills/satr-promo-director/SKILL.md');
ok(skill.includes('لا تصيّر ولا تنشر') && skill.includes('promo_get_ad_plan') && skill.includes('لا تبدأ تسجيلاً قبل اعتماد الخطة'), 'مهارة المخرج تنص على العزل والترتيب');
for (const tool of EXPECTED) ok(skill.includes(tool), 'المهارة تذكر ' + tool);

console.log('promo-agent-isolation-test: ok — ' + checks + ' فحصاً (قنوات التصدير والاعتماد خارج أدوات الوكيل، كتالوج البرومو مغلق، سطح ويندوز والمتصفح لا يبلغان نافذة سطر، التصدير والاعتماد بنقرة مستخدم).');
