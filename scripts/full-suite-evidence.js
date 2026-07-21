#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_ARTIFACT_ROOT = path.resolve(ROOT, 'dist', 'test-runs');
const SUMMARY_SCHEMA_VERSION = 1;
const SUMMARY_STATUSES = Object.freeze(['passed', 'failed', 'interrupted', 'runner_error']);
const TAIL_LINE_COUNT = 200;
const INTERRUPT_EXIT_CODE = 130;

/**
 * تحويل تاريخ UTC إلى سلسلة صالحة لاسم مجلد على Windows.
 * لا تستخدم `:` ولا مسافات.
 */
function timestampToFolderName(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  const seconds = String(date.getUTCSeconds()).padStart(2, '0');
  const ms = String(date.getUTCMilliseconds()).padStart(3, '0');
  return `${year}-${month}-${day}T${hours}-${minutes}-${seconds}-${ms}Z`;
}

/**
 * تحويل مسار مطلق إلى مسار نسبي من جذر المشروع إن أمكن.
 */
function relativeFromRoot(absolutePath) {
  const relative = path.relative(ROOT, absolutePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return absolutePath;
  }
  return relative.split(path.sep).join('/');
}

/**
 * حساب hash SHA-256 لنص محدّد.
 */
function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * قراءة Base commit عبر git rev-parse HEAD.
 */
async function readBaseCommit(runner) {
  try {
    const result = await runner.spawnForOutput('git', ['rev-parse', 'HEAD'], { cwd: ROOT });
    return (result.stdout || '').trim();
  } catch (error) {
    return null;
  }
}

/**
 * قراءة حالة الشجرة عبر git status --porcelain.
 */
async function readWorkingTreeStatus(runner) {
  try {
    const result = await runner.spawnForOutput('git', ['status', '--porcelain'], { cwd: ROOT });
    const text = (result.stdout || '').replace(/\r\n/g, '\n').trim();
    return {
      dirty: text.length > 0,
      statusText: text,
      statusHash: sha256(text),
    };
  } catch (error) {
    return { dirty: null, statusText: '', statusHash: null };
  }
}

/**
 * بناء أمر تشغيل npm run test:full بأمان.
 * يتطلّب npm_execpath؛ بدونه يفشل المشغّل بأمان.
 */
function buildFullSuiteCommand() {
  const npmExecPath = process.env.npm_execpath || null;
  if (!npmExecPath) {
    return { command: null, args: null, npmExecPath: null };
  }
  return {
    command: process.execPath,
    args: [npmExecPath, 'run', 'test:full'],
    npmExecPath,
  };
}

/**
 * استخراج إجمالي المجموعات المُعلن من سطر نهائي full-suite.
 * يعتمد التطابق الأخير لأن full-suite.js تطبع ملخصها في النهاية،
 * وقد تحتوي المخرجات على سطور مطابقة أقدم من اختبارات المشغّل نفسه.
 */
function extractReportedTotal(tailLines) {
  for (let i = tailLines.length - 1; i >= 0; i--) {
    const line = tailLines[i];
    const match = line.match(/full-suite: نجحت المجموعات كلها — (\d+)\/(\d+)/);
    if (match) return { passed: parseInt(match[1], 10), total: parseInt(match[2], 10) };
    const failMatch = line.match(/full-suite: فشلت المجموعات التالية:/);
    if (failMatch) return { passed: null, total: null };
  }
  return null;
}

/**
 * كتابة ملخص JSON بصورة ذرية.
 */
async function writeAtomicSummary(targetPath, summary) {
  const tempPath = targetPath + '.tmp';
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  await fsp.writeFile(tempPath, JSON.stringify(summary, null, 2) + '\n', 'utf8');
  await fsp.rename(tempPath, targetPath);
}

/**
 * إنشاء مجلد أثر حصري؛ عند التصادم يُلحق رقماً تسلسلياً.
 * يُنشئ المجلد الأب أولاً ثم يحاول إنشاء المجلد الفرعي حصرياً.
 */
async function createExclusiveArtifactDir(artifactRoot, folderName) {
  await fsp.mkdir(artifactRoot, { recursive: true });
  let candidate = path.resolve(artifactRoot, folderName);
  try {
    await fsp.mkdir(candidate, { recursive: false });
    return candidate;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  for (let suffix = 1; suffix < 1000; suffix++) {
    candidate = path.resolve(artifactRoot, `${folderName}-${suffix}`);
    try {
      await fsp.mkdir(candidate, { recursive: false });
      return candidate;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw new Error(`تعذّر إنشاء مجلد أثر حصري بعد عدة محاولات: ${path.resolve(artifactRoot, folderName)}`);
}

/**
 * تشغيل npm run test:full وحفظ الأدلة.
 */
async function run(options = {}) {
  const runner = options.runner || createDefaultRunner();
  const startedAt = options.now ? new Date(options.now) : new Date();
  const artifactRoot = options.artifactRoot || DEFAULT_ARTIFACT_ROOT;
  const folderName = timestampToFolderName(startedAt);

  let artifactDir = null;
  let logFile = null;
  let summaryFile = null;
  let baseCommit = null;
  let treeStatus = { dirty: null, statusText: '', statusHash: null };
  let logStream = null;
  let logWriteQueue = Promise.resolve();
  let logWriteError = null;
  let logFailureReported = false;
  let childResult = null;
  const openLogStream = options.openLogStream || (async (file) => fsp.open(file, 'w'));

  const enqueueLogWrite = (text) => {
    if (logWriteError) return;
    logWriteQueue = logWriteQueue.catch(() => {}).then(async () => {
      if (!logStream || logWriteError) return;
      await logStream.write(text);
    }).catch((writeError) => {
      if (!logWriteError) {
        logWriteError = writeError;
        process.stderr.write(`خطأ كتابة في السجل: ${writeError.message}\n`);
      }
    });
  };

  const flushLog = async () => {
    await logWriteQueue;
    if (logWriteError && !logFailureReported) {
      logFailureReported = true;
      throw logWriteError;
    }
  };

  try {
    artifactDir = await createExclusiveArtifactDir(artifactRoot, folderName);
    logFile = path.resolve(artifactDir, 'full-suite.log');
    summaryFile = path.resolve(artifactDir, 'summary.json');

    logStream = await openLogStream(logFile);

    const headerLines = [
      `command: npm run test:full`,
      `started_at: ${startedAt.toISOString()}`,
      `artifact_directory: ${relativeFromRoot(artifactDir)}`,
      '',
    ];
    for (const line of headerLines) {
      enqueueLogWrite(line + '\n');
    }

    [baseCommit, treeStatus] = await Promise.all([
      readBaseCommit(runner),
      readWorkingTreeStatus(runner),
    ]);

    const env = options.env || process.env;
    const cmd = buildFullSuiteCommand();

    if (!cmd.command) {
      throw new Error('لم يُعثر على npm_execpath؛ لا يمكن تشغيل npm run test:full بأمان.');
    }

    enqueueLogWrite(`spawn_command: ${cmd.command}\n`);
    enqueueLogWrite(`spawn_args: ${JSON.stringify(cmd.args)}\n`);
    enqueueLogWrite(`npm_execpath_available: yes\n`);
    enqueueLogWrite(`platform: ${process.platform}\n`);
    enqueueLogWrite(`arch: ${process.arch}\n`);
    enqueueLogWrite(`node: ${process.version}\n`);
    enqueueLogWrite(`app_version: ${require('../package.json').version}\n`);
    enqueueLogWrite(`base_commit: ${baseCommit || 'unknown'}\n`);
    enqueueLogWrite(`working_tree_dirty: ${treeStatus.dirty === null ? 'unknown' : treeStatus.dirty}\n`);
    enqueueLogWrite(`working_tree_status_sha256: ${treeStatus.statusHash || 'unknown'}\n`);
    enqueueLogWrite('\n--- BEGIN test:full OUTPUT ---\n');

    const tailLines = [];
    const lineCarry = { stdout: '', stderr: '' };

    const flushLineCarry = (source) => {
      const carry = lineCarry[source];
      if (carry !== '') {
        if (source === 'stdout') {
          if (tailLines.length >= TAIL_LINE_COUNT) tailLines.shift();
          tailLines.push(carry);
        }
        lineCarry[source] = '';
      }
    };

    const consumeLines = (chunk, source) => {
      const combined = lineCarry[source] + chunk;
      const parts = combined.split('\n');
      lineCarry[source] = parts.pop();
      if (source !== 'stdout') return;
      for (const part of parts) {
        const line = part.endsWith('\r') ? part.slice(0, -1) : part;
        if (tailLines.length >= TAIL_LINE_COUNT) tailLines.shift();
        tailLines.push(line);
      }
    };

    childResult = await runner.spawnStreaming(cmd.command, cmd.args, {
      cwd: ROOT,
      env,
      shell: false,
    }, async (chunk, source) => {
      process.stdout.write(chunk);
      enqueueLogWrite(chunk);
      consumeLines(chunk, source);
    });
    const result = childResult;

    flushLineCarry('stdout');
    flushLineCarry('stderr');

    enqueueLogWrite('\n--- END test:full OUTPUT ---\n');
    await flushLog();

    const finishedAt = new Date();
    const durationMs = finishedAt - startedAt;
    const reportedTotal = extractReportedTotal(tailLines);

    let status = 'failed';
    let exitCode = result.exitCode;
    if (result.signal === 'SIGTERM' || result.signal === 'SIGINT' || result.interrupted) {
      status = 'interrupted';
      if (exitCode === null || exitCode === 0) {
        exitCode = INTERRUPT_EXIT_CODE;
      }
    } else if (exitCode === 0) {
      status = 'passed';
    }

    const footer = [
      `\nstatus: ${status}`,
      `exit_code: ${exitCode}`,
      `signal: ${result.signal || ''}`,
      `duration_ms: ${durationMs}`,
      `summary_file: ${summaryFile ? relativeFromRoot(summaryFile) : ''}`,
    ];
    for (const line of footer) {
      enqueueLogWrite(line + '\n');
    }
    await flushLog();
    await logStream.close();
    logStream = null;

    const summary = {
      schema_version: SUMMARY_SCHEMA_VERSION,
      command: 'npm run test:full',
      status,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_ms: durationMs,
      exit_code: exitCode,
      signal: result.signal || null,
      app_version: require('../package.json').version,
      base_commit: baseCommit,
      working_tree_dirty: treeStatus.dirty,
      working_tree_status_sha256: treeStatus.statusHash,
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      artifact_directory: relativeFromRoot(artifactDir),
      log_file: relativeFromRoot(logFile),
      summary_file: relativeFromRoot(summaryFile),
      reported_suite_total: status === 'passed' ? reportedTotal : null,
    };

    await writeAtomicSummary(summaryFile, summary);

    console.log(`\nfull-suite-evidence: تم حفظ الأثر في ${relativeFromRoot(artifactDir)}`);
    return { exitCode, status, artifactDir };
  } catch (error) {
    const finishedAt = new Date();
    const durationMs = finishedAt - startedAt;

    if (logStream) {
      if (!logWriteError) {
        enqueueLogWrite(`\n--- RUNNER ERROR ---\n${error && error.stack ? error.stack : error}\n`);
        await flushLog().catch(() => {});
      }
      try {
        await logStream.close();
      } catch (closeError) {
        // تجاهل خطأ الإغلاق.
      }
      logStream = null;
    }

    if (!artifactDir || !summaryFile) {
      console.error('\nfull-suite-evidence: فشل إنشاء مجلد الأدلة.');
      console.error(error && error.stack ? error.stack : error);
      return { exitCode: 1, status: 'runner_error', artifactDir: null };
    }

    const childExitCode = childResult ? childResult.exitCode : null;
    const summaryExitCode = childExitCode === null || childExitCode === 0 ? null : childExitCode;
    const summary = {
      schema_version: SUMMARY_SCHEMA_VERSION,
      command: 'npm run test:full',
      status: 'runner_error',
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_ms: durationMs,
      exit_code: summaryExitCode,
      signal: childResult ? (childResult.signal || null) : null,
      app_version: require('../package.json').version,
      base_commit: baseCommit,
      working_tree_dirty: treeStatus.dirty,
      working_tree_status_sha256: treeStatus.statusHash,
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      artifact_directory: relativeFromRoot(artifactDir),
      log_file: relativeFromRoot(logFile),
      summary_file: relativeFromRoot(summaryFile),
      reported_suite_total: null,
      runner_error: error && error.message ? error.message : String(error),
    };

    try {
      await writeAtomicSummary(summaryFile, summary);
    } catch (summaryError) {
      console.error('تعذّر كتابة الملخص عند الخطأ:', summaryError.message);
    }

    console.error('\nfull-suite-evidence: فشل المشغّل.');
    console.error(error && error.stack ? error.stack : error);
    return { exitCode: 1, status: 'runner_error', artifactDir };
  }
}

/**
 * واجهة التشغيل الافتراضية للعمليات الفرعية.
 * يقبل حقن spawn وprocess target لأغراض الاختبار.
 */
function createDefaultRunner({ spawnImpl = spawn, processTarget = process } = {}) {
  return {
    spawnForOutput(command, args, options) {
      return new Promise((resolve, reject) => {
        const child = spawnImpl(command, args, { ...options, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', (exitCode) => {
          resolve({ stdout, stderr, exitCode });
        });
      });
    },

    spawnStreaming(command, args, options, onData) {
      return new Promise((resolve, reject) => {
        const child = spawnImpl(command, args, { ...options, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
        let killedBySignal = false;
        let finished = false;

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');

        child.stdout.on('data', async (chunk) => {
          await onData(chunk, 'stdout');
        });
        child.stderr.on('data', async (chunk) => {
          await onData(chunk, 'stderr');
        });

        const handleSigint = async () => {
          if (killedBySignal) return;
          killedBySignal = true;
          try {
            child.kill('SIGINT');
          } catch (killError) {
            // تجاهل.
          }
        };
        const handleSigterm = async () => {
          if (killedBySignal) return;
          killedBySignal = true;
          try {
            child.kill('SIGTERM');
          } catch (killError) {
            // تجاهل.
          }
        };

        const cleanupListeners = () => {
          if (finished) return;
          finished = true;
          processTarget.removeListener('SIGINT', handleSigint);
          processTarget.removeListener('SIGTERM', handleSigterm);
        };

        processTarget.once('SIGINT', handleSigint);
        processTarget.once('SIGTERM', handleSigterm);

        child.on('error', (error) => {
          cleanupListeners();
          reject(error);
        });
        child.on('close', (exitCode, signal) => {
          cleanupListeners();
          resolve({ exitCode, signal, interrupted: killedBySignal });
        });
      });
    },
  };
}

async function main() {
  const result = await run();
  process.exitCode = result.exitCode;
}

module.exports = {
  timestampToFolderName,
  relativeFromRoot,
  sha256,
  readBaseCommit,
  readWorkingTreeStatus,
  buildFullSuiteCommand,
  extractReportedTotal,
  writeAtomicSummary,
  createExclusiveArtifactDir,
  run,
  createDefaultRunner,
  SUMMARY_STATUSES,
  DEFAULT_ARTIFACT_ROOT,
  INTERRUPT_EXIT_CODE,
};

if (require.main === module) {
  main();
}
