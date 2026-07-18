#!/usr/bin/env node
'use strict';

/**
 * تضمين مكتبات صفحة الهبوط (site/) من node_modules إلى site/vendor — نمط
 * scripts/vendor-xterm.js نفسه: يُشغَّل يدوياً عند الترقية فقط والناتج مُلتزَم.
 * الموقع ثابت خالص بلا CDN (نفس فلسفة CSP الصارمة في التطبيق).
 * يضمّن أيضاً خط IBM Plex Sans Arabic بنسخ ناتج src/vendor/fonts المُلتزَم.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'site', 'vendor');

const FILES = [
  ['node_modules/gsap/dist/gsap.min.js', 'gsap.min.js'],
  ['node_modules/gsap/dist/ScrollTrigger.min.js', 'ScrollTrigger.min.js'],
  ['node_modules/lenis/dist/lenis.min.js', 'lenis.min.js'],
  ['src/vendor/fonts.css', 'fonts.css'],
];

fs.mkdirSync(OUT, { recursive: true });
for (const [from, to] of FILES) {
  fs.copyFileSync(path.join(ROOT, from), path.join(OUT, to));
  console.log('vendored:', to);
}

// الخط: نسخ الناتج المُلتزَم في src/vendor/fonts (لا إعادة توليد من fontsource)
const FONT_SRC = path.join(ROOT, 'src', 'vendor', 'fonts');
const FONT_OUT = path.join(OUT, 'fonts');
fs.mkdirSync(FONT_OUT, { recursive: true });
for (const name of fs.readdirSync(FONT_SRC)) {
  fs.copyFileSync(path.join(FONT_SRC, name), path.join(FONT_OUT, name));
}
console.log('vendored: fonts/ (' + fs.readdirSync(FONT_OUT).length + ' files)');
