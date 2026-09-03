#!/usr/bin/env node
/**
 * حارس شارة «نسخة تطوير» في الشريط العلوي (OBS-031 — المرشّح ب).
 * فحص ساكن: لا يحتاج متصفحاً، يكفي أن يثبت أن الشارة موجودة ومشروطة بـ
 * `app.isPackaged` عبر القناة القائمة `satr:appVersion`.
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
}

run();
console.log('topbar-dev-badge-test: ok — الشارة مشروطة بـ app.isPackaged عبر satr:appVersion.');
