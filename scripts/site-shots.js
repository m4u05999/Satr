#!/usr/bin/env node
'use strict';

/**
 * توليد لقطات واجهة «سطر» الحقيقية لصفحة الهبوط — نمط الاختبار الحي المثبّت:
 * ‏BrowserWindow يحمّل fixture يشغّل مكوّنات الواجهة الإنتاجية بمحتوى عربي مجهّز،
 * ثم capturePage إلى site/assets/. يُشغَّل يدوياً: npx electron scripts/site-shots.js
 */

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'site', 'assets');
const TIMEOUT_MS = 30000;

// profile محلي يمنع تصادم cache Electron حين تولّد شجرة عمل موازية لقطاتها في الوقت نفسه.
app.setPath('userData', path.join(ROOT, 'dist', '.site-shots-profile'));

const SHOTS = [
  { fixture: 'site-shots.html', out: 'app-tasks.png', width: 1500, height: 1220, query: { variant: 'ledger' } },
  { fixture: 'site-shots.html', out: 'app-chat.png', width: 1500, height: 1220, query: { variant: 'diff' } },
  { fixture: 'site-shots-term.html', out: 'app-term.png', width: 1500, height: 440 },
  { fixture: 'site-shots-ops.html', out: 'app-ops.png', width: 760, height: 700 },
  { fixture: 'site-shots-ops.html', out: 'app-judges.png', width: 760, height: 1080, query: { variant: 'judges' } },
  { fixture: 'site-shots-preview.html', out: 'app-preview.png', width: 1280, height: 860 },
  { fixture: 'site-shots-gen.html', out: 'app-generation-chat.png', width: 1280, height: 820, query: { scene: 'chat' } },
  { fixture: 'site-shots-gen.html', out: 'app-generation-gallery.png', width: 1280, height: 900, query: { scene: 'gallery' } },
  { fixture: 'site-shots-gen.html', out: 'app-generation-permission.png', width: 960, height: 680, query: { scene: 'permission' } },
  { sitePage: true, section: 'generate', verifyGenerate: true, out: 'round10-generation-preview.png', width: 1440, height: 2500, destination: 'dist' },
  // معاينة مقطع اهتمام ماك/لينكس — ‏OBS-069: لم يكن له مدخل. الرسو بالإزاحة التي
  // يحسبها معالج المراسي نفسه (‏anchorOffset في site/js/main.js) لا بـscrollIntoView،
  // فتُظهر اللقطة ما يراه الزائر بعد الإصلاح لا رأس المقطع خلف الرأس الثابت.
  { sitePage: true, section: 'platform-interest', anchorScroll: true, out: 'platform-interest-preview.png', width: 1440, height: 1400, destination: 'dist' },
];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitReady(win) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = await win.webContents.executeJavaScript(
      'window.__shotsError ? { error: window.__shotsError } : { ready: !!window.__shotsReady }', true);
    if (state.error) throw new Error('fixture error: ' + state.error);
    if (state.ready) return;
    await delay(50);
  }
  throw new Error('انتهت مهلة تجهيز لقطة الموقع.');
}

async function verifySiteResponsive(win, shot) {
  win.setSize(390, 844);
  await delay(120);
  const state = await win.webContents.executeJavaScript(`
    const columns = (selector) => getComputedStyle(document.querySelector(selector))
      .gridTemplateColumns.trim().split(/\\s+/).length;
    ({
      width: innerWidth,
      height: innerHeight,
      story: columns('.generate-story'),
      cost: columns('.cost-story'),
      transparency: columns('.generate-transparency'),
      frameTransform: getComputedStyle(document.querySelector('.generate-frame')).transform,
    });
  `, true);
  if (state.story !== 1 || state.cost !== 1 || state.transparency !== 1 || state.frameTransform !== 'none') {
    throw new Error('فشل تجاوب قسم التوليد: ' + JSON.stringify(state));
  }
  console.log('✓ site-responsive', state.width + 'x' + state.height,
    'columns=' + state.story + '/' + state.cost + '/' + state.transparency,
    'transform=' + state.frameTransform);
  win.setSize(shot.width, shot.height);
  await delay(120);
}

// نافذة واحدة يُعاد تحميلها لكل لقطة — إنشاء نافذة ثانية offscreen+sandbox
// يفشل حتمياً بـ ERR_FAILED في هذه البيئة (ملاحظة مثبّتة بالتجربة)
async function capture(win, shot) {
  win.setSize(shot.width, shot.height);
  if (shot.sitePage) {
    await win.loadFile(path.join(ROOT, 'site', 'index.html'));
    if (shot.verifyGenerate) await verifySiteResponsive(win, shot);
    const landing = await win.webContents.executeJavaScript(`(() => {
      document.documentElement.style.scrollBehavior = 'auto';
      document.querySelectorAll('[data-reveal]').forEach((element) => {
        element.style.setProperty('opacity', '1', 'important');
        element.style.setProperty('transform', 'none', 'important');
      });
      document.querySelectorAll('.generate-frame').forEach((element) =>
        element.style.setProperty('transform', 'none', 'important'));
      const goldLine = document.getElementById('goldLine');
      if (goldLine) goldLine.style.display = 'none';
      const section = document.getElementById(${JSON.stringify(shot.section)});
      if (${shot.anchorScroll ? 'true' : 'false'}) {
        // الإزاحة من دالة الإنتاج نفسها؛ الاحتياط للحالة التي يتعذّر فيها تحميل main.js
        const offset = typeof anchorOffset === 'function' ? anchorOffset() : -60;
        window.scrollTo(0, Math.max(0, section.getBoundingClientRect().top + window.scrollY + offset));
      } else {
        section.scrollIntoView({ block: 'start' });
      }
      const box = section.getBoundingClientRect();
      return {
        sectionTop: Math.round(box.top),
        sectionBottom: Math.round(box.bottom),
        headerBottom: Math.round(document.querySelector('.site-header').getBoundingClientRect().bottom),
        viewport: window.innerHeight,
      };
    })()`, true);
    console.log('  ↳ رسوّ #' + shot.section + ': رأس المقطع=' + landing.sectionTop +
      ' حافة الرأس=' + landing.headerBottom + ' أسفل المقطع=' + landing.sectionBottom +
      ' ارتفاع النافذة=' + landing.viewport);
    await delay(900); // تحميل الصور الكسول واستقرار خطوط صفحة الهبوط
  } else {
    await win.loadFile(path.join(__dirname, 'fixtures', shot.fixture), { query: shot.query || {} });
    await waitReady(win);
  }
  await delay(250); // استقرار الرسم النهائي
  let image = await win.webContents.capturePage();
  if (image.isEmpty()) {
    // احتياط: بعض البيئات لا ترسم offscreen — نظهر النافذة خارج الشاشة لحظة
    win.setPosition(-4000, -4000);
    win.show();
    await delay(600);
    image = await win.webContents.capturePage();
  }
  if (image.isEmpty()) throw new Error('capturePage أعادت صورة فارغة: ' + shot.out);
  const destination = shot.destination === 'dist' ? path.join(ROOT, 'dist') : OUT_DIR;
  fs.mkdirSync(destination, { recursive: true });
  const file = path.join(destination, shot.out);
  fs.writeFileSync(file, image.toPNG());
  const size = image.getSize();
  console.log('✓', shot.out, size.width + 'x' + size.height, Math.round(fs.statSync(file).size / 1024) + 'KB');
}

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({
    show: false,
    width: 1500,
    height: 1220,
    frame: false,
    webPreferences: {
      offscreen: true,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  try {
    for (const shot of SHOTS) await capture(win, shot);
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

main().then(() => app.exit(0)).catch((error) => {
  console.error('site-shots:', error && error.stack ? error.stack : error);
  app.exit(1);
});
