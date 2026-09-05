/**
 * قياس OBS-124: هل يطابق إسقاط BiDi المخزنَ الذي يعرضه العارض الشبكي؟
 *
 * العارضان يقرآن مصدراً واحداً — العارض الشبكي **هو** نسخة xterm، وإسقاط BiDi يُبنى من
 * `tab.term.buffer.active` نفسها. فأي اختلاف بينهما انحرافٌ في الإسقاط لا اختلافُ عرض.
 * لذلك المقياس هنا: لكل عنصر `.bidi-line` معروض، هل نصّه يطابق سطر المخزن عند فهرسه؟
 *
 * نسخة xterm الحقيقية تُلتقط بالتفافٍ حول المُنشئ **قبل** تحميل المكوّن — بلا تعديل حرف
 * في المكوّن نفسه، فالمقيس هو كود الإنتاج لا نسخةٌ منه.
 */
const LINE_H = 20; // يطابق ثابت terminal-panel.js — لولاه لا يُشتق فهرس العنصر من موضعه
const TERM_ID = 'term_1';
const violations = [];
const scenarios = [];
const resizes = []; // كل تغيير أبعاد يصل pty — في التطبيق الحقيقي يعقبه إعادة رسم ConPTY
let termListener = () => {};

window.__bidiParityProgress = 'loading';

// ---------- التقاط نسخة xterm الحقيقية بلا لمس المكوّن ----------
const RealTerminal = window.Terminal;
const terms = [];
window.Terminal = function PatchedTerminal(options) {
  const instance = new RealTerminal(options);
  terms.push(instance);
  return instance;
};
window.Terminal.prototype = RealTerminal.prototype;

localStorage.clear();
window.satr = {
  termStart: async () => ({ ok: true, id: TERM_ID, shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' }),
  termInput: () => {},
  termResize: (id, cols, rows) => { resizes.push({ id, cols, rows }); },
  termKill: async () => {},
  onTerm: (listener) => { termListener = listener; },
};

window.addEventListener('securitypolicyviolation', (event) => {
  violations.push({ directive: event.effectiveDirective, blockedURI: event.blockedURI });
});

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitFor(predicate, label, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(20);
  }
  throw new Error('انتهت مهلة الانتظار: ' + label);
}

// المزامنة عبر requestAnimationFrame؛ إطاران يضمنان تصريف ما جُدول أثناء الإطار الأول
async function settle() {
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await delay(16);
  }
}

function emit(data) { termListener({ id: TERM_ID, type: 'data', data }); }

function activeSpacer() {
  return document.querySelector('.term-view.active .tv-spacer') || document.querySelector('.tv-spacer');
}

/** ما يعرضه إسقاط BiDi فعلاً: فهرس السطر (من موضعه) ← نصّه الظاهر */
function domLines() {
  const out = new Map();
  for (const el of activeSpacer().querySelectorAll('.bidi-line')) {
    out.set(Math.round(parseFloat(el.style.top || '0') / LINE_H), el.textContent);
  }
  return out;
}

/** ما يحمله المخزن فعلاً — وهو نفسه ما يرسمه العارض الشبكي */
function bufferLines() {
  const buf = terms[0].buffer.active;
  const out = new Map();
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    out.set(i, line ? line.translateToString(true) : null);
  }
  return out;
}

/** نصّ المخزن كاملاً (بلا أسطر ذيلية فارغة) — لمقارنة ما قبل التبديل بما بعده */
function bufferText() {
  const lines = [];
  for (const [, text] of bufferLines()) lines.push(text === null ? '' : text.trimEnd());
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

/**
 * يقارن سطراً بسطر ويصنّف كل فرق. التصنيف هو ثمرة القياس: «مقصود» يفصل انحراف
 * التصميم المعلن (إخفاء سقالة __SATR_) عن الانحراف الحقيقي، فلا يُخلط الاثنان.
 */
function compare(label) {
  const dom = domLines();
  const buf = bufferLines();
  const drift = [];
  for (const [index, shown] of dom) {
    const stored = buf.has(index) ? buf.get(index) : null;
    if (stored !== null && stored.indexOf('__SATR_') >= 0) {
      if (shown !== '') drift.push({ index, kind: 'satr_scaffold_leaked', shown, stored });
      continue; // إخفاء السقالة انحرافٌ مقصود وموثّق
    }
    if (stored === null) {
      // عنصر يعرض نصاً لسطر لم يعد في المخزن: العارض الشبكي لا يُظهره والعربي يُظهره
      if (shown !== '') drift.push({ index, kind: 'orphan_line', shown, stored: null });
      continue;
    }
    if (shown.trimEnd() !== stored.trimEnd()) {
      drift.push({ index, kind: 'text_mismatch', shown, stored });
    }
  }
  // الاتجاه المعاكس: سطر داخل النافذة المرسومة يحمله المخزن ولا يقابله عنصر
  const indexes = [...dom.keys()];
  if (indexes.length) {
    const first = Math.min(...indexes);
    const last = Math.max(...indexes);
    for (let i = first; i <= last; i++) {
      if (dom.has(i)) continue;
      const stored = buf.get(i);
      if (stored && stored.trim() !== '') drift.push({ index: i, kind: 'missing_line', shown: null, stored });
    }
  }
  const record = { label, drift, domCount: dom.size, bufferLength: terms[0].buffer.active.length };
  scenarios.push(record);
  return record;
}

// نصّ إشعار التدهور حرفياً كما يبثّه electron/term.js — القياس على المُبثّ لا على مثيله
const DEGRADE_NOTICE = '\r\n\x1b[33m⚠ تعذّر حفظ التشكيل: حافظتك تحمل محتوى غير نصّي '
  + '(صورة أو نصّاً منسّقاً من متصفح)، و«سطر» لا يستبدلها لئلّا يُتلفها.\r\n'
  + '  انسخ نصّاً عادياً — أو أفرغ الحافظة — ثم أعد الإدخال إن لزمك التشكيل.\x1b[0m\r\n';

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await customElements.whenDefined('satr-terminal-panel');
    const panel = document.querySelector('satr-terminal-panel');
    panel.setTermOpen(true);
    await waitFor(() => terms.length === 1, 'إنشاء نسخة xterm');
    await waitFor(() => !!activeSpacer(), 'ظهور مساحة إسقاط BiDi');
    window.__bidiParityProgress = 'ready';

    // (1) الأساس: أسطر عادية — أي انحراف هنا يعني عطلاً في الإسقاط نفسه لا في حالة حدّية
    emit('PS D:\\project> echo test\r\nسطر عربي أول\r\nline two\r\nسطر عربي ثالث\r\n');
    await settle();
    compare('baseline');

    // (2) الإشعار كما يصل فعلاً من المحرك
    emit(DEGRADE_NOTICE);
    await settle();
    compare('degrade-notice');

    // (3) إعادة رسم على نمط PSReadLine: ارجع بالمؤشر وامسح لأسفل ثم اكتب موجّهاً جديداً.
    // هذا ما يفعله محرّر سطر PowerShell عند إعادة رسم السطر — ويُتلف ما فوقه في المخزن.
    window.__bidiParityProgress = 'redraw';
    emit('\x1b[4A\x1b[0J');
    emit('PS D:\\project> بب\r\n');
    await settle();
    compare('after-psreadline-redraw');

    // (4) تقلّص المخزن تحت عناصر مرسومة: reset يُعيد الطول إلى نافذة واحدة
    window.__bidiParityProgress = 'reset';
    emit('\r\n');
    for (let i = 0; i < 40; i++) emit('سطر رقم ' + i + '\r\n');
    await settle();
    compare('before-shrink');
    terms[0].reset();
    await settle();
    compare('after-buffer-shrink');

    // (5) سقالة __SATR_: انحراف مقصود — يجب أن يُصنَّف مقصوداً لا عطلاً
    emit('__SATR_START_1\r\nخرج الأمر\r\n__SATR_END_1:0\r\n');
    await settle();
    compare('satr-scaffold');

    // (6) التبديل بين العارضين — الاحتمال الثاني في OBS-124. الشبكي وحده يستدعي
    // `fit.fit()`، وتغيّر الأبعاد يُعيد xterm تدفّقَ المخزن. فالسؤال المقيس هنا ليس
    // «هل يختلف العرضان» بل **هل يُتلف التبديلُ نفسه المخزنَ الذي يقرآنه**.
    window.__bidiParityProgress = 'view-switch';
    terms[0].reset();
    emit('PS D:\\project> echo فحص\r\n');
    emit('سطر عربي قصير\r\n');
    emit('طويل: ' + 'م'.repeat(220) + '\r\n'); // يلتفّ ⇒ إعادة التدفّق تُظهر أثرها
    emit(DEGRADE_NOTICE);
    await settle();
    compare('before-view-switch');
    const beforeSwitch = bufferText();

    const gridBox = document.querySelector('.term-view.active .tv-grid');
    const bidiHeight = gridBox.getBoundingClientRect().height;
    const resizesBefore = resizes.length;
    const dimsBefore = { cols: terms[0].cols, rows: terms[0].rows };

    document.getElementById('termView').click(); // ⇐ شبكي: يستدعي fit.fit()
    await settle();
    const afterToGrid = bufferText();
    const gridHeight = gridBox.getBoundingClientRect().height;
    const dimsAfterGrid = { cols: terms[0].cols, rows: terms[0].rows };

    document.getElementById('termView').click(); // ⇐ عربي مجدداً
    await settle();
    const afterBackToBidi = bufferText();
    compare('after-view-switch');

    window.__bidiParityResult = {
      pass: true,
      scenarios,
      violations,
      lineHeight: LINE_H,
      viewSwitch: {
        cols: terms[0].cols,
        rows: terms[0].rows,
        dimsBefore,
        dimsAfterGrid,
        gridBoxHeightBidi: Math.round(bidiHeight),
        gridBoxHeightGrid: Math.round(gridHeight),
        resizesOnSwitch: resizes.length - resizesBefore,
        resizesTotal: resizes.length,
        gridChangedBuffer: afterToGrid !== beforeSwitch,
        roundTripChangedBuffer: afterBackToBidi !== beforeSwitch,
        noticeInBefore: beforeSwitch.indexOf('تعذّر حفظ التشكيل') >= 0,
        noticeAfterGrid: afterToGrid.indexOf('تعذّر حفظ التشكيل') >= 0,
        noticeAfterRoundTrip: afterBackToBidi.indexOf('تعذّر حفظ التشكيل') >= 0,
        beforeLineCount: beforeSwitch.split('\n').length,
        afterGridLineCount: afterToGrid.split('\n').length,
        afterRoundTripLineCount: afterBackToBidi.split('\n').length,
      },
    };
  } catch (error) {
    window.__bidiParityResult = {
      pass: false,
      error: String((error && error.stack) || error),
      scenarios,
      violations,
    };
  }
});
