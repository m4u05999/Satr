#!/usr/bin/env node
'use strict';

/**
 * حارس المؤلّف في عمود الدردشة الضيّق (‏OBS-168 + OBS-174) — Chromium حيّ على حاضن TestSprite.
 *
 * الشرط المقيس **ضيق العمود لا ضيق النافذة**: تُفتح غرفة العمليات بزرّها الحقيقي
 * (‏`#opsRoomToggle`) فينكمش `#chatColumn` تحت عتبتي `@container chat-column`.
 *
 * ما يُقاس في كل مقاس نافذة:
 *  (١) منتقي المحرك `#engine`: عرضه الداخلي المتاح للنصّ (‏`clientWidth` ناقص الحشوة
 *      والسهم) مقابل عرض نصّ الخيار المختار مقيساً بـcanvas بخطّ المنتقي الفعلي.
 *      يمرّ إن ظهر النصّ بنسبة ≥ 80٪ **أو** إن كان `title` يساوي نصّ الخيار المختار
 *      حرفياً (دلالة نصّية تكشف المحرك المختار) — ويُطبع أيّ الشرطين تحقّق.
 *  (٢) شريط الوعي `#awarenessBar`: يمرّ إن لم يكن مقصوصاً أصلاً
 *      (‏`scrollWidth <= clientWidth`، أي التفاف) **أو** إن وُجدت دلالة بصرية مقيسة
 *      عند القصّ (‏`mask-image` غير `none`، أو عنصر تدرّج عرضه > 0 يظهر عند القصّ وحده).
 *
 * ⚠️ **حدّان مُصرَّح بهما**: القياس بعرض النصّ لا بالبكسل المرسوم فعلاً داخل المنتقي
 * (لا وصول لصندوق النصّ الداخلي للـ`<select>` في Chromium)، فتقدير الحشوة تقريبي
 * محافظ؛ ولا يحكم هذا الحارس على جمال التخطيط بل على قابلية القراءة بالأرقام.
 */
const assert = require('assert');
const { app, BrowserWindow } = require('electron');
const harness = require('./testsprite-harness');

const TIMEOUT_MS = 15000;
const SIZES = [[844, 672], [1280, 800], [1920, 1080]];
const TEXT_RATIO_MIN = 0.8;

const watchdog = setTimeout(() => {
  console.error('composer-narrow: انتهت المهلة الكلية.');
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

/** قياس المؤلّف: عرض العمود، منتقي المحرك، شريط الوعي وارتفاعه. */
async function measure(win) {
  return evaluate(win, `(() => {
    const engine = document.getElementById('engine');
    const bar = document.getElementById('awarenessBar');
    const column = document.getElementById('chatColumn');
    const style = getComputedStyle(engine);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    ctx.font = style.fontWeight + ' ' + style.fontSize + ' ' + style.fontFamily;
    const optionText = engine.options[engine.selectedIndex] ? engine.options[engine.selectedIndex].text : '';
    const textW = Math.round(ctx.measureText(optionText).width * 10) / 10;
    // الحشوة الأفقية + عرض سهم القائمة التقريبي في Chromium (‏~16px)
    const padding = parseFloat(style.paddingInlineStart) + parseFloat(style.paddingInlineEnd);
    const availForText = Math.round((engine.clientWidth - padding - 16) * 10) / 10;
    const titleMatches = engine.title.trim() === optionText.trim();

    const barStyle = getComputedStyle(bar);
    const clipped = bar.scrollWidth - bar.clientWidth > 1;
    const maskImage = barStyle.maskImage && barStyle.maskImage !== 'none' ? barStyle.maskImage : '';
    // دلالة تدرّج على ::after (تظهر عند القصّ وحده) — نقيس عرضها المحسوب
    const afterStyle = getComputedStyle(bar, '::after');
    const afterWidth = afterStyle.content === 'none' ? 0 : parseFloat(afterStyle.width) || 0;

    return {
      columnW: column ? column.clientWidth : -1,
      engine: {
        clientW: engine.clientWidth, availForText, textW, optionText,
        ratio: textW > 0 ? Math.round((availForText / textW) * 1000) / 1000 : 1,
        titleMatches, title: engine.title,
      },
      bar: {
        scrollWidth: bar.scrollWidth, clientWidth: bar.clientWidth, height: bar.clientHeight,
        clipped, maskImage, afterWidth,
      },
      footerHeight: document.querySelector('footer') ? document.querySelector('footer').clientHeight : -1,
    };
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
      offscreen: true, backgroundThrottling: false, partition: 'composer-narrow-' + Date.now(),
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
    // غرفة العمليات بزرّها الحقيقي: هي التي تضيّق العمود (الشرط المقيس في OBS-168)
    await evaluate(win, "document.getElementById('opsRoomToggle').click()");
    await pause(260);
    for (const [width, height] of SIZES) {
      win.setContentSize(width, height);
      await waitFor(win, 'innerWidth === ' + width, 'استقرار العرض ' + width);
      await pause(180);
      const m = await measure(win);
      const engineOk = m.engine.ratio >= TEXT_RATIO_MIN || m.engine.titleMatches;
      const reason = m.engine.ratio >= TEXT_RATIO_MIN
        ? 'النصّ ظاهر ' + Math.round(m.engine.ratio * 100) + '٪'
        : (m.engine.titleMatches ? 'title = نصّ الخيار' : 'لا شرط تحقّق');
      console.log('  ' + width + '×' + height + ' — عرض العمود=' + m.columnW + 'px');
      console.log('    #engine: clientW=' + m.engine.clientW + '، availForText=' + m.engine.availForText
        + '، textW=' + m.engine.textW + ' ⇒ ' + reason
        + ' (‏title=' + JSON.stringify(m.engine.title) + ')');
      if (!engineOk) {
        failures.push('#engine عند ' + width + '×' + height + ': availForText=' + m.engine.availForText
          + ' مقابل textW=' + m.engine.textW + ' (نسبة ' + Math.round(m.engine.ratio * 100)
          + '٪ < 80٪) وبلا title مطابق — OBS-168');
      }

      const barOk = !m.bar.clipped || Boolean(m.bar.maskImage) || m.bar.afterWidth > 0;
      const barReason = !m.bar.clipped ? 'غير مقصوص (التفاف)'
        : (m.bar.maskImage ? 'مقصوص مع mask-image'
          : (m.bar.afterWidth > 0 ? 'مقصوص مع تدرّج عرضه ' + m.bar.afterWidth + 'px' : 'مقصوص بلا دلالة'));
      console.log('    #awarenessBar: scrollWidth=' + m.bar.scrollWidth + '، clientWidth=' + m.bar.clientWidth
        + '، ارتفاع=' + m.bar.height + 'px، ارتفاع footer=' + m.footerHeight + 'px ⇒ ' + barReason);
      if (!barOk) {
        failures.push('#awarenessBar عند ' + width + '×' + height + ': scrollWidth=' + m.bar.scrollWidth
          + ' مقابل clientWidth=' + m.bar.clientWidth + ' بلا دلالة قصّ — OBS-174');
      }
    }
    assert.deepStrictEqual(failures, [],
      'المؤلّف في العمود الضيّق (OBS-168/174):\n' + failures.join('\n'));
    assert.strictEqual(errors.length, 0, 'صفر خطأ JavaScript أو CSP: ' + errors.join('\n'));
    console.log('composer-narrow: نجح — ' + (SIZES.length * 2)
      + ' قياساً (منتقي المحرك + شريط الوعي × ثلاثة مقاسات) وغرفة العمليات مفتوحة.');
  } finally {
    if (!win.isDestroyed()) win.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().then(() => { clearTimeout(watchdog); app.exit(0); }).catch((error) => {
  console.error('composer-narrow:', error && error.stack ? error.stack : error);
  app.exit(1);
});
