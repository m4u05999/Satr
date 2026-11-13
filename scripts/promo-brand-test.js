// حارس الهوية والقوالب — electron/promostudio.js (sanitizeBrand، loadBrand، saveBrand) و
// src/ui/lib/promo/promo-templates.js (الدفعة 9 من مخرج الإعلانات).
// الفحص المتقاطع: ما ينتجه كل قالب وكل تطبيق هوية يجب أن تقبله تنقية main كما هو.
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const studio = require('../electron/promostudio');

let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks += 1; };
const eq = (actual, expected, message) => { assert.deepStrictEqual(actual, expected, message); checks += 1; };

(async () => {
  const { TEMPLATES, templateById, applyTemplate, applyBrand, BRAND_CLOSING_ID } = await import('../src/ui/lib/promo/promo-templates.js');
  const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-promo-brand-dl-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-promo-brand-proj-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-promo-brand-out-'));
  try {
    const clip = path.join(downloads, 'clip.mp4'), logo = path.join(downloads, 'logo.png'), secret = path.join(outside, 'logo.png');
    for (const file of [clip, logo, secret]) fs.writeFileSync(file, 'x');
    const resolve = (candidate) => studio.localAsset(downloads, candidate, studio.IMAGE_EXTENSIONS) || '';

    // ── تنقية الهوية ──
    eq(studio.sanitizeBrand(null), { name: '', primary: '', secondary: '', accent: '', closing: '', logo: '' }, 'الفارغ');
    eq(studio.sanitizeBrand({ name: '  سطر\n برو ', primary: '#AABBCC', secondary: 'red', accent: '#12345', closing: 'حمّل التطبيق‮ الآن', logo, extra: 1 }, resolve),
      { name: 'سطر برو', primary: '#aabbcc', secondary: '', accent: '', closing: 'حمّل التطبيق الآن', logo }, 'قيم صالحة ومعطوبة');
    eq(studio.sanitizeBrand({ logo: secret }, resolve).logo, '', 'شعار خارج Downloads');
    eq(studio.sanitizeBrand({ logo: clip }, resolve).logo, '', 'شعار ليس صورة');
    eq(studio.sanitizeBrand({ logo }, null).logo, '', 'بلا محلّل مسارات لا شعار');
    eq(studio.sanitizeBrand({ name: 'ا'.repeat(500), closing: 'ب'.repeat(500) }).name.length + studio.sanitizeBrand({ name: 'ا'.repeat(500), closing: 'ب'.repeat(500) }).closing.length, 180, 'الأطوال محدودة');
    eq(studio.sanitizeBrand(['x']), studio.sanitizeBrand(null), 'مصفوفة');

    // ── الحفظ والتحميل في مجلد المشروع ──
    const controller = studio.create({ downloadsPath: downloads });
    eq(controller.loadBrand(project), { ok: true, exists: false, brand: studio.sanitizeBrand(null) }, 'لا ملف بعد');
    const saved = controller.saveBrand(project, { name: 'سطر', primary: '#101826', secondary: '#d9a441', accent: '#d9a441', closing: 'جرّبه الآن', logo });
    eq(saved.ok, true, 'الحفظ');
    const file = path.join(project, '.satr', 'brand.json');
    ok(fs.existsSync(file) && !fs.existsSync(file + '.tmp'), 'الملف في ‎.satr/brand.json بلا بقايا');
    eq(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 1, name: 'سطر', primary: '#101826', secondary: '#d9a441', accent: '#d9a441', closing: 'جرّبه الآن', logo }, 'المحتوى');
    eq(controller.loadBrand(project), { ok: true, exists: true, brand: { name: 'سطر', primary: '#101826', secondary: '#d9a441', accent: '#d9a441', closing: 'جرّبه الآن', logo } }, 'التحميل');
    fs.writeFileSync(file, JSON.stringify({ name: 'خبيث', primary: 'javascript:1', logo: secret, closing: 7 }));
    eq(controller.loadBrand(project).brand, { name: 'خبيث', primary: '', secondary: '', accent: '', closing: '', logo: '' }, 'ملف معدَّل باليد يُنقّى عند التحميل');
    fs.writeFileSync(file, '{not json');
    eq(controller.loadBrand(project).error, 'bad_schema', 'JSON معطوب');
    fs.writeFileSync(file, 'x'.repeat(studio.MAX_BRAND_BYTES + 10));
    eq(controller.loadBrand(project).error, 'too_large', 'ملف فوق الحد');
    eq(controller.loadBrand('relative').error, 'bad_project', 'جذر نسبي');
    eq(controller.saveBrand('', {}).error, 'bad_project', 'بلا جذر');
    eq(controller.saveBrand(path.join(project, 'missing', 'deep'), { name: 'x' }).ok, true, 'ينشئ ‎.satr عند الحاجة');
    const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
    ok(/ipcMain\.handle\('satr:promoBrandSave'[\s\S]{0,160}validProjectDirectory\(payload && payload\.cwd\)/.test(main) && /ipcMain\.handle\('satr:promoBrandLoad'[\s\S]{0,160}validProjectDirectory/.test(main), 'قناتا الهوية تمرّان بـvalidProjectDirectory');

    // ── الهوية في الـstoryboard ──
    const board = () => ({ aspect: '16:9', scenes: [
      { asset: clip, duration_ms: 4000, caption: 'Satr Pro متاح الآن', text_style: { animation: 'none', highlight: 'Pro' }, voiceover_ar: 'أهلاً بكم.', stage: { frame: 'none', background: { type: 'none' }, label: 'satr.app' },
        camera: { mode: 'manual', cursor: true, keyframes: [{ t_ms: 0, x: 0.5, y: 0.5, zoom: 1, ease: 'hold' }, { t_ms: 1000, x: 0.4, y: 0.4, zoom: 2, ease: 'inOut' }] },
        redactions: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.1, start_ms: 0, end_ms: 4000, auto: true }] },
      { asset: clip, duration_ms: 3000, caption: 'ثانٍ' },
      { asset: logo, duration_ms: 2000, caption: 'صورة' },
    ] });
    const sanitize = (value) => studio.sanitizeStoryboard(value, { downloadsPath: downloads });
    eq('brand' in sanitize(board()).storyboard, false, 'بلا هوية لا حقل brand');
    const withBrand = sanitize({ ...board(), brand: { name: 'سطر', primary: '#101826', accent: '#D9A441', logo, closing: 'جرّبه' } }).storyboard;
    eq(withBrand.brand, { name: 'سطر', primary: '#101826', secondary: '', accent: '#d9a441', closing: 'جرّبه', logo }, 'الهوية تُنقّى داخل الـstoryboard');
    const projectFile = path.join(downloads, 'p.satr-promo.json');
    eq(studio.saveProject(downloads, { ...board(), brand: withBrand.brand }, projectFile).ok, true, 'حفظ مشروع بهوية');
    eq(studio.loadProject(projectFile, downloads).storyboard.brand, withBrand.brand, 'الهوية تعود مع المشروع');
    const shown = studio.create({ downloadsPath: downloads });
    shown.propose({ scenes: [{ asset: clip, duration_ms: 3000 }], brand: { logo } });
    eq(shown.assetUrl(logo).ok, true, 'شعار هوية الـstoryboard الحالي أصل مسموح بعرضه');
    shown.propose({ scenes: [{ asset: clip, duration_ms: 3000 }] });
    eq(shown.assetUrl(logo).ok, false, 'وبلا هوية ليس مسموحاً');

    // ── القوالب: كل قالب ينتج storyboard تقبله تنقية main كما هو ──
    ok(TEMPLATES.length >= 4 && TEMPLATES.length <= 6, 'عدد القوالب ' + TEMPLATES.length);
    eq(new Set(TEMPLATES.map((item) => item.id)).size, TEMPLATES.length, 'معرّفات فريدة');
    eq(templateById('nope'), null, 'قالب مجهول');
    const clientBoard = () => {
      const value = sanitize(board()).storyboard;
      return JSON.parse(JSON.stringify(value));
    };
    for (const template of TEMPLATES) {
      const before = clientBoard();
      const applied = applyTemplate(clientBoard(), template, { primary: '#101826', secondary: '#d9a441' });
      const cleaned = sanitize(applied);
      eq(cleaned.ok, true, template.id + ': التنقية تقبله');
      eq(JSON.parse(JSON.stringify(cleaned.storyboard)), JSON.parse(JSON.stringify(applied)), template.id + ': لا قيمة غيّرتها التنقية (كل ما يضعه القالب داخل الحدود)');
      eq(applied.aspect, template.aspect, template.id + ': المقاس');
      eq(applied.scenes[0].transition_in, 'none', template.id + ': أول مشهد بلا انتقال');
      eq(applied.scenes[1].transition_in, template.transition_in, template.id + ': انتقال بقية المشاهد');
      eq([applied.scenes[0].stage.frame, applied.scenes[0].stage.background.type, applied.scenes[0].stage.background.color], [template.stage.frame, template.stage.background, '#101826'], template.id + ': المسرح بألوان السمة');
      // ما لا يمسه القالب
      for (const key of ['asset', 'duration_ms', 'caption', 'camera', 'redactions', 'voiceover_ar', 'music', 'voice', 'trim_start_ms']) {
        assert.deepStrictEqual(applied.scenes[0][key], before.scenes[0][key], template.id + ': لا يمس ' + key);
      }
      checks += 1;
      eq(applied.scenes[0].stage.label, 'satr.app', template.id + ': نص الرابط الذي كتبه المستخدم يبقى');
      eq(applied.scenes[0].text_style.highlight, 'Pro', template.id + ': كلمة الإبراز تبقى');
      eq([applied.scenes[0].subtitles, applied.scenes[1].subtitles], [!!template.subtitles, false], template.id + ': الترجمة حيث يوجد نص تعليق فقط');
    }
    eq(applyTemplate(null, TEMPLATES[0]), null, 'مدخل فارغ');
    const branded = clientBoard(); branded.brand = { primary: '#aa0000', secondary: '#00aa00' };
    eq(applyTemplate(branded, TEMPLATES[0], { primary: '#101826', secondary: '#d9a441' }).scenes[0].stage.background.color, '#aa0000', 'ألوان الهوية تسبق ألوان السمة في القالب');

    // ── تطبيق الهوية ──
    const staged = applyTemplate(clientBoard(), TEMPLATES[0], { primary: '#101826', secondary: '#d9a441' });
    const count = staged.scenes.length;
    const first = applyBrand(staged, { name: 'سطر', primary: '#112233', secondary: '#445566', accent: '#778899', closing: 'حمّل التطبيق الآن', logo });
    eq(first.closing, 'added', 'بطاقة الختام أضيفت');
    eq(staged.scenes.length, count + 1, 'مشهد واحد زاد');
    const card = staged.scenes[staged.scenes.length - 1];
    eq([card.id, card.asset, card.asset_type, card.caption, card.fit], [BRAND_CLOSING_ID, logo, 'image', 'حمّل التطبيق الآن', 'contain'], 'بطاقة الختام: الشعار والعبارة');
    eq(staged.scenes.slice(0, count).map((scene) => [scene.stage.background.color, scene.stage.background.color2]), Array.from({ length: count }, () => ['#112233', '#445566']), 'خلفيات المشاهد بألوان الهوية');
    eq(staged.brand.accent, '#778899', 'لون الإبراز في هوية الـstoryboard');
    const cleanedBrand = sanitize(staged);
    eq(cleanedBrand.ok, true, 'التنقية تقبل الـstoryboard بعد الهوية');
    eq(JSON.parse(JSON.stringify(cleanedBrand.storyboard)), JSON.parse(JSON.stringify(staged)), 'ولا تغيّر فيه شيئاً');
    eq(applyBrand(staged, { ...staged.brand, closing: 'عبارة جديدة' }).closing, 'updated', 'تطبيق ثانٍ يحدّث البطاقة');
    eq([staged.scenes.length, staged.scenes[staged.scenes.length - 1].caption, staged.scenes.filter((scene) => scene.id === BRAND_CLOSING_ID).length], [count + 1, 'عبارة جديدة', 1], 'بطاقة واحدة فقط');
    eq(applyBrand(staged, { ...staged.brand, logo: '' }).closing, 'removed', 'بلا شعار تُزال البطاقة');
    eq(staged.scenes.length, count, 'العدد عاد');
    eq(applyBrand(staged, { primary: '#000000', closing: 'عبارة بلا شعار' }).closing, 'none', 'عبارة بلا شعار لا تضيف بطاقة');
    // مشهد بلا مسرح لا تُفرض عليه خلفية
    const plain = clientBoard();
    applyBrand(plain, { primary: '#112233', secondary: '#445566' });
    eq(plain.scenes[0].stage.background, { type: 'none', color: '', color2: '', angle: 135, image: '', blur: 0 }, 'مشهد بلا خلفية لا يُلوَّن');
    // حد 40 مشهداً
    const full = { aspect: '16:9', scenes: Array.from({ length: 40 }, () => ({ id: 's', stage: { background: { type: 'none' } } })) };
    eq([applyBrand(full, { logo, closing: 'x' }).closing, full.scenes.length], ['none', 40], 'مشروع ممتلئ لا تُضاف له بطاقة');
    eq(applyBrand(null, {}).closing, 'none', 'مدخل فارغ');

    console.log('promo-brand-test: ok — ' + checks + ' فحصاً (تنقية الهوية، ‎.satr/brand.json، الهوية في المشروع، القوالب، بطاقة الختام، وقبول main لكل ناتج).');
  } finally {
    for (const dir of [downloads, project, outside]) fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error('promo-brand-test:', error && error.stack ? error.stack : error);
  process.exit(1);
});
