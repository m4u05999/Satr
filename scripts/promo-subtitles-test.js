// حارس الترجمة على الشاشة وحقول العناوين — src/ui/lib/promo/promo-subtitles.js
// وتنقية text_style / voiceover_ar / subtitles في electron/promostudio.js.
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks += 1; };
const eq = (actual, expected, message) => { assert.deepStrictEqual(actual, expected, message); checks += 1; };

(async () => {
  const { spokenLength, splitCues, subtitleCues, cueAt, safeArea, SAFE_AREAS, MAX_VOICEOVER } = await import('../src/ui/lib/promo/promo-subtitles.js');
  const studio = require('../electron/promostudio');

  // ── وزن النطق: التشكيل والتطويل وعلامات الوقف لا تُحسب ──
  eq(spokenLength('العربية'), 7, 'حروف بلا تشكيل');
  eq(spokenLength('العَرَبِيَّةُ'), 7, 'التشكيل لا يزيد الوزن');
  eq(spokenLength('جميـــل'), 4, 'التطويل لا يُحسب');
  eq(spokenLength('نعم، لا!'), 5, 'علامات الوقف والمسافات لا تُحسب');
  eq(spokenLength('‏Satr‏'), 4, 'علامات الاتجاه لا تُحسب');
  eq(spokenLength(''), 0, 'فارغ');

  // ── التقسيم ──
  eq(splitCues(''), [], 'نص فارغ');
  eq(splitCues('   '), [], 'مسافات فقط');
  eq(splitCues('أهلاً بكم. كيف الحال؟ بخير'), ['أهلاً بكم.', 'كيف الحال؟', 'بخير'], 'التقسيم عند علامات الوقف');
  eq(splitCues('واحد اثنان ثلاثة أربعة خمسة ستة سبعة ثمانية تسعة', 4), ['واحد اثنان ثلاثة أربعة', 'خمسة ستة سبعة ثمانية تسعة'], 'لا كلمة يتيمة في آخر مقطع');
  eq(splitCues('واحد اثنان ثلاثة أربعة خمسة ستة سبعة ثمانية تسعة عشرة', 4), ['واحد اثنان ثلاثة أربعة', 'خمسة ستة سبعة ثمانية', 'تسعة عشرة'], 'كل maxWords كلمة');
  eq(splitCues('كلمة'), ['كلمة'], 'كلمة واحدة');
  ok(splitCues('ك '.repeat(5000)).join(' ').length <= MAX_VOICEOVER, 'النص يُقصّ عند الحد');

  // ── التوقيت ──
  const cues = subtitleCues('نعم. العربية لغة جميلة جداً وواسعة', 6000);
  eq(cues.length, 2, 'مقطعان');
  eq([cues[0].start_ms, cues[cues.length - 1].end_ms], [0, 6000], 'يغطي المدة كلها');
  for (let i = 1; i < cues.length; i += 1) assert.strictEqual(cues[i].start_ms, cues[i - 1].end_ms, 'بلا فجوات');
  checks += 1;
  ok(cues[1].end_ms - cues[1].start_ms > (cues[0].end_ms - cues[0].start_ms) * 4, 'المقطع الأطول يأخذ زمناً أطول');
  eq(cues[0].end_ms, Math.round(6000 * 3 / (3 + 24)), 'النسبة بعدد الحروف المنطوقة');
  const plain = subtitleCues('العربية لغة. جميلة جداً', 4000), marked = subtitleCues('العَرَبِيَّةُ لُغَةٌ. جَمِيلَةٌ جِدّاً', 4000);
  eq(plain.map((cue) => cue.end_ms), marked.map((cue) => cue.end_ms), 'التشكيل لا يغيّر التوقيت');
  eq(subtitleCues('نص', 0), [], 'مدة صفرية');
  eq(subtitleCues('', 5000), [], 'بلا نص');
  eq(cueAt(cues, 0).text, 'نعم.', 'أول مقطع');
  eq(cueAt(cues, cues[0].end_ms).text, cues[1].text, 'الحد ينتمي للمقطع التالي');
  eq(cueAt(cues, 6000), null, 'بعد النهاية');
  eq(cueAt(null, 10), null, 'بلا مقاطع');

  // ── المساحات الآمنة كما في الخطة ──
  eq(SAFE_AREAS['9:16'], { top: 0.14, bottom: 0.20 }, 'سناب / تيك توك / ريلز');
  eq(SAFE_AREAS['1:1'], { top: 0.06, bottom: 0.06 }, 'إنستقرام مربع');
  eq(SAFE_AREAS['16:9'], { top: 0.06, bottom: 0.08 }, 'يوتيوب / X');
  eq(safeArea('bogus'), SAFE_AREAS['16:9'], 'مقاس مجهول ⇒ العرضي');

  // ── تنقية الحقول في main ──
  const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-promo-text-'));
  try {
    const clip = path.join(downloads, 'clip.mp4');
    fs.writeFileSync(clip, 'x');
    const clean = (extra) => studio.sanitizeStoryboard({ scenes: [{ asset: clip, duration_ms: 3000, ...extra }] }, { downloadsPath: downloads }).storyboard.scenes[0];
    const base = clean({});
    eq([base.text_style, base.voiceover_ar, base.subtitles], [{ animation: 'none', font: 'plex', highlight: '' }, '', false], 'الافتراضي = مظهر v1');
    eq(clean({ text_style: { animation: 'words', highlight: '  Pro  ', font: 'cairo' } }).text_style, { animation: 'words', font: 'cairo', highlight: 'Pro' }, 'قيم صالحة');
    eq(clean({ text_style: { font: 'naskh' } }).text_style.font, 'naskh', 'الخط النسخي');
    for (const bad of ['Comic Sans', 'url(x)', 7, null, ['cairo']]) eq(clean({ text_style: { font: bad } }).text_style.font, 'plex', 'خط خارج القائمة يعود للافتراضي: ' + JSON.stringify(bad));
    eq(clean({ text_style: { animation: 'explode', highlight: 7 } }).text_style, { animation: 'none', font: 'plex', highlight: '' }, 'حركة مجهولة وإبراز غير نصي');
    eq(clean({ text_style: { highlight: 'كلمتان هنا' } }).text_style.highlight, 'كلمتان', 'الإبراز كلمة واحدة');
    eq(clean({ text_style: { highlight: 'ط'.repeat(500) } }).text_style.highlight.length, 60, 'الإبراز محدود الطول');
    eq(clean({ text_style: 'words' }).text_style, { animation: 'none', font: 'plex', highlight: '' }, 'text_style ليس كائناً');
    eq(clean({ text_style: ['words'] }).text_style, { animation: 'none', font: 'plex', highlight: '' }, 'text_style مصفوفة');
    eq(clean({ voiceover_ar: '  أهلاً\n\n بكم  ' }).voiceover_ar, 'أهلاً بكم', 'تطبيع المسافات');
    eq(clean({ voiceover_ar: 'ن'.repeat(5000) }).voiceover_ar.length, 2000, 'نص التعليق محدود');
    eq(clean({ voiceover_ar: { text: 'x' } }).voiceover_ar, '', 'نص التعليق غير نصي');
    eq(clean({ subtitles: true }).subtitles, false, 'ترجمة بلا نص تعليق = معطّلة');
    eq(clean({ subtitles: true, voiceover_ar: 'نص' }).subtitles, true, 'ترجمة مع نص');
    eq(clean({ subtitles: 'yes', voiceover_ar: 'نص' }).subtitles, false, 'قيمة غير منطقية');
    // جولة حفظ/تحميل
    const file = path.join(downloads, 'p.satr-promo.json');
    const board = { aspect: '9:16', scenes: [{ asset: clip, duration_ms: 3000, caption: 'Satr Pro متاح الآن', text_style: { animation: 'slide', highlight: 'Pro', font: 'naskh' }, voiceover_ar: 'أهلاً بكم', subtitles: true }] };
    eq(studio.saveProject(downloads, board, file).ok, true, 'حفظ');
    const loaded = studio.loadProject(file, downloads).storyboard;
    eq([loaded.aspect, loaded.scenes[0].text_style, loaded.scenes[0].voiceover_ar, loaded.scenes[0].subtitles], ['9:16', { animation: 'slide', font: 'naskh', highlight: 'Pro' }, 'أهلاً بكم', true], 'الحقول تعود كما حُفظت');
  } finally {
    fs.rmSync(downloads, { recursive: true, force: true });
  }

  console.log('promo-subtitles-test: ok — ' + checks + ' فحصاً (وزن النطق، التقسيم، التوقيت، المساحات الآمنة، تنقية حقول العناوين).');
})().catch((error) => {
  console.error('promo-subtitles-test:', error && error.stack ? error.stack : error);
  process.exit(1);
});
