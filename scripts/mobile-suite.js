#!/usr/bin/env node
'use strict';

/**
 * طقم «التحكم من الجوال» — يجمع اختبارات الميزة التسعة في أمر واحد.
 *
 * السبب (OBS-011): كانت التسعة تُشغَّل «بالتذكّر» خارج `test:full`، وهذا بالضبط
 * ما أنتج OBS-007 (الوسيط يخدم v6 والمستودع عند v10). و`test:mobile-integration`
 * هو حارس الوصل الوحيد للميزة، فسقوطه في دفعة لا تمسّ الجوال ما كان ليظهر.
 *
 * الترتيب: القطعية السريعة أولاً، ثم ما يحتاج Electron أو شبكة — فيسقط الأرخص
 * أولاً ولا يُدفع ثمن الأبطأ قبل معرفة النتيجة.
 */

const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const npmCli = process.env.npm_execpath;

const SUITE = [
  'test:mobile-crypto',
  'test:mobile-envelope',
  'test:mobile-pair',
  'test:mobile-link',
  'test:mobile-tls',
  'test:mobile-relay',
  'test:mobile-integration',
  'test:webpush-probe',
  'test:pwa-dom',
];

function run() {
  if (!npmCli) {
    console.error('mobile-suite: شغّل المشغّل عبر npm run كي يتاح مسار npm CLI بلا shell.');
    process.exitCode = 1;
    return;
  }
  console.log(`mobile-suite: بدء طقم الجوال (${SUITE.length} اختبارات بالتسلسل).`);

  let completed = 0;
  for (const script of SUITE) {
    console.log(`\n[${completed + 1}/${SUITE.length}] npm run ${script}`);
    try {
      execFileSync(process.execPath, [npmCli, 'run', script], {
        cwd: ROOT,
        stdio: 'inherit',
        shell: false,
      });
      completed += 1;
    } catch (error) {
      const status = Number.isInteger(error.status) && error.status > 0 ? error.status : 1;
      console.error(`\nmobile-suite: فشل ${script}؛ أُوقف الطقم عند أول فشل.`);
      console.error(`الملخّص: نجح ${completed}/${SUITE.length} قبل الفشل.`);
      process.exitCode = status;
      return;
    }
  }

  console.log(`\nmobile-suite: نجح طقم الجوال كاملاً — ${completed}/${SUITE.length}.`);
}

run();
