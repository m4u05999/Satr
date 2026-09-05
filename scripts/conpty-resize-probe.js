/**
 * OBS-124 — مسبار: ماذا يبثّ ConPTY عند تغيّر عدد الصفوف؟
 *
 * قياس fixture أثبت أن تبديل عارض الطرفية يغيّر أبعاد xterm (‏135×8 ⇒ 135×11 — ارتفاع
 * `.tv-grid` يختلف لأن صفّ الإدخال يظهر في العربي ويختفي في الشبكي) فيرسل `termResize`
 * واحداً إلى pty. بقيت الحلقة الوسطى شهادةَ تعليقٍ لا قياساً: هل يعقب ذلك إعادةُ رسمٍ
 * تمحو ما في الشاشة المرئية؟ هذا المسبار يقيسها على pty حقيقي.
 *
 * تشخيصيّ لا حارس: يطبع ما رصده ولا يفشل — الفشل هنا يعني «لم أستطع القياس» لا «عطل».
 * التشغيل: node scripts/conpty-resize-probe.js
 */
const term = require('../electron/term.js');

const IS_WIN = process.platform === 'win32';
const COLS = 120;
const ROWS_BIDI = 8;   // الوضع العربي — صفّ الإدخال يقتطع من ارتفاع الشبكة
const ROWS_GRID = 11;  // الوضع الشبكي — الفارق المقيس في fixture

const chunks = [];
let collecting = false;

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// تسلسلات المسح وإعادة التموضع التي تدلّ على إعادة رسم الشاشة المرئية
const ERASE_PATTERNS = [
  { re: /\x1b\[2J/g, label: 'مسح الشاشة كاملة (2J)' },
  { re: /\x1b\[[0-3]?J/g, label: 'مسح إلى نهاية/بداية الشاشة (J)' },
  { re: /\x1b\[[0-2]?K/g, label: 'مسح السطر (K)' },
  { re: /\x1b\[\d*;\d*H/g, label: 'إعادة تموضع المؤشر المطلق (H)' },
  { re: /\x1b\[\d*A/g, label: 'صعود المؤشر (A)' },
];

async function main() {
  if (!IS_WIN) { console.log('conpty-resize-probe: يُتخطّى — ConPTY خاص بويندوز.'); return; }

  term.setNotifier((ev) => {
    if (ev && ev.type === 'data' && collecting) chunks.push(ev.data);
  });

  const started = term.startTerm(process.cwd(), COLS, ROWS_BIDI);
  if (!started || !started.ok) {
    console.log('conpty-resize-probe: تعذّر بدء pty —', (started && started.message) || 'سبب غير معلوم');
    return;
  }
  const id = started.id;
  console.log('  pty: ' + id + ' — ' + COLS + '×' + ROWS_BIDI + ' · ' + started.shell);

  try {
    await delay(2500); // انتظار الموجّه وتهيئة PowerShell
    term.writeTerm(id, 'echo probe-marker\r');
    await delay(2000);

    const beforeBytes = (term.readBuffer(id, 200000).data || '').length;
    console.log('  المخزن قبل التغيير: ' + beforeBytes + ' بايت');

    // النصّ المحليّ الذي يكتبه «سطر» نفسه لا ConPTY — نظير إشعار التدهور
    collecting = true;
    chunks.length = 0;

    term.resizeTerm(id, COLS, ROWS_GRID);
    await delay(1500);
    const onGrow = chunks.join('');

    chunks.length = 0;
    term.resizeTerm(id, COLS, ROWS_BIDI);
    await delay(1500);
    const onShrink = chunks.join('');
    collecting = false;

    for (const [label, payload] of [['تكبير ' + ROWS_BIDI + '→' + ROWS_GRID, onGrow],
      ['تصغير ' + ROWS_GRID + '→' + ROWS_BIDI, onShrink]]) {
      console.log('  [' + label + '] بثّ ConPTY ' + payload.length + ' بايت بعد التغيير');
      if (!payload.length) { console.log('      لا شيء — لم يُعِد الرسم'); continue; }
      for (const p of ERASE_PATTERNS) {
        const hits = payload.match(p.re);
        if (hits) console.log('      · ' + p.label + ' ×' + hits.length);
      }
      const visible = payload.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/[\x00-\x08\x0b-\x1f]/g, '');
      console.log('      نصّ مُعاد كتابته: ' + JSON.stringify(visible.slice(0, 160)));
    }
  } finally {
    term.killTerm(id);
    await delay(300);
    term.killAll();
  }
}

main().then(() => process.exit(0)).catch((error) => {
  console.error('conpty-resize-probe: فشل القياس —', (error && error.stack) || error);
  process.exit(1);
});
