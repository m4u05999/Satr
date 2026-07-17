/**
 * إعداد بناء «سطر Enterprise» (ARCHITECTURE.md §6) — يوسّع إعداد package.json:
 * نفس إعداد البناء المجتمعي تماماً + ضمّ checkout خاص خارجي في موضع enterprise/
 * داخل الحزمة (النواة تكتشفه بالمُحمِّل الشرطي تلقائياً). الاستعمال:
 *   SATR_ENTERPRISE_DIR=<absolute-private-checkout> npm run dist:ee
 *
 * لا تكرار للإعداد: نقرأ build من package.json ونعدّل قائمة الملفات فقط.
 */

const base = require('../package.json').build;
const { resolveEnterpriseSource } = require('./enterprise-source');

const { source } = resolveEnterpriseSource(process.env.SATR_ENTERPRISE_DIR);
const cfg = JSON.parse(JSON.stringify(base));

// حزمة Enterprise خاصة وتُرفع كـ artifact فقط؛ لا ترث ناشر Community العام.
delete cfg.publish;

// إزالة الاستثناء العام ثم إضافة FileSet صريح من المستودع الخاص؛ لا تُنسخ الشفرة إلى Community.
cfg.files = cfg.files.filter((f) => f !== '!enterprise/**');
cfg.files.push({
  from: source,
  to: 'enterprise',
  filter: ['**/*', '!.git{,/**/*}', '!test.js', '!README.md'],
});

// تمييز حزمة Enterprise عن المجتمعية بلاحقة في اسم الناتج (نفس appId — ترقية سلسة)
cfg.artifactName = '${productName}-EE-${version}-${arch}.${ext}';

module.exports = cfg;
