/**
 * سطر — القياس الرجعي للغة على الجلسات المحفوظة (‏OBS-001، الدفعة 2).
 *
 * **أرخص دليل نملكه**: بيانات الانزلاق موجودة على القرص منذ أسابيع في ملفات
 * jsonl تحت `~/.claude/projects/` ولا تكلّف رمزاً واحداً. القياس الأولي (رأي كلود
 * في العصف) كشف أن الانهيار **مفتاح يُقلَب من الرسالة الأولى** لا تسرّب تدريجي —
 * هذا السكربت يجعله **قابلاً للإعادة بprovenance** (مطلب نقد كودكس: «مسح رجعي
 * قابل للإعادة مع provenance، لا جداول منتقاة»).
 *
 * **تعريف العينة (مجمَّد — تغييره يرفع SAMPLE_DEF_VERSION)**:
 *   - رسالة نثرية = رسالة مساعد نصّها بعد الإقصاءات ≥ 40 حرفاً قوياً.
 *   - جلسة مشمولة = ≥ 8 رسائل نثرية.
 *   - منهارة = وسيط الحصّة < 0.3 · سليمة = ≥ 0.7 · وإلا مختلطة.
 *
 * **لا نصوص في الخرج**: أرقام ومعرّفات فقط — لا نثر مستخدم ولا مساعد.
 *
 * التشغيل: node scripts/language-history.js [--projects <dir>] [--out <file>]
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { arabicShare, METRIC_VERSION } = require('../electron/langmetric');

const SAMPLE_DEF_VERSION = 1;
const MIN_STRONG_PER_MESSAGE = 40;
const MIN_PROSE_MESSAGES = 8;
const COLLAPSED_MEDIAN = 0.3;
const HEALTHY_MEDIAN = 0.7;

function arg(name, fallback) {
  const index = process.argv.indexOf('--' + name);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const PROJECTS_DIR = path.resolve(arg('projects', path.join(os.homedir(), '.claude', 'projects')));

/** يجمع نص رسالة مساعد من كتل content النصية؛ يتجاهل tool_use وغيرها. */
function assistantText(line) {
  let parsed;
  try { parsed = JSON.parse(line); } catch { return null; }
  if (!parsed || parsed.type !== 'assistant' || !parsed.message) return null;
  const content = parsed.message.content;
  if (!Array.isArray(content)) return null;
  let text = '';
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') text += block.text + '\n';
  }
  return text || null;
}

function firstUserText(lines) {
  for (const line of lines) {
    let parsed;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (!parsed || parsed.type !== 'user' || !parsed.message) continue;
    const content = parsed.message.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      let text = '';
      for (const block of content) {
        if (block && block.type === 'text' && typeof block.text === 'string') text += block.text;
      }
      if (text) return text;
    }
  }
  return '';
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round(value) {
  return value === null ? null : Math.round(value * 1000) / 1000;
}

function measureSession(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const lines = raw.split('\n').filter(Boolean);
  const shares = [];
  for (const line of lines) {
    const text = assistantText(line);
    if (!text) continue;
    const measured = arabicShare(text);
    if (measured.share === null || measured.arabic + measured.latin < MIN_STRONG_PER_MESSAGE) continue;
    shares.push(measured.share);
  }
  if (shares.length < MIN_PROSE_MESSAGES) return null;

  const half = Math.floor(shares.length / 2);
  const sessionMedian = median(shares);
  const firstUser = arabicShare(firstUserText(lines));
  let stat;
  try { stat = fs.statSync(file); } catch { stat = null; }
  return {
    session: path.basename(file, '.jsonl'),
    project: path.basename(path.dirname(file)),
    mtime: stat ? new Date(stat.mtimeMs).toISOString() : null,
    prose_messages: shares.length,
    median: round(sessionMedian),
    first_half_mean: round(shares.slice(0, half).reduce((a, b) => a + b, 0) / half),
    second_half_mean: round(shares.slice(half).reduce((a, b) => a + b, 0) / (shares.length - half)),
    first3: shares.slice(0, 3).map(round),
    first_user_share: round(firstUser.share),
    class: sessionMedian < COLLAPSED_MEDIAN ? 'collapsed'
      : sessionMedian >= HEALTHY_MEDIAN ? 'healthy' : 'mixed',
    // متسلسلة الحصص كاملة — أرقام فقط، تكفي لأي إعادة تحليل بلا عودة للنصوص
    shares: shares.map(round),
  };
}

function main() {
  const files = [];
  let scanned = 0;
  for (const project of fs.readdirSync(PROJECTS_DIR)) {
    const dir = path.join(PROJECTS_DIR, project);
    let entries;
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const entry of entries) {
      if (entry.endsWith('.jsonl')) files.push(path.join(dir, entry));
    }
  }

  const sessions = [];
  for (const file of files) {
    scanned += 1;
    const measured = measureSession(file);
    if (measured) sessions.push(measured);
  }

  const byClass = { healthy: 0, mixed: 0, collapsed: 0 };
  let secondHalfHigher = 0;
  for (const s of sessions) {
    byClass[s.class] += 1;
    if (s.second_half_mean > s.first_half_mean) secondHalfHigher += 1;
  }

  const out = {
    at: new Date().toISOString(),
    metric_version: METRIC_VERSION,
    sample_def_version: SAMPLE_DEF_VERSION,
    projects_dir: PROJECTS_DIR,
    scanned_files: scanned,
    included_sessions: sessions.length,
    inclusion: {
      min_strong_per_message: MIN_STRONG_PER_MESSAGE,
      min_prose_messages: MIN_PROSE_MESSAGES,
      collapsed_median: COLLAPSED_MEDIAN,
      healthy_median: HEALTHY_MEDIAN,
    },
    summary: {
      by_class: byClass,
      second_half_higher_share: sessions.length
        ? round(secondHalfHigher / sessions.length) : null,
      collapsed_first3_all_low: sessions
        .filter((s) => s.class === 'collapsed')
        .every((s) => s.first3.every((v) => v < 0.3)),
      collapsed_first_user_arabic: sessions
        .filter((s) => s.class === 'collapsed' && s.first_user_share !== null)
        .filter((s) => s.first_user_share >= 0.5).length,
    },
    sessions: sessions.sort((a, b) => (a.median ?? 1) - (b.median ?? 1)),
  };

  const outDir = path.resolve(__dirname, '..', 'dist', 'language-history');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.resolve(arg('out',
    path.join(outDir, out.at.replace(/[:.]/g, '-') + '.json')));
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2), 'utf8');

  console.log('language-history: مُسح ' + scanned + ' ملفاً ⇒ ' + sessions.length
    + ' جلسة مشمولة (metric v' + METRIC_VERSION + ', sample v' + SAMPLE_DEF_VERSION + ')');
  console.log('  التصنيف: سليمة ' + byClass.healthy + ' · مختلطة ' + byClass.mixed
    + ' · منهارة ' + byClass.collapsed);
  console.log('  النصف الثاني أعلى من الأول في '
    + (out.summary.second_half_higher_share === null ? '—'
      : Math.round(out.summary.second_half_higher_share * 100) + '%') + ' من الجلسات');
  console.log('  المنهارة أولها منخفض (first3 < 0.3): '
    + (out.summary.collapsed_first3_all_low ? 'كلها' : 'ليست كلها'));
  console.log('  منهارة رغم أول رسالة مستخدم عربية: '
    + out.summary.collapsed_first_user_arabic + ' من ' + byClass.collapsed);
  console.log('الخرج: ' + path.relative(path.resolve(__dirname, '..'), outFile));
}

main();
