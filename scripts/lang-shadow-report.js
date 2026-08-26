/**
 * سطر — تقرير حارس الظلّ اللغوي (‏OBS-001، الدفعة 5).
 *
 * يقرأ `~/.satr/lang-shadow.jsonl` ويلخّصه: حصّة الانزلاق لكل محرك وطور، وتوزيع
 * الأسباب. **هذا هو ناتج أسبوع الظلّ** الذي تُعايَر عليه العتبات قبل أي عرض
 * للمستخدم (قرار العصف: لا حارس ظاهر قبل معايرة على بيانات حقيقية).
 *
 * التشغيل: node scripts/lang-shadow-report.js [--file <path>]
 */
'use strict';

const fs = require('fs');
const langshadow = require('../electron/langshadow');

function arg(name, fallback) {
  const index = process.argv.indexOf('--' + name);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const file = arg('file', langshadow.file);
let raw = '';
try { raw = fs.readFileSync(file, 'utf8'); } catch {
  console.log('lang-shadow-report: لا سجل ظلّ بعد في ' + file);
  console.log('السجل يمتلئ أثناء استعمال «سطر» العادي — عُد بعد جلسات فعلية.');
  process.exit(0);
}

const rows = [];
for (const line of raw.split('\n')) {
  if (!line.trim()) continue;
  try { rows.push(JSON.parse(line)); } catch { /* سطر فاسد — يُتخطى */ }
}
if (!rows.length) {
  console.log('lang-shadow-report: السجل فارغ.');
  process.exit(0);
}

const groups = new Map(); // engine|phase → { n, slips, shares[] }
for (const row of rows) {
  const key = row.engine + ' · ' + row.phase;
  if (!groups.has(key)) groups.set(key, { n: 0, slips: 0, shares: [] });
  const group = groups.get(key);
  group.n += 1;
  if (row.slip) group.slips += 1;
  if (typeof row.share === 'number') group.shares.push(row.share);
}

const from = new Date(Math.min(...rows.map((r) => r.at))).toISOString().slice(0, 10);
const to = new Date(Math.max(...rows.map((r) => r.at))).toISOString().slice(0, 10);
console.log('lang-shadow-report: ' + rows.length + ' رسالة مقيسة (' + from + ' ← ' + to
  + ')، مقياس v' + rows[rows.length - 1].v + '\n');
console.log('المحرك · الطور'.padEnd(30) + 'العدد'.padEnd(8) + 'انزلاق'.padEnd(9) + 'وسيط الحصّة');
for (const [key, group] of [...groups.entries()].sort()) {
  const sorted = [...group.shares].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  console.log('  ' + key.padEnd(28)
    + String(group.n).padEnd(8)
    + (group.slips + ' (' + Math.round(group.slips / group.n * 100) + '%)').padEnd(9)
    + (median === null ? '—' : Math.round(median * 100) + '%'));
}
// ── سرد العمل مقابل الإجابة (‏2026-08-26) ───────────────────────────────────
// `phase` وحده يضلّل: `commentary` سردُ عمل في Codex وتفكيرٌ فقط في SDK، فسرد عمل
// SDK يقع في `final_answer` مخلوطاً بالإجابة. حقل `tool` محايد عن المحرك — رسالةٌ
// نادت أداةً هي سرد عمل أياً كان وسم محرّكها. يظهر لصفوف v3 فصاعداً فقط.
const tagged = rows.filter((row) => typeof row.tool === 'boolean' || row.tool === true);
if (tagged.length) {
  const kinds = new Map();
  for (const row of tagged) {
    const key = row.engine + ' · ' + (row.tool ? 'سرد عمل' : 'إجابة');
    if (!kinds.has(key)) kinds.set(key, { n: 0, slips: 0 });
    const kind = kinds.get(key);
    kind.n += 1;
    if (row.slip) kind.slips += 1;
  }
  console.log('\nبدلالة موحّدة عبر المحرّكات (‏' + tagged.length + ' صفاً يحمل الوسم):');
  for (const [key, kind] of [...kinds.entries()].sort()) {
    console.log('  ' + key.padEnd(28) + String(kind.n).padEnd(8)
      + (kind.slips + ' (' + Math.round(kind.slips / kind.n * 100) + '%)'));
  }
} else {
  console.log('\nلا صفّ يحمل وسم «سرد عمل/إجابة» بعد — يبدأ تسجيله من مقياس v3.');
}

// ── الخط (‏OBS-022) ─────────────────────────────────────────────────────────
const scripts = new Map();
for (const row of rows) if (row.script) scripts.set(row.script, (scripts.get(row.script) || 0) + 1);
const nonArabic = [...scripts.entries()].filter(([name]) => name !== 'ar');
if (nonArabic.length) {
  console.log('\n⚠️ خطوط غير عربية في السجل: '
    + nonArabic.map(([name, n]) => name + '=' + n).join(' · ')
    + ' — استبعدها قبل معايرة عتبات العربية.');
}

// ── قابلية المقارنة ─────────────────────────────────────────────────────────
// القاعدة المجمَّدة: لا تُقارن الأرقام عبر إصدارين. لكن v3 وُثّق توافقه الحكمي مع v2
// لكل نثر عربي، فالخلط مسموح **لصفوف العربية وحدها** — وقولها صراحةً أصدق من
// إخفاء الخلط أو رفض التجميع كلياً.
const versions = [...new Set(rows.map((row) => row.v))].sort();
if (versions.length > 1) {
  console.log('\nℹ️ السجل يخلط إصدارَي مقياس (' + versions.map((v) => 'v' + v).join(' · ')
    + '). حكم v3 موثَّق التطابق مع v2 للنثر العربي، فأرقام العربية أعلاه قابلة للجمع؛'
    + ' أما صفوف الخطوط الأخرى فمن v3 وحده.');
}

console.log('\nالسجل أرقام فقط — لا نص فيه. المعايرة ثم قرار الخروج من الظلّ للمالك.');
