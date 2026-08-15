'use strict';

// مسبار استنساخ تنازع التحكم في متصفح «سطر» (OBS-013 — دفعة «صقل متصفح سطر» 2026-08-15).
// البلاغ: المستخدم يتفاعل مع المعاينة أثناء قيادة الوكيل، فيبني الوكيل خطوته على حالة
// تغيّرت. هذا المسبار يستنسخ السباق **مضبوطاً** ويجيب سؤالاً واحداً لكل سيناريو:
// «هل يكشف سطر اليوم أن الحالة تغيّرت بين لقطة الوكيل وفعله؟»
// محاكاة المستخدم عبر wc.sendInputEvent (مسار الإدخال الحقيقي للنقر في WebContentsView —
// لا يمر بأي أداة وكيل)، مع سقوط موثَّق إلى el.click() إن لم توصل البيئة أحداث الماوس.
// الخرج: dist/preview-latency-probe/contention-report.json + ملخص مطبوع.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const preview = require('../electron/preview');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function page() {
  return `<!doctype html><html><body>
    <h1>صفحة التنازع</h1>
    <div id="log">idle</div>
    <div id="user-clicks">0</div>
    <button id="user-btn" onclick="
      document.getElementById('user-clicks').textContent = Number(document.getElementById('user-clicks').textContent) + 1;
      document.getElementById('log').textContent = 'user-changed-state';
    ">زر المستخدم</button>
    <button id="agent-target" onclick="
      document.getElementById('log').textContent = 'AGENT-' + this.getAttribute('data-mode');
    " data-mode="save">حفظ التغييرات</button>
    <button id="mutate-btn" onclick="
      var t = document.getElementById('agent-target');
      t.setAttribute('data-mode', 'delete'); t.textContent = 'حذف المشروع نهائياً';
      document.getElementById('user-clicks').textContent = Number(document.getElementById('user-clicks').textContent) + 1;
    ">بدّل معنى الهدف</button>
    <button id="replace-btn" onclick="
      var t = document.getElementById('agent-target');
      var n = document.createElement('button'); n.id = 'agent-target'; n.textContent = 'زر بديل';
      t.replaceWith(n);
      document.getElementById('user-clicks').textContent = Number(document.getElementById('user-clicks').textContent) + 1;
    ">استبدل الهدف</button>
    <a id="nav-link" href="/two">صفحة ثانية</a>
  </body></html>`;
}

function startServer() {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(request.url === '/two'
      ? '<!doctype html><html><body><h1>الثانية</h1></body></html>' : page());
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: 'http://127.0.0.1:' + server.address().port })));
}

async function main() {
  await app.whenReady();
  const { server, url } = await startServer();
  const win = new BrowserWindow({ show: false, width: 1000, height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const report = { at: new Date().toISOString(), user_input_path: null, scenarios: [] };

  try {
    preview.setBounds({ x: 0, y: 0, width: 1000, height: 800 });
    if (!preview.open(win, () => {}, url + '/one').ok) throw new Error('open failed');
    if (!(await preview.waitFor({ selector: '#agent-target' }, 8000)).found) throw new Error('page not ready');
    const view = win.contentView.children.find((child) => child.webContents);
    const wc = view.webContents;
    wc.on('console-message', (e, level, message, line) => {
      if (level >= 3) console.error('[page-error] line ' + line + ': ' + message);
    });

    // محاكاة نقر مستخدم: مسار الإدخال الحقيقي أولاً، وسقوط موثَّق إلى el.click()
    async function rectOf(selector) {
      return wc.executeJavaScript(`(function(){var r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`, true);
    }
    async function userClicks() {
      // متسامح: في سيناريو التنقّل تكون الصفحة الجديدة بلا عدّاد
      const value = await wc.executeJavaScript("(function(){var e=document.getElementById('user-clicks');return e?e.textContent:'-1';})()", true);
      return Number(value);
    }
    async function userClick(selector, { nav = false } = {}) {
      const before = nav ? wc.getURL() : await userClicks();
      const point = await rectOf(selector);
      wc.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
      await delay(nav ? 400 : 120);
      const landed = nav ? wc.getURL() !== before : (await userClicks()) > before;
      if (landed) { report.user_input_path = report.user_input_path || 'sendInputEvent'; return; }
      // البيئة لم توصل حدث الماوس (نافذة مخفية) — سقوط برمجي خارج مسار أدوات الوكيل
      await wc.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).click()`, true);
      await delay(nav ? 400 : 60);
      report.user_input_path = report.user_input_path || 'executeJavaScript_fallback';
    }
    async function freshRef(label) {
      const snap = await preview.snapshot();
      const match = snap.snap.elements.join('\n').match(new RegExp('\\[(s\\d+:e\\d+)\\] button "' + label + '[^"]*"'));
      return { ref: match ? match[1] : null, snapshotText: snap.snap.elements.join('\n') };
    }
    async function resetPage() {
      await preview.navigate(url + '/one');
      await preview.waitFor({ selector: '#agent-target' }, 8000);
    }

    // ---- S1: المستخدم يغيّر حالة الصفحة بين لقطة الوكيل وفعله ----
    {
      await resetPage();
      const { ref } = await freshRef('حفظ التغييرات');
      await userClick('#user-btn'); // تدخّل المستخدم بعد اللقطة
      const stateAfterUser = await wc.executeJavaScript("document.getElementById('log').textContent", true);
      const result = await preview.clickElement(ref); // فعل الوكيل بref ما قبل التدخّل
      const finalState = await wc.executeJavaScript("document.getElementById('log').textContent", true);
      report.scenarios.push({
        id: 'S1_state_changed_between_snapshot_and_action',
        user_action: 'نقر زراً غيّر حالة الصفحة بعد لقطة الوكيل',
        state_after_user: stateAfterUser,
        agent_result: { ok: !!result.ok, error: result.error || null, dom_changed: result.dom_changed, note: result.note || null, has_any_conflict_signal: false },
        final_state: finalState,
        detected: false,
        verdict: result.ok && !result.error
          ? 'صامت: الفعل نجح بلا أي إشارة أن الحالة تغيّرت منذ اللقطة'
          : 'مكشوف جزئياً: ' + (result.error || ''),
      });
      report.scenarios[report.scenarios.length - 1].detected = !result.ok;
    }

    // ---- S2 (الأخطر): المستخدم يبدّل معنى العنصر الهدف نفسه — ref يبقى صالحاً ----
    {
      await resetPage();
      const { ref, snapshotText } = await freshRef('حفظ التغييرات');
      const sawSave = /حفظ التغييرات/.test(snapshotText);
      await userClick('#mutate-btn'); // الهدف صار «حذف المشروع نهائياً» بنفس ref
      const result = await preview.clickElement(ref);
      const finalState = await wc.executeJavaScript("document.getElementById('log').textContent", true);
      report.scenarios.push({
        id: 'S2_element_meaning_mutated',
        user_action: 'حوّل زر الهدف من «حفظ التغييرات» إلى «حذف المشروع نهائياً» (العنصر نفسه، ref باقٍ)',
        snapshot_showed: sawSave ? 'حفظ التغييرات' : '?',
        agent_result: { ok: !!result.ok, error: result.error || null, dom_changed: result.dom_changed },
        final_state: finalState,
        executed_deleted_action: finalState === 'AGENT-delete',
        detected: !result.ok,
        verdict: finalState === 'AGENT-delete' && result.ok
          ? 'صامت وخطر: الوكيل رأى «حفظ» في لقطته ونفّذ «حذف» بنجاح مبلَّغ ok:true'
          : 'غير مستنسخ — راجع',
      });
    }

    // ---- S3: المستخدم يستبدل العنصر الهدف كلياً (يختفي data-satr-ref) ----
    {
      await resetPage();
      const { ref } = await freshRef('حفظ التغييرات');
      await userClick('#replace-btn');
      const result = await preview.clickElement(ref);
      report.scenarios.push({
        id: 'S3_element_replaced',
        user_action: 'استبدل عنصر الهدف بعنصر جديد — سمة data-satr-ref اختفت',
        agent_result: { ok: !!result.ok, error: result.error || null },
        detected: !result.ok,
        verdict: result.error === 'not_found'
          ? 'مكشوف بالصدفة: not_found — لكن الرسالة لا تميّز «المستخدم غيّر الصفحة» من «مُحدِّد خاطئ»'
          : 'نتيجة غير متوقعة: ' + JSON.stringify(result),
      });
    }

    // ---- S4 (الحارس القائم): تنقّل المستخدم يبطل refs ----
    {
      await resetPage();
      const { ref } = await freshRef('حفظ التغييرات');
      await userClick('#nav-link', { nav: true }); // المستخدم انتقل لصفحة أخرى
      await preview.waitFor({ text: 'الثانية' }, 8000);
      const result = await preview.clickElement(ref);
      report.scenarios.push({
        id: 'S4_user_navigation',
        user_action: 'انتقل إلى صفحة أخرى بنقر رابط',
        agent_result: { ok: !!result.ok, error: result.error || null },
        detected: result.error === 'stale_ref',
        verdict: result.error === 'stale_ref'
          ? 'مكشوف: التنقّل هو حالة الإبطال الوحيدة المرصودة اليوم (did-start-navigation)'
          : 'نتيجة غير متوقعة: ' + JSON.stringify(result),
      });
    }

    const detectedCount = report.scenarios.filter((s) => s.detected).length;
    report.summary = {
      total: report.scenarios.length,
      detected: detectedCount,
      silent: report.scenarios.length - detectedCount,
      key_finding: 'تفاعل المستخدم لا يُرصد إلا إذا سبّب تنقّلاً (S4) أو أزال العنصر (S3 بالصدفة). '
        + 'تغيير الحالة (S1) وتبديل المعنى (S2) يمرّان صامتين — وS2 نفّذ فعلاً مغايراً لما رآه الوكيل.',
    };

    const outDir = path.join(__dirname, '..', 'dist', 'preview-latency-probe');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, 'contention-report.json');
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

    console.log('preview-contention-probe: اكتمل — مسار إدخال المستخدم: ' + report.user_input_path);
    for (const s of report.scenarios) console.log(`${s.id}: ${s.detected ? 'مكشوف' : 'صامت'} — ${s.verdict}`);
    console.log('التقرير: ' + outPath);
  } finally {
    preview.destroy();
    if (!win.isDestroyed()) win.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().then(() => app.exit(0)).catch((error) => { console.error(error.stack || error); app.exit(1); });
