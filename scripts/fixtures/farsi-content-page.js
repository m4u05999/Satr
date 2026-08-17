// fixture حيّ لـ«سلامة عرض المحتوى الفارسي»: النص المختلط يمرّ بمكوّني الإنتاج.
const FarsiText = String.raw`پژوهش چگونه ژرف‌تر گردد؟ ۰۱۲۳۴۵۶۷۸۹ — مسیر C:\repo\src\app.js و npm test`;
const FilePath = String.raw`C:\repo\src\app.js`;
const Command = 'npm test';
const FileContent = String.raw`// پژوهش ژرف‌تر با پ چ ژ گ ک ی و ۰۱۲۳۴۵۶۷۸۹
const filePath = "C:\\repo\\src\\app.js";
// اجرای آزمون npm test بدون تغییر مسیر
export default filePath;`;
const violations = [];

window.addEventListener('securitypolicyviolation', (event) => {
  violations.push({ directive: event.effectiveDirective, blockedURI: event.blockedURI });
});

window.satr = {
  readFile: async (_cwd, rel) => ({
    ok: true,
    rel,
    content: FileContent,
    bytes: new TextEncoder().encode(FileContent).length,
    version: 'a'.repeat(64),
    truncated: false,
  }),
  writeFile: async () => ({ ok: false, error: 'disabled_in_fixture' }),
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function zwnjCount(text) {
  return Array.from(text || '').filter((char) => char.codePointAt(0) === 0x200c).length;
}

function rangeRect(node, start, end) {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  return range.getBoundingClientRect();
}

function assertFirstCharacterAnchoredRight(element, label) {
  const node = element.firstChild;
  assert(node && node.nodeType === Node.TEXT_NODE, label + ': غابت عقدة النص الأولى.');
  const charRect = rangeRect(node, 0, 1);
  const box = element.getBoundingClientRect();
  const rightGap = box.right - charRect.right;
  const leftGap = charRect.left - box.left;
  assert(rightGap < leftGap,
    label + ': قياس أول محرف لم يثبت رسوه يميناً (' + rightGap + ' مقابل ' + leftGap + ').');
  return { rightGap, leftGap };
}

function assertLtrRun(node, fullText, run, label) {
  const start = fullText.indexOf(run);
  assert(start >= 0, label + ': غاب المقطع المطلوب.');
  const first = rangeRect(node, start, start + 1);
  const lastIndex = start + run.length - 1;
  const last = rangeRect(node, lastIndex, lastIndex + 1);
  assert(first.left < last.left,
    label + ': قياس المحرفين الطرفيين لم يثبت ترتيب LTR (' + first.left + ' ثم ' + last.left + ').');
  return { firstX: first.left, lastX: last.left };
}

function strongCounts(text) {
  return {
    arabicScript: (text.match(/[؀-ۿݐ-ݿ]/g) || []).length,
    latin: (text.match(/[A-Za-z]/g) || []).length,
  };
}

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await Promise.all([
      customElements.whenDefined('satr-chat'),
      customElements.whenDefined('satr-file-viewer'),
      document.fonts.ready,
    ]);

    const before = zwnjCount(FarsiText);
    assert(before === 1, 'بقاء ZWNJ: العدد قبل العرض ' + before + '، والمتوقع 1.');
    const counts = strongCounts(FarsiText);
    assert(counts.arabicScript * 2 >= counts.latin,
      'الحسم الإحصائي لم يجد المحتوى الفارسي غالباً: ' + JSON.stringify(counts));

    const chat = document.querySelector('satr-chat');
    chat.addUserMsg(FarsiText);
    const assistantMarkdown = FarsiText
      .replace(FilePath, '`' + FilePath + '`')
      .replace(Command, '`' + Command + '`');
    const block = chat.newAssistantBlock('اختبار');
    block.addText(assistantMarkdown);
    block.finish({});

    const userBubble = document.querySelector('.msg.user .bubble');
    const assistantParagraph = document.querySelector('.msg.assistant .md p');
    assert(userBubble && userBubble.textContent === FarsiText, 'فقاعة المستخدم غيّرت نص fixture.');
    assert(assistantParagraph && assistantParagraph.textContent === FarsiText, 'فقرة المساعد غيّرت نص fixture.');
    assert(userBubble.dir === 'rtl' && getComputedStyle(userBubble).direction === 'rtl',
      'فقاعة المستخدم الفارسية المختلطة ليست RTL صريحاً ومحسوباً.');
    assert(assistantParagraph.dir === 'rtl' && getComputedStyle(assistantParagraph).direction === 'rtl',
      'فقرة المساعد الفارسية المختلطة ليست RTL صريحاً ومحسوباً.');

    const userAnchor = assertFirstCharacterAnchoredRight(userBubble, 'فقاعة المستخدم');
    const assistantAnchor = assertFirstCharacterAnchoredRight(assistantParagraph, 'فقرة المساعد');
    const userNode = userBubble.firstChild;
    const pathRun = assertLtrRun(userNode, FarsiText, FilePath, 'مسار فقاعة المستخدم');
    const commandRun = assertLtrRun(userNode, FarsiText, Command, 'أمر فقاعة المستخدم');

    const inlineCode = Array.from(assistantParagraph.querySelectorAll('code'));
    assert(inlineCode.length === 2, 'يجب أن تعزل فقرة المساعد المسار والأمر داخل عنصري code.');
    assert(inlineCode[0].textContent === FilePath && inlineCode[1].textContent === Command,
      'عزل code غيّر المسار أو الأمر.');
    for (const code of inlineCode) {
      const style = getComputedStyle(code);
      assert(style.direction === 'ltr' && ['embed', 'isolate', 'isolate-override'].includes(style.unicodeBidi),
        'عنصر code غير معزول LTR: ' + code.textContent);
    }

    const userZwnj = zwnjCount(userBubble.textContent);
    const assistantZwnj = zwnjCount(assistantParagraph.textContent);
    assert(userZwnj === before,
      'بقاء ZWNJ فشل في فقاعة المستخدم: قبل=' + before + ' بعد=' + userZwnj + '.');
    assert(assistantZwnj === before,
      'بقاء ZWNJ فشل في فقرة المساعد: قبل=' + before + ' بعد=' + assistantZwnj + '.');

    const fontChecks = [];
    for (const weight of [400, 500, 700]) {
      const descriptor = weight + ' 24px "IBM Plex Sans Arabic"';
      await document.fonts.load(descriptor, 'پچژگ');
      const loaded = document.fonts.check(descriptor, 'پچژگ');
      assert(loaded, 'document.fonts.check فشل للحروف پچژگ في الوزن ' + weight + '.');
      const loadedFace = Array.from(document.fonts).some((face) =>
        face.family.replace(/["']/g, '') === 'IBM Plex Sans Arabic'
          && String(face.weight) === String(weight) && face.status === 'loaded');
      assert(loadedFace, 'لم تُحمّل FontFace المضمّنة فعلياً في الوزن ' + weight + '.');
      const probe = document.createElement('span');
      probe.textContent = 'پچژگ';
      probe.dir = 'rtl';
      probe.hidden = true;
      probe.style.fontFamily = 'IBM Plex Sans Arabic';
      probe.style.fontWeight = String(weight);
      document.body.appendChild(probe);
      assert(getComputedStyle(probe).fontFamily.includes('IBM Plex Sans Arabic'),
        'مسبار الخط لم يستخدم العائلة المضمّنة في الوزن ' + weight + '.');
      probe.remove();
      fontChecks.push({ weight, loaded, loadedFace });
    }

    const viewer = document.querySelector('satr-file-viewer');
    await viewer.open('D:\\fixture-project', 'src/farsi-proof.js');
    const root = viewer.shadowRoot;
    const pre = root.querySelector('pre');
    const lines = Array.from(root.querySelectorAll('.lt'));
    assert(pre && getComputedStyle(pre).direction === 'ltr' && !pre.classList.contains('rtl-doc'),
      'عارض ملف .js لم يبقَ LTR.');
    assert(lines.length === 4 && lines.every((line) => line.dir === 'ltr'
      && getComputedStyle(line).direction === 'ltr'), 'أسطر ملف .js ليست LTR كلها.');
    const comments = Array.from(root.querySelectorAll('.hl-c'));
    assert(comments.length === 2 && comments.every((comment) => /[پچژگکی]/.test(comment.textContent)
      || comment.textContent.includes('آزمون')), 'تظليل التعليقات الفارسية غائب أو ناقص.');
    assert(comments.every((comment) => getComputedStyle(comment).fontStyle === 'italic'),
      'فئة تظليل التعليق لم تُطبّق بصرياً.');
    assert(root.querySelectorAll('.hl-k').length >= 2 && root.querySelectorAll('.hl-s').length === 1,
      'تظليل كلمات JavaScript أو النص المقتبس غير سليم.');
    viewer.close();

    assert(violations.length === 0, 'رُصد securitypolicyviolation.');
    window.__farsiContentResult = {
      pass: true,
      counts,
      anchors: { user: userAnchor, assistant: assistantAnchor },
      ltrRuns: { path: pathRun, command: commandRun },
      zwnj: { before, user: userZwnj, assistant: assistantZwnj },
      fontChecks,
      viewer: { lines: lines.length, comments: comments.length },
    };
  } catch (error) {
    window.__farsiContentResult = {
      pass: false,
      error: error && error.stack ? error.stack : String(error),
      violations,
    };
  }
});
