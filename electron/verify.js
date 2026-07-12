/**
 * أوامر تحقق المشروع الصريحة (.satr/verify.json).
 *
 * لا تخمين ولا تشغيل تلقائي: هذه الوحدة تقرأ إعداداً داخل cwd وتنفّذ فقط IDs
 * موجودة فيه بعد أن تمر أداة verify_project بطبقة إذن exec لدى المحرك.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const term = require('./term');

const CONFIG_VERSION = 1;
const CONFIG_REL = path.join('.satr', 'verify.json');
const SAFE_CHECK_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_CHECKS = 6;
const MAX_COMMAND = 1000;
const MAX_LABEL = 120;
const MAX_OUTPUT = 6000;
const MAX_MODEL_RESULT = 32 * 1024;

function realInside(root, target) {
  try {
    const realRoot = fs.realpathSync(root);
    const realTarget = fs.realpathSync(target);
    const prefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
    return realTarget.startsWith(prefix) ? realTarget : null;
  } catch {
    return null;
  }
}

function loadConfig(cwd) {
  if (typeof cwd !== 'string' || !cwd.trim()) return { ok: false, error: 'bad_cwd' };
  const root = path.resolve(cwd.trim());
  const candidate = path.join(root, CONFIG_REL);
  try {
    const lstat = fs.lstatSync(candidate);
    if (!lstat.isFile() || lstat.isSymbolicLink() || lstat.size > MAX_CONFIG_BYTES) {
      return { ok: false, error: 'bad_config' };
    }
    const file = realInside(root, candidate);
    if (!file) return { ok: false, error: 'outside' };
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || parsed.version !== CONFIG_VERSION || !Array.isArray(parsed.commands)) {
      return { ok: false, error: 'bad_schema' };
    }
    const checks = [];
    const seen = new Set();
    for (const value of parsed.commands.slice(0, MAX_CHECKS)) {
      const id = value && typeof value.id === 'string' ? value.id.trim() : '';
      const command = value && typeof value.command === 'string' ? value.command.trim() : '';
      const label = value && typeof value.label === 'string' ? value.label.trim().slice(0, MAX_LABEL) : id;
      if (!SAFE_CHECK_ID.test(id) || seen.has(id) || !command || command.length > MAX_COMMAND || /[\r\n\0]/.test(command)) {
        return { ok: false, error: 'bad_command' };
      }
      const timeout = Number.isFinite(value.timeout_seconds)
        ? Math.max(1, Math.min(600, Math.floor(value.timeout_seconds))) : 120;
      seen.add(id);
      checks.push({ id, label: label || id, command, timeout_seconds: timeout });
    }
    if (!checks.length) return { ok: false, error: 'empty' };
    return { ok: true, version: CONFIG_VERSION, checks };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { ok: false, error: 'notfound' };
    return { ok: false, error: 'read_failed' };
  }
}

function selectChecks(config, requestedIds) {
  if (!config || !config.ok) return { ok: false, error: config && config.error || 'bad_config' };
  const ids = Array.isArray(requestedIds) ? requestedIds.filter((id) => typeof id === 'string') : [];
  if (!ids.length) return { ok: true, checks: config.checks.slice() };
  const wanted = [...new Set(ids)].slice(0, MAX_CHECKS);
  if (wanted.some((id) => !SAFE_CHECK_ID.test(id))) return { ok: false, error: 'bad_check_id' };
  const map = new Map(config.checks.map((check) => [check.id, check]));
  if (wanted.some((id) => !map.has(id))) return { ok: false, error: 'unknown_check' };
  return { ok: true, checks: wanted.map((id) => map.get(id)) };
}

async function visibleExecutor(cwd, check, ctx) {
  const ensured = term.ensureModelTerm(cwd);
  if (!ensured.ok) return { ok: false, exitCode: null, timedOut: false, output: 'تعذّر فتح طرفية النموذج' };
  if (ensured.created && ctx && typeof ctx.emit === 'function') {
    ctx.emit({ type: 'model_term', id: ensured.id, shell: ensured.shell, cwd });
  }
  const result = await term.runCapture(ensured.id, check.command, { timeoutMs: check.timeout_seconds * 1000 });
  return {
    ok: !!result.ok,
    exitCode: result.exitCode,
    timedOut: !!result.timedOut,
    output: result.output || '',
    error: result.message || result.error || '',
  };
}

async function run(cwd, requestedIds, ctx, options) {
  const config = loadConfig(cwd);
  const selected = selectChecks(config, requestedIds);
  if (!selected.ok) return { ok: false, error: selected.error, passed: false, checks: [] };
  const execute = options && typeof options.execute === 'function' ? options.execute : visibleExecutor;
  const results = [];
  for (const check of selected.checks) {
    const started = Date.now();
    let outcome;
    try { outcome = await execute(cwd, check, ctx); }
    catch (error) { outcome = { ok: false, exitCode: null, output: '', error: String((error && error.message) || error) }; }
    let output = String(outcome.output || outcome.error || '').trim();
    if (output.length > MAX_OUTPUT) output = output.slice(0, MAX_OUTPUT) + '\n…(قُصّ الخرج)';
    const passed = !!outcome.ok && outcome.exitCode === 0 && !outcome.timedOut;
    results.push({
      id: check.id,
      label: check.label,
      command: check.command,
      passed,
      exit_code: Number.isInteger(outcome.exitCode) ? outcome.exitCode : null,
      timed_out: !!outcome.timedOut,
      duration_ms: Date.now() - started,
      output,
    });
  }
  const passed = results.length > 0 && results.every((result) => result.passed);
  return {
    ok: true,
    schema_version: 1,
    passed,
    summary: passed ? 'نجحت كل أوامر التحقق.' : 'فشل أمر تحقق واحد أو أكثر.',
    checks: results,
  };
}

function formatConfig(config) {
  if (!config || !config.ok) {
    if (config && config.error === 'notfound') return 'لا يوجد ملف .satr/verify.json في المشروع.';
    return 'ملف .satr/verify.json غير صالح (' + ((config && config.error) || 'unknown') + ').';
  }
  return config.checks.map((check) => '- ' + check.id + ': ' + check.label + '\n  ' + check.command).join('\n');
}

function formatResult(result) {
  if (!result || !result.ok) return 'تعذّر تشغيل التحقق (' + ((result && result.error) || 'unknown') + ').';
  const lines = [result.passed ? '✓ نجح التحقق' : '✗ فشل التحقق'];
  for (const check of result.checks) {
    lines.push('', (check.passed ? '✓ ' : '✗ ') + check.label + ' [' + check.id + ']');
    lines.push('exit code: ' + (check.exit_code == null ? 'غير معروف' : check.exit_code));
    if (check.output) lines.push(check.output);
    if (lines.join('\n').length >= MAX_MODEL_RESULT) break;
  }
  const text = lines.join('\n');
  return text.length > MAX_MODEL_RESULT ? text.slice(0, MAX_MODEL_RESULT) + '\n…(قُصّت نتيجة التحقق)' : text;
}

module.exports = {
  CONFIG_VERSION,
  loadConfig,
  selectChecks,
  run,
  formatConfig,
  formatResult,
  SAFE_CHECK_ID,
};
