#!/usr/bin/env node
'use strict';

/**
 * اختبار Chromium حيّ لبوابة أول التشغيل بعد عقد الجاهزية بحسب المحرك
 * (أسبوع خطة العصف — البند الأول، قرار 2026-08-23).
 *
 * لماذا حيّ ولا يكفي اختبار readiness النقي؟ لأن الحاجز المعتمد يقول «البوابة تفتح
 * لمن يملك Codex أو Kimi» — وهذا سلوك مكوّن، لا حساب دالة. الدرس المثبّت عندنا أن
 * حارساً يختبر منطقاً موازياً بدل منطق الطرف نفسه يبقى أخضر بينما الميزة معطّلة.
 * لذلك يشغّل هذا الاختبار <satr-gate> الإنتاجي تحت CSP الفعلية ويضغط «أعد الفحص»
 * كما يفعل المستخدم، ويتحقق من الحجب/الفتح والإرشاد المعروض فعلاً.
 *
 * ويثبت أيضاً عقد main.js الساكن (نمط assertStaticContract): أن preflight يسأل
 * مسبارَي Codex وKimi ويعيد لقطة الجاهزية، وأن مفاتيح المحاكاة الثلاثة موجودة.
 *
 * التشغيل (سكربت npm ‏test:gate-live): electron scripts/gate-live-test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const TIMEOUT_MS = 30000;
const CHECKS = [
  'codex-only-opens', 'claude-only-opens', 'kimi-only-opens',
  'key-provider-opens', 'key-section-guidance', 'key-setup-saves-and-opens',
  'key-save-error-redacted', 'recheck-forces-scan',
  'none-installed-blocks', 'three-engines-guided', 'logged-out-guides-login',
  'fail-open-unknown-auth', 'legacy-preflight-fallback', 'null-preflight-blocks',
  'recheck-button-drives-scan',
];

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// عقد main.js الساكن: البوابة لا تعمل إن لم يجمع preflight حالات المحركات الثلاثة.
function assertPreflightContract() {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  const start = main.indexOf("ipcMain.handle('satr:preflight'");
  assert(start !== -1, 'غاب معالج satr:preflight من main.js.');
  const block = main.slice(start, start + 5000);
  for (const needle of [
    'readiness.deriveReadiness', 'codex.resolveCodexBin(true)', 'codex.accountStatus(force)',
    'kimi.resolveKimiBin(true)', 'kimi.authStatus()',
    "forced('CLAUDE')", "forced('CODEX')", "forced('KIMI')", "forced('KEYS')",
    'keys.names()', 'keyProviders', 'readyEngines', 'preferred',
  ]) assert(block.includes(needle), 'نقص في معالج preflight بـ main.js: ' + needle);
  // العقد القديم يجب أن يبقى — كل مستهلك قائم يقرأ claude/node/npm كما كان
  assert(/return\s*\{\s*\n?\s*claude,\s*node,\s*npm,/.test(block), 'عقد preflight القديم (claude/node/npm) تغيّر.');
  assert(main.includes("const readiness = require('./readiness')"), 'readiness.js غير مربوط في main.js.');
  const codexStatusStart = main.indexOf("ipcMain.handle('satr:codexStatus'");
  const codexStatusBlock = main.slice(codexStatusStart, codexStatusStart + 500);
  assert(codexStatusStart !== -1 && codexStatusBlock.includes('codex.accountStatus()')
    && !codexStatusBlock.includes('codex.accountStatus(true)') && !codexStatusBlock.includes('codex.accountStatus(force)'),
  'satr:codexStatus يجب أن يبقى على كاش الحساب بلا force.');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8');
  assert(preload.includes("ipcRenderer.invoke('satr:preflight'") && preload.includes('{ force: true }'),
    'preload لا يمرّر force المنقّى إلى satr:preflight.');
  const ui = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'app.js'), 'utf8');
  assert(ui.includes('providerPreferred') && ui.includes('[gatePreferred]')
    && ui.includes("localStorage.setItem('satr_engine', next)"),
  'app.js لا يصحح محركاً أصيلاً غير جاهز إلى preferred الخاص بمزوّد المفتاح.');
}

function assertFixtureContract() {
  const source = fs.readFileSync(path.join(__dirname, 'fixtures', 'gate-live.html'), 'utf8');
  assert(source.includes('../../src/styles/base.css'), 'fixture البوابة لا يستورد base.css الحقيقي.');
  assert(source.includes('../../src/ui/components/gate.js'), 'fixture البوابة لا يستورد المكوّن الحقيقي.');
  assert(!/<script(?![^>]*\bsrc\s*=)[^>]*>/i.test(source), 'fixture البوابة يحوي script مضمّناً.');
  assert(!/\sstyle\s*=/i.test(source), 'fixture البوابة يحوي style مضمّناً.');
}

async function waitForResult(win) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await win.webContents.executeJavaScript('window.__gateLiveResult || null', true);
    if (result) return result;
    await delay(50);
  }
  const progress = await win.webContents.executeJavaScript('window.__gateLiveProgress || "unknown"', true);
  throw new Error('انتهت مهلة اختبار البوابة الحي؛ المرحلة: ' + progress);
}

// browser_readability لا يدخل Shadow DOM؛ هذا القياس الحي يطبّق العدادات الأربعة
// نفسها على سطح البوابة الحقيقي عند عرضين وفي الوضعين، ويقيس الرسوّ بالبكسل لا
// getComputedStyle(direction) وحدها.
async function auditGateSurface(win, width, height, theme) {
  win.setContentSize(width, height);
  await win.webContents.executeJavaScript(
    `document.documentElement.dataset.theme = ${JSON.stringify(theme)}; document.fonts.ready.then(() => true)`, true);
  await delay(80);
  return win.webContents.executeJavaScript(`(() => {
    const gate = document.getElementById('gate');
    const root = gate.shadowRoot;
    const card = root.querySelector('.gate-card');
    const hostBox = gate.getBoundingClientRect();
    const cardBox = card.getBoundingClientRect();
    const visible = (el) => {
      const box = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
    };
    const blocks = Array.from(root.querySelectorAll('p,li,h1,h2,label'))
      .filter((el) => visible(el) && (el.textContent || '').trim().length >= 12);
    const wanted = (text) => {
      const ar = (text.match(/[\u0600-\u06FF\u0750-\u077F\u0870-\u089F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g) || []).length;
      const lat = (text.match(/[A-Za-z]/g) || []).length;
      return !ar && !lat ? '' : (ar * 2 >= lat ? 'rtl' : 'ltr');
    };
    const firstRect = (el) => {
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walk.nextNode())) {
        // العلامة المخصّصة في li محرف ضعيف زخرفي؛ BiDi يحسم من أول محرف قوي.
        const at = node.data.search(/[A-Za-z\u0600-\u06FF\u0750-\u077F\u0870-\u089F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/);
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at); range.setEnd(node, at + 1);
        const box = range.getBoundingClientRect();
        if (box.width || box.height) return box;
      }
      return null;
    };
    const direction = [];
    for (const el of blocks) {
      const want = wanted(el.textContent || '');
      if (!want) continue;
      if (el.getAttribute('dir') !== want) {
        direction.push({ kind: 'attribute', tag: el.tagName, text: el.textContent.slice(0, 40) });
        continue;
      }
      const first = firstRect(el); const box = el.getBoundingClientRect();
      if (!first) continue;
      const fromRight = box.right - first.right; const fromLeft = first.left - box.left;
      if (Math.abs(fromRight - fromLeft) < 1) continue;
      const got = fromRight <= fromLeft ? 'rtl' : 'ltr';
      if (got !== want) direction.push({ kind: 'pixel', tag: el.tagName, text: el.textContent.slice(0, 40) });
    }
    const rgba = (value) => {
      const match = String(value).match(/[\d.]+/g);
      if (!match || match.length < 3) return null;
      return [Number(match[0]), Number(match[1]), Number(match[2]), match.length > 3 ? Number(match[3]) : 1];
    };
    const background = (el) => {
      let current = el;
      while (current) {
        const color = rgba(getComputedStyle(current).backgroundColor);
        if (color && color[3] >= .99) return color;
        current = current.parentElement || (current.getRootNode && current.getRootNode().host) || null;
      }
      return [255, 255, 255, 1];
    };
    const luminance = (color) => {
      const values = color.slice(0, 3).map((part) => {
        const channel = part / 255;
        return channel <= .03928 ? channel / 12.92 : Math.pow((channel + .055) / 1.055, 2.4);
      });
      return .2126 * values[0] + .7152 * values[1] + .0722 * values[2];
    };
    const contrast = [];
    for (const el of blocks) {
      const fg = rgba(getComputedStyle(el).color); const bg = background(el);
      if (!fg || fg[3] < .99) continue;
      const a = luminance(fg); const b = luminance(bg);
      const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
      const style = getComputedStyle(el);
      const large = parseFloat(style.fontSize) >= 24
        || (parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700);
      if (ratio + .01 < (large ? 3 : 4.5)) contrast.push({ tag: el.tagName, ratio });
    }
    const horizontal = Array.from(root.querySelectorAll('*')).filter(visible).filter((el) => {
      const box = el.getBoundingClientRect();
      return box.left < hostBox.left - .5 || box.right > hostBox.right + .5;
    }).map((el) => el.className || el.tagName);
    const fontFamily = getComputedStyle(root.querySelector('.gate-key-intro')).fontFamily;
    const loadedFamilies = Array.from(document.fonts).filter((face) => face.status === 'loaded').map((face) => face.family);
    return {
      viewport: document.documentElement.clientWidth,
      direction,
      contrast,
      overflow: horizontal,
      pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      hostOverflow: gate.scrollWidth > gate.clientWidth,
      clippedTop: cardBox.top < hostBox.top - .5,
      font: !fontFamily.includes('IBM Plex Sans Arabic')
        || !loadedFamilies.some((family) => family.includes('IBM Plex Sans Arabic')),
    };
  })()`, true);
}

async function main() {
  assertPreflightContract();
  assertFixtureContract();
  await app.whenReady();
  const consoleErrors = [];
  const win = new BrowserWindow({
    show: false, width: 1000, height: 900,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2 || /securitypolicyviolation|content security policy|uncaught|unhandled/i.test(String(message))) {
      consoleErrors.push(String(message));
    }
  });
  try {
    await win.loadFile(path.join(__dirname, 'fixtures', 'gate-live.html'));
    const result = await waitForResult(win);
    assert.strictEqual(result.pass, true,
      'فشل اختبار البوابة داخل الصفحة (' + (result.progress || '?') + '): ' + (result.error || ''));
    assert.deepStrictEqual(result.violations, [], 'رُصد securitypolicyviolation في البوابة.');
    assert.deepStrictEqual(consoleErrors, [], 'ظهرت أخطاء console أثناء اختبار البوابة.');
    for (const check of CHECKS) assert(result.checks.includes(check), 'غاب فحص البوابة الحي: ' + check);
    const audits = [];
    for (const theme of ['dark', 'light']) {
      audits.push(await auditGateSurface(win, 390, 700, theme));
      audits.push(await auditGateSurface(win, 1280, 900, theme));
    }
    for (const audit of audits) {
      assert([390, 1280].includes(audit.viewport), 'عرض القياس الفعلي غير متوقع: ' + audit.viewport);
      assert.deepStrictEqual(audit.direction, [], 'مخالفة اتجاه في بوابة Shadow: ' + JSON.stringify(audit.direction));
      assert.strictEqual(audit.font, false, 'خط IBM Plex Sans Arabic غير محمّل في البوابة.');
      assert.deepStrictEqual(audit.contrast, [], 'مخالفة تباين في البوابة: ' + JSON.stringify(audit.contrast));
      assert.deepStrictEqual(audit.overflow, [], 'تجاوز أفقي داخل البوابة: ' + JSON.stringify(audit.overflow));
      assert.strictEqual(audit.pageOverflow || audit.hostOverflow, false, 'تجاوز أفقي في صفحة/مضيف البوابة.');
      assert.strictEqual(audit.clippedTop, false, 'أعلى بطاقة البوابة مقصوص في النافذة القصيرة.');
    }
    console.log('gate-live: نجح — البوابة تفتح على محرك أصيل أو مفتاح REST محفوظ، وتعرض مسار المفتاح المجاني '
      + 'وتحفظه بلا صدى ثم تعيد الفحص، و«أعد الفحص» يرسل force؛ وتتراجع للعقد القديم؛ '
      + 'قياس 390/1280px في الداكن/الفاتح: اتجاه/خط/تباين/تجاوز = 0؛ صفر CSP.');
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

main().then(() => app.quit()).catch((error) => {
  console.error('gate-live:', error && error.stack ? error.stack : error);
  app.exit(1);
});
