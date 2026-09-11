#!/usr/bin/env node
'use strict';

// سطر — حارس قوائم الشريط فوق المعاينة: ترميز index والقشرة وtopbar والدرع من الإنتاج.
// Chromium حقيقي مع محاكاة preload فقط؛ لا يدّعي هذا الحارس فحص WebContentsView الأصلي.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const harness = require('./testsprite-harness');

const TIMEOUT_MS = 15000;
const indexArg = process.argv.indexOf('--index');
const alternateIndex = indexArg < 0 ? null : process.argv[indexArg + 1];
const stylesArg = process.argv.indexOf('--styles');
const alternateStyles = stylesArg < 0 ? null : process.argv[stylesArg + 1];
const previewArg = process.argv.indexOf('--preview');
const alternatePreview = previewArg < 0 ? null : process.argv[previewArg + 1];
const topbarArg = process.argv.indexOf('--topbar');
const alternateTopbar = topbarArg < 0 ? null : process.argv[topbarArg + 1];
let checks = 0;
let lastAction = 'boot';
const watchdog = setTimeout(() => { console.error('topbar-surfaces: timeout after ' + lastAction); app.exit(1); }, 45000);
function check(condition, message) { checks += 1; assert(condition, message); }
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

async function settle(win) {
  await evaluate(win, 'new Promise(resolve => setTimeout(resolve, 30))');
}

async function act(win, code) {
  lastAction = code;
  await evaluate(win, code);
  await settle(win);
}

async function state(win) {
  return evaluate(win, `(() => ({
    held: window.__topbarHold.current,
    calls: window.__topbarHold.calls.slice(),
    settings: !document.getElementById('settingsPop').hidden,
    shortcuts: !document.getElementById('shortcutsPop').hidden,
    changes: !document.getElementById('sessionChangesPop').hidden,
    inline: !document.getElementById('topTools').hidden
  }))()`);
}

function createServer() {
  const server = harness.createHarnessServer();
  if (!alternateIndex && !alternateStyles && !alternatePreview && !alternateTopbar) return server;
  // العضّة تقرأ نسخة معزولة؛ ما لم يُستبدل يبقى من أصول الإنتاج نفسها.
  let html = null;
  if (alternateIndex) {
    const source = fs.readFileSync(path.resolve(alternateIndex), 'utf8');
    const injection = '<script src="vendor/xterm.js"></script>';
    assert(source.includes(injection), 'نقطة حقن محاكاة preload غير موجودة');
    html = source.replace(injection, '<script src="/__testsprite__/mock-satr.js"></script>\n' + injection);
  }
  const styles = alternateStyles ? fs.readFileSync(path.resolve(alternateStyles), 'utf8') : null;
  const preview = alternatePreview ? fs.readFileSync(path.resolve(alternatePreview), 'utf8') : null;
  const topbar = alternateTopbar ? fs.readFileSync(path.resolve(alternateTopbar), 'utf8') : null;
  const original = server.listeners('request')[0];
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    if (html != null && (req.url === '/' || req.url === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
    } else if (styles != null && req.url === '/styles/base.css') {
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(styles);
    } else if (preview != null && req.url === '/ui/components/preview-panel.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(preview);
    } else if (topbar != null && req.url === '/ui/components/topbar.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(topbar);
    } else original(req, res);
  });
  return server;
}

async function main() {
  if (indexArg >= 0) assert(alternateIndex, 'خيار --index يحتاج مساراً');
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, harness.HOST, resolve);
  });
  await app.whenReady();
  const errors = [];
  const win = new BrowserWindow({
    show: false, width: 1366, height: 900,
    webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false,
      offscreen: true, backgroundThrottling: false, partition: 'topbar-surfaces-' + Date.now(), // الرسم يسلم ResizeObserver حتى مع نافذة اختبار مخفية
    },
  });
  win.webContents.on('console-message', (_event, _level, message) => {
    if (/content security policy|uncaught|unhandled/i.test(String(message))) errors.push(String(message));
  });
  try {
    await win.loadURL('http://' + harness.HOST + ':' + server.address().port + '/');
    await waitFor(win,
      "customElements.get('satr-topbar') && document.querySelector('satr-preview-panel').holdForModal && document.querySelector('satr-gate').hidden",
      'إقلاع الشريط والدرع');
    // نراقب حافة الدرع في القشرة ونمرّر النداء إلى التنفيذ الأصلي دون تبديل سلوكه.
    await evaluate(win, `(() => {
      const panel = document.querySelector('satr-preview-panel');
      const original = panel.holdForModal.bind(panel);
      window.__topbarHold = { current: null, calls: [], bounds: [] };
      const bounds = window.satr.previewBounds.bind(window.satr);
      window.satr.previewBounds = (...args) => { window.__topbarHold.bounds.push(args); return bounds(...args); };
      panel.holdForModal = (hold) => {
        window.__topbarHold.current = hold;
        window.__topbarHold.calls.push(hold);
        return original(hold);
      };
    })()`);
    let current = await state(win);
    check(!current.settings && !current.shortcuts && !current.changes, 'تبدأ القوائم الثلاث مغلقة');

    await act(win, "document.getElementById('settingsBtn').click()");
    current = await state(win);
    check(current.settings, 'زر الإعدادات يفتح البطاقة الإنتاجية');
    if (!current.held) {
      console.error('surface diagnostics:', JSON.stringify(await evaluate(win, `({ observed: window.__topbarHold, surfaces: [...document.querySelectorAll('dialog[open], [role="dialog"], [aria-modal="true"], [data-preview-overlay]')].filter(el => el.checkVisibility()).map(el => ({ id: el.id, tag: el.tagName, role: el.getAttribute('role') })) })`)), errors);
    }
    check(current.held, 'settingsPop must hold preview while open');
    check(await evaluate(win, 'window.__topbarHold.bounds.some(args => args.slice(0, 4).every(value => value === 0))'),
      'preview must send zero bounds before its first navigation when an overlay opens');
    await act(win, "document.getElementById('settingsPop').click()");
    check((await state(win)).settings && (await state(win)).held, 'النقر داخل الإعدادات يبقيها مع الحجب');
    await act(win, "document.getElementById('settingsClose').click()");
    current = await state(win);
    check(!current.settings && !current.held, 'زر إغلاق الإعدادات يعيد المعاينة');
    check(await evaluate(win, "document.activeElement.id === 'settingsBtn'"), 'الإغلاق يعيد التركيز إلى زر الإعدادات');

    await act(win, "document.getElementById('settingsBtn').click()");
    await act(win, "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    current = await state(win);
    check(!current.settings && !current.held, 'Escape يغلق الإعدادات ويعيد المعاينة');
    await act(win, "document.getElementById('settingsBtn').click()");
    await act(win, "document.getElementById('input').click()");
    current = await state(win);
    check(!current.settings && !current.held, 'النقر خارج الإعدادات يغلقها ويعيد المعاينة');

    await act(win, "document.getElementById('topMore').click()");
    current = await state(win);
    check(current.inline && !current.held, 'صف الأدوات المضمّن يفتح دون حجب المعاينة');
    for (const [button, field, pop] of [
      ['shortcutsToggle', 'shortcuts', 'shortcutsPop'],
      ['sessionChangesToggle', 'changes', 'sessionChangesPop'],
    ]) {
      await act(win, 'document.getElementById(' + JSON.stringify(button) + ').click()');
      current = await state(win);
      check(current[field], button + ' opens production popover');
      check(current.held, pop + ' must hold preview while open');
      await act(win, 'document.getElementById(' + JSON.stringify(pop) + ').click()');
      current = await state(win);
      check(current[field] && current.held, 'النقر داخل ' + pop + ' يبقي الحجب');
      await act(win, 'document.getElementById(' + JSON.stringify(button) + ').click()');
      current = await state(win);
      check(!current[field] && !current.held, 'النقرة الثانية على ' + button + ' تعيد المعاينة');
      await act(win, 'document.getElementById(' + JSON.stringify(button) + ').click()');
      await act(win, "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
      current = await state(win);
      check(!current[field] && !current.held, 'Escape يغلق ' + pop + ' ويعيد المعاينة');
      await act(win, 'document.getElementById(' + JSON.stringify(button) + ').click()');
      await act(win, "document.getElementById('input').click()");
      current = await state(win);
      check(!current[field] && !current.held, 'النقر خارج ' + pop + ' يعيد المعاينة');
    }

    await act(win, "document.getElementById('settingsBtn').click()");
    const transitionCount = (await state(win)).calls.length;
    await act(win, "document.getElementById('shortcutsToggle').click()");
    current = await state(win);
    check(current.shortcuts && !current.settings && current.held, 'الانتقال من الإعدادات للاختصارات يبقي الحجب');
    await act(win, "document.getElementById('sessionChangesToggle').click()");
    current = await state(win);
    check(current.changes && !current.shortcuts && current.held, 'الانتقال من الاختصارات لملخص الجلسة يبقي الحجب');
    await act(win, "document.getElementById('settingsBtn').click()");
    current = await state(win);
    check(current.settings && !current.changes && current.held, 'العودة إلى الإعدادات تطوي الملخص وتبقي الحجب');
    check(!current.calls.slice(transitionCount).includes(false), 'تبادل القوائم لا يفرج عن المعاينة للحظة');

    await act(win, "document.getElementById('notesDialog').hidden = false");
    await act(win, "document.getElementById('settingsClose').click()");
    current = await state(win);
    check(!current.settings && current.held, 'إغلاق الإعدادات لا يفك حجب حوار ما الجديد');
    await act(win, "document.getElementById('notesDialog').hidden = true");
    check(!(await state(win)).held, 'إغلاق آخر حوار يعيد المعاينة');
    await act(win, "document.getElementById('shortcutsToggle').click()");
    await act(win, "document.getElementById('notesDialog').hidden = false");
    await act(win, "document.getElementById('notesDialog').hidden = true");
    current = await state(win);
    check(current.shortcuts && current.held, 'إغلاق الحوار لا يفك حجب قائمة الاختصارات المتبقية');
    await act(win, "document.getElementById('shortcutsToggle').click()");
    current = await state(win);
    check(!current.held && current.inline, 'آخر قائمة تغلق وصف الأدوات يبقى مرئياً بلا حجب');

    await act(win, "document.getElementById('settingsBtn').click()");
    await act(win, "document.querySelector('satr-topbar').hidden = true");
    check(!(await state(win)).held, 'الإعدادات المخفية بأبيها لا تحجب المعاينة');
    await act(win, "document.querySelector('satr-topbar').hidden = false");
    check((await state(win)).held, 'إظهار أب الإعدادات يعيد الحجب');
    await act(win, "document.getElementById('settingsClose').click()");

    await act(win, "document.querySelector('satr-gate').hidden = false");
    check((await state(win)).held, 'البوابة الظاهرة تحجب المعاينة');
    await act(win, "document.querySelector('satr-gate').hidden = true");
    check(!(await state(win)).held, 'إخفاء البوابة يعيد المعاينة');

    for (const [input, menu] of [['/', 'slashMenu'], ['@src', 'fileMenu']]) {
      await act(win, '(() => { const input = document.getElementById("input"); input.value = '
        + JSON.stringify(input) + '; input.setSelectionRange(input.value.length, input.value.length); input.dispatchEvent(new Event("input", { bubbles: true })); })()');
      await waitFor(win, 'document.getElementById(' + JSON.stringify(menu) + ').classList.contains("open")', 'قائمة ' + input);
      await settle(win);
      check((await state(win)).held, menu + ' must hold preview while open');
      await act(win, "document.getElementById('input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
      check(!(await evaluate(win, 'document.getElementById(' + JSON.stringify(menu) + ').classList.contains("open")')), 'Escape يغلق ' + menu);
      check(!(await state(win)).held, 'إغلاق ' + menu + ' يعيد المعاينة');
      await act(win, "(() => { const input = document.getElementById('input'); input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); })()");
    }

    // xterm الإنتاجي يضع عناصر قياس مخفية خارج الشاشة؛ يجب ألا تمدد جذر RTL.
    await act(win, "document.getElementById('termToggle').click()");
    await waitFor(win, "document.querySelector('.xterm-char-measure-element') && !document.getElementById('termPanel').hidden", 'إقلاع xterm الإنتاجي');
    await act(win, "document.getElementById('previewToggle').click()");
    check(await evaluate(win, "document.querySelector('satr-preview-panel').hasAttribute('open')"), 'المعاينة والطرفية مفتوحتان معاً');
    for (const width of [1000, 1440]) {
      win.setContentSize(width, 900);
      await pause(160);
      await act(win, "document.getElementById('settingsBtn').click()");
      await act(win, "document.getElementById('settingsClose').click()");
      await act(win, "document.getElementById('termView').click()");
      await act(win, "document.getElementById('termView').click()");
      const layout = await evaluate(win, `(() => {
        const root = document.documentElement;
        const before = { width: innerWidth, scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, x: scrollX };
        window.scrollTo(-536, 0);
        return { ...before, afterScroll: scrollX, rootX: root.getBoundingClientRect().x };
      })()`);
      if (layout.scrollWidth > layout.clientWidth + 1) console.error('rtl overflow:', JSON.stringify(await evaluate(win, `(() => { const rootX = document.documentElement.getBoundingClientRect().x; const all = []; const visit = root => { for (const el of root.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) visit(el.shadowRoot); } }; visit(document); return all.filter(el => el.checkVisibility() && el.getBoundingClientRect().x < rootX - 1).slice(0,20).map(el => ({ tag: el.tagName, id: el.id, cls: el.className, rect: el.getBoundingClientRect().toJSON(), text: el.textContent.slice(0,80) })); })()`)));
      check(layout.scrollWidth <= layout.clientWidth + 1,
        'terminal measurement must not overflow RTL document at ' + width + ': ' + JSON.stringify(layout));
      check(layout.afterScroll === 0 && layout.rootX === 0,
        'التركيز وتغيير العرض لا يزيحان جذر التطبيق عند ' + width + ': ' + JSON.stringify(layout));
    }

    // القوائم تبقى داخل النافذة بعد الالتفاف وإعادة التحجيم وهي مفتوحة.
    await act(win, "document.getElementById('cwd').value = 'D:/satr-surface-fixture/project'; document.getElementById('cwd').dispatchEvent(new Event('change', { bubbles: true }))");
    await act(win, "window.satr.appVersion = async () => ({ ok: true, version: '0.0.0', packaged: false }); true");
    win.setContentSize(720, 780);
    await pause(180);
    for (const [button, menu] of [
      ['settingsBtn', 'settingsPop'],
      ['shortcutsToggle', 'shortcutsPop'],
      ['sessionChangesToggle', 'sessionChangesPop'],
    ]) {
      await act(win, 'document.getElementById(' + JSON.stringify(button) + ').click()');
      for (const width of [720, 984, 1424, 984]) {
        win.setContentSize(width, 780);
        await waitFor(win, 'innerWidth === ' + width + ' && innerHeight === 780', 'استقرار حجم النافذة');
        await evaluate(win, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
        await settle(win);
        const bounds = await evaluate(win, '(() => { const el = document.getElementById(' + JSON.stringify(menu)
          + '); const r = el.getBoundingClientRect(); return { maxHeight: el.style.maxHeight, scrollX, animation: getComputedStyle(el).animation, transform: getComputedStyle(el).transform, visible: el.checkVisibility(), left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: innerWidth, height: innerHeight }; })()');
        if (alternateTopbar) console.log('popover bounds:', menu, width, JSON.stringify(bounds));
        check(bounds.visible && bounds.left >= -1 && bounds.top >= -1 && bounds.right <= bounds.width + 1 && bounds.bottom <= bounds.height + 1,
          menu + ' must fit viewport after resize to ' + width + ': ' + JSON.stringify(bounds));
      }
      await act(win, "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    }

    check(errors.length === 0, 'صفر خطأ JavaScript أو CSP: ' + errors.join('\n'));
    console.log('topbar-surfaces: PASS ' + checks + ' checks (production DOM/topbar/shield; mocked preload; no native view claim).');
  } finally {
    if (!win.isDestroyed()) win.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().then(() => { clearTimeout(watchdog); app.exit(0); }).catch((error) => {
  console.error('topbar-surfaces:', error && error.stack ? error.stack : error);
  app.exit(1);
});
