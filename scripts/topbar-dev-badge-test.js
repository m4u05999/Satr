#!/usr/bin/env node
/**
 * حارس شارات بيئة التشغيل (OBS-031 — المرشّح ب، ثم نسخة المتجر 2026-09-04).
 * فحص ساكن: لا يحتاج متصفحاً، يكفي أن يثبت أن الشارتين موجودتان ومشروطتان
 * بالعلمين اللذين تعيدهما القناة القائمة `satr:appVersion` — `app.isPackaged`
 * لنسخة التطوير، و`process.windowsStore` لنسخة Microsoft Store (‏MSIX).
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function read(rel) {
  // main.js يحوي بايتات \0 تتخلّل التعليقات الكبيرة؛ نزيلها كي لا تكسر البحث
  return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\0/g, '');
}

function run() {
  const html = read('src/index.html');
  assert(/<span\s+id="topbarDevBadge"/.test(html),
    'index.html يحوي شارة الشريط العلوي #topbarDevBadge');
  assert(/\btopbarDevBadge\b[^>]*\bhidden\b/.test(html),
    'الشارة مخفية افتراضياً (hidden)');
  assert(/title="[^"]*منفصلة[^"]*مجلد بيانات[^"]*"/.test(html),
    'title للشارة يشرح الانفصال عن النسخة المثبتة');
  assert(/>\s*نسخة تطوير\s*</.test(html),
    'نص الشارة «نسخة تطوير»');

  const topbar = read('src/ui/components/topbar.js');
  assert(/window\.satr\.appVersion\s*\(\s*\)/.test(topbar),
    'topbar.js يستدعي satr:appVersion القائمة');
  assert(/topbarDevBadge/.test(topbar),
    'topbar.js يقرأ عنصر الشارة');
  assert(/topbarDevBadge[\s\S]{0,120}appVersionData\.packaged\s*!==\s*false/.test(topbar),
    'الشارة تظهر فقط حين packaged === false (تطوير)');

  const css = read('src/styles/base.css');
  assert(/\.dev-badge\s*\{/.test(css),
    'base.css يعرّف صنف .dev-badge');
  assert(/\.dev-badge[\s\S]*?var\(--gold\)[\s\S]*?var\(--gold-soft\)/.test(css),
    'نمط الشارة يستخدم tokens الألوان');

  const main = read('electron/main.js');
  assert(/ipcMain\.handle\('satr:appVersion'/.test(main),
    'main.js يعرّف معالج satr:appVersion');
  assert(/packaged:\s*app\.isPackaged\s*===\s*true/.test(main),
    'satr:appVersion يعيد packaged من app.isPackaged');

  // ---- نسخة المتجر (‏MSIX) ----
  // العلم يُقاس لا يُفترض: هو نفسه الشرط الذي يعطّل المُحدِّث، فلو لم يُرفع داخل
  // الحاوية لحاولت نسخة المتجر تنزيل مثبّت NSIS موازٍ.
  assert(/msix:\s*process\.windowsStore\s*===\s*true/.test(main),
    'satr:appVersion يعيد msix من process.windowsStore');
  assert(/appVersionData\.msix\s*===\s*true/.test(topbar),
    'topbar.js يفرّع على علم msix');
  assert(/appVersionData\.msix[\s\S]{0,400}checkUpdatesRow/.test(topbar),
    'نسخة المتجر تُخفي صف «تحقق من التحديثات» — المتجر هو من يحدّث');
  assert(/نسخة المتجر/.test(topbar),
    'شارة ⚙ تقول «نسخة المتجر» صراحةً');

  const updater = read('electron/updater.js');
  assert(/options\.msix\s*!==\s*true/.test(updater),
    'shouldEnableUpdates يشترط غياب msix');
}

run();
console.log('topbar-dev-badge-test: ok — الشارتان مشروطتان بـ app.isPackaged وprocess.windowsStore عبر satr:appVersion.');
