/**
 * إعداد بناء «سطر Enterprise» (ARCHITECTURE.md §6) — يوسّع إعداد package.json:
 * نفس إعداد البناء المجتمعي تماماً + ضمّ checkout خاص خارجي في موضع enterprise/
 * داخل الحزمة (النواة تكتشفه بالمُحمِّل الشرطي تلقائياً). الاستعمال:
 *   SATR_ENTERPRISE_DIR=<absolute-private-checkout> npm run dist:ee
 *
 * لا تكرار للإعداد: نقرأ build من package.json ونعدّل قائمة الملفات فقط.
 */

const base = require('../package.json').build;
const fs = require('fs');
const path = require('path');
const { resolveEnterpriseSource } = require('./enterprise-source');
const { createStageHooks } = require('./enterprise-stage');

const { source, manifest } = resolveEnterpriseSource(process.env.SATR_ENTERPRISE_DIR);
const inheritedBeforePack = base.beforePack;
const inheritedAfterPack = base.afterPack;
const cfg = JSON.parse(JSON.stringify(base));
const packageFiles = Object.freeze([...manifest.packageFiles]);

function resolveHook(hook, name) {
  if (hook == null) return null;
  if (typeof hook === 'function') return hook;
  if (typeof hook !== 'string') throw new Error(`خطاف ${name} غير صالح`);
  const projectRoot = path.resolve(__dirname, '..');
  const candidate = path.isAbsolute(hook) ? hook : path.resolve(projectRoot, hook);
  const target = fs.existsSync(candidate) ? candidate : require.resolve(hook, { paths: [projectRoot] });
  const loaded = require(target);
  const resolved = loaded[name] || loaded.default || loaded;
  if (typeof resolved !== 'function') throw new Error(`خطاف ${name} لا يصدّر دالة`);
  return resolved;
}

// حزمة Enterprise خاصة وتُرفع كـ artifact فقط؛ null صريح يتغلب على دمج electron-builder
// مع build.publish في package.json. حذف المفتاح وحده لا يكفي لأنه يعيد وراثة إعداد Community.
cfg.publish = null;

// هوية الحزمة لا تعتمد على نجاح الترخيص أو تحميل الوحدة وقت التشغيل.
cfg.extraMetadata = {
  ...(cfg.extraMetadata || {}),
  satrEdition: 'enterprise',
  satrEnterpriseContract: manifest.contractVersion,
};

// عزل مخرجات الإصدارين يمنع بقايا app-update.yml العامة أو win-unpacked مجتمعي قديم.
cfg.directories = { ...(cfg.directories || {}), output: 'dist/enterprise' };

// لا تدخل ملفات المصدر الخاصة المتتبعة؛ تُحزم نسخة مؤقتة من allowlist داخل dist فقط.
cfg.files = cfg.files.filter((f) => f !== '!enterprise/**');
const enterpriseFileSet = {
  // نسخة build مؤقتة من allowlist فقط؛ لا تُنشئ enterprise/ في المصدر ولا تدخل Community.
  from: path.join(__dirname, '..', 'dist', '.enterprise-stage-pending'),
  to: 'enterprise',
  filter: [...packageFiles],
};
cfg.files.push(enterpriseFileSet);

const stageHooks = createStageHooks({
  projectRoot: path.resolve(__dirname, '..'),
  source,
  packageFiles,
  distRoot: path.resolve(__dirname, '..', 'dist'),
  fileSet: enterpriseFileSet,
  beforePack: resolveHook(inheritedBeforePack, 'beforePack'),
  afterPack: resolveHook(inheritedAfterPack, 'afterPack'),
  verifySource() {
    const current = resolveEnterpriseSource(process.env.SATR_ENTERPRISE_DIR);
    if (current.source !== source
        || current.manifest.name !== manifest.name
        || current.manifest.contractVersion !== manifest.contractVersion
        || current.manifest.main !== manifest.main
        || JSON.stringify(current.manifest.packageFiles) !== JSON.stringify(packageFiles)) {
      throw new Error('تغير عقد Enterprise بعد تحميل إعداد البناء');
    }
  },
});
cfg.beforePack = stageHooks.beforePack;
cfg.afterPack = stageHooks.afterPack;

// تمييز حزمة Enterprise عن المجتمعية بلاحقة في اسم الناتج (نفس appId — ترقية سلسة)
cfg.artifactName = '${productName}-EE-${version}-${arch}.${ext}';

module.exports = cfg;
