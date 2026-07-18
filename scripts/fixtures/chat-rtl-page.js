// fixture اتجاه المحتوى المختلط في المحادثة (دفعة RTL — لقطات مالك 2026-07-18):
// الفقرة/العنصر العربي الجوهر البادئ برمز لاتيني يجب أن يرسو RTL بالحسم الإحصائي،
// والفقرة الإنجليزية الخالصة LTR، وكتل الكود تبقى LTR كما هي.
const violations = [];
window.addEventListener('securitypolicyviolation', (event) => {
  violations.push({ directive: event.effectiveDirective, blockedURI: event.blockedURI });
});

function assert(condition, message) { if (!condition) throw new Error(message); }

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await customElements.whenDefined('satr-chat');
    const chat = document.querySelector('satr-chat');

    // 1. فقاعة مستخدم عربية الجوهر تبدأ برمز لاتيني (نمط البرومبت التقني)
    chat.addUserMsg('test:design-guard شغّله ثم راجع baseline المتبقي بالعدّ الجديد.');
    const userBubble = document.querySelector('.msg.user .bubble');
    assert(userBubble && userBubble.dir === 'rtl',
      'فقاعة المستخدم العربية البادئة برمز لاتيني يجب أن تُحسم rtl إحصائياً.');

    // 2. فقاعة مستخدم إنجليزية خالصة تبقى ltr
    chat.addUserMsg('Run the full suite and report raw results only.');
    const bubbles = document.querySelectorAll('.msg.user .bubble');
    assert(bubbles[1] && bubbles[1].dir === 'ltr',
      'الفقاعة الإنجليزية الخالصة يجب أن تُحسم ltr.');

    // 3. رد مساعد مختلط: فقرة عربية تبدأ برمز + فقرة إنجليزية + قائمة مختلطة + كود
    const block = chat.newAssistantBlock('اختبار');
    block.addText([
      'SPACE_DECL_RE غير مربوط ببداية التصريح، فيلتقط خصائص أخرى بالخطأ.',
      '',
      'Pure English paragraph stays left to right.',
      '',
      '- `--card-padding: 10px` أفشل الحارس بينما background-position أُهمل صحيحاً.',
      '- Second bullet is entirely English text.',
      '',
      '```',
      'const x = 1;',
      '```',
    ].join('\n'));
    block.finish({});

    const paragraphs = document.querySelectorAll('.msg.assistant .md p');
    assert(paragraphs.length >= 2, 'يجب أن تُبنى فقرتا الرد.');
    assert(paragraphs[0].getAttribute('dir') === 'rtl',
      'الفقرة العربية البادئة بـ SPACE_DECL_RE يجب أن تُحسم rtl.');
    assert(paragraphs[1].getAttribute('dir') === 'ltr',
      'الفقرة الإنجليزية الخالصة يجب أن تُحسم ltr.');

    const listItems = document.querySelectorAll('.msg.assistant .md li bdi');
    assert(listItems.length === 2, 'يجب أن يُبنى عنصرا القائمة داخل bdi.');
    assert(listItems[0].getAttribute('dir') === 'rtl',
      'عنصر القائمة العربي البادئ بكود يجب أن يُحسم rtl.');
    assert(listItems[1].getAttribute('dir') === 'ltr',
      'عنصر القائمة الإنجليزي يجب أن يُحسم ltr.');

    // 4. كتلة الكود تبقى LTR بأساس CSS الثابت (لا dir معاكس عليها)
    const pre = document.querySelector('.msg.assistant .md pre');
    assert(pre && getComputedStyle(pre).direction === 'ltr',
      'كتلة الكود يجب أن تبقى LTR.');

    // 5. الرسو المحسوب: الفقرة rtl ترسو يميناً فعلاً داخل Chromium
    assert(getComputedStyle(paragraphs[0]).direction === 'rtl',
      'اتجاه الفقرة المحسوب يجب أن يكون rtl.');

    assert(violations.length === 0, 'رُصد securitypolicyviolation.');
    window.__chatRtlResult = { pass: true };
  } catch (error) {
    window.__chatRtlResult = {
      pass: false,
      error: error && error.stack ? error.stack : String(error),
      violations,
    };
  }
});
