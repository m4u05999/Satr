'use strict';

// مسبار كمون أدوات متصفح «سطر» (OBS-014 — دفعة «صقل متصفح سطر» 2026-08-15).
// الغاية: أرقام لا انطباعات قبل العصف. يفصل المسبار ثلاث طبقات:
//   (أ) زمن الأداة الصافي داخل preview.js — يُقاس هنا مباشرة.
//   (ب) توزيع الزمن داخل الأداة الواحدة — بلفّ wc.executeJavaScript بمتتبّع يصنّف
//       كل ذهاب-إياب (flash / probe-begin / الفعل / probe-wait / probe-end / لقطة).
//   (ج) حجم النتيجة العائدة للنموذج بالبايت — هو ما يحدّد رموز الدور وكلفته وزمنه.
// ما لا يقيسه المسبار (فجوة معلنة للعصف): زمن دور النموذج نفسه وزمن الإذن البشري —
// قياسهما يحتاج مسبار SDK حياً مكلفاً أو تحليل سجلات جلسات حقيقية.
// الخرج: dist/preview-latency-probe/report.json + ملخص مطبوع.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { performance } = require('perf_hooks');
const { app, BrowserWindow } = require('electron');
const preview = require('../electron/preview');

const REPEATS = 7; // تكرارات كل قياس — نعتمد الوسيط ضد الشوائب

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
}

// صفحتا القياس: صغيرة (واقع صفحة تجريبية) وكبيرة (200 عنصر تفاعلي — واقع صفحة إنتاجية)
// قيم فريدة لكل نقرة (عدّاد) — درس مثبت من عزل الشذوذ: إسناد textContent بقيمة مطابقة
// لا يولّد mutation في Blink، فيبدو الفعل «بلا أثر» ويلتهم مهلة الرصد كاملة. زر
// same-value يبقى عمداً بقيمة ثابتة لقياس هذا السيناريو الحقيقي باسمه.
function smallPage() {
  return `<!doctype html><html><body>
    <h1>صفحة صغيرة</h1>
    <button id="change" onclick="document.getElementById('status').textContent='changed-'+(++window.__satrC)">غيّر</button>
    <button id="delayed" onclick="setTimeout(function(){document.getElementById('status').textContent='delayed-'+(++window.__satrC)},120)">متأخر</button>
    <button id="noop">بلا أثر</button>
    <button id="same-value" onclick="document.getElementById('status').textContent='fixed'">قيمة ثابتة</button>
    <input id="field" placeholder="حقل">
    <div id="status">idle</div>
    <div id="late-target"></div>
    <script>window.__satrC = 0; setTimeout(function(){document.getElementById('late-target').textContent='ظهر متأخراً';}, 600);</script>
  </body></html>`;
}
function largePage() {
  let buttons = '';
  for (let i = 1; i <= 200; i += 1) {
    buttons += `<button id="b${i}" onclick="document.getElementById('big-status').textContent='clicked-${i}-'+Date.now()">زر رقم ${i} في الصفحة الكبيرة</button>\n`;
  }
  let paragraphs = '';
  for (let i = 1; i <= 60; i += 1) {
    paragraphs += `<p>فقرة نصية رقم ${i} تحاكي محتوى صفحة إنتاجية فيها نص عربي طويل يدخل في bodyText الذي يعود إلى النموذج كاملاً ضمن نتيجة read_page.</p>\n`;
  }
  return `<!doctype html><html><body><h1>صفحة كبيرة</h1><div id="big-status">idle</div>${buttons}${paragraphs}</body></html>`;
}

function startServer() {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(request.url === '/large' ? largePage() : smallPage());
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: 'http://127.0.0.1:' + server.address().port })));
}

// تصنيف ذهابات executeJavaScript بمقاطع مميزة من سكربتات preview.js الفعلية
function classify(expr) {
  const text = String(expr || '');
  if (text.includes('data-satr-agent-flash') && text.includes('transition:opacity')) return 'flash';
  if (text.includes('__satrActionProbe') && text.includes('MutationObserver')) return 'probe_begin';
  if (text.includes('p.resolve=resolve')) return 'probe_wait';
  if (text.includes('p.ob.disconnect')) return 'probe_end';
  if (text.includes("removeAttribute('data-satr-ref')")) return 'snapshot_scan';
  if (text.includes('el.click()')) return 'action_click';
  if (text.includes("dispatchEvent(new Event('input'")) return 'action_type';
  if (text.includes('bodyText')) return 'read_page';
  if (text.includes('indexOf(opt.text)') || text.includes('opt.selector')) return 'wait_poll';
  if (text.includes('scrollIntoView') && text.includes('getBoundingClientRect')) return 'rect';
  return 'other';
}

async function main() {
  await app.whenReady();
  const { server, url } = await startServer();
  const win = new BrowserWindow({ show: false, width: 1000, height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const report = { at: new Date().toISOString(), repeats: REPEATS, baseline: {}, tools: {}, sizes: {}, notes: [] };

  try {
    preview.setBounds({ x: 0, y: 0, width: 1000, height: 800 });
    const opened = preview.open(win, () => {}, url + '/small');
    if (!opened.ok) throw new Error('preview.open failed');
    const ready = await preview.waitFor({ selector: '#change' }, 8000);
    if (!ready.found) throw new Error('small page not ready');

    // الوصول إلى webContents العرض ولفّ executeJavaScript بالمتتبّع
    const view = win.contentView.children.find((child) => child.webContents);
    if (!view) throw new Error('preview view not found');
    const wc = view.webContents;
    const original = wc.executeJavaScript.bind(wc);
    let trace = [];
    wc.executeJavaScript = async (expr, gesture) => {
      const t0 = performance.now();
      const result = await original(expr, gesture);
      trace.push({ tag: classify(expr), ms: Math.round((performance.now() - t0) * 10) / 10 });
      return result;
    };

    // خط الأساس: ذهاب-إياب executeJavaScript فارغ
    const baseTimes = [];
    for (let i = 0; i < REPEATS; i += 1) {
      const t0 = performance.now();
      await original('1', true);
      baseTimes.push(performance.now() - t0);
    }
    report.baseline.execute_roundtrip_ms = Math.round(median(baseTimes) * 10) / 10;

    // قياس أداة: يعيد {median_ms, phases: {tag: median_ms}, result_bytes}
    async function measure(name, fn, { perRunSetup } = {}) {
      const totals = [];
      const phaseRuns = [];
      let resultBytes = 0;
      for (let i = 0; i < REPEATS; i += 1) {
        if (perRunSetup) await perRunSetup();
        trace = [];
        const t0 = performance.now();
        const result = await fn();
        totals.push(performance.now() - t0);
        phaseRuns.push(trace.slice());
        if (result && !result.error) resultBytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
        else if (result && result.error) report.notes.push(`${name}: error=${result.error} (run ${i + 1})`);
      }
      const phases = {};
      for (const run of phaseRuns) for (const step of run) {
        (phases[step.tag] = phases[step.tag] || []).push(step.ms);
      }
      const phaseMedians = {};
      for (const [tag, values] of Object.entries(phases)) {
        phaseMedians[tag] = { median_ms: median(values), calls_per_run: Math.round((values.length / REPEATS) * 10) / 10 };
      }
      report.tools[name] = {
        median_ms: Math.round(median(totals) * 10) / 10,
        result_bytes: resultBytes,
        phases: phaseMedians,
      };
      return report.tools[name];
    }

    // ---- الصفحة الصغيرة ----
    await measure('snapshot_small', () => preview.snapshot());
    await measure('read_page_small', () => preview.readPage());
    // النقر بتغيّر فوري / متأخر 120ms / بلا أثر — يكشف أثر نافذة الرصد 360ms
    let currentRef = '';
    const refFromSnapshot = async (label) => {
      const snap = await preview.snapshot();
      const match = snap.snap.elements.join('\n').match(new RegExp('\\[(s\\d+:e\\d+)\\] button "' + label + '"'));
      return match ? match[1] : null;
    };
    await measure('click_instant_change', () => preview.clickElement(currentRef),
      { perRunSetup: async () => { currentRef = await refFromSnapshot('غيّر'); } });
    await measure('click_delayed_120ms', () => preview.clickElement(currentRef),
      { perRunSetup: async () => { currentRef = await refFromSnapshot('متأخر'); } });
    await measure('click_noop', () => preview.clickElement(currentRef),
      { perRunSetup: async () => { currentRef = await refFromSnapshot('بلا أثر'); } });
    // فعل حقيقي بلا mutation: زر يسند القيمة الثابتة نفسها — النقر ينفَّذ ومعناه يقع
    // لكن Blink لا يولّد mutation فتُلتهم مهلة الرصد ويعود dom_changed:false مضللاً
    await measure('click_same_value', () => preview.clickElement(currentRef),
      { perRunSetup: async () => { currentRef = await refFromSnapshot('قيمة ثابتة'); } });
    let typeCounter = 0;
    await measure('type_text', () => preview.typeText('#field', 'نص القياس ' + (++typeCounter)));
    await measure('wait_for_present', () => preview.waitFor({ selector: '#change' }, 5000));
    await measure('screenshot_page', () => preview.screenshot());
    await measure('screenshot_element', () => preview.screenshotElement('#change', { emitThumbnail: false }));

    // ظهور متأخر 600ms — يكشف حبيبية الاستقصاء 250ms في waitFor
    await measure('wait_for_late_600ms', async () => {
      await preview.navigate(url + '/small');
      await preview.waitFor({ selector: '#change' }, 8000);
      return preview.waitFor({ text: 'ظهر متأخراً' }, 8000);
    });

    // ---- الصفحة الكبيرة (200 عنصر) ----
    await preview.navigate(url + '/large');
    await preview.waitFor({ selector: '#b200' }, 8000);
    await measure('snapshot_large_200', () => preview.snapshot());
    await measure('read_page_large', () => preview.readPage());
    let largeRef = '';
    await measure('click_large_page', () => preview.clickElement(largeRef), {
      perRunSetup: async () => {
        const snap = await preview.snapshot();
        largeRef = snap.snap.elements.join('\n').match(/\[(s\d+:e\d+)\] button "زر رقم 7 /)[1];
      },
    });
    await measure('screenshot_large', () => preview.screenshot());

    // أحجام النتائج المفتاحية (ما يعود للنموذج فيستهلك رموز الدور)
    report.sizes.snapshot_small_bytes = report.tools.snapshot_small.result_bytes;
    report.sizes.snapshot_large_bytes = report.tools.snapshot_large_200.result_bytes;
    report.sizes.read_page_small_bytes = report.tools.read_page_small.result_bytes;
    report.sizes.read_page_large_bytes = report.tools.read_page_large.result_bytes;
    report.sizes.screenshot_page_bytes = report.tools.screenshot_page.result_bytes;
    report.sizes.screenshot_large_bytes = report.tools.screenshot_large.result_bytes;

    // كتابة التقرير
    const outDir = path.join(__dirname, '..', 'dist', 'preview-latency-probe');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, 'report.json');
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

    const lines = ['preview-latency-probe: اكتمل — الوسيط من ' + REPEATS + ' تكرارات', 'baseline executeJavaScript: ' + report.baseline.execute_roundtrip_ms + 'ms'];
    for (const [name, data] of Object.entries(report.tools)) {
      const phases = Object.entries(data.phases)
        .map(([tag, ph]) => `${tag}=${ph.median_ms}ms×${ph.calls_per_run}`).join(' ');
      lines.push(`${name}: ${data.median_ms}ms · ${data.result_bytes}B · ${phases}`);
    }
    lines.push('التقرير: ' + outPath);
    console.log(lines.join('\n'));
  } finally {
    preview.destroy();
    if (!win.isDestroyed()) win.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().then(() => app.exit(0)).catch((error) => { console.error(error.stack || error); app.exit(1); });
