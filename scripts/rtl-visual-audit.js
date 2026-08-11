#!/usr/bin/env node
// scripts/rtl-visual-audit.js — جولة «فحص RTL شامل» بصري
// يشغّل التطبيق الحقيقي (electron/main.js) مرتين (افتراضي / --lang=ar) ويلتقط
// لقطات لأسطح الواجهة، ويقيس مؤشرات هندسية، ثم يفرز الفروق في docs/RTL-AUDIT.md.
// لا يعدّل ملفات الإنتاج — ينتج ملفين فقط:
//   dist/rtl-audit/{default,ar}/*   (لقطات + metrics.json)
//   docs/RTL-AUDIT.md               (التقرير)

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'rtl-audit');
const FIXTURE_REPO = path.join(DIST, 'fixture-repo');

const LOCALES = [
  { name: 'default', flag: [] },
  { name: 'ar', flag: ['--lang=ar'] },
];

const SIZES = [
  { name: '1400x900', width: 1400, height: 900 },
  { name: '1100x760', width: 1100, height: 760 },
];

const SURFACES = [
  { name: 'topbar' },
  { name: 'empty-chat' },
  { name: 'composer' },
  { name: 'terminal' },
  { name: 'files' },
  { name: 'git' },
  { name: 'settings' },
  { name: 'ops-room' },
  { name: 'preview' },
];

const IS_WORKER = !!process.env.SATR_RTL_AUDIT_PASS;

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function resolveElectron() {
  const candidates = [
    path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
    path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron'),
    path.join(ROOT, 'node_modules', '.bin', 'electron'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error('لم يُعثر على ثنائي Electron');
}

// ---------- إعداد مستودع الاختبار ----------

function prepareFixtureRepo() {
  fs.rmSync(FIXTURE_REPO, { recursive: true, force: true });
  fs.mkdirSync(FIXTURE_REPO, { recursive: true });

  const readme = '# مشروع تجريبي\n\nملف للفحص البصري.\n';
  fs.writeFileSync(path.join(FIXTURE_REPO, 'README.md'), readme, 'utf8');
  fs.writeFileSync(path.join(FIXTURE_REPO, 'feature.js'), '// ملف جديد غير ملتزم\n', 'utf8');
  fs.mkdirSync(path.join(FIXTURE_REPO, 'src'), { recursive: true });
  fs.writeFileSync(path.join(FIXTURE_REPO, 'src', 'app.js'), 'console.log("hello");\n', 'utf8');

  // git init + commit أولي، ثم تعديل وحذف لإظهار تغييرات
  const run = (cmd) => require('child_process').execSync(cmd, { cwd: FIXTURE_REPO, encoding: 'utf8' });
  run('git init -q');
  run('git config user.email "audit@satr.local"');
  run('git config user.name "Audit"');
  run('git add README.md src/app.js');
  run('git commit -q -m "initial"');
  fs.writeFileSync(path.join(FIXTURE_REPO, 'README.md'), readme + '\n## تعديل\n', 'utf8');
  fs.writeFileSync(path.join(FIXTURE_REPO, 'feature.js'), '// ملف جديد غير ملتزم\nconst x = 1;\n', 'utf8');
  fs.rmSync(path.join(FIXTURE_REPO, 'src', 'app.js'));
}

// ---------- خادم المعاينة المحلي ----------

function startPreviewServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      // صفحة بلون مميز (magenta) يسهل رصدها في لقطة الشاشة
      res.end('<!doctype html><html><body style="margin:0;background:#ff00ff;"></body></html>');
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// ---------- وضع المراقب (controller) ----------

async function runController() {
  prepareFixtureRepo();

  for (const loc of LOCALES) {
    const dir = path.join(DIST, loc.name);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  }

  for (const loc of LOCALES) {
    console.log(`[مراقب] بدء التشغيل بلغة: ${loc.name}`);
    await runWorkerProcess(loc.name, loc.flag);
  }

  const metrics = {};
  for (const loc of LOCALES) {
    const file = path.join(DIST, loc.name, 'metrics.json');
    metrics[loc.name] = JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  const report = buildReport(metrics.default, metrics.ar);
  fs.writeFileSync(path.join(ROOT, 'docs', 'RTL-AUDIT.md'), report, 'utf8');
  console.log('[مراقب] اكتمل التقرير: docs/RTL-AUDIT.md');
}

async function runWorkerProcess(locale, flag) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, SATR_RTL_AUDIT_PASS: locale };
    const args = [__filename, ...flag];
    const child = spawn(resolveElectron(), args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => process.stdout.write(d));
    child.stderr.on('data', (d) => process.stderr.write(d));
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`فشل العامل ${locale} بالرمز ${code}`));
      resolve();
    });
  });
}

// ---------- وضع العامل (worker) — تشغيل التطبيق الحقيقي ----------

async function runWorker(locale) {
  const { app, BrowserWindow, desktopCapturer, screen } = require('electron');

  if (locale === 'ar') app.commandLine.appendSwitch('lang', 'ar');

  // تحميل التطبيق الحقيقي: يسجّل معالجات IPC وينشئ النافذة عند جهوزية التطبيق
  require(path.join(ROOT, 'electron', 'main.js'));

  await app.whenReady();
  const win = await waitForMainWindow();

  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const label = level >= 2 ? 'RENDERER-ERR' : 'RENDERER-LOG';
    console.log(`[${label}] ${sourceId}:${line} ${message}`);
  });

  // تجهيز الواجهة: مسح الحالة المحفوظة، ضبط مجلد المشروع، إخفاء بوابة الإطلاق
  await execJS(win, 'init-ui', `
    (function(){
      try { localStorage.clear(); } catch(e) {}
      const cwd = document.getElementById('cwd');
      if (cwd) {
        cwd.value = ${JSON.stringify(FIXTURE_REPO)};
        cwd.dispatchEvent(new Event('change', { bubbles: true }));
        cwd.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const gate = document.querySelector('satr-gate');
      if (gate) { gate.hidden = true; gate.style.display = 'none'; }
    })();
  `);
  await delay(900);

  const previewServer = await startPreviewServer();
  const previewUrl = `http://127.0.0.1:${previewServer.address().port}/`;

  const metrics = { locale, appLocale: app.getLocale(), sizes: [] };

  for (const size of SIZES) {
    win.setContentSize(size.width, size.height);
    await delay(500);

    const sizeMetrics = {
      name: size.name,
      window: { width: size.width, height: size.height },
      surfaces: {},
    };

    for (const surface of SURFACES) {
      await execJS(win, `prep-${surface.name}`, prepareSurfaceScript(surface.name, previewUrl));
      await delay(surface.name === 'preview' ? 1200 : 700);

      const shotPath = path.join(DIST, locale, `${surface.name}-${size.name}.png`);
      const img = await win.capturePage();
      fs.writeFileSync(shotPath, img.toPNG());

      const domMetrics = await execJS(win, `measure-${surface.name}`, measureSurfaceScript(surface.name));
      sizeMetrics.surfaces[surface.name] = {
        screenshot: path.relative(ROOT, shotPath).replace(/\\/g, '/'),
        dom: domMetrics,
      };

      if (surface.name === 'preview') {
        const native = await measurePreviewNative(win, desktopCapturer, screen);
        sizeMetrics.surfaces[surface.name].nativeView = native;
      }
    }

    metrics.sizes.push(sizeMetrics);
  }

  previewServer.close();
  win.destroy();

  fs.writeFileSync(path.join(DIST, locale, 'metrics.json'), JSON.stringify(metrics, null, 2), 'utf8');
  console.log(`[عامل ${locale}] حُفظت المقاييس`);

  app.exit(0);
}

async function execJS(win, label, code) {
  try {
    return await win.webContents.executeJavaScript(code);
  } catch (err) {
    console.error(`[JS-ERR ${label}]`, err.message);
    throw err;
  }
}

async function waitForMainWindow(timeout = 30000) {
  const { BrowserWindow } = require('electron');
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const wins = BrowserWindow.getAllWindows();
    if (wins.length) return wins[0];
    await delay(100);
  }
  throw new Error('انتهت مهلة انتظار النافذة الرئيسية');
}

// ---------- سكربتات داخل Renderer ----------

function prepareSurfaceScript(surface, previewUrl) {
  return `
    (function(){
      function click(id) { const el = document.getElementById(id); if (el) el.click(); }
      function closeAll() {
        const settingsPop = document.getElementById('settingsPop');
        if (settingsPop && !settingsPop.hidden) click('settingsBtn');
        const topTools = document.getElementById('topTools');
        if (topTools && !topTools.hidden) click('topMore');
        const files = document.querySelector('satr-files-panel');
        if (files && files.close && files.hasAttribute('open')) files.close();
        const git = document.querySelector('satr-git-panel');
        if (git && git.close && git.hasAttribute('open')) git.close();
        const ops = document.querySelector('satr-ops-room');
        if (ops && ops.close && ops.hasAttribute('open')) ops.close();
        const preview = document.querySelector('satr-preview-panel');
        if (preview && preview.close && preview.hasAttribute('open')) preview.close();
        const termPanel = document.getElementById('termPanel');
        if (termPanel && !termPanel.hidden) click('termToggle');
      }
      closeAll();

      const surface = ${JSON.stringify(surface)};
      if (surface === 'terminal') click('termToggle');
      else if (surface === 'files') { click('topMore'); click('filesToggle'); }
      else if (surface === 'git') { click('topMore'); click('gitToggle'); }
      else if (surface === 'settings') click('settingsBtn');
      else if (surface === 'ops-room') click('opsRoomToggle');
      else if (surface === 'preview') {
        click('previewToggle');
        setTimeout(() => {
          if (window.satr && window.satr.previewOpen) window.satr.previewOpen(${JSON.stringify(previewUrl)});
        }, 120);
      }
    })();
  `;
}

function measureSurfaceScript(surface) {
  return `
    (function(){
      const surface = ${JSON.stringify(surface)};
      const $ = (id) => document.getElementById(id);
      const qs = (sel) => document.querySelector(sel);
      const sr = (host, sel) => (host && host.shadowRoot) ? host.shadowRoot.querySelector(sel) : null;
      const r = (el) => {
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return {
          x: Math.round(b.x), y: Math.round(b.y),
          w: Math.round(b.width), h: Math.round(b.height),
          l: Math.round(b.left), r: Math.round(b.right),
          t: Math.round(b.top), b: Math.round(b.bottom),
        };
      };
      const win = { w: window.innerWidth, h: window.innerHeight };
      const m = { window: win, elements: {} };

      if (surface === 'topbar') {
        m.elements.header = r(qs('satr-topbar header'));
        m.elements.wordmark = r(qs('.wordmark'));
        m.elements.controls = r(qs('satr-topbar .controls'));
        m.elements.cwdField = r($('cwd'));
        m.elements.settingsBtn = r($('settingsBtn'));
      }
      else if (surface === 'empty-chat') {
        m.elements.chatColumn = r($('chatColumn'));
        m.elements.chat = r(qs('satr-chat'));
        m.elements.banner = r($('banner'));
        m.elements.composer = r(qs('satr-composer footer'));
      }
      else if (surface === 'composer') {
        const footer = qs('satr-composer footer');
        m.elements.footer = r(footer);
        m.elements.input = r($('input'));
        m.elements.send = r($('send'));
        m.elements.engine = r($('engine'));
        m.elements.awarenessBar = r($('awarenessBar'));
        m.elements.attachBtn = r($('attachBtn'));
      }
      else if (surface === 'terminal') {
        m.elements.termPanel = r($('termPanel'));
        m.elements.termTabs = r(qs('.term-tabs'));
        m.elements.termHost = r(qs('.term-host'));
        m.elements.termToggle = r($('termToggle'));
      }
      else if (surface === 'files') {
        const host = qs('satr-files-panel');
        m.elements.panel = r(host);
        m.elements.head = r(sr(host, '.panel-head'));
        m.elements.search = r(sr(host, '.panel-search input'));
        m.elements.tree = r(sr(host, '.tree'));
        m.elements.firstRow = r(sr(host, '.ft-row'));
      }
      else if (surface === 'git') {
        const host = qs('satr-git-panel');
        m.elements.panel = r(host);
        m.elements.head = r(sr(host, '.panel-head'));
        m.elements.list = r(sr(host, '.panel-list'));
        m.elements.firstRow = r(sr(host, '.gd-row'));
      }
      else if (surface === 'settings') {
        m.elements.settingsPop = r($('settingsPop'));
        m.elements.settingsHead = r(qs('.settings-head'));
        m.elements.effortField = r($('effort'));
        m.elements.keysMgr = r($('keysMgr'));
      }
      else if (surface === 'ops-room') {
        const host = qs('satr-ops-room');
        m.elements.panel = r(host);
        m.elements.head = r(sr(host, '.panel-head'));
        m.elements.guidedPath = r(sr(host, '.guided-path'));
        m.elements.stationStrip = r(sr(host, '.station-strip'));
      }
      else if (surface === 'preview') {
        const host = qs('satr-preview-panel');
        m.elements.panel = r(host);
        m.elements.pvHead = r(sr(host, '.pv-head'));
        m.elements.pvBox = r(sr(host, '#pvBox'));
        m.elements.pvUrl = r(sr(host, '#pvUrl'));
        m.elements.pvHint = r(sr(host, '#pvHint'));
      }
      return m;
    })();
  `;
}

// ---------- قياس العرض الأصلي في لوحة المعاينة (لقطة شاشة) ----------

async function measurePreviewNative(win, desktopCapturer, screen) {
  const contentBounds = win.getContentBounds();
  const display = screen.getDisplayMatching(contentBounds);
  const sf = display.scaleFactor || 1;
  const thumbW = Math.round(display.size.width * sf);
  const thumbH = Math.round(display.size.height * sf);

  let sources;
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: thumbW, height: thumbH },
    });
  } catch (e) {
    return { error: 'capture_failed', message: e.message };
  }
  const img = sources[0] && sources[0].thumbnail;
  if (!img || img.isEmpty()) return { error: 'no_image' };

  const size = img.getSize();
  const bmp = img.toBitmap(); // BGRA
  const k = size.width / display.size.width;

  // لون الصفحة المؤشرة magenta (#ff00ff) — BGRA: R=255, G=0, B=255
  const isMagenta = (i) => bmp[i] > 220 && bmp[i + 1] < 35 && bmp[i + 2] > 220;

  const xMin = Math.round(contentBounds.x * k);
  const xMax = Math.round((contentBounds.x + contentBounds.width) * k);
  const yMid = Math.round((contentBounds.y + contentBounds.height / 2) * k);

  let first = -1, last = -1;
  for (let x = xMin; x <= xMax && x < size.width; x++) {
    const idx = (yMid * size.width + x) * 4;
    if (isMagenta(idx)) { if (first < 0) first = x; last = x; }
  }

  if (first < 0) return { found: false, contentBounds };
  return {
    found: true,
    leftInWindow: Math.round(first / k) - contentBounds.x,
    rightInWindow: Math.round(last / k) - contentBounds.x,
    width: Math.round((last - first + 1) / k),
    contentBounds,
  };
}

// ---------- بناء التقرير ----------

function buildReport(def, ar) {
  const date = new Date().toISOString();
  const rows = [];
  const differences = [];

  for (const size of SIZES) {
    const defSize = def.sizes.find((s) => s.name === size.name);
    const arSize = ar.sizes.find((s) => s.name === size.name);
    if (!defSize || !arSize) {
      rows.push({ surface: '—', size: size.name, verdict: 'لم يُقاس', severity: '—', notes: 'ناقص مقاس كامل' });
      continue;
    }

    for (const surface of SURFACES) {
      const ds = defSize.surfaces[surface.name];
      const as = arSize.surfaces[surface.name];
      const result = compareSurface(size.name, surface.name, ds, as);
      rows.push({
        surface: surface.name,
        size: size.name,
        verdict: result.ok ? 'مطابق' : 'مختلف',
        severity: result.severity,
        notes: result.notes,
      });
      if (!result.ok) {
        differences.push({
          surface: surface.name,
          size: size.name,
          severity: result.severity,
          description: result.description,
          defaultShot: ds && ds.screenshot,
          arShot: as && as.screenshot,
          hypothesis: result.hypothesis,
        });
      }
    }
  }

  const tableRows = rows.map((row) =>
    `| ${row.surface} | ${row.size} | ${row.verdict} | ${row.severity} | ${row.notes} |`
  ).join('\n');

  const diffSection = differences.length
    ? differences.map((d) => {
        const lines = [
          `### ${d.surface} — ${d.size} (${d.severity})`,
          '',
          d.description,
          '',
          `- اللقطة الافتراضية: \`${d.defaultShot || '—'}\``,
          `- اللقطة العربية: \`${d.arShot || '—'}\``,
          `- فرضية السبب: ${d.hypothesis}`,
        ];
        return lines.join('\n');
      }).join('\n\n')
    : 'لم يُرصد أي فرق هندسي يتجاوز عتبة التسامح (+2 بكسل).'

  const severityOrder = { 'يمنع الاستخدام': 0, 'مزعج': 1, 'تجميلي': 2 };
  const bySeverity = [...differences].sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
  const top3 = bySeverity.slice(0, 3);
  const top3Text = top3.length
    ? top3.map((d, i) => `${i + 1}. **${d.surface}** (${d.size}): ${d.description.split('\n')[0]}`).join('\n')
    : 'لا توجد فروق ذات خطورة مرتفعة.';

  const recImmediate = differences.filter((d) => d.severity === 'يمنع الاستخدام').map((d) => `- ${d.surface} (${d.size})`).join('\n') || '- لا شيء.';
  const recLater = differences.filter((d) => d.severity !== 'يمنع الاستخدام').map((d) => `- ${d.surface} (${d.size}) — ${d.severity}`).join('\n') || '- لا شيء.';

  return `# تقرير فحص RTL بصري — سطر

**تاريخ التشغيل:** ${date}  
**اللغات المقارنة:** افتراضي النظام (${def.appLocale}) مقابل \`--lang=ar\` (${ar.appLocale})  
**المقاسات:** ${SIZES.map((s) => s.name).join('، ')}  
**الأسطح المفحوصة:** ${SURFACES.map((s) => s.name).join('، ')}

## ملخص

- عدد الأسطح المفحوصة: **${SURFACES.length * SIZES.length}** (${SURFACES.length} أسطح × ${SIZES.length} مقاس).
- عدد الفروق المُكتشفة: **${differences.length}**.
- أخطر ثلاثة:

${top3Text}

## منهجية المقارنة

1. شُغّل التطبيق الحقيقي (electron/main.js) مرتين: باللغة الافتراضية وبـ \`--lang=ar\`.
2. لكل مقاس، أُخذت لقطة لكل سطح بعد فتحه برمجياً (نقرات محاكاة).
3. قُيست \`getBoundingClientRect\` لعناصر رئيسية في كل سطح.
4. قورنت العناصر بين اللغتين:
   - العرض والارتفاع يجب أن يتطابقا (+2 بكسل).
   - الحواف الأفقية والرأسية يجب ألا تزح (+2 بكسل).
   - لا عنصر يُقصّ خارج نافذة المحتوى.
   - لا تداخل غير متوقع بين عناصر رئيسية.
5. بالنسبة لـ **المعاينة**، رُصد العرض الأصلي (WebContentsView) بلون مؤشر من لقطة الشاشة للتحقق من انعكاس RTL.

> ملاحظة: HTML الأساسي للتطبيق يبقى \`dir="rtl"\` في الحالتين؛ الفرق الوحيد هو إعداد \`--lang\` الذي يغيّر سلوك Chromium للطبقات الأصلية والخطوط/الأشرطة الافتراضية.

## جدول النتائج

| السطح | المقاس | الحكم | الخطورة | ملاحظات |
|---|---|---|---|---|
${tableRows}

## تفاصيل الفروق

${diffSection}

## ما لم يُفحص ولماذا

- **المحادثة الحية بمحتوى:** تتطلب تشغيل دور SDK/Codex ومفاتيح API، وهو خارج نطاق الفحص البصري بدون شبكة.
- **مربع الأذونات / حوار السؤال / حوار Elicitation:** يتطلب وصولاً برمجياً لحالة الدور؛ لم تُعرض أثناء الفحص.
- **عارض الملفات (file-viewer):** يتطلب فتح ملف باختيار مستخدم؛ يمكن فحصه في دفعة لاحقة.
- **الوضع الفاتح:** جميع اللقطات التقطت بالثيمة الافتراضية (داكن)؛ لم يُجرَب الوضع الفاتح.
- **شريط التمرير الأفقي:** لم تُقاس دقة موضع الشريط بين اللغتين إلا ضمنياً عبر عدم القصّ.

## توصية الفرز

### إصلاح فوري (يمنع الاستخدام)

${recImmediate}

### يؤجَّل / يُراجع

${recLater}

## مسارات اللقطات

- الافتراضي: \`dist/rtl-audit/default/\`
- العربية: \`dist/rtl-audit/ar/\`

---
*أُنتج تلقائياً بواسطة scripts/rtl-visual-audit.js*
`;
}

function compareSurface(sizeName, surfaceName, ds, as) {
  if (!ds || !as) {
    return {
      ok: false, severity: 'يمنع الاستخدام',
      notes: 'ناقص بيانات سطح في إحدى اللغتين',
      description: `بيانات السطح ناقصة: default=${!!ds}, ar=${!!as}.`,
      hypothesis: 'فشل في التقاط أو قياس السطح — راجع سجلات العامل.',
    };
  }

  const defWin = ds.dom.window || ds.dom.elements.window || {};
  const arWin = as.dom.window || as.dom.elements.window || {};
  const tolerance = 2;
  const issues = [];

  const defEls = ds.dom.elements || {};
  const arEls = as.dom.elements || {};
  const keys = new Set([...Object.keys(defEls), ...Object.keys(arEls)]);

  for (const key of keys) {
    const a = defEls[key];
    const b = arEls[key];
    if ((a == null) !== (b == null)) {
      issues.push(`العنصر "${key}" ${a == null ? 'غائب في الافتراضي' : 'غائب في العربية'}.`);
      continue;
    }
    if (a == null) continue;
    if (Math.abs(a.w - b.w) > tolerance || Math.abs(a.h - b.h) > tolerance) {
      issues.push(`"${key}" أبعاد مختلفة: default ${a.w}×${a.h} vs ar ${b.w}×${b.h}.`);
    }
    if (Math.abs(a.x - b.x) > tolerance || Math.abs(a.y - b.y) > tolerance) {
      issues.push(`"${key}" موضع مختلف: default (${a.x},${a.y}) vs ar (${b.x},${b.y}).`);
    }

    // فحص القصّ في كل لغة على حدة
    const winW = (a == defEls[key] ? defWin.w : arWin.w) || a.w;
    const winH = (a == defEls[key] ? defWin.h : arWin.h) || a.h;
    if (a.r > winW + tolerance || a.b > winH + tolerance || a.x < -tolerance || a.y < -tolerance) {
      issues.push(`"${key}" مقصوص في ${a === defEls[key] ? 'الافتراضي' : 'العربية'}: x=${a.x} y=${a.y} r=${a.r} b=${a.b} (نافذة ${winW}×${winH}).`);
    }
  }

  // فحص تداخل العرض الأصلي مع إطار المعاينة (للمعاينة فقط)
  if (surfaceName === 'preview' && ds.nativeView && as.nativeView && ds.nativeView.found && as.nativeView.found) {
    const pvBoxDef = defEls.pvBox;
    const pvBoxAr = arEls.pvBox;
    if (pvBoxDef && pvBoxAr) {
      const defInside = ds.nativeView.leftInWindow >= pvBoxDef.x - tolerance &&
        ds.nativeView.rightInWindow <= pvBoxDef.r + tolerance;
      const arInside = as.nativeView.leftInWindow >= pvBoxAr.x - tolerance &&
        as.nativeView.rightInWindow <= pvBoxAr.r + tolerance;
      if (!defInside || !arInside) {
        issues.push(`العرض الأصلي خارج إطار المعاينة: default inside=${defInside} (left=${ds.nativeView.leftInWindow}, box=${pvBoxDef.x}-${pvBoxDef.r}), ar inside=${arInside} (left=${as.nativeView.leftInWindow}, box=${pvBoxAr.x}-${pvBoxAr.r}).`);
      }
    }
    if (Math.abs(ds.nativeView.width - as.nativeView.width) > 20 ||
        Math.abs(ds.nativeView.leftInWindow - as.nativeView.leftInWindow) > tolerance) {
      issues.push(`موضع/عرض العرض الأصلي يختلف: default ${ds.nativeView.leftInWindow}+${ds.nativeView.width}, ar ${as.nativeView.leftInWindow}+${as.nativeView.width}.`);
    }
  }

  // فحص تداخل بسيط: هل رأس اللوحة الجانبية يتداخل مع الشريط العلوي؟
  if (['files', 'git', 'ops-room', 'preview'].includes(surfaceName)) {
    const defPanel = defEls.panel || defEls.termPanel;
    const defHeader = defEls.header;
    if (defPanel && defHeader && rectanglesOverlap(defPanel, defHeader)) {
      issues.push(`تداخل بين السطح الجانبي والشريط العلوي في الافتراضي.`);
    }
    const arPanel = arEls.panel || arEls.termPanel;
    const arHeader = arEls.header;
    if (arPanel && arHeader && rectanglesOverlap(arPanel, arHeader)) {
      issues.push(`تداخل بين السطح الجانبي والشريط العلوي في العربية.`);
    }
  }

  if (!issues.length) {
    return { ok: true, severity: '—', notes: 'مطابق هندسياً', description: '', hypothesis: '' };
  }

  const hasClip = issues.some((i) => i.includes('مقصوص'));
  const hasMissing = issues.some((i) => i.includes('غائب'));
  const severity = (hasClip || hasMissing) ? 'يمنع الاستخدام' : 'مزعج';

  return {
    ok: false,
    severity,
    notes: issues[0],
    description: issues.join('\n'),
    hypothesis: surfaceName === 'preview'
      ? 'ربما متعلق بمرآة RTL للعرض الأصلي (WebContentsView) — راجع electron/preview.js nativeBounds/applyBounds.'
      : 'ربما فرق في أبعاد النافذة الأصلية أو ترتيب العرض عند تغيير --lang.',
  };
}

function rectanglesOverlap(a, b) {
  return a.x < b.r && a.r > b.x && a.y < b.b && a.b > b.y;
}

// ---------- نقطة الدخول ----------

main().catch((err) => {
  console.error(err.stack || err);
  process.exit(1);
});

async function main() {
  if (IS_WORKER) await runWorker(process.env.SATR_RTL_AUDIT_PASS);
  else await runController();
}
