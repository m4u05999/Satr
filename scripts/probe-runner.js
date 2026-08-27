/**
 * مشغّل المسابير الحيّة — **بمهلة لكل مسبار** (‏OBS-062).
 *
 * المسابير خارج `test:full` عمداً (تستهلك أدواراً حقيقية من الاشتراكات)، فلم ترث حارس
 * المهلة الذي كسبه `full-suite.js` بعد `OBS-056`. والنتيجة المرصودة حيّاً 2026-08-27:
 * مسبارٌ طبع تقريره كاملاً ثم بقي حيّاً، فحجب أربعة مسابير بعده **بلا إشارة** — لا
 * خضراء ولا حمراء، بل جلسة تُهدر حتى ينتبه بشر. هذا الملف يسدّ تلك الفجوة: أي مسبار
 * يتجاوز مهلته يصير **فشلاً صريحاً** وتُقتل شجرته وتكمل السلسلة.
 *
 * **ليس بديلاً عن إصلاح السبب الجذري** في المسبار نفسه؛ هو شبكة الأمان تحته — فمسبار
 * بلا خروج صريح يبقى عطلاً يُصلَح، لكنه لن يحجب غيره بعد اليوم.
 *
 * النمط مأخوذ من `full-suite.js` حرفياً: `spawnSync` بمهلة أصلية + `killTree` لأن
 * `spawnSync` يقتل الابن المباشر وحده بينما المعلِّق قد يكون حفيداً.
 *
 * التشغيل:
 *   node scripts/probe-runner.js <probe.js> [probe2.js …] [-- <وسائط تُمرَّر لكلٍّ منها>]
 *   node scripts/probe-runner.js --list
 * المهلة: `--timeout <ثانية>` أو `SATR_PROBE_TIMEOUT_MS`، والافتراضي 300 ثانية.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS_DIR = __dirname;
const ROOT = path.join(__dirname, '..');
const DEFAULT_TIMEOUT_MS = 300000;
const MIN_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 3600000;

const LABELS = Object.freeze({
  pass: '✅ نجح', fail: '❌ فشل', timeout: '⏳ تجاوز المهلة', missing: '❓ غير موجود',
});
const MARKS = Object.freeze({ pass: '✅', fail: '❌', timeout: '⏳', missing: '❓' });

function listProbes() {
  return fs.readdirSync(SCRIPTS_DIR)
    .filter((name) => /probe.*\.js$/.test(name) && !/helper/.test(name))
    .sort();
}

/** قتل الشجرة — `spawnSync` يقتل الابن المباشر وحده والمعلِّق قد يكون حفيداً. */
function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch { /* ماتت أصلاً */ }
}

/** تجاوز بحدود: خارجها يسقط إلى الافتراضي بدل تعطيل الحارس بصفر أو لا نهاية. */
function resolveTimeout(cliSeconds) {
  const fromCli = Number(cliSeconds) * 1000;
  if (Number.isFinite(fromCli) && fromCli >= MIN_TIMEOUT_MS && fromCli <= MAX_TIMEOUT_MS) return fromCli;
  const fromEnv = Number(process.env.SATR_PROBE_TIMEOUT_MS);
  if (Number.isFinite(fromEnv) && fromEnv >= MIN_TIMEOUT_MS && fromEnv <= MAX_TIMEOUT_MS) return fromEnv;
  return DEFAULT_TIMEOUT_MS;
}

/** مسابير Electron تُشغَّل بثنائيه لا بـnode — يُكتشف من مصدرها لا بقائمة تتقادم. */
function needsElectron(source) {
  return /require\(\s*['"]electron['"]\s*\)/.test(source);
}

/** يشغّل مسباراً واحداً. لا يرمي أبداً — التعليق **نتيجة** لا استثناء. */
function runProbe(file, args, timeoutMs) {
  // الحصر داخل `scripts/` بلا تجريد المجلدات الفرعية: `path.basename` كان يحوّل
  // `fixtures/x.js` إلى `scripts/x.js` فيبدو المسبار مفقوداً (أمسكه الحارس).
  const target = path.resolve(SCRIPTS_DIR, file);
  if (target !== SCRIPTS_DIR && !target.startsWith(SCRIPTS_DIR + path.sep)) {
    return { file, status: 'missing', code: null, ms: 0 };
  }
  if (!fs.existsSync(target)) return { file, status: 'missing', code: null, ms: 0 };

  const electron = needsElectron(fs.readFileSync(target, 'utf8'));
  const command = electron
    ? (process.platform === 'win32' ? 'cmd' : 'npx')
    : process.execPath;
  const argv = electron
    ? (process.platform === 'win32'
      ? ['/d', '/s', '/c', 'npx', 'electron', target, ...args]
      : ['electron', target, ...args])
    : [target, ...args];

  const startedAt = Date.now();
  const result = spawnSync(command, argv, {
    cwd: ROOT,
    env: process.env,
    stdio: 'inherit',
    shell: false,
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  });
  const ms = Date.now() - startedAt;

  if (result.error && result.error.code === 'ETIMEDOUT') {
    killTree(result.pid);
    return { file, status: 'timeout', code: null, ms };
  }
  if (result.error) return { file, status: 'fail', code: null, ms, message: String(result.error.message || '').slice(0, 200) };
  return { file, status: result.status === 0 ? 'pass' : 'fail', code: result.status, ms };
}

function parseArgs(argv) {
  const sep = argv.indexOf('--');
  const head = sep >= 0 ? argv.slice(0, sep) : argv;
  const passThrough = sep >= 0 ? argv.slice(sep + 1) : [];
  let timeoutMs = resolveTimeout(null);
  const files = [];
  for (let i = 0; i < head.length; i++) {
    if (head[i] === '--timeout') { timeoutMs = resolveTimeout(head[++i]); continue; }
    files.push(head[i]);
  }
  return { files, passThrough, timeoutMs };
}

function main(argv) {
  if (argv.includes('--list')) {
    for (const name of listProbes()) console.log(name);
    return 0;
  }
  const { files, passThrough, timeoutMs } = parseArgs(argv);
  if (!files.length) {
    console.error('probe-runner: لا مسبار محدَّد. جرّب --list');
    return 2;
  }

  console.log('probe-runner: ' + files.length + ' مسباراً بالتسلسل · مهلة كلٍّ '
    + Math.round(timeoutMs / 1000) + 'ث');
  const results = [];
  for (let i = 0; i < files.length; i++) {
    console.log('\n=============== [' + (i + 1) + '/' + files.length + '] ' + files[i] + ' ===============');
    const result = runProbe(files[i], passThrough, timeoutMs);
    results.push(result);
    console.log('--- ' + LABELS[result.status] + ' (' + Math.round(result.ms / 1000) + 'ث'
      + (result.code != null ? ' · رمز ' + result.code : '') + ') ---');
  }

  console.log('\n=============== الخلاصة ===============');
  for (const r of results) {
    console.log('  ' + MARKS[r.status] + ' ' + r.file.padEnd(34) + Math.round(r.ms / 1000) + 'ث');
  }
  const bad = results.filter((r) => r.status !== 'pass');
  console.log(bad.length
    ? '\nprobe-runner: ' + bad.length + ' من ' + results.length + ' لم ينجح — '
      + bad.map((r) => r.file + ':' + r.status).join(' · ')
    : '\nprobe-runner: نجحت المسابير كلها — ' + results.length + '/' + results.length);
  return bad.length ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = {
  listProbes, resolveTimeout, killTree, runProbe, parseArgs, needsElectron, main,
  DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS,
};
