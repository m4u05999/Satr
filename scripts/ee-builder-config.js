/**
 * إعداد بناء «سطر Enterprise» (ARCHITECTURE.md §6) — يوسّع إعداد package.json:
 * نفس إعداد البناء المجتمعي تماماً + ضمّ مجلد enterprise/ (النواة تكتشفه بالمُحمِّل
 * الشرطي تلقائياً). الاستعمال: npm run dist:ee
 *
 * لا تكرار للإعداد: نقرأ build من package.json ونعدّل قائمة الملفات فقط.
 */

const base = require('../package.json').build;
const cfg = JSON.parse(JSON.stringify(base));

// إزالة استثناء enterprise وضمّه (اعتماديات الطبقة — إن وُجدت لاحقاً — تُضاف هنا)
cfg.files = cfg.files.filter((f) => f !== '!enterprise/**');
cfg.files.push('enterprise/**/*');

// تمييز حزمة Enterprise عن المجتمعية بلاحقة في اسم الناتج (نفس appId — ترقية سلسة)
cfg.artifactName = '${productName}-EE-${version}-${arch}.${ext}';

module.exports = cfg;
