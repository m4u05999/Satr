#!/usr/bin/env node
'use strict';

/**
 * سطر — قارئ `npm audit --json` يقسم التنبيهات إلى **تشغيلي** و**dev**.
 *
 * لماذا: الرقم الإجمالي الذي يطبعه `npm audit` يخلط ما ينكشف عند **المستخدم**
 * (سلسلة `dependencies`: تصل إلى المثبّت) بما ينكشف على **جهاز البناء** وحده
 * (سلسلة `devDependencies`: ‏electron-builder وطقم الاختبار). خلطُهما يقود
 * قراراً خاطئاً في الاتجاهين: فزعٌ من ٢٣ تنبيهاً معظمها لا يشحن، أو تهوينٌ
 * يخفي تنبيهاً عالياً يشحن فعلاً. قِيس في رادار ٠١٠: الإجمالي ٢٣ والتشغيلي ٧
 * (لا واحداً كما ادّعى عدد سابق).
 *
 * كيف: ‏`npm audit --json` لا يحمل حقل `dev` لكل تنبيه، لكن `package-lock.json`
 * يحمل `dev: true` لكل عقدة لا يصل إليها إلا من `devDependencies` — فالتصنيف
 * يُقرأ من القفل لا من التدقيق: التنبيه **dev** إذا كانت كل عقده `dev: true`،
 * و**تشغيلي** إن بقيت عقدةٌ واحدة بلا العلم.
 *
 * الاستعمال (بلا شبكة بعد توليد الـJSON، وبلا أي تبعية):
 *   npm audit --json > dist/audit-after.json
 *   node scripts/audit-split.js < dist/audit-after.json
 *   node scripts/audit-split.js dist/audit-after.json   # أو بمسار
 *
 * ليس فحصاً في `SUITE`: توليد مُدخله يحتاج شبكة، فاسمه `audit:split` لا `test:*`.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function readInput() {
  const arg = process.argv[2];
  if (arg) return fs.readFileSync(arg, 'utf8');
  return fs.readFileSync(0, 'utf8');
}

function loadLock() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8')).packages || {};
  } catch (err) {
    return {};
  }
}

const SEVERITY_ORDER = ['critical', 'high', 'moderate', 'low', 'info'];
const SEVERITY_AR = {
  critical: 'حرجة', high: 'عالية', moderate: 'متوسطة', low: 'منخفضة', info: 'معلومة',
};

/** يتتبّع `effects` صعوداً حتى التبعيات المباشرة كي يُظهر «من أين تدخل». */
function rootsOf(name, vulns, seen) {
  const guard = seen || new Set();
  if (guard.has(name)) return [];
  guard.add(name);
  const entry = vulns[name];
  if (!entry) return [name];
  const effects = entry.effects || [];
  if (entry.isDirect || effects.length === 0) return [name];
  const out = [];
  for (const next of effects) {
    for (const root of rootsOf(next, vulns, guard)) if (!out.includes(root)) out.push(root);
  }
  return out.length ? out : [name];
}

function classify(entry, lockPackages) {
  const nodes = entry.nodes || [];
  if (!nodes.length) return 'runtime';
  const known = nodes.filter((n) => lockPackages[n]);
  if (!known.length) return 'runtime'; // بلا دليل ⇒ نصنّفه تشغيلياً (الأحوط)
  return known.every((n) => lockPackages[n].dev === true) ? 'dev' : 'runtime';
}

function versionOf(entry, lockPackages) {
  for (const node of entry.nodes || []) {
    const pkg = lockPackages[node];
    if (pkg && pkg.version) return pkg.version;
  }
  return entry.range || '—';
}

function printTable(title, rows) {
  console.log('');
  console.log(`## ${title} — ${rows.length} تنبيهاً`);
  if (!rows.length) {
    console.log('  (لا شيء)');
    return;
  }
  const head = ['الحزمة', 'النسخة', 'الشدّة', 'المسار الجذري'];
  const body = rows.map((r) => [r.name, r.version, `${SEVERITY_AR[r.severity] || r.severity}`, r.roots.join(' · ')]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => String(b[i]).length)));
  const line = (cells) => '  ' + cells.map((c, i) => String(c).padEnd(widths[i])).join(' | ');
  console.log(line(head));
  console.log('  ' + widths.map((w) => '-'.repeat(w)).join('-+-'));
  for (const b of body) console.log(line(b));
}

function main() {
  let report;
  try {
    report = JSON.parse(readInput());
  } catch (err) {
    console.error('audit-split: المدخل ليس JSON صالحاً من `npm audit --json`.');
    process.exit(2);
  }
  const vulns = report.vulnerabilities || {};
  const lockPackages = loadLock();

  const rows = Object.keys(vulns).map((name) => {
    const entry = vulns[name];
    return {
      name,
      version: versionOf(entry, lockPackages),
      severity: entry.severity || 'info',
      kind: classify(entry, lockPackages),
      roots: rootsOf(name, vulns, new Set()),
    };
  }).sort((a, b) => {
    const d = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
    return d !== 0 ? d : a.name.localeCompare(b.name);
  });

  const runtime = rows.filter((r) => r.kind === 'runtime');
  const dev = rows.filter((r) => r.kind === 'dev');

  const count = (list) => SEVERITY_ORDER
    .map((s) => [s, list.filter((r) => r.severity === s).length])
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${SEVERITY_AR[s]} ${n}`)
    .join(' · ') || 'صفر';

  printTable('تشغيلي (يصل إلى المستخدم)', runtime);
  printTable('dev (جهاز البناء وحده)', dev);
  console.log('');
  console.log(`الإجمالي ${rows.length} · تشغيلي ${runtime.length} (${count(runtime)}) · dev ${dev.length} (${count(dev)})`);
  if (!Object.keys(lockPackages).length) {
    console.log('⚠ لم يُقرأ package-lock.json — التصنيف سقط إلى «تشغيلي» للجميع.');
  }
}

main();
