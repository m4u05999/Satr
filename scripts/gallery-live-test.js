#!/usr/bin/env node
'use strict';

/**
 * اختبار Chromium حيّ لسطحَي التوليد عند كيمي (الجولتان 8 و9): يشغّل المكوّنين
 * الحقيقيين وورق التصميم الحقيقي تحت CSP الفعلية بنمط اللوحات، مع جسر
 * window.satr مزيف يقدّم بيانات fixture.
 *
 * fixture 1 — لوحة معرض التوليدات 🖼 (ج8/ج9 + مشغّلا الوسائط من ج10 §3): الفتح
 * والإغلاق، الشبكة بخمس بطاقات (صورتان + فيديو + صوت + فاشلة)، المصغرات
 * الكسولة عبر genThumb، المشغّلان الكسولان عبر genMedia (لا طلب قبل النقر،
 * <video/audio controls> بـ objectURL، رفض السقف/المسار/الامتداد برسالة صريحة،
 * revokeObjectURL عند الإغلاق)، نسخ البرومبت، حدث gallery-insert بلا إرسال
 * فعلي، العرض المكبر (فتح/Escape/✕)، والحالة الفارغة الإرشادية.
 *
 * fixture 2 — بطاقة «توليد مكتمل» في المحادثة (ج9 §2): method addGenerationCard
 * في chat.js بعقد الحدث المجمَّد generation_done (مصغرة الصورة عبر genThumb،
 * بطاقتا معلومات للصوت/الفيديو، الكلفة والمسار LTR، نقر البطاقة يستدعي معاودة
 * فتح المعرض، وسقوط المصغرة الصريح). بثّ الحدث الحقيقي يضيفه كودكس عند الدمج،
 * والقائد يتحقق من الوصلة الحية بعده — هنا يُحقن العقد اصطناعياً بنمط الـharness.
 *
 * التشغيل المباشر (سكربت npm ‏test:gallery):
 *   electron scripts/gallery-live-test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const TIMEOUT_MS = 30000;

const FIXTURES = [
  {
    file: 'gallery-live.html',
    component: '../../src/ui/components/gallery-panel.js',
    resultVar: '__galleryLiveResult', progressVar: '__galleryLiveProgress',
    checks: [
      'grid-five-cards', 'lazy-thumbs', 'video-player-card', 'audio-player-card', 'media-lazy-no-preload',
      'failed-card', 'meta-ltr-prompt-auto', 'copy-prompt', 'insert-event-no-send',
      'lightbox-open-esc-close', 'video-player-lazy', 'audio-player-lazy',
      'media-oversize-rejected', 'media-path-ext-rejected', 'close-event', 'media-revoke-on-close', 'empty-state',
    ],
    label: 'gallery-live',
    done: 'شبكة 5 بطاقات، مصغرات كسولة، مشغّلا فيديو/صوت كسولان (genMedia عند النقر فقط)، رفض السقف/المسار/الامتداد، revokeObjectURL عند الإغلاق، نسخ، إدراج بلا إرسال، عرض مكبّر، حالة فارغة',
  },
  {
    file: 'gen-card-live.html',
    component: '../../src/ui/components/chat.js',
    resultVar: '__genCardLiveResult', progressVar: '__genCardLiveProgress',
    checks: [
      'image-card-thumb', 'ltr-cost-path', 'click-opens-gallery',
      'audio-card-info', 'video-card-info', 'thumb-fallback',
    ],
    label: 'gen-card-live',
    done: 'بطاقة صورة بمصغرة genThumb، كلفة ومسار LTR، نقر يفتح المعرض، بطاقتا صوت/فيديو بلا معاينة، سقوط مصغرة صريح',
  },
];

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// عقد genMedia الساكن (ج10 §3): الكتلة المعلَّمة في main.js تفرض القواعد الفعلية —
// الجسر المزيف في الصفحة يحاكيها فقط. الفحص بنمط assertStaticContract في chat-rtl.
function assertGenMediaMainContract() {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8');
  assert.strictEqual((main.match(/satr:genMedia/g) || []).length, 1, 'معالج satr:genMedia ليس وحيداً في main.js.');
  const start = main.indexOf('كتلة genMedia');
  const end = main.indexOf('نهاية كتلة genMedia');
  assert(start !== -1 && end > start, 'غابت علامتا كتلة genMedia الموضعية في main.js.');
  const block = main.slice(start, end);
  for (const needle of [
    "'.mp4': 'video/mp4'", "'.webm': 'video/webm'", "'.wav': 'audio/wav'", "'.mp3': 'audio/mpeg'",
    '24 * 1024 * 1024', 'safeGenerationRel(cwd, p && p.rel, true)',
    'fs.realpathSync', 'stat.size > GEN_MEDIA_MAX_BYTES',
    'GEN_MEDIA_MIME[path.extname(rel).toLowerCase()]',
  ]) assert(block.includes(needle), 'نقص في كتلة genMedia بـ main.js: ' + needle);
  assert(preload.includes("genMedia: (cwd, rel) => ipcRenderer.invoke('satr:genMedia', { cwd, rel })"),
    'غاب سطر genMedia المحدّد في preload.js.');
}

function assertFixtureContract(spec) {
  const source = fs.readFileSync(path.join(__dirname, 'fixtures', spec.file), 'utf8');
  assert(source.includes('../../src/styles/base.css'), spec.file + ' لا يستورد base.css الحقيقي.');
  assert(source.includes(spec.component), spec.file + ' لا يستورد المكوّن الحقيقي.');
  assert(source.includes('gallery-fixture.js'), spec.file + ' لا يحمّل بيانات fixture المشتركة.');
  assert(!/<script(?![^>]*\bsrc\s*=)[^>]*>/i.test(source), spec.file + ' يحوي script مضمّناً.');
  assert(!/\sstyle\s*=/i.test(source), spec.file + ' يحوي style مضمّناً.');
}

async function waitForResult(win, spec) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await win.webContents.executeJavaScript('window.' + spec.resultVar + ' || null', true);
    if (result) return result;
    await delay(50);
  }
  const progress = await win.webContents.executeJavaScript('window.' + spec.progressVar + ' || "unknown"', true);
  throw new Error('انتهت مهلة اختبار ' + spec.label + ' الحي؛ المرحلة: ' + progress);
}

async function runFixture(spec) {
  assertFixtureContract(spec);
  const consoleErrors = [];
  const win = new BrowserWindow({
    show: false, width: 1100, height: 850,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2 || /securitypolicyviolation|content security policy|uncaught|unhandled/i.test(String(message))) {
      consoleErrors.push(String(message));
    }
  });
  try {
    await win.loadFile(path.join(__dirname, 'fixtures', spec.file));
    const result = await waitForResult(win, spec);
    assert.strictEqual(result.pass, true,
      'فشل اختبار ' + spec.label + ' داخل الصفحة (' + (result.progress || '?') + '): ' + (result.error || ''));
    assert.deepStrictEqual(result.violations, [], 'رُصد securitypolicyviolation أثناء ' + spec.label + '.');
    assert.deepStrictEqual(consoleErrors, [], 'ظهرت أخطاء console أثناء ' + spec.label + '.');
    for (const check of spec.checks) assert(result.checks.includes(check), 'غاب فحص ' + spec.label + ' الحي: ' + check);
    console.log(spec.label + ': نجح — ' + spec.done + '؛ صفر CSP.');
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

async function main() {
  assertGenMediaMainContract();
  await app.whenReady();
  // إتلاف نافذة fixture 1 قبل إقلاع نافذة fixture 2 يُسقط آخر نافذة فيبدأ Electron
  // الإغلاق التلقائي فيفشل التحميل الثاني بـ ERR_FAILED — نمنع الإقلاع بين النافذتين
  app.on('window-all-closed', () => {});
  for (const spec of FIXTURES) await runFixture(spec);
}

main().then(() => app.quit()).catch((error) => {
  console.error('gallery-live:', error && error.stack ? error.stack : error);
  app.exit(1);
});
