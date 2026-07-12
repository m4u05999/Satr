/**
 * خريطة مستودع تقريبية للمزوّدات العمياء — فهرس خفيف بلا parser أو اعتماديات.
 *
 * لا تفتح هذه الوحدة مساراً بنفسها: سرد الملفات عبر files.listFiles والقراءة عبر
 * files.readText، لذلك ترث حصر cwd ورفض الثنائي وسقف القراءة والمجلدات المتجاهلة.
 * search.js يوفّر التطبيع وتفكيك الاستعلام فقط لترتيب المسارات والرموز ذات الصلة.
 */

'use strict';

const path = require('path');
const files = require('./files');
const search = require('./search');

const TIME_BUDGET_MS = 1200;
const MAX_FILES_SCAN = 400;
const MAX_FILES_OUT = 120;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_HEAD_CHARS = 96 * 1024;
const MAX_LINES_PER_FILE = 4000;
const MAX_SYMBOLS_PER_FILE = 12;
const MAX_SYMBOL_CANDIDATES = 120;
const MAX_TOTAL_SYMBOLS = 500;
const MAX_SYMBOL_TEXT = 180;
const MAX_OUTPUT_CHARS = 24 * 1024;

const SOURCE_EXTENSIONS = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx',
  '.py', '.rb', '.php', '.go', '.rs', '.java', '.kt', '.kts', '.cs',
  '.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.swift',
]);

const MAP_EXTENSIONS = new Set([
  ...SOURCE_EXTENSIONS,
  '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.xml',
  '.md', '.html', '.css', '.scss', '.sql', '.sh', '.ps1', '.bat', '.cmd',
]);

const IMPORTANT_NAMES = new Set([
  'package.json', 'readme.md', 'agents.md', 'claude.md', 'cargo.toml', 'go.mod',
  'pyproject.toml', 'requirements.txt', 'pom.xml', 'build.gradle', 'settings.gradle',
  'dockerfile', 'docker-compose.yml', 'makefile', '.gitignore', '.env.example',
]);

const JS_PATTERNS = [
  { kind: 'export', re: /^\s*export\s+default\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'export', re: /^\s*export\s+(?:declare\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'function', re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/ },
  { kind: 'class', re: /^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'type', re: /^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'const', re: /^\s*(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'export', re: /^\s*(?:module\.)?exports(?:\.([A-Za-z_$][\w$]*))?\s*=/, fallback: 'module.exports' },
];

const PY_PATTERNS = [
  { kind: 'class', re: /^\s*class\s+([A-Za-z_]\w*)\b/ },
  { kind: 'function', re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/ },
  { kind: 'const', re: /^([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=/ },
];

const RUBY_PATTERNS = [
  { kind: 'class', re: /^\s*(?:class|module)\s+([A-Z][\w:]*)/ },
  { kind: 'function', re: /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[!?=]?)/ },
  { kind: 'const', re: /^\s*([A-Z][A-Z0-9_]*)\s*=/ },
];

const PHP_PATTERNS = [
  { kind: 'class', re: /^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait|enum)\s+([A-Za-z_]\w*)/i },
  { kind: 'function', re: /^\s*(?:public|protected|private|static|final|abstract|\s)*function\s+&?\s*([A-Za-z_]\w*)/i },
  { kind: 'const', re: /^\s*(?:public|protected|private)?\s*const\s+([A-Za-z_]\w*)/i },
];

const GO_PATTERNS = [
  { kind: 'function', re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/ },
  { kind: 'type', re: /^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface|\w+)/ },
  { kind: 'const', re: /^\s*(?:const|var)\s+([A-Za-z_]\w*)/ },
];

const RUST_PATTERNS = [
  { kind: 'function', re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/ },
  { kind: 'type', re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|type|union)\s+([A-Za-z_]\w*)/ },
  { kind: 'class', re: /^\s*impl(?:<[^>]+>)?\s+(?:\w+\s+for\s+)?([A-Za-z_]\w*)/ },
  { kind: 'const', re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s+([A-Za-z_]\w*)/ },
];

const JVM_PATTERNS = [
  { kind: 'class', re: /^\s*(?:(?:public|protected|private|abstract|final|sealed|data|open|internal|static)\s+)*(?:class|interface|enum|record|object)\s+([A-Za-z_]\w*)/ },
  { kind: 'function', re: /^\s*(?:(?:public|protected|private|static|final|abstract|suspend|override|open|internal)\s+)*(?:fun\s+)?(?:[\w<>,?\[\].]+\s+)?([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:\{|=|throws\b)/ },
  { kind: 'const', re: /^\s*(?:(?:public|protected|private|static|final|const|internal)\s+)+(?:[\w<>,?\[\].]+\s+)?([A-Za-z_]\w*)\s*=/ },
];

const C_PATTERNS = [
  { kind: 'class', re: /^\s*(?:class|struct|enum|union)\s+([A-Za-z_]\w*)/ },
  { kind: 'const', re: /^\s*#\s*define\s+([A-Za-z_]\w*)/ },
  { kind: 'const', re: /^\s*(?:static\s+)?const\s+[\w:*&<>\[\]\s]+\s+([A-Za-z_]\w*)\s*(?:=|;)/ },
  { kind: 'function', re: /^\s*(?:[\w:*&<>\[\]]+\s+)+([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:\{|$)/ },
];

const SWIFT_PATTERNS = [
  { kind: 'class', re: /^\s*(?:(?:public|private|internal|open|final)\s+)*(?:class|struct|enum|protocol|actor)\s+([A-Za-z_]\w*)/ },
  { kind: 'function', re: /^\s*(?:(?:public|private|internal|open|static|class|override|async)\s+)*func\s+([A-Za-z_]\w*)/ },
  { kind: 'const', re: /^\s*(?:(?:public|private|internal|static|class)\s+)*(?:let|var)\s+([A-Za-z_]\w*)/ },
];

function patternsFor(rel) {
  const extension = path.extname(rel).toLowerCase();
  if (['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'].includes(extension)) return JS_PATTERNS;
  if (extension === '.py') return PY_PATTERNS;
  if (extension === '.rb') return RUBY_PATTERNS;
  if (extension === '.php') return PHP_PATTERNS;
  if (extension === '.go') return GO_PATTERNS;
  if (extension === '.rs') return RUST_PATTERNS;
  if (['.java', '.kt', '.kts', '.cs'].includes(extension)) return JVM_PATTERNS;
  if (['.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh'].includes(extension)) return C_PATTERNS;
  if (extension === '.swift') return SWIFT_PATTERNS;
  return [];
}

function isMappable(rel) {
  const base = path.basename(rel).toLowerCase();
  return IMPORTANT_NAMES.has(base) || MAP_EXTENSIONS.has(path.extname(base));
}

function pathPriority(rel, terms) {
  const normalized = search.normalize(rel);
  let score = SOURCE_EXTENSIONS.has(path.extname(rel).toLowerCase()) ? 8 : 2;
  if (IMPORTANT_NAMES.has(path.basename(rel).toLowerCase())) score += 12;
  score += Math.max(0, 5 - rel.split('/').length);
  for (const term of terms) if (normalized.includes(term)) score += 20;
  return score;
}

function symbolHeader(line) {
  let text = String(line || '').trim().replace(/\s+/g, ' ');
  const brace = text.indexOf('{');
  if (brace >= 0) text = text.slice(0, brace).trim();
  if (/\b(?:const|let|var)\b/.test(text)) {
    const equals = text.indexOf('=');
    if (equals >= 0) text = text.slice(0, equals).trim();
  }
  return text.slice(0, MAX_SYMBOL_TEXT);
}

function extractSymbols(rel, content, terms) {
  const patterns = patternsFor(rel);
  if (!patterns.length) return [];
  const lines = String(content || '').slice(0, MAX_HEAD_CHARS).split('\n').slice(0, MAX_LINES_PER_FILE);
  const symbols = [];
  const seen = new Set();
  for (let index = 0; index < lines.length && symbols.length < MAX_SYMBOL_CANDIDATES; index++) {
    const line = lines[index].replace(/\r$/, '');
    for (const pattern of patterns) {
      const match = line.match(pattern.re);
      if (!match) continue;
      const name = (match[1] || pattern.fallback || '').slice(0, 100);
      const key = pattern.kind + ':' + name;
      if (!name || seen.has(key)) break;
      seen.add(key);
      const text = symbolHeader(line);
      let relevance = 0;
      const normalized = search.normalize(name + ' ' + text);
      for (const term of terms) if (normalized.includes(term)) relevance++;
      const kindWeight = { export: 6, class: 5, type: 4, function: 3, const: 1 }[pattern.kind] || 0;
      const indentation = Math.min((line.match(/^\s*/) || [''])[0].length, 12);
      symbols.push({
        line: index + 1,
        kind: pattern.kind,
        name,
        text,
        relevance,
        importance: relevance * 20 + kindWeight * 3 - Math.floor(indentation / 2),
      });
      break;
    }
  }
  symbols.sort((left, right) => right.importance - left.importance || left.line - right.line);
  return symbols.slice(0, MAX_SYMBOLS_PER_FILE).map(({ importance, ...symbol }) => symbol);
}

function formatMap(result, maxChars) {
  const lines = [
    '<satr_repo_map estimate="true" partial="' + (result.partial ? 'true' : 'false') + '">',
    'Approximate regex-based repository map. Definitions may be incomplete; use search_code/read_file to verify before editing.',
  ];
  let truncated = false;
  for (const entry of result.files) {
    const block = ['[' + entry.rel + ']'];
    for (const symbol of entry.symbols) {
      block.push('  L' + symbol.line + ' ' + symbol.kind + ' ' + symbol.name + ' — ' + symbol.text);
    }
    if (!entry.symbols.length) block.push('  (path only; no supported definition found in the bounded scan)');
    const addition = block.join('\n');
    if (lines.join('\n').length + addition.length + 160 > maxChars) { truncated = true; break; }
    lines.push(addition);
  }
  lines.push(
    'estimate: scanned ' + result.scanned + '/' + result.total + ' candidate files; mapped ' + result.files.length
      + '; skipped_large ' + result.skipped_large + '; elapsed ' + result.duration_ms + 'ms'
      + (result.partial || truncated ? '; partial=true' : ''),
    '</satr_repo_map>'
  );
  let text = lines.join('\n');
  if (text.length > maxChars) { text = text.slice(0, maxChars); truncated = true; }
  return { text, truncated };
}

async function build(cwd, query, options) {
  const settings = options || {};
  const now = typeof settings.now === 'function' ? settings.now : Date.now;
  const timeBudget = Math.max(1, Math.min(Number(settings.timeBudgetMs) || TIME_BUDGET_MS, TIME_BUDGET_MS));
  const maxFiles = Math.max(1, Math.min(Number(settings.maxFiles) || MAX_FILES_SCAN, MAX_FILES_SCAN));
  const maxFilesOut = Math.max(1, Math.min(Number(settings.maxFilesOut) || MAX_FILES_OUT, MAX_FILES_OUT));
  const maxOutputChars = Math.max(512, Math.min(Number(settings.maxOutputChars) || MAX_OUTPUT_CHARS, MAX_OUTPUT_CHARS));
  const terms = search.queryTerms(typeof query === 'string' ? query : '');
  const all = await files.listFiles(cwd);
  const candidates = all.filter(isMappable).map((rel) => ({ rel, priority: pathPriority(rel, terms) }));
  candidates.sort((left, right) => right.priority - left.priority || left.rel.localeCompare(right.rel, 'en'));

  const started = now();
  const mapped = [];
  let scanned = 0;
  let skippedLarge = 0;
  let totalSymbols = 0;
  let partial = candidates.length > maxFiles;

  for (const candidate of candidates) {
    if (scanned >= maxFiles || now() - started > timeBudget) { partial = true; break; }
    scanned++;
    const read = files.readText(cwd, candidate.rel);
    let symbols = [];
    if (read.ok && read.bytes <= MAX_FILE_BYTES) {
      symbols = extractSymbols(candidate.rel, read.content, terms);
    } else if (read.ok && read.bytes > MAX_FILE_BYTES) {
      skippedLarge++;
    }
    if (totalSymbols + symbols.length > MAX_TOTAL_SYMBOLS) {
      symbols = symbols.slice(0, Math.max(0, MAX_TOTAL_SYMBOLS - totalSymbols));
      partial = true;
    }
    totalSymbols += symbols.length;
    let relevance = candidate.priority;
    for (const symbol of symbols) relevance += symbol.relevance * 15 + 2;
    mapped.push({ rel: candidate.rel, symbols, relevance });
    if (totalSymbols >= MAX_TOTAL_SYMBOLS) { partial = true; break; }
  }

  mapped.sort((left, right) => right.relevance - left.relevance || left.rel.localeCompare(right.rel, 'en'));
  const result = {
    ok: true,
    estimate: true,
    query_terms: terms,
    files: mapped.slice(0, maxFilesOut).map((entry) => ({
      rel: entry.rel,
      symbols: entry.symbols.map(({ relevance, ...symbol }) => symbol),
    })),
    scanned,
    total: candidates.length,
    partial: partial || mapped.length > maxFilesOut,
    skipped_large: skippedLarge,
    duration_ms: Math.max(0, now() - started),
  };
  const formatted = formatMap(result, maxOutputChars);
  result.text = formatted.text;
  result.truncated = formatted.truncated;
  if (formatted.truncated) result.partial = true;
  return result;
}

module.exports = {
  build,
  extractSymbols,
  patternsFor,
  TIME_BUDGET_MS,
  MAX_FILES_SCAN,
  MAX_FILES_OUT,
  MAX_FILE_BYTES,
  MAX_SYMBOLS_PER_FILE,
  MAX_TOTAL_SYMBOLS,
  MAX_OUTPUT_CHARS,
};
