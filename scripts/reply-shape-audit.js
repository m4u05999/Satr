'use strict';

/**
 * محلل قراءة فقط لشكل ردود الوكيل النهائية — خط أساس قرائية الردود (جولة 2026-09-10).
 *
 * يمسح سجلات المحرّكات على القرص، يستخرج **الرد النهائي لكل دور** (آخر نص للمساعد قبل
 * رسالة المستخدم التالية)، ويحسب مقاييس الشكل ثم يرمي النص: لا يخرج من هذا السكربت
 * حرفٌ واحد من أي رد — أرقام فقط. نمط `browser-session-audit.js`.
 *
 * المصادر:
 *  - Claude Code: ~/.claude/projects/**\/*.jsonl (مع `entrypoint` كبُعد: sdk-ts هو محرك سطر)
 *  - Codex:       ~/.codex/sessions/**\/*.jsonl (الصيغتان القديمة والحديثة كما في codexsessions.js)
 *  - المحوّلات:   ~/.satr/chats/<provider>/*.json (history بصيغة OpenAI أو Gemini)
 * حدّ مُصرَّح به: جلسات Kimi Code (‏~/.kimi-code/sessions/**\/wire.jsonl) صيغة خاصة لا يقرؤها
 * السكربت، فلا خط أساس لها هنا.
 *
 * المقاييس لكل محرك (على آخر N رد عربي — الافتراضي 50):
 *  headings/100 lines · توزيع مستويات العناوين · المئينان 50/90 لطول الفقرة بالكلمات ·
 *  نسبة أسطر القوائم · العلامات المتسربة التي لا يعرضها renderMD (`####`، `>`، روابط،
 *  قوائم متداخلة، قوائم مهام) · وجود خلاصة أولى ≤40 كلمة قبل أول عنوان في الردود الطويلة ·
 *  كثافة الغامق/100 كلمة · الإيموجي · جداول وكتل كود · ختام بسطر «التالي».
 */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const readline = require('readline');

const HOME = os.homedir();
const CLAUDE_ROOT = path.join(HOME, '.claude', 'projects');
const CODEX_ROOT = path.join(HOME, '.codex', 'sessions');
const CHATS_ROOT = path.join(HOME, '.satr', 'chats');
const SESSION_META = path.join(HOME, '.satr', 'session-meta.json');
const JSON_REPORT = path.join(__dirname, '..', 'dist', 'reply-shape-audit.json');

const DEFAULT_LIMIT = 50;      // آخر N رد لكل محرك
const LONG_REPLY_WORDS = 120;  // «رد طويل» — عتبة الخلاصة الأولى والبنية
const SUMMARY_MAX_WORDS = 40;  // الخلاصة الأولى المقبولة
const MIN_ARABIC_RATIO = 0.3;  // الردود العربية وحدها (سطر يفرض العربية)
const MIN_REPLY_WORDS = 8;     // ما دونه ردّ مسبار/اختبار («ok») لا شكل يُقاس فيه
const TOOL_PATH = /[\\/]\.satr[\\/]worktrees[\\/]|[\\/]Temp[\\/]/i; // نفس مرشّح لوحة الجلسات

// ---------- أدوات نصية نقية ----------
const ARABIC_LETTER = /[؀-ۿݐ-ݿࢠ-ࣿ]/g;
const LATIN_LETTER = /[A-Za-z]/g;
const HEADING = /^(#{1,6})\s+\S/;
const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+/;
const TASK_ITEM = /^\s*[-*+]\s+\[[ xX]\]\s/;
const BLOCKQUOTE = /^\s*>\s?/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const FENCE = /^\s*```/;
const LINK = /\[[^\]\n]+\]\((?:https?:\/\/|mailto:)[^)\s]+\)/g;
const BOLD = /\*\*[^*\n]+\*\*/g;
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}]/gu;
const NEXT_LINE = /^\s*(?:\*\*)?(?:التالي|الخطوة التالية)(?:\*\*)?\s*[:：]/;

function arabicRatio(text) {
  const ar = (text.match(ARABIC_LETTER) || []).length;
  const lat = (text.match(LATIN_LETTER) || []).length;
  return ar + lat ? ar / (ar + lat) : 0;
}

function words(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

/** يقيس رداً واحداً ويعيد أرقاماً فقط. */
function measureReply(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const nonEmpty = lines.filter((l) => l.trim());
  const totalWords = words(text);
  const stats = {
    words: totalWords, lines: nonEmpty.length,
    headings: { h1: 0, h2: 0, h3: 0, h4plus: 0 },
    listLines: 0, tableRows: 0, codeFences: 0, blockquoteLines: 0,
    leaks: { h4plus: 0, blockquote: 0, links: 0, nestedList: 0, taskList: 0 },
    bold: (text.match(BOLD) || []).length,
    emoji: (text.match(EMOJI) || []).length,
    paragraphWords: [],
    long: totalWords >= LONG_REPLY_WORDS,
    summaryFirst: false,
    endsWithNext: false,
    arabicRatio: arabicRatio(text),
  };
  let inFence = false;
  let paragraph = [];
  let firstBlockSeen = false;
  const flushParagraph = () => {
    if (paragraph.length) stats.paragraphWords.push(words(paragraph.join(' ')));
    paragraph = [];
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (FENCE.test(line)) { flushParagraph(); inFence = !inFence; if (inFence) stats.codeFences += 1; firstBlockSeen = true; continue; }
    if (inFence) continue;
    if (!line.trim()) { flushParagraph(); continue; }
    const heading = line.match(HEADING);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      if (level === 1) stats.headings.h1 += 1;
      else if (level === 2) stats.headings.h2 += 1;
      else if (level === 3) stats.headings.h3 += 1;
      else { stats.headings.h4plus += 1; stats.leaks.h4plus += 1; }
      firstBlockSeen = true;
      continue;
    }
    if (TABLE_ROW.test(line)) { flushParagraph(); stats.tableRows += 1; firstBlockSeen = true; continue; }
    if (BLOCKQUOTE.test(line)) { flushParagraph(); stats.blockquoteLines += 1; stats.leaks.blockquote += 1; firstBlockSeen = true; continue; }
    const item = line.match(LIST_ITEM);
    if (item) {
      flushParagraph();
      stats.listLines += 1;
      if (item[1].length >= 2) stats.leaks.nestedList += 1;
      if (TASK_ITEM.test(line)) stats.leaks.taskList += 1;
      firstBlockSeen = true;
      continue;
    }
    // فقرة عادية — الخلاصة الأولى: أول كتلة في الرد فقرةٌ لا عنوان، وطولها ≤ السقف
    if (!firstBlockSeen) {
      firstBlockSeen = true;
      paragraph.push(line);
      // تُحسم بعد اكتمال الفقرة الأولى (انظر أدناه)
      stats._firstIsParagraph = true;
    } else paragraph.push(line);
  }
  flushParagraph();
  stats.leaks.links = (text.match(LINK) || []).length;
  if (stats._firstIsParagraph && stats.paragraphWords.length) {
    stats.summaryFirst = stats.paragraphWords[0] <= SUMMARY_MAX_WORDS;
  }
  delete stats._firstIsParagraph;
  const last = nonEmpty[nonEmpty.length - 1] || '';
  stats.endsWithNext = NEXT_LINE.test(last);
  stats.leakTotal = Object.values(stats.leaks).reduce((a, b) => a + b, 0);
  return stats;
}

// ---------- القرّاء: كل قارئ يعيد [{engine, mtime, order, text}] بلا احتفاظ خارج الاستدعاء ----------
async function walkFiles(root, ext) {
  const files = [];
  async function visit(dir, depth) {
    if (depth > 8) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(target, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(ext)) files.push(target);
    }
  }
  await visit(root, 0);
  return files;
}

async function mtimeOf(file) {
  try { return (await fsp.stat(file)).mtimeMs; } catch { return 0; }
}

function loadToolSessionIds() {
  try {
    const meta = JSON.parse(fs.readFileSync(SESSION_META, 'utf8'));
    const entries = meta && (meta.entries || meta.sessions || meta);
    const ids = new Set();
    for (const [id, value] of Object.entries(entries || {})) {
      if (value && value.kind === 'tool') ids.add(id);
    }
    return ids;
  } catch { return new Set(); }
}

function textOfBlocks(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n\n');
}

function isHumanPrompt(entry) {
  if (!entry || entry.type !== 'user' || entry.isMeta || entry.isSidechain || !entry.message) return false;
  const content = entry.message.content;
  if (typeof content === 'string') return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  if (content.some((b) => b && b.type === 'tool_result')) return false;
  return content.some((b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.trim());
}

/** Claude Code: الرد النهائي = آخر نص مساعد (غير جانبي) قبل رسالة المستخدم التالية. */
async function readClaudeReplies(file, toolIds, counters) {
  const replies = [];
  let current = null; // نص آخر كتلة مساعد في الدور الجاري
  let entrypoint = 'unknown';
  let isTool = toolIds.has(path.basename(file, '.jsonl'));
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { counters.invalidLines += 1; continue; }
      if (entry && typeof entry.cwd === 'string' && TOOL_PATH.test(entry.cwd)) isTool = true;
      if (entry && entry.entrypoint) entrypoint = String(entry.entrypoint);
      if (isHumanPrompt(entry)) {
        if (current) replies.push(current);
        current = null;
        continue;
      }
      if (!entry || entry.type !== 'assistant' || entry.isSidechain || !entry.message) continue;
      const text = textOfBlocks(entry.message.content).trim();
      if (text) current = text;
    }
  } catch { counters.failedFiles += 1; return []; }
  if (current) replies.push(current);
  if (isTool) return []; // جلسات الأدوات (مراجعون/عصف/عوامل) ليست ردوداً للمستخدم
  return replies.map((text, order) => ({ engine: 'claude:' + entrypoint, order, text }));
}

function codexMessage(entry) {
  if (!entry || !entry.payload) return null;
  const p = entry.payload;
  if (entry.type === 'event_msg') {
    if (p.type === 'user_message') return { role: 'user', text: String(p.message || '') };
    if (p.type === 'agent_message') return { role: 'assistant', text: String(p.message || '') };
    return null;
  }
  if (entry.type === 'response_item' && p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
    const text = Array.isArray(p.content)
      ? p.content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('\n') : String(p.content || '');
    return { role: p.role, text };
  }
  return null;
}

async function readCodexReplies(file, counters) {
  const replies = [];
  let current = null;
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { counters.invalidLines += 1; continue; }
      const message = codexMessage(entry);
      if (!message) continue;
      const text = message.text.trim();
      if (message.role === 'user') {
        if (text.startsWith('<')) continue; // كتلة سياق محقونة لا رسالة مستخدم
        if (current) replies.push(current);
        current = null;
      } else if (text) current = text;
    }
  } catch { counters.failedFiles += 1; return []; }
  if (current) replies.push(current);
  return replies.map((text, order) => ({ engine: 'codex', order, text }));
}

async function readAdapterReplies(file, provider, counters) {
  let data;
  try { data = JSON.parse(await fsp.readFile(file, 'utf8')); } catch { counters.failedFiles += 1; return []; }
  const history = Array.isArray(data && data.history) ? data.history : [];
  const replies = [];
  let current = null;
  for (const message of history) {
    if (!message || typeof message !== 'object') continue;
    const role = message.role;
    if (role === 'user') { if (current) replies.push(current); current = null; continue; }
    if (role !== 'assistant' && role !== 'model') continue;
    let text = '';
    if (typeof message.content === 'string') text = message.content;
    else if (Array.isArray(message.content)) text = textOfBlocks(message.content);
    else if (Array.isArray(message.parts)) text = message.parts.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('\n');
    text = text.trim();
    if (text) current = text;
  }
  if (current) replies.push(current);
  return replies.map((text, order) => ({ engine: provider, order, text }));
}

// ---------- التجميع ----------
function aggregate(engine, items) {
  const measured = items.map((item) => measureReply(item.text));
  const n = measured.length;
  const sum = (fn) => measured.reduce((acc, m) => acc + fn(m), 0);
  const totalLines = sum((m) => m.lines) || 1;
  const totalWords = sum((m) => m.words) || 1;
  const paragraphs = measured.flatMap((m) => m.paragraphWords);
  const longOnes = measured.filter((m) => m.long);
  const headingTotal = sum((m) => m.headings.h1 + m.headings.h2 + m.headings.h3 + m.headings.h4plus);
  const pct = (part, whole) => (whole ? Number((part * 100 / whole).toFixed(1)) : 0);
  return {
    engine,
    replies: n,
    long_replies: longOnes.length,
    words_median: percentile(measured.map((m) => m.words), 0.5),
    words_p90: percentile(measured.map((m) => m.words), 0.9),
    headings_per_100_lines: Number((headingTotal * 100 / totalLines).toFixed(2)),
    heading_levels: {
      h1: sum((m) => m.headings.h1), h2: sum((m) => m.headings.h2),
      h3: sum((m) => m.headings.h3), h4plus: sum((m) => m.headings.h4plus),
    },
    paragraph_words_p50: percentile(paragraphs, 0.5),
    paragraph_words_p90: percentile(paragraphs, 0.9),
    list_line_share_pct: pct(sum((m) => m.listLines), totalLines),
    leaks: {
      h4plus: sum((m) => m.leaks.h4plus), blockquote: sum((m) => m.leaks.blockquote),
      links: sum((m) => m.leaks.links), nested_list: sum((m) => m.leaks.nestedList),
      task_list: sum((m) => m.leaks.taskList),
    },
    replies_with_leak_pct: pct(measured.filter((m) => m.leakTotal > 0).length, n),
    long_with_summary_first_pct: pct(longOnes.filter((m) => m.summaryFirst).length, longOnes.length),
    long_with_headings_pct: pct(longOnes.filter((m) => m.headings.h1 + m.headings.h2 + m.headings.h3 + m.headings.h4plus > 0).length, longOnes.length),
    bold_per_100_words: Number((sum((m) => m.bold) * 100 / totalWords).toFixed(2)),
    replies_with_emoji_pct: pct(measured.filter((m) => m.emoji > 0).length, n),
    replies_with_table_pct: pct(measured.filter((m) => m.tableRows > 0).length, n),
    replies_with_code_pct: pct(measured.filter((m) => m.codeFences > 0).length, n),
    ends_with_next_pct: pct(measured.filter((m) => m.endsWithNext).length, n),
  };
}

function formatMarkdownTable(rows) {
  const head = ['المحرك', 'الردود', 'الطويلة', 'كلمات p50/p90', 'عناوين/100 سطر', 'h1/h2/h3/h4+', 'فقرة p50/p90 كلمة',
    'أسطر القوائم %', 'ردود بتسرّب %', 'تسرّب h4+/>/روابط/متداخل/مهام', 'خلاصة أولى في الطويلة %', 'عناوين في الطويلة %',
    'غامق/100 كلمة', 'إيموجي %', 'جدول %', 'كود %', 'ختام «التالي» %'];
  const lines = ['| ' + head.join(' | ') + ' |', '|' + head.map(() => '---').join('|') + '|'];
  for (const r of rows) {
    lines.push('| ' + [
      '`' + r.engine + '`', r.replies, r.long_replies, r.words_median + '/' + r.words_p90, r.headings_per_100_lines,
      [r.heading_levels.h1, r.heading_levels.h2, r.heading_levels.h3, r.heading_levels.h4plus].join('/'),
      (r.paragraph_words_p50 ?? '—') + '/' + (r.paragraph_words_p90 ?? '—'), r.list_line_share_pct, r.replies_with_leak_pct,
      [r.leaks.h4plus, r.leaks.blockquote, r.leaks.links, r.leaks.nested_list, r.leaks.task_list].join('/'),
      r.long_with_summary_first_pct, r.long_with_headings_pct, r.bold_per_100_words, r.replies_with_emoji_pct,
      r.replies_with_table_pct, r.replies_with_code_pct, r.ends_with_next_pct,
    ].join(' | ') + ' |');
  }
  return lines.join('\n');
}

async function collect(limit, arabicOnly) {
  const counters = { invalidLines: 0, failedFiles: 0, filesScanned: 0, repliesSeen: 0, repliesNonArabic: 0, repliesTiny: 0 };
  const byEngine = new Map();
  const push = (items, mtime) => {
    for (const item of items) {
      counters.repliesSeen += 1;
      if (words(item.text) < MIN_REPLY_WORDS) { counters.repliesTiny += 1; continue; }
      if (arabicOnly && arabicRatio(item.text) < MIN_ARABIC_RATIO) { counters.repliesNonArabic += 1; continue; }
      if (!byEngine.has(item.engine)) byEngine.set(item.engine, []);
      byEngine.get(item.engine).push({ ...item, mtime });
    }
  };
  const toolIds = loadToolSessionIds();
  for (const file of await walkFiles(CLAUDE_ROOT, '.jsonl')) {
    counters.filesScanned += 1;
    push(await readClaudeReplies(file, toolIds, counters), await mtimeOf(file));
  }
  for (const file of await walkFiles(CODEX_ROOT, '.jsonl')) {
    counters.filesScanned += 1;
    push(await readCodexReplies(file, counters), await mtimeOf(file));
  }
  let providers = [];
  try { providers = (await fsp.readdir(CHATS_ROOT, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name); } catch { providers = []; }
  for (const provider of providers) {
    for (const file of await walkFiles(path.join(CHATS_ROOT, provider), '.json')) {
      counters.filesScanned += 1;
      push(await readAdapterReplies(file, provider, counters), await mtimeOf(file));
    }
  }
  // آخر N رد لكل محرك: الأحدث ملفاً ثم الأخير موضعاً
  const rows = [];
  for (const [engine, items] of byEngine) {
    items.sort((a, b) => b.mtime - a.mtime || b.order - a.order);
    rows.push(aggregate(engine, items.slice(0, limit)));
  }
  rows.sort((a, b) => b.replies - a.replies || a.engine.localeCompare(b.engine));
  return { rows, counters };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('الاستخدام: node scripts/reply-shape-audit.js [--limit N] [--all-languages] [--json] [--markdown]');
    return;
  }
  const limitIndex = args.indexOf('--limit');
  const limit = limitIndex >= 0 ? Math.max(1, Number(args[limitIndex + 1]) || DEFAULT_LIMIT) : DEFAULT_LIMIT;
  const known = new Set(['--limit', '--all-languages', '--json', '--markdown']);
  const unknown = args.filter((arg, i) => !known.has(arg) && !(limitIndex >= 0 && i === limitIndex + 1));
  if (unknown.length) throw new Error('وسيط غير معروف: ' + unknown.join(' '));
  const arabicOnly = !args.includes('--all-languages');
  const { rows, counters } = await collect(limit, arabicOnly);
  const report = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    limit_per_engine: limit,
    arabic_only: arabicOnly,
    thresholds: { long_reply_words: LONG_REPLY_WORDS, summary_max_words: SUMMARY_MAX_WORDS, min_arabic_ratio: MIN_ARABIC_RATIO, min_reply_words: MIN_REPLY_WORDS },
    files_scanned: counters.filesScanned,
    replies_seen: counters.repliesSeen,
    replies_skipped_tiny: counters.repliesTiny,
    replies_skipped_non_arabic: counters.repliesNonArabic,
    invalid_lines: counters.invalidLines,
    failed_files: counters.failedFiles,
    engines: rows,
    limitations: [
      'الرد النهائي = آخر نص مساعد قبل رسالة المستخدم التالية؛ الأدوار الموقوفة أو الفاشلة تدخل بنصها الجزئي.',
      'جلسات Kimi Code (wire.jsonl) بصيغة خاصة لا يقرؤها السكربت — لا خط أساس لها.',
      'claude:sdk-ts هو محرك سطر؛ claude:cli جلسات الطرفية؛ claude:sdk-cli محوّل claude -p أو تشغيلات SDK أخرى.',
      'الفقرة = كتلة نص متصلة بين سطرين فارغين؛ الأسطر المفردة داخل الكتلة تُعدّ فقرة واحدة (كما يعرضها renderMD بـ<br>).',
      'التسرّب = علامات لا يعرضها renderMD الحالي: #### فأكثر، > اقتباس، [نص](رابط)، قوائم متداخلة، قوائم مهام.',
      'الردود العربية وحدها (نسبة الحروف العربية ≥ 0.3) إلا مع --all-languages؛ وما دون ' + MIN_REPLY_WORDS + ' كلمات يُستبعد (ردود مسابير واختبارات).',
      'عدّاد «الإيموجي» يشمل الرموز التصويرية والزخارف (✓ ✗ ⚠ …) لا وجوه الإيموجي وحدها.',
    ],
  };
  console.log('محلل شكل الردود — أرقام فقط، لا نص من أي رد');
  console.log('الملفات الممسوحة: ' + counters.filesScanned + ' · الردود المرصودة: ' + counters.repliesSeen
    + ' · المستبعدة (أقصر من ' + MIN_REPLY_WORDS + ' كلمات): ' + counters.repliesTiny
    + ' · المستبعدة لغير العربية: ' + counters.repliesNonArabic + ' · السقف لكل محرك: ' + limit);
  console.log('');
  if (args.includes('--markdown')) console.log(formatMarkdownTable(rows));
  else {
    for (const r of rows) {
      console.log(r.engine + '\tردود=' + r.replies + ' طويلة=' + r.long_replies + ' كلمات p50/p90=' + r.words_median + '/' + r.words_p90
        + ' عناوين/100سطر=' + r.headings_per_100_lines + ' h1/h2/h3/h4+=' + [r.heading_levels.h1, r.heading_levels.h2, r.heading_levels.h3, r.heading_levels.h4plus].join('/')
        + ' فقرة p50/p90=' + r.paragraph_words_p50 + '/' + r.paragraph_words_p90 + ' قوائم%=' + r.list_line_share_pct
        + ' تسرّب%=' + r.replies_with_leak_pct + ' (' + [r.leaks.h4plus, r.leaks.blockquote, r.leaks.links, r.leaks.nested_list, r.leaks.task_list].join('/') + ')'
        + ' خلاصة-أولى%=' + r.long_with_summary_first_pct + ' عناوين-في-الطويلة%=' + r.long_with_headings_pct
        + ' غامق/100=' + r.bold_per_100_words + ' إيموجي%=' + r.replies_with_emoji_pct + ' جدول%=' + r.replies_with_table_pct
        + ' كود%=' + r.replies_with_code_pct + ' التالي%=' + r.ends_with_next_pct);
    }
  }
  if (counters.invalidLines || counters.failedFiles) {
    console.log('\nتنبيه: أُهمل ' + counters.invalidLines + ' سطر JSON تالف، وتعذّرت قراءة ' + counters.failedFiles + ' ملف.');
  }
  if (args.includes('--json')) {
    await fsp.mkdir(path.dirname(JSON_REPORT), { recursive: true });
    await fsp.writeFile(JSON_REPORT, JSON.stringify(report, null, 2) + '\n', 'utf8');
    console.log('\nكُتب JSON المنقّى (بلا نص): ' + JSON_REPORT);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('فشل محلل شكل الردود: ' + String((error && error.message) || error));
    process.exitCode = 1;
  });
}

module.exports = { _internals: { measureReply, aggregate, arabicRatio, codexMessage, isHumanPrompt } };
