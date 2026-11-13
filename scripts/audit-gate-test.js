#!/usr/bin/env node
'use strict';

/**
 * سطر — بوابة التدقيق بالتقسيم: **الرقم بوابةٌ لا تقرير**.
 *
 * العلّة (رادار سطر، البند ب-٣ / العدد ٠٢١ — الشقّ الذي لم ينزل من OBS-197): كانت بوابة
 * الإصدار تقرأ `npm audit` يدوياً عند قطع الإصدار (DEFINITION-OF-DONE §٧) لا بوابةً آلية،
 * والإجمالي يخلط ما يُشحن إلى المستخدم بما ينكشف على جهاز البناء وحده — فخبّأ الخطأ أحد
 * عشر عدداً من الرادار.
 *
 * ما يعضّ عليه:
 *  (١) الطبقتان الشاحنتان (تشغيلي وpeer): أسماء مسموحة في scripts/audit-floor.json بشدّتها
 *      القصوى، تحت سقف صلب للطبقة لا يتجاوزه اسم مهما كان ⇒ اسم جديد أو شدّة أعلى = فشل.
 *  (٢) dev: عدٌّ لكل شدّة ⇒ عدٌّ أكبر = فشل (انكشاف جهاز البناء يُحرَس من التراجع لا من الوجود).
 *  (٣) التحسّن (اسم زال أو عدٌّ نقص) يُعلن بسطر صاخب «اخفض العتبة» ولا يفشل — كي لا تشيخ
 *      العتبة بصمت (درس الرادار: الرقعة المسمّاة تشيخ بلا إنذار).
 *  (٤) تعذّر الوصول إلى سجلّ npm ⇒ **فشل مغلق** بسبب معلن (قرار مالك 2026-10-05)؛ والتجاوز
 *      الصريح SATR_AUDIT_GATE=skip يُعلن التخطّي بسطر صاخب ويمرّ — للعمل بلا شبكة فقط.
 *
 * التصنيف بالمسار لا بالاسم (scripts/audit-split.js): الحزمة نفسها قد تكون dev في مسار
 * وتشغيلية سليمة في آخر (builder-util-runtime 9.2.10 dev / 9.7.0 تشغيلية — OBS-197).
 *
 * الاستعمال:
 *   npm run test:audit-gate                        # يشغّل npm audit --json --package-lock-only
 *   node scripts/audit-gate-test.js --input f.json # يقرأ خرجاً محفوظاً (بلا شبكة؛ للعضّة)
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { splitReport, SEVERITY_ORDER, SEVERITY_AR } = require('./audit-split');

const ROOT = path.resolve(__dirname, '..');
const FLOOR_FILE = path.join(ROOT, 'scripts', 'audit-floor.json');
const AUDIT_COMMAND = 'npm audit --json --package-lock-only';
const SHIPPING_TIERS = ['runtime', 'peer'];

// أصغر رتبةً = أشدّ (الترتيب من audit-split: critical ⇐ info).
function severityRank(severity) {
  const index = SEVERITY_ORDER.indexOf(severity);
  return index < 0 ? SEVERITY_ORDER.length : index;
}
function worseThan(a, b) { return severityRank(a) < severityRank(b); }
function ar(severity) { return SEVERITY_AR[severity] || String(severity); }

function readInput(argv) {
  const index = argv.indexOf('--input');
  if (index >= 0 && argv[index + 1]) {
    return { source: argv[index + 1], text: fs.readFileSync(argv[index + 1], 'utf8'), stderr: '' };
  }
  // الأمر ثابت بلا أي مدخل مستخدم؛ shell:true لأن npm على ويندوز ملف .cmd لا يُقلع بغيره.
  const run = spawnSync(AUDIT_COMMAND, {
    cwd: ROOT, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true,
  });
  return {
    source: AUDIT_COMMAND,
    text: run.stdout || '',
    stderr: (run.stderr || '') + (run.error ? ' ' + run.error.message : ''),
  };
}

/** يميّز خرج التدقيق الصالح عن فشل الأداة أو الشبكة (npm يطبع {error:{code,summary}} في JSON). */
function parseAudit(input) {
  let report;
  try {
    report = JSON.parse(input.text);
  } catch (error) {
    const tail = (input.stderr || '').trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] || '';
    return { ok: false, reason: 'خرج npm audit ليس JSON' + (tail ? ' — ' + tail : '') };
  }
  if (report && report.error) {
    const e = report.error;
    // قد يأتي الكائن بلا code/summary (مقيس 2026-10-05 عند عبور عابر للسجلّ) — فيُطبع كما هو كي لا تخرج الرسالة فارغة.
    const named = [e.code, e.summary || e.detail].filter(Boolean).join(' ');
    return { ok: false, reason: 'npm audit أبلغ خطأً: ' + (named || JSON.stringify(e).slice(0, 300)) };
  }
  if (!report || typeof report !== 'object' || !report.vulnerabilities || !report.metadata) {
    return { ok: false, reason: 'خرج npm audit بلا vulnerabilities/metadata' };
  }
  return { ok: true, report };
}

function loadFloor() {
  const floor = JSON.parse(fs.readFileSync(FLOOR_FILE, 'utf8'));
  for (const tier of SHIPPING_TIERS) {
    if (!floor.ceiling || !SEVERITY_ORDER.includes(floor.ceiling[tier])) {
      throw new Error('audit-floor.json: سقف الطبقة ' + tier + ' غائب أو ليس شدّة معروفة');
    }
  }
  if (!floor.max || !floor.max.dev) throw new Error('audit-floor.json: max.dev غائب');
  return floor;
}

function evaluate(split, floor) {
  const failures = [];
  const notes = [];
  for (const tier of SHIPPING_TIERS) {
    const allowed = (floor.allow && floor.allow[tier]) || {};
    const ceiling = floor.ceiling[tier];
    const present = split.rows.filter((row) => row.tier === tier);
    for (const row of present) {
      const where = row.nodes.join(', ') || '—';
      if (worseThan(row.severity, ceiling)) {
        failures.push(`${tier}: ${row.name}@${row.version} ${ar(row.severity)} يتجاوز سقف الطبقة (${ar(ceiling)}) — ${where}`);
      } else if (!Object.prototype.hasOwnProperty.call(allowed, row.name)) {
        failures.push(`${tier}: تنبيه غير معلن ${row.name}@${row.version} (${ar(row.severity)}) — ${where}`);
      } else if (worseThan(row.severity, allowed[row.name])) {
        failures.push(`${tier}: ${row.name}@${row.version} صار ${ar(row.severity)} فوق المعلن (${ar(allowed[row.name])}) — ${where}`);
      }
    }
    for (const name of Object.keys(allowed)) {
      if (!present.some((row) => row.name === name)) {
        notes.push(`${tier}: ${name} لم يعد في التدقيق — احذفه من audit-floor.json (اخفض العتبة)`);
      }
    }
  }
  const devMax = floor.max.dev;
  const devTally = split.tally.dev || {};
  for (const severity of SEVERITY_ORDER) {
    const count = devTally[severity] || 0;
    const max = Number(devMax[severity]) || 0;
    if (count > max) {
      const names = split.rows.filter((row) => row.tier === 'dev' && row.severity === severity).map((row) => row.name);
      failures.push(`dev: ${ar(severity)} ${count} > العتبة ${max} — ${names.join('، ')}`);
    } else if (count < max) {
      notes.push(`dev: ${ar(severity)} ${count} < العتبة ${max} — اخفض العتبة في audit-floor.json`);
    }
  }
  return { failures, notes };
}

function summarize(tally) {
  return SEVERITY_ORDER
    .map((severity) => [severity, tally[severity] || 0])
    .filter(([, count]) => count > 0)
    .map(([severity, count]) => `${ar(severity)} ${count}`)
    .join(' · ') || 'صفر';
}

function main() {
  const argv = process.argv.slice(2);
  const skipRequested = String(process.env.SATR_AUDIT_GATE || '').trim().toLowerCase() === 'skip';
  const floor = loadFloor();
  let input = readInput(argv);
  let parsed = parseAudit(input);
  // محاولة ثانية واحدة معلنة عند الفشل الحيّ: السجلّ يعبر عابراً أحياناً (مقيس 2026-10-05)،
  // والمحاولة لا تُخفي الفشل الدائم — بعدها الإغلاق.
  if (!parsed.ok && !argv.includes('--input')) {
    console.log('audit-gate: ⚠ المحاولة الأولى فشلت (' + parsed.reason + ') — محاولة ثانية بعد ثلاث ثوانٍ.');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
    input = readInput(argv);
    parsed = parseAudit(input);
  }
  if (!parsed.ok) {
    if (skipRequested) {
      console.log('audit-gate: ⚠ تخطٍّ صريح (SATR_AUDIT_GATE=skip) — البوابة لم تُقَس: ' + parsed.reason + '. هذه ليست خضراء.');
      return;
    }
    console.error('audit-gate: فشل مغلق — تعذّر قياس التدقيق: ' + parsed.reason);
    console.error('audit-gate: للعمل بلا شبكة اضبط SATR_AUDIT_GATE=skip صراحةً (يُعلن التخطّي ولا يُخفيه).');
    process.exitCode = 1;
    return;
  }
  const split = splitReport(parsed.report);
  if (!split.lockKnown) {
    console.error('audit-gate: فشل مغلق — package-lock.json لم يُقرأ فلا تصنيف بالمسار.');
    process.exitCode = 1;
    return;
  }
  const { failures, notes } = evaluate(split, floor);
  console.log(`audit-gate: المصدر ${input.source} · الإجمالي ${split.rows.length} · تشغيلي ${summarize(split.tally.runtime)} · peer ${summarize(split.tally.peer)} · dev ${summarize(split.tally.dev)} · العتبة مقيسة ${floor.measured_at}`);
  for (const note of notes) console.log('audit-gate: ⚠ ' + note);
  if (failures.length) {
    for (const failure of failures) console.error('audit-gate: ✗ ' + failure);
    console.error(`audit-gate: فشل — ${failures.length} تجاوزاً للعتبة المعلنة في scripts/audit-floor.json (الطبقتان الشاحنتان بالأسماء تحت سقف ${ar(floor.ceiling.runtime)}، وdev بالعدّ).`);
    process.exitCode = 1;
    return;
  }
  console.log(`audit-gate: نجح — ضمن العتبة المعلنة (تشغيلي وpeer بالأسماء تحت سقف ${ar(floor.ceiling.runtime)}، وdev بالعدّ)${notes.length ? '؛ ' + notes.length + ' تحسّناً يستحق خفض العتبة' : ''}.`);
}

if (require.main === module) main();

module.exports = { evaluate, parseAudit, worseThan };
