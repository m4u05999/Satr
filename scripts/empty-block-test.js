/**
 * حارس OBS-142 — «الدور الفارغ» على مكوّن chat الإنتاجي.
 *
 * يشغّل مكوّن chat الإنتاجي تحت CSP صارم ويقيس **ما يراه المستخدم**: هل بقي
 * سطحٌ مرئي بعد نهاية الدور (إجابة أو تعليق أو بطاقة أداة). العطل المُصلَح:
 * `finish()` كان يطوي سجلّ العمل بلا شرط، فدورٌ بلا نصّ إجابة يُعرض كتلةً خالية.
 *
 * التشغيل:  npm run test:empty-block
 */
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const FIXTURE = path.join(__dirname, 'fixtures', 'empty-block.html');
const TIMEOUT_MS = 30000;

app.disableHardwareAcceleration();

// إقلاعٌ فاشل في العملية الرئيسية يعلّق العملية بحوار بدل أن ينهار — درس مثبّت.
process.on('uncaughtException', (error) => {
  console.log(JSON.stringify({ ok: false, error: 'uncaught: ' + String(error && error.message) }));
  process.exit(1);
});

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 900,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  const timer = setTimeout(() => {
    console.log(JSON.stringify({ ok: false, error: 'انتهت المهلة قبل اكتمال الصفحة' }));
    process.exit(1);
  }, TIMEOUT_MS);

  await win.loadFile(FIXTURE);
  // انتظار العلم بدل مهلة ثابتة — الصفحة تضبط __DONE__ عند فراغها.
  const deadline = Date.now() + TIMEOUT_MS - 2000;
  let result = null;
  for (;;) {
    result = await win.webContents.executeJavaScript('window.__DONE__ ? window.__RESULT__ : null');
    if (result) break;
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  clearTimeout(timer);

  if (!result) {
    console.log(JSON.stringify({ ok: false, error: 'لم تكتمل الصفحة' }, null, 2));
    process.exit(1);
  }

  // الحكم: أيُّ شكلٍ يُنتج كتلةً بلا نصّ مرئي؟
  const verdict = {};
  for (const [name, s] of Object.entries(result.scenarios || {})) {
    verdict[name] = {
      answerShown: s.answerShown,
      worklogCollapsed: s.worklogCollapsed,
      commentaryShown: s.commentaryShown,
      visibleToolCards: s.visibleToolCards,
      // «فارغ بصرياً» = لا سطح مرئي إطلاقاً: لا إجابة ولا تعليق ولا بطاقة أداة.
      looksEmpty: !s.answerShown && !s.commentaryShown && !s.visibleToolCards,
      answerLen: (s.answerText || '').length,
      blockPreview: (s.blockText || '').slice(0, 90),
    };
  }
  console.log(JSON.stringify({ ok: result.ok, error: result.error || null, verdict }, null, 2));
  process.exit(result.ok ? 0 : 1);
}).catch((error) => {
  console.log(JSON.stringify({ ok: false, error: String((error && error.message) || error) }));
  process.exit(1);
});
