#!/usr/bin/env node
'use strict';

/**
 * سطر — مزامنة رقم الإصدار في `README.md` مع `package.json` (‏OBS-054).
 *
 * **لماذا توليدٌ لا فحصٌ فقط**: الخطوة موثّقة في إجراء النشر ومع ذلك سقطت **سبع
 * مرات متتالية**، فبقي أمر التنزيل المنشور في الواجهة الأولى للمشروع يعيد `404`
 * من `v2.16.1` حتى `v2.16.8` — لأن `latest/download` يبحث عن اسم الأصل حرفياً.
 * وما يسقط سبع مرات لا يُعالَج بتذكيرٍ ثامن. فالمصدر الوحيد صار `package.json`،
 * وتُشتقّ منه المواضع تلقائياً عند رفع الرقم.
 *
 * **الربط باسم المنتج لا بشكل الرقم — قرار جوهري**: README يحمل أرقاماً تاريخية
 * يجب ألّا تُمسّ (متى دُمج التحديث التلقائي، وحدُّ رخصة MIT). سكربتٌ يستبدل «كل
 * `\d+.\d+.\d+`» كان سيُعيد كتابة تاريخ الترخيص بصمت. فالاستبدال محصور فيما
 * يسبقه اسمُ المنتج أو مسارُ الشارة، وهي وحدها المواضع التي يجب أن تتحرك.
 *
 * التشغيل:
 *   node scripts/sync-readme-version.js           # يكتب (خطّاف `npm version`)
 *   node scripts/sync-readme-version.js --check   # يفحص ولا يكتب (وظيفة الإصدار)
 *
 * **وموضع الفحص مقصود**: عند الوسم لا عند كل push. بين الإصدارات يكون README على
 * الرقم **المنشور** بينما `package.json` قد رُفع بالفعل — ففحصٌ على كل push كان
 * سيكسر CI على عمل سليم.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const README = path.join(ROOT, 'README.md');
const SEMVER = String.raw`\d+\.\d+\.\d+`;

/**
 * المواضع الديناميكية — كلٌّ مرساتُه نصٌّ لا يظهر إلا حيث يجب أن يتحرك الرقم.
 * إضافة موضع جديد إلى README بأحد هذه المراسي يُلتقط تلقائياً؛ وإضافته بمرساة
 * جديدة (‏`Satr-Setup-x.msi` مثلاً) تلتقطها المرساة الثانية لأنها على البادئة.
 */
const ANCHORS = [
  { name: 'شارة الإصدار', re: new RegExp(`(badge/version-)(${SEMVER})`, 'g') },
  { name: 'اسم المثبّت', re: new RegExp(`(Satr-Setup-)(${SEMVER})`, 'g') },
  // `Satr-<رقم>.zip` = أرشيف المصدر الذي يحذّر README من تنزيله. لا يتداخل مع
  // ما قبله لأن `Satr-Setup-` يليه حرفٌ لا رقم.
  { name: 'أرشيف المصدر', re: new RegExp(`(Satr-)(${SEMVER})`, 'g') },
];

function readVersion() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
}

/** يعيد كل موضع ديناميكي مع سطره ورقمه الحالي — للتقرير والفحص معاً. */
function scan(source) {
  const lines = source.split(/\r?\n/);
  const found = [];
  lines.forEach((line, index) => {
    for (const anchor of ANCHORS) {
      anchor.re.lastIndex = 0;
      let match;
      while ((match = anchor.re.exec(line)) !== null) {
        found.push({ line: index + 1, anchor: anchor.name, version: match[2] });
      }
    }
  });
  return found;
}

function rewrite(source, version) {
  let out = source;
  for (const anchor of ANCHORS) out = out.replace(anchor.re, (whole, prefix) => prefix + version);
  return out;
}

function main() {
  const check = process.argv.includes('--check');
  const version = readVersion();
  const source = fs.readFileSync(README, 'utf8');
  const found = scan(source);

  if (!found.length) {
    // اختفاء **كل** المواضع يعني أن README أُعيدت كتابته وسقطت المراسي — وهو
    // بالضبط شكل العطل الأصلي بوجه آخر: مزامنةٌ تنجح على لا شيء.
    console.error('sync-readme-version: لم يُعثر على أي موضع إصدار في README — سقطت المراسي.');
    process.exit(1);
  }

  const stale = found.filter((item) => item.version !== version);
  if (check) {
    if (stale.length) {
      console.error('sync-readme-version: README متأخر عن package.json (' + version + '):');
      for (const item of stale) {
        console.error('  سطر ' + item.line + ' · ' + item.anchor + ' · ' + item.version);
      }
      console.error('العلاج: node scripts/sync-readme-version.js');
      process.exit(1);
    }
    console.log('sync-readme-version: متزامن — ' + found.length + ' موضعاً على ' + version + '.');
    return;
  }

  if (!stale.length) {
    console.log('sync-readme-version: لا تغيير — ' + found.length + ' موضعاً على ' + version + '.');
    return;
  }
  fs.writeFileSync(README, rewrite(source, version), 'utf8');
  console.log('sync-readme-version: حُدِّث ' + stale.length + ' موضعاً إلى ' + version
    + ' (من ' + [...new Set(stale.map((item) => item.version))].join('، ') + ').');
}

if (require.main === module) main();

module.exports = { scan, rewrite, readVersion, ANCHORS };
