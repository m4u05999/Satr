#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fsp = require('fs/promises');
const path = require('path');

const evidence = require('./full-suite-evidence');

const ROOT = path.resolve(__dirname, '..');

async function withTempArtifactRoot(testFn) {
  const cacheDir = path.join(ROOT, 'node_modules', '.cache');
  await fsp.mkdir(cacheDir, { recursive: true });
  const temp = await fsp.mkdtemp(path.join(cacheDir, 'satr-evidence-test-'));
  try {
    return await testFn(temp);
  } finally {
    await fsp.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

async function withNonExistentArtifactRoot(testFn) {
  const cacheDir = path.join(ROOT, 'node_modules', '.cache');
  await fsp.mkdir(cacheDir, { recursive: true });
  const uniqueName = `satr-evidence-missing-root-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const temp = path.join(cacheDir, uniqueName);
  if (await fsp.stat(temp).then(() => true).catch(() => false)) {
    await fsp.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  try {
    return await testFn(temp);
  } finally {
    await fsp.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

async function withFileAsArtifactRoot(testFn) {
  const cacheDir = path.join(ROOT, 'node_modules', '.cache');
  await fsp.mkdir(cacheDir, { recursive: true });
  const uniqueName = `satr-evidence-file-root-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const temp = path.join(cacheDir, uniqueName);
  await fsp.writeFile(temp, 'not-a-directory', 'utf8');
  try {
    return await testFn(temp);
  } finally {
    await fsp.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

function countSignalListeners(signal) {
  return process.listenerCount(signal);
}

const { EventEmitter } = require('events');

function createFakeRunner({ exitCode = 0, signal = null, output = '', outputChunks = null, errorChunks = null, streamChunks = null, error = null, interrupted = false, delayOutputMs = 0 } = {}) {
  return {
    spawnForOutputCalls: [],
    spawnStreamingCalls: [],

    spawnForOutput(command, args, options) {
      this.spawnForOutputCalls.push({ command, args, options });
      if (command === 'git' && args[0] === 'rev-parse') {
        return Promise.resolve({ stdout: 'abc123def456\n', stderr: '', exitCode: 0 });
      }
      if (command === 'git' && args[0] === 'status') {
        return Promise.resolve({ stdout: ' M package.json\n?? scripts/new.js\n', stderr: '', exitCode: 0 });
      }
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    },

    spawnStreaming(command, args, options, onData) {
      this.spawnStreamingCalls.push({ command, args, options });
      return new Promise((resolve, reject) => {
        if (error) {
          reject(error);
          return;
        }
        (async () => {
          if (delayOutputMs > 0) await new Promise((r) => setTimeout(r, delayOutputMs));
          if (streamChunks) {
            for (const item of streamChunks) {
              if (item.source !== 'stdout' && item.source !== 'stderr') {
                throw new Error(`مصدر chunk غير صالح: ${item.source}`);
              }
              await onData(item.text, item.source);
            }
          } else {
            const chunks = outputChunks || (output ? [output] : []);
            for (const chunk of chunks) {
              await onData(chunk, 'stdout');
            }
            if (errorChunks) {
              for (const chunk of errorChunks) {
                await onData(chunk, 'stderr');
              }
            }
          }
          resolve({ exitCode, signal, interrupted });
        })();
      });
    },
  };
}

async function main() {
  // 1. اسم مجلد UTC صالح على Windows.
  const folderName = evidence.timestampToFolderName(new Date('2026-07-21T14:30:45.123Z'));
  assert(!folderName.includes(':'), 'اسم المجلد يحتوي على :');
  assert(!folderName.includes(' '), 'اسم المجلد يحتوي على مسافة');
  assert(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(folderName), 'صيغة اسم المجلد غير متوقعة');

  // 2. إنشاء summary.json و full-suite.log.
  await withTempArtifactRoot(async (temp) => {
    const artifactDir = path.join(temp, evidence.timestampToFolderName(new Date()));
    await fsp.mkdir(artifactDir, { recursive: true });
    const summaryFile = path.join(artifactDir, 'summary.json');
    const logFile = path.join(artifactDir, 'full-suite.log');
    const summary = {
      schema_version: 1,
      status: 'passed',
      artifact_directory: evidence.relativeFromRoot(artifactDir),
      log_file: evidence.relativeFromRoot(logFile),
    };
    await evidence.writeAtomicSummary(summaryFile, summary);
    await fsp.writeFile(logFile, 'test log content\n', 'utf8');

    const savedSummary = JSON.parse(await fsp.readFile(summaryFile, 'utf8'));
    assert.strictEqual(savedSummary.status, 'passed');
    assert(await fsp.stat(logFile).then(() => true).catch(() => false));
  });

  // 3. حالة نجاح برمز 0.
  await withTempArtifactRoot(async (temp) => {
    const runner = createFakeRunner({ exitCode: 0, output: 'full-suite: نجحت المجموعات كلها — 45/45.\n' });
    const result = await evidence.run({ runner, env: process.env, artifactRoot: temp });
    assert.strictEqual(result.status, 'passed');
    assert.strictEqual(result.exitCode, 0);
    const summary = JSON.parse(await fsp.readFile(path.join(result.artifactDir, 'summary.json'), 'utf8'));
    assert.strictEqual(summary.exit_code, 0);
    assert.strictEqual(summary.status, 'passed');
    assert.deepStrictEqual(summary.reported_suite_total, { passed: 45, total: 45 });
  });

  // 4. حالة فشل برمز غير صفري.
  await withTempArtifactRoot(async (temp) => {
    const runner = createFakeRunner({ exitCode: 1, output: 'full-suite: فشلت المجموعات التالية:\n' });
    const result = await evidence.run({ runner, env: process.env, artifactRoot: temp });
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.exitCode, 1);
    const summary = JSON.parse(await fsp.readFile(path.join(result.artifactDir, 'summary.json'), 'utf8'));
    assert.strictEqual(summary.exit_code, 1);
    assert.strictEqual(summary.status, 'failed');
    assert.strictEqual(summary.reported_suite_total, null);
  });

  // لا يجوز أن يسرّب سطر نجاح داخلي عدداً ناجحاً إلى أثر تشغيل فاشل.
  await withTempArtifactRoot(async (temp) => {
    const runner = createFakeRunner({ exitCode: 1, output: 'full-suite: نجحت المجموعات كلها — 47/47.\n' });
    const result = await evidence.run({ runner, env: process.env, artifactRoot: temp });
    const summary = JSON.parse(await fsp.readFile(path.join(result.artifactDir, 'summary.json'), 'utf8'));
    assert.strictEqual(summary.status, 'failed');
    assert.strictEqual(summary.reported_suite_total, null);
  });

  // 5. الحفاظ على رمز الخروج.
  await withTempArtifactRoot(async (temp) => {
    const runner = createFakeRunner({ exitCode: 7, output: '' });
    const result = await evidence.run({ runner, env: process.env, artifactRoot: temp });
    assert.strictEqual(result.exitCode, 7);
    const summary = JSON.parse(await fsp.readFile(path.join(result.artifactDir, 'summary.json'), 'utf8'));
    assert.strictEqual(summary.exit_code, 7);
  });

  // 6. تسجيل working_tree_dirty.
  await withTempArtifactRoot(async (temp) => {
    const runner = createFakeRunner({ exitCode: 0, output: '' });
    const result = await evidence.run({ runner, env: process.env, artifactRoot: temp });
    const summary = JSON.parse(await fsp.readFile(path.join(result.artifactDir, 'summary.json'), 'utf8'));
    assert.strictEqual(summary.working_tree_dirty, true);
    assert(typeof summary.working_tree_status_sha256 === 'string');
    assert.strictEqual(summary.working_tree_status_sha256.length, 64);
  });

  // 7. عدم تسجيل قيم البيئة.
  await withTempArtifactRoot(async (temp) => {
    const runner = createFakeRunner({ exitCode: 0, output: '' });
    const result = await evidence.run({ runner, env: { TEST_SECRET_VALUE: 'should-not-appear' }, artifactRoot: temp });
    const log = await fsp.readFile(path.join(result.artifactDir, 'full-suite.log'), 'utf8');
    assert(!log.includes('should-not-appear'), 'السجل يحتوي على قيمة بيئة سرية.');
  });

  // 8 و 9. لا shell: true ولا command string قابلة للحقن.
  await withTempArtifactRoot(async (temp) => {
    const runner = createFakeRunner({ exitCode: 0, output: '' });
    await evidence.run({ runner, env: process.env, artifactRoot: temp });
    const streaming = runner.spawnStreamingCalls[0];
    assert(streaming, 'لم يُستدعَ spawnStreaming.');
    assert.strictEqual(streaming.options.shell, false, 'shell ليس false.');
    assert(Array.isArray(streaming.args), 'args ليس مصفوفة.');
    assert(!streaming.args.some((arg) => typeof arg === 'string' && arg.includes(';') && arg.includes('test:full')),
      'يوجد args مركّب يحتوي على ;');
  });

  // 10. غياب npm_execpath ينتج runner_error.
  const originalNpmExecPath = process.env.npm_execpath;
  delete process.env.npm_execpath;
  try {
    const cmd = evidence.buildFullSuiteCommand();
    assert.strictEqual(cmd.command, null);
    assert.strictEqual(cmd.args, null);
    assert.strictEqual(cmd.npmExecPath, null);

    await withTempArtifactRoot(async (temp) => {
      const runner = createFakeRunner({ exitCode: 0, output: '' });
      const result = await evidence.run({ runner, env: process.env, artifactRoot: temp });
      assert.strictEqual(result.status, 'runner_error');
      assert.strictEqual(result.exitCode, 1);
      const summary = JSON.parse(await fsp.readFile(path.join(result.artifactDir, 'summary.json'), 'utf8'));
      assert.strictEqual(summary.status, 'runner_error');
      assert.strictEqual(summary.exit_code, null);
      assert(summary.runner_error && summary.runner_error.includes('npm_execpath'));
    });
  } finally {
    if (originalNpmExecPath !== undefined) process.env.npm_execpath = originalNpmExecPath;
  }

  // 11. كتابة ملخص عند فشل العملية الابنة.
  await withTempArtifactRoot(async (temp) => {
    const runner = createFakeRunner({ exitCode: 1, output: 'some failure\n' });
    const result = await evidence.run({ runner, env: process.env, artifactRoot: temp });
    const summary = JSON.parse(await fsp.readFile(path.join(result.artifactDir, 'summary.json'), 'utf8'));
    assert.strictEqual(summary.status, 'failed');
    assert.strictEqual(summary.exit_code, 1);
  });

  // 12. منع recursion: لا يجب أن يشغّل المشغّل نفسه.
  await withTempArtifactRoot(async (temp) => {
    const runner = createFakeRunner({ exitCode: 0, output: '' });
    await evidence.run({ runner, env: process.env, artifactRoot: temp });
    const streaming = runner.spawnStreamingCalls[0];
    assert(!streaming.args.includes('test:full:evidence'), 'المشغّل يشغّل نفسه.');
    assert(streaming.args.includes('test:full'), 'المشغّل لا يشغّل test:full.');
  });

  // 13. كتابة مسارات نسبية داخل الملخص.
  await withTempArtifactRoot(async (temp) => {
    const runner = createFakeRunner({ exitCode: 0, output: '' });
    const result = await evidence.run({ runner, env: process.env, artifactRoot: temp });
    const summary = JSON.parse(await fsp.readFile(path.join(result.artifactDir, 'summary.json'), 'utf8'));
    assert(!path.isAbsolute(summary.artifact_directory), 'مسار الأثر مطلق.');
    assert(!path.isAbsolute(summary.log_file), 'مسار السجل مطلق.');
    assert(!path.isAbsolute(summary.summary_file), 'مسار الملخص مطلق.');
  });

  // 14. schema مستقرة وأحجام معقولة.
  await withTempArtifactRoot(async (temp) => {
    const runner = createFakeRunner({ exitCode: 0, output: '' });
    const result = await evidence.run({ runner, env: process.env, artifactRoot: temp });
    const summaryText = await fsp.readFile(path.join(result.artifactDir, 'summary.json'), 'utf8');
    const summary = JSON.parse(summaryText);
    assert.strictEqual(summary.schema_version, 1);
    assert(evidence.SUMMARY_STATUSES.includes(summary.status), 'حالة غير معروفة.');
    assert(summaryText.length < 100 * 1024, 'ملف الملخص كبير جداً.');
  });

  // 15. عدم استبدال أثر سابق عند تصادم timestamp؛ يُلحق رقم تسلسلي.
  await withTempArtifactRoot(async (temp) => {
    const fixedTime = Date.now();
    const runner1 = createFakeRunner({ exitCode: 0, output: '' });
    const result1 = await evidence.run({ runner: runner1, env: process.env, artifactRoot: temp, now: fixedTime });
    await fsp.writeFile(path.join(result1.artifactDir, 'keep.txt'), 'keep', 'utf8');

    const runner2 = createFakeRunner({ exitCode: 0, output: '' });
    const result2 = await evidence.run({ runner: runner2, env: process.env, artifactRoot: temp, now: fixedTime });
    assert.notStrictEqual(result1.artifactDir, result2.artifactDir, 'استُبدل الأثر السابق.');
    assert(await fsp.stat(path.join(result1.artifactDir, 'keep.txt')).then(() => true).catch(() => false),
      'حُذف الأثر السابق.');
  });

  // 16. المقاطعة تُنتج status=interrupted ورمز خروج غير صفري.
  await withTempArtifactRoot(async (temp) => {
    const runner = createFakeRunner({ exitCode: 0, signal: 'SIGINT', interrupted: true, output: '' });
    const result = await evidence.run({ runner, env: process.env, artifactRoot: temp });
    assert.strictEqual(result.status, 'interrupted');
    assert(result.exitCode !== 0, 'رمز خروج المقاطعة صفري.');
    const summary = JSON.parse(await fsp.readFile(path.join(result.artifactDir, 'summary.json'), 'utf8'));
    assert.strictEqual(summary.status, 'interrupted');
    assert.strictEqual(summary.exit_code, evidence.INTERRUPT_EXIT_CODE);
  });

  // 17. عدم تسرب مستمعي SIGINT/SIGTERM بعد الإغلاق أو الخطأ.
  await withTempArtifactRoot(async (temp) => {
    const beforeSigint = countSignalListeners('SIGINT');
    const beforeSigterm = countSignalListeners('SIGTERM');
    const runner = createFakeRunner({ exitCode: 0, output: '' });
    await evidence.run({ runner, env: process.env, artifactRoot: temp });
    assert.strictEqual(countSignalListeners('SIGINT'), beforeSigint, 'تسرب مستمع SIGINT.');
    assert.strictEqual(countSignalListeners('SIGTERM'), beforeSigterm, 'تسرب مستمع SIGTERM.');
  });

  await withTempArtifactRoot(async (temp) => {
    const beforeSigint = countSignalListeners('SIGINT');
    const beforeSigterm = countSignalListeners('SIGTERM');
    const runner = createFakeRunner({ exitCode: 0, output: '', error: new Error('spawn failure') });
    try {
      await evidence.run({ runner, env: process.env, artifactRoot: temp });
    } catch (error) {
      // المشغّل يمسك الخطأ ويعيد runner_error؛ لا يُعاد طرحه.
    }
    // انتظار دورة الأحداث لإكمال إزالة المستمعين.
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(countSignalListeners('SIGINT'), beforeSigint, 'تسرب مستمع SIGINT عند الخطأ.');
    assert.strictEqual(countSignalListeners('SIGTERM'), beforeSigterm, 'تسرب مستمع SIGTERM عند الخطأ.');
  });

  // 18. انتظار آخر كتابة قبل إغلاق السجل.
  await withTempArtifactRoot(async (temp) => {
    const runner = createFakeRunner({ exitCode: 0, output: 'final line\n', delayOutputMs: 50 });
    const result = await evidence.run({ runner, env: process.env, artifactRoot: temp });
    const log = await fsp.readFile(path.join(result.artifactDir, 'full-suite.log'), 'utf8');
    assert(log.includes('final line'), 'لم تُكتب آخر سطور الخرج قبل إغلاق السجل.');
    assert(log.includes('--- END test:full OUTPUT ---'), 'لم يُغلق السجل بعد اكتمال الكتابات.');
  });

  // 19. إنشاء artifact root غير موجود.
  await withNonExistentArtifactRoot(async (temp) => {
    assert.strictEqual(await fsp.stat(temp).then(() => true).catch(() => false), false, 'المجلد الأب موجود مسبقاً.');
    const runner = createFakeRunner({ exitCode: 0, output: '' });
    const result = await evidence.run({ runner, env: process.env, artifactRoot: temp });
    assert.strictEqual(result.status, 'passed');
    assert(await fsp.stat(temp).then(() => true).catch(() => false), 'لم يُنشأ المجلد الأب.');
    assert(await fsp.stat(result.artifactDir).then(() => true).catch(() => false), 'لم يُنشأ مجلد التشغيل.');
    assert(await fsp.stat(path.join(result.artifactDir, 'full-suite.log')).then(() => true).catch(() => false), 'لم يُنشأ full-suite.log.');
    assert(await fsp.stat(path.join(result.artifactDir, 'summary.json')).then(() => true).catch(() => false), 'لم يُنشأ summary.json.');
  });

  // 20. فشل كتابة السجل لا ينتج passed.
  await withTempArtifactRoot(async (temp) => {
    const runner = createFakeRunner({ exitCode: 0, output: 'some output\n' });
    const result = await evidence.run({
      runner,
      env: process.env,
      artifactRoot: temp,
      openLogStream: async () => ({
        write: async () => { throw new Error('write failure'); },
        close: async () => {},
      }),
    });
    assert.notStrictEqual(result.status, 'passed', 'ظهرت حالة passed رغم فشل الكتابة.');
    assert.notStrictEqual(result.exitCode, 0, 'رمز الخروج صفري رغم فشل الكتابة.');
    const summary = JSON.parse(await fsp.readFile(path.join(result.artifactDir, 'summary.json'), 'utf8'));
    assert.notStrictEqual(summary.status, 'passed', 'ملخص passed رغم فشل الكتابة.');
    assert(summary.runner_error && summary.runner_error.includes('write failure'), 'لم يُسجّل سبب فشل الكتابة.');
  });

  // 21. انقسام summary line بين chunks.
  await withTempArtifactRoot(async (temp) => {
    const runner = createFakeRunner({
      exitCode: 0,
      outputChunks: [
        'full-suite: نجحت المجموعات',
        ' كلها — 47/',
        '47.\n',
      ],
    });
    const result = await evidence.run({ runner, env: process.env, artifactRoot: temp });
    const summary = JSON.parse(await fsp.readFile(path.join(result.artifactDir, 'summary.json'), 'utf8'));
    assert.deepStrictEqual(summary.reported_suite_total, { passed: 47, total: 47 }, 'لم يُعالج انقسام السطر.');
  });

  // 22. آخر سطر بلا newline يُعالج عند الإغلاق.
  await withTempArtifactRoot(async (temp) => {
    const runner = createFakeRunner({
      exitCode: 0,
      outputChunks: ['full-suite: نجحت المجموعات كلها — 12/12.'],
    });
    const result = await evidence.run({ runner, env: process.env, artifactRoot: temp });
    const summary = JSON.parse(await fsp.readFile(path.join(result.artifactDir, 'summary.json'), 'utf8'));
    assert.deepStrictEqual(summary.reported_suite_total, { passed: 12, total: 12 }, 'لم يُعالج السطر الأخير بدون newline.');
  });

  // 23. آخر تطابق هو المُعتمد عند تكرار summary line.
  await withTempArtifactRoot(async (temp) => {
    const runner = createFakeRunner({
      exitCode: 0,
      outputChunks: [
        'full-suite: نجحت المجموعات كلها — 45/45.\n',
        'other output\n',
        'full-suite: نجحت المجموعات كلها — 47/47.\n',
      ],
    });
    const result = await evidence.run({ runner, env: process.env, artifactRoot: temp });
    const summary = JSON.parse(await fsp.readFile(path.join(result.artifactDir, 'summary.json'), 'utf8'));
    assert.deepStrictEqual(summary.reported_suite_total, { passed: 47, total: 47 }, 'لم يُعتمد التطابق الأخير عند انقسام chunks.');
  });

  // 24. فشل الكتابة المتأخر في footer لا ينتج passed.
  await withTempArtifactRoot(async (temp) => {
    const runner = createFakeRunner({ exitCode: 0, output: 'some output\n' });
    const result = await evidence.run({
      runner,
      env: process.env,
      artifactRoot: temp,
      openLogStream: async () => ({
        write: async (text) => {
          if (text.includes('status:')) {
            throw new Error('late footer failure');
          }
        },
        close: async () => {},
      }),
    });
    assert.strictEqual(result.status, 'runner_error', 'حالة النتيجة ليست runner_error عند فشل footer.');
    assert.notStrictEqual(result.exitCode, 0, 'رمز الخروج صفري عند فشل footer.');
    const summary = JSON.parse(await fsp.readFile(path.join(result.artifactDir, 'summary.json'), 'utf8'));
    assert.strictEqual(summary.status, 'runner_error', 'ملخص summary ليس runner_error عند فشل footer.');
    assert(summary.runner_error && summary.runner_error.includes('late footer failure'), 'لم يُسجّل سبب فشل footer.');
  });

  // 25. stdout و stderr يفصلان في line buffering.
  await withTempArtifactRoot(async (temp) => {
    const runner = createFakeRunner({
      exitCode: 0,
      streamChunks: [
        { source: 'stdout', text: 'full-suite: نجحت المجموعات كلها — 47/' },
        { source: 'stderr', text: 'stderr-partial' },
        { source: 'stdout', text: '47.\n' },
      ],
    });
    const result = await evidence.run({ runner, env: process.env, artifactRoot: temp });
    assert.strictEqual(result.status, 'passed', 'الحالة تغيّرت رغم نجاح الاختبار.');
    assert.strictEqual(result.exitCode, 0, 'رمز الخروج تغيّر رغم نجاح الاختبار.');
    const summary = JSON.parse(await fsp.readFile(path.join(result.artifactDir, 'summary.json'), 'utf8'));
    assert.deepStrictEqual(summary.reported_suite_total, { passed: 47, total: 47 }, 'تداخل stderr مع stdout في parsing.');
    const log = await fsp.readFile(path.join(result.artifactDir, 'full-suite.log'), 'utf8');
    assert(log.includes('stderr-partial'), 'لم يُكتب stderr في السجل.');
  });

  // 25b. الخرج الجزئي قبل رمي spawnStreaming لا يُفقد من السجل.
  await withTempArtifactRoot(async (temp) => {
    const runner = {
      spawnForOutput(command, args, options) {
        if (command === 'git' && args[0] === 'rev-parse') {
          return Promise.resolve({ stdout: 'abc123def456\n', stderr: '', exitCode: 0 });
        }
        if (command === 'git' && args[0] === 'status') {
          return Promise.resolve({ stdout: ' M package.json\n?? scripts/new.js\n', stderr: '', exitCode: 0 });
        }
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      },
      spawnStreaming(command, args, options, onData) {
        this.spawnStreamingCalls = this.spawnStreamingCalls || [];
        this.spawnStreamingCalls.push({ command, args, options });
        return new Promise(async (resolve, reject) => {
          await onData('partial-output-before-error', 'stderr');
          reject(new Error('simulated child error'));
        });
      },
    };
    const result = await evidence.run({ runner, env: process.env, artifactRoot: temp });
    assert.strictEqual(result.status, 'runner_error', 'الحالة ليست runner_error عند رمي العملية الابنة.');
    assert.notStrictEqual(result.exitCode, 0, 'رمز الخروج صفري عند رمي العملية الابنة.');
    const summary = JSON.parse(await fsp.readFile(path.join(result.artifactDir, 'summary.json'), 'utf8'));
    assert.strictEqual(summary.status, 'runner_error', 'ملخص summary ليس runner_error.');
    assert(summary.runner_error && summary.runner_error.includes('simulated child error'), 'لم يُسجّل خطأ العملية الابنة في الملخص.');
    const log = await fsp.readFile(path.join(result.artifactDir, 'full-suite.log'), 'utf8');
    assert(log.includes('partial-output-before-error'), 'فُقد الخرج الجزئي الذي وصل قبل الخطأ من السجل.');
  });

  // 26. artifact root يشير إلى ملف موجود ينتج runner_error دون رمي.
  await withFileAsArtifactRoot(async (temp) => {
    const runner = createFakeRunner({ exitCode: 0, output: '' });
    let threw = false;
    let result;
    try {
      result = await evidence.run({ runner, env: process.env, artifactRoot: temp });
    } catch (error) {
      threw = true;
    }
    assert.strictEqual(threw, false, 'run() رمى exception عندما يكون artifactRoot ملفاً.');
    assert.strictEqual(result.status, 'runner_error', 'الحالة ليست runner_error عندما يكون artifactRoot ملفاً.');
    assert.notStrictEqual(result.exitCode, 0, 'رمز الخروج صفري عندما يكون artifactRoot ملفاً.');
    assert.strictEqual(result.artifactDir, null, 'artifactDir ليس null عندما يكون artifactRoot ملفاً.');
  });

  function createFakeChildForRunner() {
    const childEmitter = new EventEmitter();
    childEmitter.stdout = new EventEmitter();
    childEmitter.stdout.setEncoding = () => {};
    childEmitter.stderr = new EventEmitter();
    childEmitter.stderr.setEncoding = () => {};
    childEmitter.kill = () => {};
    return childEmitter;
  }

  // 24. تنظيف مستمعي الإشارات في createDefaultRunner الحقيقي.
  await withTempArtifactRoot(async (temp) => {
    const processTarget = new EventEmitter();
    const childEmitter = createFakeChildForRunner();

    const spawnImpl = () => childEmitter;
    const runner = evidence.createDefaultRunner({ spawnImpl, processTarget });

    const beforeSigint = processTarget.listenerCount('SIGINT');
    const beforeSigterm = processTarget.listenerCount('SIGTERM');

    const runPromise = runner.spawnStreaming('node', ['--version'], { cwd: ROOT, shell: false }, async () => {});

    // محاكاة خروج العملية الابنة.
    childEmitter.stdout.emit('data', 'output\n');
    childEmitter.emit('close', 0, null);

    await runPromise;

    assert.strictEqual(processTarget.listenerCount('SIGINT'), beforeSigint, 'تسرب مستمع SIGINT في createDefaultRunner.');
    assert.strictEqual(processTarget.listenerCount('SIGTERM'), beforeSigterm, 'تسرب مستمع SIGTERM في createDefaultRunner.');
  });

  // 25. createDefaultRunner ينظف المستمعين عند error أيضاً.
  await withTempArtifactRoot(async (temp) => {
    const processTarget = new EventEmitter();
    const childEmitter = createFakeChildForRunner();

    const spawnImpl = () => childEmitter;
    const runner = evidence.createDefaultRunner({ spawnImpl, processTarget });

    const beforeSigint = processTarget.listenerCount('SIGINT');
    const beforeSigterm = processTarget.listenerCount('SIGTERM');

    const runPromise = runner.spawnStreaming('node', ['--version'], { cwd: ROOT, shell: false }, async () => {});
    childEmitter.emit('error', new Error('spawn failure'));

    try {
      await runPromise;
      assert.fail('كان من المتوقع رفض الوعد.');
    } catch (error) {
      // متوقع.
    }

    await new Promise((r) => setImmediate(r));
    assert.strictEqual(processTarget.listenerCount('SIGINT'), beforeSigint, 'تسرب مستمع SIGINT عند error.');
    assert.strictEqual(processTarget.listenerCount('SIGTERM'), beforeSigterm, 'تسرب مستمع SIGTERM عند error.');
  });

  // 26. المقاطعة عندما يكون exitCode === null تُنتج 130 في createDefaultRunner.
  await withTempArtifactRoot(async (temp) => {
    const processTarget = new EventEmitter();
    const childEmitter = createFakeChildForRunner();

    const spawnImpl = () => childEmitter;
    const runner = evidence.createDefaultRunner({ spawnImpl, processTarget });

    const runPromise = runner.spawnStreaming('node', ['--version'], { cwd: ROOT, shell: false }, async () => {});
    processTarget.emit('SIGINT');
    childEmitter.emit('close', null, 'SIGINT');

    const result = await runPromise;
    assert.strictEqual(result.signal, 'SIGINT');
    assert.strictEqual(result.interrupted, true);
  });

  // 27. تكامل null exitCode → 130 عبر createDefaultRunner + run() الحقيقي.
  await withTempArtifactRoot(async (temp) => {
    const processTarget = new EventEmitter();
    const childEmitter = createFakeChildForRunner();
    const defaultRunner = evidence.createDefaultRunner({ spawnImpl: () => childEmitter, processTarget });

    const runner = {
      spawnForOutput(command, args, options) {
        if (command === 'git' && args[0] === 'rev-parse') {
          return Promise.resolve({ stdout: 'abc123def456\n', stderr: '', exitCode: 0 });
        }
        if (command === 'git' && args[0] === 'status') {
          return Promise.resolve({ stdout: ' M package.json\n', stderr: '', exitCode: 0 });
        }
        return defaultRunner.spawnForOutput(command, args, options);
      },
      spawnStreaming(command, args, options, onData) {
        return defaultRunner.spawnStreaming(command, args, options, onData);
      },
    };

    const beforeSigint = countSignalListeners('SIGINT');
    const beforeSigterm = countSignalListeners('SIGTERM');

    const runPromise = evidence.run({ runner, env: process.env, artifactRoot: temp });
    await new Promise((r) => setTimeout(r, 100));
    processTarget.emit('SIGINT');
    childEmitter.emit('close', null, 'SIGINT');

    const result = await runPromise;
    assert.strictEqual(result.status, 'interrupted', 'حالة التكامل ليست interrupted.');
    assert.strictEqual(result.exitCode, evidence.INTERRUPT_EXIT_CODE, 'رمز خروج التكامل ليس 130.');
    const summary = JSON.parse(await fsp.readFile(path.join(result.artifactDir, 'summary.json'), 'utf8'));
    assert.strictEqual(summary.status, 'interrupted', 'ملخص التكامل ليس interrupted.');
    assert.strictEqual(summary.exit_code, evidence.INTERRUPT_EXIT_CODE, 'ملخص التكامل لا يحتوي 130.');
    assert.strictEqual(countSignalListeners('SIGINT'), beforeSigint, 'تسرب مستمع SIGINT في اختبار التكامل.');
    assert.strictEqual(countSignalListeners('SIGTERM'), beforeSigterm, 'تسرب مستمع SIGTERM في اختبار التكامل.');
  });

  // اختبارات وحدة إضافية.
  const hash = evidence.sha256('hello');
  assert.strictEqual(hash.length, 64);

  const failExtract = evidence.extractReportedTotal(['full-suite: فشلت المجموعات التالية:']);
  assert.deepStrictEqual(failExtract, { passed: null, total: null });

  const passExtract = evidence.extractReportedTotal(['full-suite: نجحت المجموعات كلها — 12/12.']);
  assert.deepStrictEqual(passExtract, { passed: 12, total: 12 });

  const lastWins = evidence.extractReportedTotal([
    'full-suite: نجحت المجموعات كلها — 45/45.',
    'other output',
    'full-suite: نجحت المجموعات كلها — 47/47.',
  ]);
  assert.deepStrictEqual(lastWins, { passed: 47, total: 47 }, 'لم يُعتمد التطابق الأخير.');

  console.log('✓ windows-safe UTC folder name');
  console.log('✓ summary.json and full-suite.log creation');
  console.log('✓ success and failure exit codes preserved');
  console.log('✓ working tree dirty state recorded');
  console.log('✓ no environment secrets logged');
  console.log('✓ no shell: true or injectable command strings');
  console.log('✓ missing npm_execpath is runner_error');
  console.log('✓ summary written even when child process fails');
  console.log('✓ recursion prevented');
  console.log('✓ relative paths in summary');
  console.log('✓ stable schema and reasonable size limits');
  console.log('✓ previous artifacts preserved on timestamp collision');
  console.log('✓ interruption returns non-zero and status=interrupted');
  console.log('✓ SIGINT/SIGTERM listeners are removed after close/error');
  console.log('✓ last write is flushed before closing log');
  console.log('✓ artifact root created when missing');
  console.log('✓ log write failure prevents passed status');
  console.log('✓ summary line split across chunks is parsed');
  console.log('✓ final line without newline is handled');
  console.log('✓ last matching summary wins across chunks');
  console.log('✓ createDefaultRunner cleans signal listeners on close/error');
  console.log('✓ createDefaultRunner interruption maps null exitCode to 130');
  console.log('✓ late footer write failure prevents passed');
  console.log('✓ stdout and stderr are buffered separately');
  console.log('✓ invalid artifact root (file) returns runner_error without throwing');
  console.log('✓ integration maps null exitCode SIGINT to 130 via real run()');
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
