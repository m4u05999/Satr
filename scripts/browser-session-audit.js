'use strict';

/**
 * محلل قراءة فقط لجلسات Claude التي استعملت أدوات المتصفح.
 * لا يحتفظ بنص المحادثة أو محتوى النتائج؛ يحسب الأحجام والأزمنة ثم يرمي المحتوى.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const readline = require('readline');

const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');
const JSON_REPORT = path.join(__dirname, '..', 'dist', 'browser-session-audit.json');
const SNAPSHOT_TOOLS = new Set(['browser_snapshot', 'screenshot', 'browser_screenshot_element']);
const EXTRA_BROWSER_TOOLS = new Set(['open_preview', 'read_page', 'screenshot']);

function normalizeToolName(value) {
  const name = String(value || '');
  const split = name.lastIndexOf('__');
  return split >= 0 ? name.slice(split + 2) : name;
}

function isBrowserTool(name) {
  return name.startsWith('browser_') || EXTRA_BROWSER_TOOLS.has(name);
}

function timestampMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function contentBytes(value) {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  if (value == null) return 0;
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8'); } catch { return 0; }
}

function hasDomChangedFalse(value) {
  if (value == null) return false;
  if (typeof value === 'string') return /(?:dom_changed|effect_observed)\s*[=:]\s*false\b/i.test(value);
  if (Array.isArray(value)) return value.some(hasDomChangedFalse);
  if (typeof value !== 'object') return false;
  if (value.dom_changed === false || value.effect_observed === false) return true;
  return Object.values(value).some(hasDomChangedFalse);
}

function isHumanPrompt(entry) {
  if (!entry || entry.type !== 'user' || entry.isMeta || !entry.message) return false;
  const content = entry.message.content;
  if (typeof content === 'string') return content.trim().length > 0;
  return Array.isArray(content) && content.some((block) => block && block.type === 'text'
    && typeof block.text === 'string' && block.text.trim());
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index];
}

function formatMs(value) {
  if (value == null) return '—';
  if (value < 1000) return Math.round(value) + 'ms';
  return (value / 1000).toFixed(value < 10000 ? 2 : 1) + 's';
}

function formatBytes(value) {
  if (value < 1024) return value + 'B';
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + 'KiB';
  return (value / (1024 * 1024)).toFixed(1) + 'MiB';
}

async function listJsonlFiles(root) {
  const files = [];
  async function visit(dir) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(target);
    }
  }
  await visit(root);
  return files;
}

function applyResult(call, block, entry) {
  call.resultTime = timestampMs(entry.timestamp);
  call.resultBytes = contentBytes(block.content);
  call.domChangedFalse = hasDomChangedFalse(block.content)
    || hasDomChangedFalse(entry.toolUseResult);
}

async function parseSession(file, counters) {
  const calls = [];
  const callsById = new Map();
  const pendingResults = new Map();
  let taskOrdinal = 0;
  let order = 0;
  let hasBrowserPrefix = false;
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });

  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { counters.invalidLines += 1; continue; }
      if (isHumanPrompt(entry)) taskOrdinal += 1;
      const content = entry && entry.message && entry.message.content;
      if (!Array.isArray(content)) continue;

      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'tool_use' && block.id) {
          const name = normalizeToolName(block.name);
          if (!isBrowserTool(name)) continue;
          if (name.startsWith('browser_')) hasBrowserPrefix = true;
          if (callsById.has(block.id)) continue;
          const call = {
            id: String(block.id), name, task: Math.max(1, taskOrdinal), order: order++,
            useTime: timestampMs(entry.timestamp), resultTime: null, resultBytes: 0,
            domChangedFalse: false,
          };
          calls.push(call);
          callsById.set(call.id, call);
          if (pendingResults.has(call.id)) {
            const pending = pendingResults.get(call.id);
            applyResult(call, pending.block, pending.entry);
            pendingResults.delete(call.id);
          }
        } else if (block.type === 'tool_result' && block.tool_use_id) {
          const id = String(block.tool_use_id);
          const call = callsById.get(id);
          if (call) applyResult(call, block, entry);
          else pendingResults.set(id, { block, entry });
        }
      }
    }
  } catch {
    counters.failedFiles += 1;
    return null;
  }

  if (!hasBrowserPrefix) return null;
  return { sessionId: path.basename(file, '.jsonl'), calls };
}

function buildReport(filesScanned, sessions, counters) {
  const tasks = [];
  const byTool = new Map();
  for (const session of sessions) {
    const groups = new Map();
    for (const call of session.calls) {
      if (!groups.has(call.task)) groups.set(call.task, []);
      groups.get(call.task).push(call);
    }
    for (const [taskNumber, unordered] of groups) {
      const calls = unordered.slice().sort((a, b) => {
        if (a.useTime != null && b.useTime != null) return a.useTime - b.useTime || a.order - b.order;
        return a.order - b.order;
      });
      const gaps = [];
      let wastedCycles = 0;
      for (let index = 0; index < calls.length; index += 1) {
        const call = calls[index];
        const next = calls[index + 1];
        const gap = next && call.resultTime != null && next.useTime != null && next.useTime >= call.resultTime
          ? next.useTime - call.resultTime : null;
        if (gap != null) gaps.push(gap);
        if (call.domChangedFalse && next && next.name === 'browser_snapshot') wastedCycles += 1;
        if (!byTool.has(call.name)) byTool.set(call.name, { calls: 0, resultBytes: [], gaps: [] });
        const tool = byTool.get(call.name);
        tool.calls += 1;
        if (call.resultTime != null) tool.resultBytes.push(call.resultBytes);
        if (gap != null) tool.gaps.push(gap);
      }
      const resultBytes = calls.reduce((sum, call) => sum + call.resultBytes, 0);
      const snapshotBytes = calls.filter((call) => SNAPSHOT_TOOLS.has(call.name))
        .reduce((sum, call) => sum + call.resultBytes, 0);
      tasks.push({
        session_id: session.sessionId,
        task: taskNumber,
        steps: calls.length,
        result_bytes: resultBytes,
        snapshot_bytes: snapshotBytes,
        snapshot_share_pct: resultBytes ? Number((snapshotBytes * 100 / resultBytes).toFixed(1)) : 0,
        model_turn_samples: gaps.length,
        model_turn_median_ms: percentile(gaps, 0.5),
        model_turn_p90_ms: percentile(gaps, 0.9),
        wasted_snapshot_cycles: wastedCycles,
      });
    }
  }

  tasks.sort((a, b) => a.session_id.localeCompare(b.session_id) || a.task - b.task);
  const tools = Array.from(byTool, ([name, data]) => ({
    tool: name,
    calls: data.calls,
    result_samples: data.resultBytes.length,
    result_median_bytes: percentile(data.resultBytes, 0.5),
    result_p90_bytes: percentile(data.resultBytes, 0.9),
    model_turn_samples: data.gaps.length,
    model_turn_median_ms: percentile(data.gaps, 0.5),
    model_turn_p90_ms: percentile(data.gaps, 0.9),
  })).sort((a, b) => a.tool.localeCompare(b.tool));
  const allGaps = tools.flatMap((tool) => byTool.get(tool.tool).gaps);
  const totals = {
    sessions: sessions.length,
    tasks: tasks.length,
    steps: tasks.reduce((sum, task) => sum + task.steps, 0),
    result_bytes: tasks.reduce((sum, task) => sum + task.result_bytes, 0),
    snapshot_bytes: tasks.reduce((sum, task) => sum + task.snapshot_bytes, 0),
    snapshot_share_pct: 0,
    model_turn_samples: allGaps.length,
    model_turn_median_ms: percentile(allGaps, 0.5),
    model_turn_p90_ms: percentile(allGaps, 0.9),
    wasted_snapshot_cycles: tasks.reduce((sum, task) => sum + task.wasted_snapshot_cycles, 0),
  };
  totals.snapshot_share_pct = totals.result_bytes
    ? Number((totals.snapshot_bytes * 100 / totals.result_bytes).toFixed(1)) : 0;
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    files_scanned: filesScanned,
    invalid_lines: counters.invalidLines,
    failed_files: counters.failedFiles,
    totals,
    tasks,
    tools,
    limitations: [
      'زمن دور النموذج تقريبي: الفاصل بين timestamp نتيجة أداة وtimestamp طلب أداة المتصفح التالية.',
      'زمن انتظار الإذن البشري غير موجود منفصلاً في schema السجل، لذلك لم يُقَس.',
      'الدورة المهدورة هي dom_changed:false أو effect_observed:false التي تليها browser_snapshot مباشرةً.',
      'حصة اللقطات تجمع browser_snapshot وscreenshot وbrowser_screenshot_element.',
    ],
  };
}

function printReport(report) {
  console.log('محلل جلسات المتصفح — لا يتضمن نص المحادثة');
  console.log('الملفات الممسوحة: ' + report.files_scanned + ' · الجلسات: ' + report.totals.sessions
    + ' · المهام: ' + report.totals.tasks + ' · الخطوات: ' + report.totals.steps);
  console.log('بايتات النتائج: ' + formatBytes(report.totals.result_bytes)
    + ' · حصة اللقطات: ' + report.totals.snapshot_share_pct + '%'
    + ' · وسيط دور النموذج: ' + formatMs(report.totals.model_turn_median_ms)
    + ' · P90: ' + formatMs(report.totals.model_turn_p90_ms)
    + ' · الدورات المهدورة: ' + report.totals.wasted_snapshot_cycles);
  console.log('\nالمهام');
  console.log('المهمة\tالخطوات\tالنتائج\tحصة اللقطات\tMedian الدور\tP90 الدور\tالمهدورة');
  for (const task of report.tasks) {
    console.log(task.session_id.slice(0, 8) + '#' + task.task + '\t' + task.steps + '\t'
      + formatBytes(task.result_bytes) + '\t' + task.snapshot_share_pct + '%\t'
      + formatMs(task.model_turn_median_ms) + '\t' + formatMs(task.model_turn_p90_ms) + '\t'
      + task.wasted_snapshot_cycles);
  }
  console.log('\nحسب الأداة');
  console.log('الأداة\tالنداءات\tMedian البايتات\tP90 البايتات\tMedian الدور\tP90 الدور\tعينات الدور');
  for (const tool of report.tools) {
    console.log(tool.tool + '\t' + tool.calls + '\t' + formatBytes(tool.result_median_bytes || 0) + '\t'
      + formatBytes(tool.result_p90_bytes || 0) + '\t' + formatMs(tool.model_turn_median_ms) + '\t'
      + formatMs(tool.model_turn_p90_ms) + '\t' + tool.model_turn_samples);
  }
  if (report.invalid_lines || report.failed_files) {
    console.log('\nتنبيه: أُهمل ' + report.invalid_lines + ' سطر JSON تالف، وتعذّرت قراءة ' + report.failed_files + ' ملف.');
  }
  console.log('\nمذكور لا منفَّذ: زمن الإذن البشري لا يحمل طابعاً زمنياً مستقلاً في schema الحالية.');
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('الاستخدام: node scripts/browser-session-audit.js [--json]');
    return;
  }
  const unknown = process.argv.slice(2).filter((arg) => arg !== '--json');
  if (unknown.length) throw new Error('وسيط غير معروف: ' + unknown.join(' '));
  const counters = { invalidLines: 0, failedFiles: 0 };
  const files = await listJsonlFiles(PROJECTS_ROOT);
  const sessions = [];
  for (const file of files) {
    const session = await parseSession(file, counters);
    if (session) sessions.push(session);
  }
  const report = buildReport(files.length, sessions, counters);
  printReport(report);
  if (process.argv.includes('--json')) {
    await fsp.mkdir(path.dirname(JSON_REPORT), { recursive: true });
    await fsp.writeFile(JSON_REPORT, JSON.stringify(report, null, 2) + '\n', 'utf8');
    console.log('\nكُتب JSON المنقّى: ' + JSON_REPORT);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('فشل محلل جلسات المتصفح: ' + String((error && error.message) || error));
    process.exitCode = 1;
  });
}

module.exports = { _internals: { parseSession, buildReport, contentBytes, hasDomChangedFalse } };
