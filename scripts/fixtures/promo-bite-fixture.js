// اختبار العضّة العربي: يرسم العناوين في ثلاث لحظات ويتحقق من الترتيب البصري والمساحة الآمنة.

import { layoutText, drawTitle, drawSubtitle, FONT_FAMILY, clearTextCaches } from '../../src/ui/lib/promo/promo-text.js';
import { safeArea, subtitleCues, cueAt } from '../../src/ui/lib/promo/promo-subtitles.js';

export const TITLES = [
  'Satr Pro متاح الآن',
  'حمّل تطبيق Satr Pro الآن',
  'العَرَبِيَّةُ لُغَةٌ جَمِيلَةٌ',
  'لا تقلق، الإصدار (تجريبي) جاهز؟',
  'خصم ٢٥٪ حتى ١٥ نوفمبر',
  'خصم 25% حتى 15 نوفمبر',
  'احجز موعدك في أقل من 30 ثانية — بدون تسجيل',
];

// الترتيب البصري المتوقع من اليمين إلى اليسار، بفهارس القراءة. مكتوب باليد من قراءة العنوان،
// لا مشتق من الكود المختبَر.
const VISUAL_RTL = {
  0: [1, 0, 2, 3],          // [Satr Pro] ثم متاح ثم الآن: «Pro» أيمن «Satr» داخل المقطع اللاتيني
  1: [0, 1, 3, 2, 4],       // حمّل، تطبيق، [Satr Pro]، الآن
  2: [0, 1, 2],
  4: [0, 1, 2, 3, 4],
  5: [0, 1, 2, 3, 4],
};

const COLORS = { background: '#0b0f14', captionBackground: '#1a2230', captionText: '#ffffff', accent: '#d9a441' };
const bright = (r, g, b) => r > 215 && g > 215 && b > 215;

function bbox(canvas, test) {
  const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1, count = 0;
  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const i = (y * canvas.width + x) * 4;
      if (test(data[i], data[i + 1], data[i + 2])) {
        count += 1;
        if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  return count ? { left: minX, top: minY, right: maxX + 1, bottom: maxY + 1, count } : { count: 0 };
}

function render(text, width, height, aspect, localMs, style, position = 'bottom') {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d', { alpha: false });
  context.fillStyle = COLORS.background; context.fillRect(0, 0, width, height);
  const result = drawTitle(context, text, { width, height, colors: COLORS, aspect, localMs, position, boxStyle: 'box', style });
  return { canvas, result };
}

async function run() {
  await document.fonts.load('700 100px "IBM Plex Sans Arabic"', 'متاح Satr ٢٥');
  await document.fonts.load('500 60px "IBM Plex Sans Arabic"', 'متاح Satr ٢٥');
  clearTextCaches();
  const failures = [];
  const expect = (label, condition, detail) => { if (!condition) failures.push(label + ': ' + JSON.stringify(detail === undefined ? null : detail)); };
  const images = [];
  const summary = [];
  const W = 1080, H = 1920, aspect = '9:16';
  const safe = safeArea(aspect);

  TITLES.forEach((text, titleIndex) => {
    const label = 'العنوان ' + (titleIndex + 1);
    const full = render(text, W, H, aspect, 60000, { animation: 'words' });
    const layout = full.result.layout;
    const words = layout.lines.flatMap((line) => line.words);
    summary.push({ text, dir: layout.dir, lines: layout.lines.length, mismatch: Math.round(layout.mismatch * 100) / 100 });

    expect(label + ' — حارس التطابق DOM/canvas ≤ 1 بكسل', layout.mismatch <= 1, layout.mismatch);
    expect(label + ' — الاتجاه rtl', layout.dir === 'rtl', layout.dir);
    expect(label + ' — كل الكلمات مرسومة', full.result.visibleWords === words.length && words.length === text.split(' ').length, [full.result.visibleWords, words.length]);

    // (1) داخل المساحة الآمنة وداخل اللوحة
    const box = full.result.box;
    expect(label + ' — الكتلة داخل المساحة الآمنة', box.boxY >= Math.round(H * safe.top) && box.boxY + box.boxHeight <= H - Math.round(H * safe.bottom)
      && box.boxX >= 0 && box.boxX + box.boxWidth <= W, box);
    const ink = bbox(full.canvas, bright);
    expect(label + ' — الحبر داخل الكتلة', ink.count > 200 && ink.left >= box.boxX && ink.right <= box.boxX + box.boxWidth && ink.top >= box.boxY && ink.bottom <= box.boxY + box.boxHeight, { ink, box });

    // (2) الترتيب البصري للسطر الأول يطابق المكتوب باليد
    if (VISUAL_RTL[titleIndex] && layout.lines.length === 1) {
      const order = layout.lines[0].words.slice().sort((a, b) => b.left - a.left).map((word) => word.index);
      expect(label + ' — الترتيب البصري من اليمين', JSON.stringify(order) === JSON.stringify(VISUAL_RTL[titleIndex]), order);
    }

    // (3) القطع تغطي السطر بلا تداخل: الكشف الكامل = رسم السطر مباشرة بـfillText
    const reference = document.createElement('canvas'); reference.width = W; reference.height = H;
    const context = reference.getContext('2d', { alpha: false });
    context.fillStyle = COLORS.background; context.fillRect(0, 0, W, H);
    context.fillStyle = COLORS.captionBackground; context.fillRect(box.boxX, box.boxY, box.boxWidth, box.boxHeight);
    context.font = '700 ' + layout.fontSize + 'px ' + FONT_FAMILY;
    context.direction = layout.dir; context.textAlign = 'left'; context.textBaseline = 'middle'; context.fillStyle = COLORS.captionText;
    layout.lines.forEach((line, lineIndex) => {
      context.fillText(line.text, Math.round(box.boxX + box.padding + line.left), Math.round(box.boxY + box.padding + lineIndex * layout.lineHeight) + layout.lineHeight / 2);
    });
    const a = full.canvas.getContext('2d').getImageData(box.boxX, box.boxY, box.boxWidth, box.boxHeight).data;
    const b = reference.getContext('2d').getImageData(box.boxX, box.boxY, box.boxWidth, box.boxHeight).data;
    let differing = 0;
    for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) > 24) differing += 1;
    expect(label + ' — الكشف بالقص يطابق السطر المرسوم مباشرة (لا كسر وصل ولا فواصل)', differing / (a.length / 4) < 0.002, { differing, pixels: a.length / 4 });

    // (4) أول ما يظهر هو أول كلمة في القراءة، داخل قطعتها فقط
    const early = render(text, W, H, aspect, 100, { animation: 'words' });
    const first = words.find((word) => word.index === 0);
    const firstLine = layout.lines.findIndex((line) => line.words.includes(first));
    const earlyInk = bbox(early.canvas, (r, g, b2) => r > 90 && g > 90 && b2 > 90);
    const wordLeft = box.boxX + box.padding + first.left, wordRight = wordLeft + first.width;
    const gap = layout.fontSize * 0.45;
    expect(label + ' — عند 100ms يظهر حبر', early.result.visibleWords === 1 && earlyInk.count > 20, { visible: early.result.visibleWords, earlyInk });
    expect(label + ' — الحبر المبكر داخل قطعة أول كلمة في القراءة', earlyInk.count > 0 && earlyInk.left >= wordLeft - gap && earlyInk.right <= wordRight + gap
      && earlyInk.top >= box.boxY + firstLine * layout.lineHeight && earlyInk.bottom <= box.boxY + box.padding * 2 + (firstLine + 1) * layout.lineHeight + layout.fontSize, { earlyInk, wordLeft, wordRight, word: first.text });

    const middleMs = 110 * Math.floor(words.length / 2) + 200;
    const middle = render(text, W, H, aspect, middleMs, { animation: 'words' });
    expect(label + ' — المنتصف يكشف بعض الكلمات لا كلها', middle.result.visibleWords > 1 && (words.length < 3 || bbox(middle.canvas, bright).count < ink.count), middle.result.visibleWords);

    const name = String(titleIndex + 1).padStart(2, '0');
    images.push({ name: name + '-1-early.png', data: early.canvas.toDataURL('image/png') });
    images.push({ name: name + '-2-middle.png', data: middle.canvas.toDataURL('image/png') });
    images.push({ name: name + '-3-full.png', data: full.canvas.toDataURL('image/png') });

    // (5) المقاسان الآخران: داخل المساحة الآمنة أيضاً، في المواضع الثلاثة
    for (const [w, h, other] of [[1920, 1080, '16:9'], [1080, 1080, '1:1']]) {
      for (const position of ['top', 'center', 'bottom']) {
        const item = render(text, w, h, other, 60000, { animation: 'words' }, position);
        const area = safeArea(other), itemBox = item.result.box;
        expect(label + ' — ' + other + ' ' + position + ' داخل المساحة الآمنة', itemBox.boxY >= Math.round(h * area.top) && itemBox.boxY + itemBox.boxHeight <= h - Math.round(h * area.bottom)
          && itemBox.boxX >= 0 && itemBox.boxX + itemBox.boxWidth <= w && item.result.layout.mismatch <= 1, { itemBox, mismatch: item.result.layout.mismatch });
      }
    }
  });

  // إبراز كلمة بلون الهوية
  const gold = (r, g, b) => r > 190 && g > 130 && g < 190 && b < 110;
  const highlighted = render(TITLES[0], W, H, aspect, 60000, { animation: 'none', highlight: 'Pro' });
  const goldInk = bbox(highlighted.canvas, gold);
  const pro = highlighted.result.layout.lines[0].words.find((word) => word.text === 'Pro');
  const proLeft = highlighted.result.box.boxX + highlighted.result.box.padding + pro.left;
  expect('الإبراز يلوّن الكلمة المطلوبة فقط', goldInk.count > 100 && goldInk.left >= proLeft - 30 && goldInk.right <= proLeft + pro.width + 30, { goldInk, proLeft, width: pro.width });
  expect('بلا إبراز لا لون هوية', bbox(render(TITLES[0], W, H, aspect, 60000, { animation: 'none' }).canvas, gold).count === 0);
  images.push({ name: '08-highlight.png', data: highlighted.canvas.toDataURL('image/png') });

  // الانزلاق والتكبير: يبدآن شفافين وينتهيان مطابقين للثابت
  for (const animation of ['slide', 'zoom']) {
    const start = bbox(render(TITLES[2], W, H, aspect, 0, { animation }).canvas, bright);
    const end = render(TITLES[2], W, H, aspect, 60000, { animation });
    const still = render(TITLES[2], W, H, aspect, 60000, { animation: 'none' });
    expect(animation + ' يبدأ بلا حبر', start.count === 0, start);
    expect(animation + ' ينتهي مطابقاً للثابت', JSON.stringify(bbox(end.canvas, bright)) === JSON.stringify(bbox(still.canvas, bright)));
  }
  // الحتمية: نفس الزمن مرتين
  const one = render(TITLES[1], W, H, aspect, 333, { animation: 'words' }).canvas.toDataURL();
  const two = render(TITLES[1], W, H, aspect, 333, { animation: 'words' }).canvas.toDataURL();
  expect('نفس الزمن ⇒ نفس البكسلات', one === two);

  // الترجمة على الشاشة: داخل المساحة الآمنة، وتتبدل مع الزمن
  const voice = 'أهلاً بكم في سطر، البيت العربي لأدوات الذكاء الاصطناعي. احجز موعدك في أقل من 30 ثانية!';
  const cues = subtitleCues(voice, 6000);
  const subtitle = (t) => {
    const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
    const context = canvas.getContext('2d', { alpha: false });
    context.fillStyle = COLORS.background; context.fillRect(0, 0, W, H);
    const reserved = drawSubtitle(context, cueAt(cues, t), { width: W, height: H, colors: COLORS, aspect });
    return { canvas, reserved };
  };
  const firstCue = subtitle(100), lastCue = subtitle(5900);
  const subInk = bbox(firstCue.canvas, bright);
  expect('الترجمة مرسومة داخل المساحة الآمنة السفلية', subInk.count > 100 && subInk.bottom <= H - Math.round(H * safe.bottom) && subInk.top > H * 0.5 && subInk.left >= 0 && subInk.right <= W, subInk);
  expect('الترجمة تحجز ارتفاعاً للعنوان', firstCue.reserved > 40, firstCue.reserved);
  expect('الترجمة تتبدل مع الزمن', firstCue.canvas.toDataURL() !== lastCue.canvas.toDataURL());
  images.push({ name: '09-subtitle.png', data: firstCue.canvas.toDataURL('image/png') });

  return { ok: !failures.length, failures, summary, images };
}

window.__promoBite = run().catch((error) => ({ ok: false, failures: [String(error && error.stack || error)], summary: [], images: [] }));
