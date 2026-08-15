'use strict';

// المسبار الحاجز لدفعة «صقل متصفح سطر» (مرحلة 0 — قرار مالك 2026-08-15).
// يجمّد عقد الطبقة الأمنية لعلاج OBS-013 قبل أي سطر إنتاج. ثلاثة أسئلة:
//   (1) هل يُطلق wc.sendInputEvent حدث 'input-event' على نفس webContents؟
//       (أساس «الكتم الذي يملكه main» حول أفعال الوكيل التي تمر بمسار الإدخال)
//   (2) هل أفعال الوكيل عبر executeJavaScript (el.click/native setter) تمر
//       بمسار input-event؟ (متوقع: لا — فلا تلوث كاشف تدخل المستخدم)
//   (3) سلوك mainFrame.executeJavaScriptInIsolatedWorld على WebContentsView
//       المعزولة: قراءة DOM، رؤية سمات data-satr-ref الموسومة من main world،
//       وحصانة دوال العالم المعزول أمام صفحة تستبدل querySelector/addEventListener.
// الخرج: dist/preview-latency-probe/guard-probe.json + ملخص مطبوع.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const preview = require('../electron/preview');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function startServer() {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html><body>
      <button id="btn" onclick="document.getElementById('log').textContent='clicked-'+Date.now()">زر</button>
      <input id="field" placeholder="حقل">
      <div id="log">idle</div>
      <script>
        // صفحة عدائية: تخرّب main world عمداً — يجب ألا يتأثر العالم المعزول
        document.querySelector = function(){ return null; };
        document.querySelectorAll = function(){ return []; };
        EventTarget.prototype.addEventListener = function(){};
      </script>
    </body></html>`);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: 'http://127.0.0.1:' + server.address().port })));
}

async function main() {
  await app.whenReady();
  const { server, url } = await startServer();
  const win = new BrowserWindow({ show: false, width: 800, height: 600,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const report = { at: new Date().toISOString(), electron: process.versions.electron, findings: {} };

  try {
    preview.setBounds({ x: 0, y: 0, width: 800, height: 600 });
    if (!preview.open(win, () => {}, url).ok) throw new Error('open failed');
    // ملاحظة: الصفحة خرّبت querySelector في main world، لذلك waitFor العادي سيفشل —
    // ننتظر بالتحميل لا بالمحدد
    await delay(1200);
    const view = win.contentView.children.find((child) => child.webContents);
    const wc = view.webContents;

    // ---- (1) + (2): مستمع input-event على webContents ----
    const inputEvents = [];
    wc.on('input-event', (_event, inputEvent) => {
      inputEvents.push({ type: inputEvent.type, at: Date.now() });
    });

    // 1أ: sendInputEvent ماوس (مسار pressKey/نقر المستخدم الحقيقي)
    inputEvents.length = 0;
    wc.sendInputEvent({ type: 'mouseDown', x: 60, y: 30, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: 60, y: 30, button: 'left', clickCount: 1 });
    await delay(250);
    report.findings.sendInputEvent_mouse_emits_input_event = {
      emitted: inputEvents.length > 0,
      types: inputEvents.map((e) => e.type),
    };

    // 1ب: sendInputEvent مفاتيح (مسار pressKey حرفياً)
    inputEvents.length = 0;
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
    await delay(250);
    report.findings.sendInputEvent_key_emits_input_event = {
      emitted: inputEvents.length > 0,
      types: inputEvents.map((e) => e.type),
    };

    // 2: فعل وكيل عبر executeJavaScript — هل يمر بمسار input-event؟
    inputEvents.length = 0;
    await wc.executeJavaScript("document.getElementById('btn').click()", true);
    await wc.executeJavaScript(`(function(){
      var el = document.getElementById('field');
      var desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      desc.set.call(el, 'agent text');
      el.dispatchEvent(new Event('input', {bubbles:true}));
    })()`, true);
    await delay(250);
    report.findings.executeJavaScript_actions_emit_input_event = {
      emitted: inputEvents.length > 0,
      types: inputEvents.map((e) => e.type),
    };

    // ---- (3) isolated world — الـAPI على WebContents نفسه (electron.d.ts:16253
    // داخل class WebContents، لا على WebFrameMain — درس مثبت من تشغيل أول) ----
    const frame = wc;
    report.findings.isolated_world_api_available = typeof frame.executeJavaScriptInIsolatedWorld === 'function';
    if (report.findings.isolated_world_api_available) {
      const WORLD = 1013;
      // 3أ: قراءة DOM من العالم المعزول رغم تخريب main world لـ querySelector
      const isoRead = await frame.executeJavaScriptInIsolatedWorld(WORLD, [{
        code: `(function(){
          var sabotaged = document.querySelector('#btn') === null && (function(){ try { return true; } catch(e){ return false; } })();
          // في العالم المعزول document نفسه لكن prototypes مستقلة؟ نقيس فعلياً:
          var byQS = null; try { byQS = document.querySelector('#btn'); } catch(e){}
          var byId = document.getElementById('btn');
          return { qs_works: !!byQS, getElementById_works: !!byId, btn_text: byId ? byId.textContent : null };
        })()`,
      }]);
      report.findings.isolated_world_dom_read = isoRead;

      // 3ب: وسم سمة من العالم المعزول وقراءتها من main world (السمات مشتركة في DOM)
      await frame.executeJavaScriptInIsolatedWorld(WORLD, [{
        code: `document.getElementById('btn').setAttribute('data-satr-ref-probe', 'iso1'); true`,
      }]);
      const mainSees = await wc.executeJavaScript("document.getElementById('btn').getAttribute('data-satr-ref-probe')", true);
      report.findings.isolated_world_attr_shared_with_main = mainSees === 'iso1';

      // 3ج: هل مستمع مسجل في العالم المعزول يعمل رغم تخريب addEventListener في main؟
      const isoListener = await frame.executeJavaScriptInIsolatedWorld(WORLD, [{
        code: `(function(){
          window.__isoCount = 0;
          try { document.addEventListener('click', function(){ window.__isoCount++; }, true); return { registered: true }; }
          catch(e){ return { registered: false, err: String(e) }; }
        })()`,
      }]);
      wc.sendInputEvent({ type: 'mouseDown', x: 60, y: 30, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x: 60, y: 30, button: 'left', clickCount: 1 });
      await delay(250);
      const isoCount = await frame.executeJavaScriptInIsolatedWorld(WORLD, [{ code: 'window.__isoCount' }]);
      report.findings.isolated_world_listener = { ...isoListener, click_count_after_user_click: isoCount };

      // 3د: عزل globals — main world لا يرى متغيرات العالم المعزول
      const mainSeesIsoGlobal = await wc.executeJavaScript("typeof window.__isoCount", true);
      report.findings.isolated_world_globals_hidden_from_main = mainSeesIsoGlobal === 'undefined';
    }

    // ---- خلاصة العقد ----
    const f = report.findings;
    report.contract = {
      mute_window_feasible: !!(f.sendInputEvent_mouse_emits_input_event && f.sendInputEvent_mouse_emits_input_event.emitted),
      agent_js_actions_invisible_to_detector: !(f.executeJavaScript_actions_emit_input_event && f.executeJavaScript_actions_emit_input_event.emitted),
      isolated_world_viable: !!(f.isolated_world_api_available
        && f.isolated_world_dom_read && (f.isolated_world_dom_read.qs_works || f.isolated_world_dom_read.getElementById_works)
        && f.isolated_world_attr_shared_with_main),
    };

    const outDir = path.join(__dirname, '..', 'dist', 'preview-latency-probe');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'guard-probe.json'), JSON.stringify(report, null, 2), 'utf8');
    console.log('browser-guard-probe: اكتمل');
    console.log(JSON.stringify(report.findings, null, 1));
    console.log('العقد:', JSON.stringify(report.contract));
  } finally {
    preview.destroy();
    if (!win.isDestroyed()) win.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().then(() => app.exit(0)).catch((error) => { console.error(error.stack || error); app.exit(1); });
