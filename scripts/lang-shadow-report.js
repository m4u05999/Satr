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
console.log('\nالسجل أرقام فقط — لا نص فيه. المعايرة ثم قرار الخروج من الظلّ للمالك.');
