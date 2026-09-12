#!/usr/bin/env node
'use strict';

/**
 * حارس تجاوز جذر المستند عند فتح الأسطح (‏OBS-171) — Chromium حيّ على حاضن TestSprite.
 *
 * العلّة المقيسة: مقبض تغيير عرض غرفة العمليات (`.resize-handle`) كان
 * `left: 0; width: var(--space-3); transform: translateX(-50%)` فنصفه (‏6px) خارج حافة
 * المستند، فيصير `documentElement.scrollWidth` أكبر من `clientWidth` بـ6px في المقاسات
 * الثلاثة كلها — شريط تمرير أفقي في واجهة RTL بلا محتوى يبرّره.
 *
 * يفتح هذا الحارس **كل سطح بزرّه الحقيقي** في ثلاثة مقاسات ويقيس الفرق بالبكسل.
 *
 * ⚠️ **حدّ مُصرَّح به**: يقيس `documentElement` وحده — أي **جذر** الصفحة؛ لا يقيس
 * العناصر القابلة للتمرير داخلياً (قوائم، لوحات بـ`overflow:auto`) ولا يدّعي أن
 * تخطيطها سليم. ولا يفحص `WebContentsView` الأصلي للمعاينة (الجسر مزيّف في الحاضن).
 */
const assert = require('assert');
const { app, BrowserWindow } = require('electron');
const harness = require('./testsprite-harness');

const TIMEOUT_MS = 15000;
const SIZES = [[844, 672], [1280, 800], [1920, 1080]];
// السطح = (اسمه العربي، زرّ الفتح الحقيقي في القشرة)
const SURFACES = [
  { key: 'غرفة العمليات', button: 'opsRoomToggle' },
  { key: 'لوحة الملفات', button: 'filesToggle' },
  { key: 'الطرفية', button: 'termToggle' },
  { key: 'المعاينة', button: 'previewToggle' },
  { key: 'الجلسات', button: 'sessionsToggle' },
];
// عضّة التغطية: `--only <زر>` يقصر الفحص على سطح واحد لإثبات أي سطح يمسك العلّة
const onlyArg = process.argv.indexOf('--only');
const only = onlyArg < 0 ? null : process.argv[onlyArg + 1];

const watchdog = setTimeout(() => {
  console.error('surface-overflow: انتهت المهلة الكلية.');
  app.exit(1);
}, 110000);

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evaluate = (win, code) => win.webContents.executeJavaScript(code, true);

async function waitFor(win, expression, label) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await evaluate(win, 'Boolean(' + expression + ')')) return;
    await pause(30);
  }
  throw new Error('انتهت مهلة ' + label);
}

/** فرق عرض جذر المستند بالبكسل + أول العناصر الخارجة عن الحافة (للتشخيص). */
async function overflowOf(win) {
  return evaluate(win, `(() => {
    const root = document.documentElement;
    const delta = root.scrollWidth - root.clientWidth;
    let offenders = [];
    if (delta > 1) {
      const all = [];
      const visit = (node) => {
        for (const el of node.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) visit(el.shadowRoot); }
      };
      visit(document);
      const rootX = root.getBoundingClientRect().x;
      offenders = all
        .filter((el) => el.checkVisibility() && el.getBoundingClientRect().x < rootX - 1)
        .slice(0, 5)
        .map((el) => el.tagName + (el.id ? '#' + el.id : '')
          + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().replace(/\\s+/g, '.') : '')
          + '@x=' + Math.round(el.getBoundingClientRect().x));
    }
    return { delta, scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, offenders };
  })()`);
}

async function main() {
  const server = harness.createHarnessServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, harness.HOST, resolve);
  });
  await app.whenReady();
  const errors = [];
  const win = new BrowserWindow({
    show: false, width: 1280, height: 800,
    webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false,
      offscreen: true, backgroundThrottling: false, partition: 'surface-overflow-' + Date.now(),
    },
  });
  win.webContents.on('console-message', (_event, _level, message) => {
    if (/content security policy|uncaught|unhandled/i.test(String(message))) errors.push(String(message));
  });
  const failures = [];
  try {
    await win.loadURL('http://' + harness.HOST + ':' + server.address().port + '/');
    await waitFor(win, "customElements.get('satr-ops-room') && document.querySelector('satr-gate').hidden",
      'إقلاع القشرة');
    const surfaces = only ? SURFACES.filter((s) => s.button === only) : SURFACES;
    assert(surfaces.length, 'لا سطح مطابق للخيار --only ' + only);
    for (const [width, height] of SIZES) {
      win.setContentSize(width, height);
      await waitFor(win, 'innerWidth === ' + width, 'استقرار العرض ' + width);
      await pause(150);
      const base = await overflowOf(win);
      console.log('  ' + width + '×' + height + ' — بلا سطح مفتوح: فرق=' + base.delta + 'px');
      for (const surface of surfaces) {
        await evaluate(win, 'document.getElementById(' + JSON.stringify(surface.button) + ').click()');
        await pause(220);
        const measured = await overflowOf(win);
        console.log('    ' + surface.key + ' (#' + surface.button + '): فرق=' + measured.delta
          + 'px (scrollWidth=' + measured.scrollWidth + '، clientWidth=' + measured.clientWidth + ')'
          + (measured.offenders.length ? ' ⇐ ' + measured.offenders.join('، ') : ''));
        if (measured.delta > 1) {
          failures.push(surface.key + ' عند ' + width + '×' + height + ': فرق=' + measured.delta + 'px'
            + (measured.offenders.length ? ' ⇐ ' + measured.offenders.join('، ') : ''));
        }
        // إغلاق ما فُتح كي لا تتراكم الأسطح؛ الإغلاق ليس موضوع القياس فلا يُؤكَّد
        await evaluate(win, '(() => { const b = document.getElementById('
          + JSON.stringify(surface.button) + '); if (b) b.click();'
          + ' document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); })()');
        await pause(160);
      }
    }
    assert.deepStrictEqual(failures, [],
      'تجاوز جذر المستند عند فتح سطح (OBS-171):\n' + failures.join('\n'));
    assert.strictEqual(errors.length, 0, 'صفر خطأ JavaScript أو CSP: ' + errors.join('\n'));
    console.log('surface-overflow: نجح — ' + (surfaces.length * SIZES.length)
      + ' حالة (سطح × مقاس) بلا تجاوز أفقي لجذر المستند؛ القياس على documentElement وحده.');
  } finally {
    if (!win.isDestroyed()) win.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().then(() => { clearTimeout(watchdog); app.exit(0); }).catch((error) => {
  console.error('surface-overflow:', error && error.stack ? error.stack : error);
  app.exit(1);
});
