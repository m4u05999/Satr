// fixture قرائية الردود (جولة 2026-09-10): يعرض الرد النموذجي المعتمد للقبول حرفياً
// عبر مكوّن chat الإنتاجي تحت CSP، ثم يقيس العارض (صفر تسرّب + البنية) والتصميم
// (سلّم العناوين والهوامش وعمود النثر) في Chromium الفعلي — لا نسخة موازية من المنطق.
const violations = [];
window.addEventListener('securitypolicyviolation', (event) => {
  violations.push({ directive: event.effectiveDirective, blockedURI: event.blockedURI });
});

function assert(condition, message) { if (!condition) throw new Error(message); }

// الرد النموذجي — نسخة واحدة يتشاركها الحارس ومشاهد ui:audit والقبول البشري
// (‏docs/READABILITY-PLAN.md)؛ أي تغيير فيه يُغيّر المعايير الثلاثة معاً. وفيه كتلة كود
// كي يُقاس أن الكود بالعرض الكامل لا بعمود النثر.
const SAMPLE_REPLY = [
  '## تحليل مشكلة بطء الصفحة الرئيسية',
  'بعد فحص الصفحة والشبكة وجدت أن السبب الرئيسي هو تحميل ثلاث صور كبيرة بلا ضغط، إضافة إلى سكربت خارجي يحجب العرض الأول، كما أن الخط العربي يُحمَّل من خادم بعيد بلا unicode-range فيتأخر ظهور النص العربي حتى اكتمال التنزيل، وهذا يفسّر ما رأيته من وميض النص. هناك أيضاً استعلامان مكرران لواجهة البيانات نفسها في أول ثانية.',
  '### الأسباب مرتبة بالأثر',
  '1. الصور الثلاث في قسم الهيرو بحجم 4.2 ميجابايت مجتمعة.',
  '2. سكربت التتبع يُحمَّل في الرأس بلا `defer`.',
  '3. الخط العربي بلا `font-display: swap`.',
  '#### تفصيل الصور',
  '- الصورة الأولى 1.9 ميجابايت',
  '  - يمكن تحويلها إلى WebP بجودة 80',
  '  - النتيجة المتوقعة نحو 210 كيلوبايت',
  '- الصورة الثانية 1.4 ميجابايت',
  '```bash',
  'cwebp -q 80 hero-1.jpg -o hero-1.webp',
  '```',
  '> ملاحظة: القياس على اتصال 4G محاكى، والأرقام تقريبية.',
  '| الإجراء | الأثر المتوقع | الكلفة |',
  '|---|---|---|',
  '| ضغط الصور | −70% من زمن التحميل | منخفضة |',
  '| تأجيل السكربت | −400 مللي ثانية | منخفضة |',
  '| استضافة الخط محلياً | يزول الوميض | متوسطة |',
  '### الخطوة التالية',
  'أقترح أن نبدأ بضغط الصور لأنها **أكبر أثر بأقل كلفة**، ثم تأجيل السكربت، وأخيراً الخط. تفاصيل التنفيذ في [دليل الأداء](https://example.com/perf). هل أبدأ بالصور الآن؟',
].join('\n');

// علامات كانت تتسرّب حرفياً قبل الجولة — يجب ألا يظهر أي منها نصاً في العارض
const LEAK_PATTERNS = [
  ['####', /#{2,}/],
  ['اقتباس >', /(^|\n)\s*>/],
  ['رابط [نص](رابط)', /\]\(/],
  ['غامق **', /\*\*/],
  ['قائمة مهام [ ]', /\[[ xX]\]/],
];

function px(value) { return parseFloat(value) || 0; }
function measureHeading(el) {
  const cs = getComputedStyle(el);
  return { size: px(cs.fontSize), weight: Number(cs.fontWeight), color: cs.color, top: px(cs.marginTop), bottom: px(cs.marginBottom) };
}

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await customElements.whenDefined('satr-chat');
    await document.fonts.ready;
    const chat = document.querySelector('satr-chat');
    chat.addUserMsg('لماذا الصفحة الرئيسية بطيئة؟');
    const block = chat.newAssistantBlock('اختبار القرائية');
    block.addText(SAMPLE_REPLY);
    block.finish({});

    const md = document.querySelector('.msg.assistant .answer-wrap .md');
    assert(md, 'يجب أن تُبنى إجابة الرد النموذجي.');

    // ---------- العارض: صفر تسرّب ----------
    const text = md.textContent;
    for (const [label, re] of LEAK_PATTERNS) {
      assert(!re.test(text), 'علامة متسربة في نص العارض: ' + label);
    }
    assert(!md.querySelector('a'), 'لا وسم <a> — الروابط نصٌّ ظاهر بلا فتح تلقائي.');

    // ---------- العارض: البنية ----------
    const count = (sel) => md.querySelectorAll(sel).length;
    assert(count('h1') === 0 && count('h2') === 1 && count('h3') === 2 && count('h4') === 1,
      'العناوين: h2=1 وh3=2 و####⇒h4=1 — وجد ' + [count('h1'), count('h2'), count('h3'), count('h4')].join('/'));
    assert(count('ol > li') === 3, 'القائمة المرقمة بثلاثة عناصر.');
    assert(count('.md > ul > li') === 2, 'القائمة النقطية بعنصرين في المستوى الأول.');
    assert(count('.md > ul > li > ul > li') === 2, 'القائمة المتداخلة بعنصرين تحت الصورة الأولى.');
    const quote = md.querySelector('blockquote');
    assert(quote && /ملاحظة/.test(quote.textContent) && quote.querySelector('p'), 'الاقتباس يُبنى blockquote بفقرة داخله.');
    assert(count('table thead th') === 3 && count('table tbody tr') === 3, 'الجدول 3 أعمدة و3 صفوف.');
    const link = md.querySelector('.md-link');
    const linkUrl = md.querySelector('.md-link-url');
    assert(link && /دليل الأداء/.test(link.textContent), 'الرابط يعرض نصه.');
    assert(linkUrl && linkUrl.getAttribute('dir') === 'ltr' && linkUrl.textContent === '(https://example.com/perf)',
      'عنوان الرابط يظهر LTR بين قوسين بلا فتح.');
    assert(md.querySelector('strong') && !/\*\*/.test(md.textContent), 'الغامق يُرسم strong.');
    assert(md.querySelectorAll(':not(pre) > code').length === 2, 'مقطعا الكود داخل القائمة المرقمة.');
    assert(count('pre > code') === 1 && /cwebp/.test(md.querySelector('pre').textContent), 'كتلة الكود تُبنى pre.');
    const firstP = md.querySelector('p');
    assert(firstP && firstP.getAttribute('dir') === 'rtl', 'الفقرة الأولى العربية تُحسم rtl (الاتجاه الإحصائي لا يُمسّ).');
    for (const bdi of md.querySelectorAll('li > bdi')) {
      assert(bdi.getAttribute('dir') === 'rtl', 'عناصر القوائم العربية تُحسم rtl داخل bdi.');
    }

    // ---------- العارض: حالات لم يشملها الرد النموذجي ----------
    const extra = chat.newAssistantBlock('اختبار الحالات الإضافية');
    extra.addText([
      '##### مستوى خامس',
      '###### مستوى سادس ##',
      '- [ ] مهمة مفتوحة',
      '- [x] مهمة منجزة',
      '1. أولاً',
      '   1. فرع مرقم',
      '2. ثانياً',
      'نص فيه `[ليس](رابطاً)` داخل كود و![صورة](https://example.com/a.png) بعده.',
      '',
      '~~خطة قديمة~~ ألغيناها لصالح الضغط.',
      '',
      '| الخطوة | التفاصيل |',
      '|---|---|',
      '| الضغط | WebP<br>بجودة 80 |',
      '',
      '> اقتباس أول',
      '> - عنصر داخل الاقتباس',
    ].join('\n'));
    extra.finish({});
    const mds = document.querySelectorAll('.msg.assistant .answer-wrap .md');
    const md2 = mds[mds.length - 1];
    const c2 = (sel) => md2.querySelectorAll(sel).length;
    assert(c2('h4') === 2 && c2('h5') === 0 && c2('h6') === 0, 'المستويان الخامس والسادس يُرسمان h4.');
    assert(!/#/.test(md2.querySelectorAll('h4')[1].textContent), 'علامات # الذيلية تُزال من العنوان.');
    assert(c2('li.md-task') === 2 && c2('li.md-task.done') === 1, 'قائمتا المهام: عنصران أحدهما منجز.');
    assert(!/\[[ x]\]/.test(md2.textContent), 'علامة المهمة لا تظهر نصاً.');
    assert(c2('.md > ol > li') === 2 && c2('.md > ol > li > ol > li') === 1, 'القائمة المرقمة المتداخلة.');
    const codeSpan = md2.querySelector('p code');
    assert(codeSpan && codeSpan.textContent === '[ليس](رابطاً)' && !codeSpan.querySelector('.md-link'),
      'الرابط داخل مقطع الكود يبقى حرفياً.');
    assert(c2('p .md-link') === 1 && /صورة/.test(md2.querySelector('p .md-link').textContent), 'الصورة تُعرض نصاً بديلاً + عنوانها.');
    assert(md2.querySelector('blockquote ul li'), 'قائمة داخل الاقتباس تُعرض قائمة.');
    // تنظيف العلامات غير المدعومة سابقاً: الشطب و<br> داخل خلية الجدول
    const del = md2.querySelector('p del');
    assert(del && del.textContent === 'خطة قديمة' && !/~~/.test(md2.textContent), 'الشطب ~~ يُرسم del بلا علاماته.');
    const brCell = Array.from(md2.querySelectorAll('td')).find((td) => td.querySelector('br'));
    assert(brCell && !/<br/i.test(md2.textContent), 'وسم <br> داخل الخلية سطرٌ جديد لا نصٌّ ظاهر.');

    // ---------- التصميم: سلّم العناوين والهوامش ----------
    const p = measureHeading(firstP);
    const h2 = measureHeading(md.querySelector('h2'));
    const h3 = measureHeading(md.querySelector('h3'));
    const h4 = measureHeading(md.querySelector('h4'));
    assert(h2.size > h3.size && h3.size > p.size && h4.size >= p.size,
      'سلّم الأحجام h2 > h3 > p ≤ h4 — وجد ' + [h2.size, h3.size, h4.size, p.size].join('/'));
    assert(h2.size / p.size >= 1.25 && h2.size / p.size <= 1.32, 'h2 نحو 1.28× المتن — وجد ' + (h2.size / p.size).toFixed(2));
    assert(h2.weight >= 700 && h3.weight === 500 && h4.weight >= 700, 'الأوزان: h2 700 · h3 500 · h4 700.');
    const gold = getComputedStyle(document.documentElement).getPropertyValue('--gold').trim();
    const probe = document.createElement('span');
    probe.style.color = gold; document.body.appendChild(probe);
    const goldRgb = getComputedStyle(probe).color; probe.remove();
    assert(h2.color === goldRgb, 'h2 ذهبي بلون token --gold.');
    assert(h3.color === p.color, 'h3 بلون المتن لا لون ثانٍ.');
    // h2 هو أول عنصر في الإجابة ⇒ بلا هامش علوي (لا فراغ فوق أول عنوان)؛ h3 وسط الإجابة
    // ⇒ هامشه أعلاه أكبر بوضوح من أسفله كي يرتبط العنوان بما يليه لا بما قبله.
    assert(md.firstElementChild === md.querySelector('h2') && h2.top === 0, 'العنوان الأول في الإجابة بلا هامش علوي.');
    assert(h3.top > h3.bottom * 3 && h4.top > h4.bottom * 3, 'هامش العنوان أعلاه أكبر من أسفله — وجد ' + h3.top + '/' + h3.bottom);

    // ---------- التصميم: عمود النثر ----------
    const bubble = md.closest('.bubble');
    const bubbleInner = bubble.clientWidth - px(getComputedStyle(bubble).paddingLeft) - px(getComputedStyle(bubble).paddingRight);
    const pRect = firstP.getBoundingClientRect();
    // محارف السطر تُقاس من عرض الحبر الفعلي: مجموع عرض مقاطع الأسطر ÷ عدد المحارف يعطي
    // عرض المحرف الفعلي في هذا الخط، ثم عرض الفقرة ÷ عرض المحرف = محارف السطر الممتلئ.
    // (قسمة العدد الكلي على عدد الأسطر تضلّل: السطر الأخير ناقص فتصغر النسبة زوراً.)
    const range = document.createRange();
    range.selectNodeContents(firstP);
    const rects = Array.from(range.getClientRects());
    const lines = new Set(rects.map((r) => Math.round(r.top))).size;
    const inkWidth = rects.reduce((sum, r) => sum + r.width, 0);
    const pxPerChar = inkWidth / firstP.textContent.length;
    const charsPerLine = pRect.width / pxPerChar;
    assert(pRect.width < bubbleInner - 40, 'الفقرة أضيق من الفقاعة (عمود النثر) — ' + Math.round(pRect.width) + ' من ' + Math.round(bubbleInner));
    // معيار الخطة: سطر النثر «لا يتجاوز ~70 محرفاً» (≈11 كلمة؛ الحرف العربي هنا ≈6.1px
    // فـ45ch ≈ 419px ≈ 68 محرفاً). السقف 72 هامش «~»، والأرضية 60 كي لا يضيق العمود حتى
    // تتكسّر الجمل — لا معيار لاتيني (66ch) ولا الوضع القديم (~105).
    assert(charsPerLine >= 60 && charsPerLine <= 72, 'سطر النثر نحو 60–72 محرفاً — وجد ' + charsPerLine.toFixed(1) + ' على ' + lines
      + ' أسطر (عرض ' + Math.round(pRect.width) + 'px، max-width ' + getComputedStyle(firstP).maxWidth + ')');
    const table = md.querySelector('table');
    assert(table.getBoundingClientRect().left >= bubble.getBoundingClientRect().left, 'الجدول داخل الفقاعة.');
    assert(getComputedStyle(table).maxWidth === '100%' || px(getComputedStyle(table).maxWidth) >= bubbleInner - 1,
      'الجدول لا يقيّده عمود النثر (max-width 100%).');
    const preRect = md.querySelector('pre').getBoundingClientRect();
    assert(preRect.width >= bubbleInner - 24 && preRect.width > pRect.width + 40,
      'كتلة الكود بالعرض الكامل لا بعمود النثر — ' + Math.round(preRect.width) + 'px مقابل النثر ' + Math.round(pRect.width) + 'px');
    assert(getComputedStyle(md.querySelector('ul')).maxWidth !== 'none', 'القوائم داخل عمود النثر.');
    assert(getComputedStyle(quote).maxWidth !== 'none', 'الاقتباس داخل عمود النثر.');

    assert(violations.length === 0, 'رُصد securitypolicyviolation.');
    window.__chatMdResult = {
      pass: true,
      measures: {
        h2: h2.size, h3: h3.size, h4: h4.size, p: p.size, h2Top: h2.top, h2Bottom: h2.bottom,
        proseWidth: Math.round(pRect.width), bubbleInner: Math.round(bubbleInner), charsPerLine: Number(charsPerLine.toFixed(1)), lines,
        preWidth: Math.round(preRect.width),
      },
    };
  } catch (error) {
    window.__chatMdResult = { pass: false, error: error && error.stack ? error.stack : String(error), violations };
  }
});
