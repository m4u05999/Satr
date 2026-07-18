'use strict';
// لقطة الطرفية عبر المكوّن الإنتاجي الحقيقي (ملاحظة مراجعة Codex — لا نسخة ساكنة):
// جسر مزيف يقبل termStart ويبثّ خرج ANSI عبر onTerm، فيمر بمحرك xterm الفعلي
// ثم إسقاط BiDi الإنتاجي — نفس pipeline العرض في التطبيق حرفياً، بلا pty فقط.
// سكربت كلاسيكي: يضبط window.satr قبل تنفيذ وحدة المكوّن المؤجلة.

let termListener = null;
const TERM_ID = 'term_1';

window.satr = {
  termStart: async () => ({ ok: true, id: TERM_ID, shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' }),
  termInput: () => {},
  termResize: () => {},
  termKill: async () => ({ ok: true }),
  termList: async () => [],
  onTerm: (cb) => { termListener = cb; },
};

const ESC = '\x1b[';
const R = ESC + '0m';               // reset
const BLUE = ESC + '94m';           // موجّه PowerShell
const GREEN = ESC + '92m';          // علامات النجاح
const GOLD = ESC + '33m';           // بصمة commit
const DIM = ESC + '90m';            // خرج ثانوي
const B = ESC + '1m';               // غامق

const PROMPT = BLUE + 'PS D:\\projects\\matjar-app> ' + R;
const OUTPUT = [
  PROMPT + B + 'npm test' + R,
  '',
  DIM + '> matjar@1.4.0 test' + R,
  '',
  GREEN + '✓ ' + R + 'اختبارات السلة — 8 نجحت',
  GREEN + '✓ ' + R + 'اختبارات الدفع — 6 نجحت',
  GREEN + '✓ ' + R + 'استعادة الجلسة بعد التحديث — نجحت',
  DIM + 'Tests: ' + R + GREEN + '14 passed' + R + DIM + ', 14 total — 3.2s' + R,
  '',
  PROMPT + B + 'git commit -m "إصلاح استعادة الجلسة عند التحديث"' + R,
  DIM + '[main ' + R + GOLD + '4f2a91c' + R + DIM + '] ' + R + 'إصلاح استعادة الجلسة عند التحديث',
  DIM + ' 2 files changed, 41 insertions(+), 2 deletions(-)' + R,
  '',
  PROMPT,
].join('\r\n');

async function frames(count) {
  for (let i = 0; i < count; i++) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await customElements.whenDefined('satr-terminal-panel');
    const panel = document.querySelector('satr-terminal-panel');
    panel.setTermOpen(true); // يفتح اللوحة وينشئ التبويب الأول عبر termStart المزيف
    await frames(3);
    if (!termListener) throw new Error('onTerm لم يُسجَّل — تغيّر عقد المكوّن.');
    termListener({ type: 'data', id: TERM_ID, data: OUTPUT });
    await frames(4);

    // مسودة عربية حية في سطر الإدخال (نفس عنصر المكوّن الإنتاجي)
    const input = document.getElementById('termInput');
    if (input) input.value = 'شغّل خادم التطوير npm run dev';

    await document.fonts.ready;
    await frames(3);
    window.__shotsReady = true;
  } catch (error) {
    window.__shotsError = error && error.stack ? error.stack : String(error);
  }
});
