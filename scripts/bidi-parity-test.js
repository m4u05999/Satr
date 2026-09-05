/**
 * OBS-124 — قياس تطابق عارضَي الطرفية على المخزن نفسه.
 *
 * العارض الشبكي **هو** نسخة xterm، وإسقاط BiDi يُبنى من `buffer.active` نفسها؛ فاتفاقهما
 * واجب. يشغّل هذا السكربت المكوّن الحقيقي داخل Chromium تحت CSP الفعلية، يبثّ أسطراً
 * معلومة عبر قناة `onTerm` نفسها، ثم يقارن ما يعرضه الإسقاط بما يحمله المخزن **سطراً
 * بسطر** — فيسمّي المنحرف بدل الاستدلال من لقطة.
 *
 * يخرج بـ1 عند أي انحراف غير مقصود؛ فهو قياسٌ اليوم وحارسُ عدم تراجع بعد العلاج.
 */
const assert = require('assert');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const FIXTURE = path.join(__dirname, 'fixtures', 'terminal-bidi-parity.html');
const TIMEOUT_MS = 40000;

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitForResult(win) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await win.webContents.executeJavaScript('window.__bidiParityResult || null', true);
    if (result) return result;
    await delay(60);
  }
  const progress = await win.webContents.executeJavaScript('window.__bidiParityProgress || "unknown"', true);
  throw new Error('انتهت مهلة قياس تطابق العارضين؛ المرحلة: ' + progress);
}

function short(text, max = 70) {
  if (text === null) return '(غير موجود)';
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max) + '…' : flat;
}

const KIND_LABEL = {
  orphan_line: 'سطر يتيم — الإسقاط يعرضه والمخزن لا يحمله',
  missing_line: 'سطر ساقط — المخزن يحمله والإسقاط لا يعرضه',
  text_mismatch: 'نصّ مختلف عن سطر المخزن عند الفهرس نفسه',
  satr_scaffold_leaked: 'سقالة __SATR_ تسرّبت إلى الإسقاط',
};

async function main() {
  await app.whenReady();
  const consoleErrors = [];
  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });

  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2 || /securitypolicyviolation|uncaught|unhandled/i.test(String(message))) {
      consoleErrors.push(String(message));
    }
  });

  try {
    await win.loadFile(FIXTURE);
    const result = await waitForResult(win);
    assert.strictEqual(result.pass, true, result.error || 'فشل القياس داخل الصفحة.');
    assert.deepStrictEqual(result.violations, [], 'رُصد securitypolicyviolation أثناء القياس.');
    assert.deepStrictEqual(consoleErrors, [], 'ظهرت أخطاء console أثناء القياس.');

    let total = 0;
    for (const scenario of result.scenarios) {
      const count = scenario.drift.length;
      total += count;
      const head = count === 0 ? 'متطابق' : count + ' انحراف';
      console.log(`  [${scenario.label}] ${head} — عناصر الإسقاط ${scenario.domCount}، أسطر المخزن ${scenario.bufferLength}`);
      for (const item of scenario.drift) {
        console.log(`      · سطر ${item.index}: ${KIND_LABEL[item.kind] || item.kind}`);
        console.log(`          الإسقاط: ${short(item.shown)}`);
        console.log(`          المخزن : ${short(item.stored)}`);
      }
    }

    const sw = result.viewSwitch || {};
    console.log(`  [تبديل العرض] الشبكة ${sw.cols}×${sw.rows} — المخزن تغيّر بالتبديل للشبكي: `
      + `${sw.gridChangedBuffer ? 'نعم' : 'لا'}، وبعد العودة: ${sw.roundTripChangedBuffer ? 'نعم' : 'لا'}`);
    console.log(`      أسطر المخزن: قبل ${sw.beforeLineCount} · بعد الشبكي ${sw.afterGridLineCount}`
      + ` · بعد العودة ${sw.afterRoundTripLineCount}`);
    console.log(`      الإشعار حاضر: قبل ${sw.noticeInBefore ? 'نعم' : 'لا'}`
      + ` · بعد الشبكي ${sw.noticeAfterGrid ? 'نعم' : 'لا'}`
      + ` · بعد العودة ${sw.noticeAfterRoundTrip ? 'نعم' : 'لا'}`);
    console.log(`      أبعاد xterm: قبل ${sw.dimsBefore.cols}×${sw.dimsBefore.rows}`
      + ` · بعد الشبكي ${sw.dimsAfterGrid.cols}×${sw.dimsAfterGrid.rows}`);
    console.log(`      ارتفاع .tv-grid: في العربي ${sw.gridBoxHeightBidi}px · في الشبكي ${sw.gridBoxHeightGrid}px`);
    console.log(`      نداءات termResize إلى pty بسبب التبديل: ${sw.resizesOnSwitch}`
      + ` (الإجمالي ${sw.resizesTotal})`);

    assert.strictEqual(total, 0, 'العارضان يختلفان على المخزن نفسه: ' + total
      + ' انحراف (التفصيل أعلاه) — OBS-124.');
    assert.strictEqual(sw.noticeInBefore, true, 'لم يصل إشعار التدهور إلى المخزن أصلاً.');
    assert.strictEqual(sw.noticeAfterRoundTrip, true,
      'تبديل العرض ذهاباً وإياباً أسقط إشعار التدهور من المخزن — OBS-124.');
    console.log('bidi-parity: نجح — إسقاط BiDi يطابق مخزن xterm سطراً بسطر في السيناريوهات الخمسة.');
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

process.on('uncaughtException', (error) => {
  console.error('bidi-parity: فشل غير متوقع —', (error && error.stack) || error);
  app.exit(1);
});

main().then(() => app.exit(0)).catch((error) => {
  console.error('bidi-parity: فشل —', (error && error.message) || error);
  app.exit(1);
});
