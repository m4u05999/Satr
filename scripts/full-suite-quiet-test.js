#!/usr/bin/env node
'use strict';

/**
 * سطر — حارس الوضع الصامت لمشغّل الأدلة (‏`npm run test:full:evidence -- --quiet`).
 *
 * ما يعضّ عليه: (١) الكونسول الصامت يطبع رؤوس المجموعات وأسطر المشغّل والخاتمة، ولا يطبع
 * ضجيج المجموعات الناجحة؛ (٢) المجموعة الساقطة تصل ذيلُها (آخر QUIET_TAIL_LINES سطراً)
 * بعد الخاتمة، لا أولُها؛ (٣) السجل في ملف الأدلة **كامل** حرفياً رغم صمت الكونسول؛
 * (٤) `summary.json` يعلن الوضع (`console_mode`)؛ (٥) الوضع المفصّل الافتراضي لم يتغيّر؛
 * (٦) `parseCliOptions` يقبل `--quiet` و`SATR_SUITE_QUIET=1` ويرفض وسيطاً مجهولاً.
 *
 * قطعي بلا شبكة وبلا npm فعلي: المشغّل الفرعي محقون (runner مزيّف يبثّ نصاً مصطنعاً).
 */

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

// المشغّل يشترط npm_execpath (يضبطه npm run)؛ عند التشغيل المباشر بـnode نزوّده قيمة اسمية —
// المشغّل المزيّف أدناه لا ينفّذ الأمر أصلاً.
if (!process.env.npm_execpath) process.env.npm_execpath = 'npm-cli.js';

const evidence = require('./full-suite-evidence');

let checks = 0;
function ok(condition, message) { assert.ok(condition, message); checks += 1; }

/** نص مصطنع بصيغة full-suite.js: مجموعة ناجحة، ومتخطّاة، وساقطة بخمسين سطراً. */
function buildTranscript() {
  const lines = [];
  lines.push('full-suite: بدء 3 مجموعة اختبار قطعية/حية بالتسلسل.');
  lines.push('مستبعدة عمداً (1، بأسباب موثّقة في EXCLUDED_FROM_SUITE): test:full.');
  lines.push('');
  lines.push('[1/3] npm run test:alpha');
  for (let i = 1; i <= 30; i++) lines.push(`alpha noise ${i}`);
  lines.push('');
  lines.push('[2/3] ⏭ test:beta — متخطّاة على linux: سبب معلَن');
  lines.push('');
  lines.push('[3/3] npm run test:gamma');
  for (let i = 1; i <= 50; i++) lines.push(`gamma noise ${i}`);
  lines.push('');
  lines.push('full-suite: أبطأ ثماني مجموعات (ثانية) — أساس معايرة المهل:');
  lines.push('  test:gamma                       1.2');
  lines.push('  test:alpha                       0.4');
  lines.push('');
  lines.push('full-suite: فشلت المجموعات التالية:');
  lines.push('- test:gamma: 1');
  return lines.join('\n') + '\n';
}

function createFakeRunner(transcript, exitCode) {
  return {
    async spawnForOutput() { return { stdout: 'deadbeef', stderr: '', exitCode: 0 }; },
    async spawnStreaming(command, args, options, onData) {
      // يُبثّ على دفعات غير محاذية للأسطر عمداً — المرشّح يجب أن يعيد تجميعها.
      for (let offset = 0; offset < transcript.length; offset += 7) {
        await onData(transcript.slice(offset, offset + 7), 'stdout');
      }
      await onData('full-suite: ⚠ سطر من stderr\n', 'stderr');
      return { exitCode, signal: null, interrupted: false };
    },
  };
}

async function withTemp(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'satr-quiet-'));
  try { return await fn(dir); } finally { await fsp.rm(dir, { recursive: true, force: true }); }
}

async function main() {
  // ── (٦) تحليل الوسائط ──
  assert.deepStrictEqual(evidence.parseCliOptions([], {}), { quiet: false }); checks += 1;
  assert.deepStrictEqual(evidence.parseCliOptions(['--quiet'], {}), { quiet: true }); checks += 1;
  assert.deepStrictEqual(evidence.parseCliOptions([], { SATR_SUITE_QUIET: '1' }), { quiet: true }); checks += 1;
  assert.throws(() => evidence.parseCliOptions(['--loud'], {}), /وسيط غير معروف/); checks += 1;

  // ── (١)(٢) المرشّح وحدة ──
  {
    let out = '';
    const printer = evidence.createQuietPrinter((text) => { out += text; }, 5);
    printer.feed(buildTranscript(), 'stdout');
    const result = printer.finish();
    ok(out.includes('[1/3] npm run test:alpha'), 'رأس المجموعة الناجحة يظهر');
    ok(out.includes('[2/3] ⏭ test:beta'), 'رأس المجموعة المتخطّاة يظهر');
    ok(!out.includes('alpha noise'), 'ضجيج المجموعة الناجحة لا يظهر');
    ok(out.includes('full-suite: فشلت المجموعات التالية:'), 'كتلة الفشل تظهر');
    ok(out.includes('  test:gamma                       1.2'), 'جدول الأبطأ يمرّ كاملاً');
    ok(out.includes('gamma noise 50') && out.includes('gamma noise 47'), 'ذيل الساقطة يظهر');
    ok(!out.includes('gamma noise 46'), 'الذيل مقيَّد بالحدّ (5 أسطر هنا: 47–50 والسطر الفارغ) — لا يُطبع ما قبله');
    ok(out.indexOf('gamma noise 50') > out.indexOf('- test:gamma: 1'), 'الذيل بعد الخاتمة لا قبلها');
    assert.deepStrictEqual(result.failed, ['test:gamma']); checks += 1;
  }

  // ── (٣)(٤) سلوكياً عبر run() ──
  await withTemp(async (temp) => {
    let out = '';
    const transcript = buildTranscript();
    const result = await evidence.run({
      runner: createFakeRunner(transcript, 1),
      env: process.env,
      artifactRoot: temp,
      quiet: true,
      consoleWrite: (text) => { out += text; },
    });
    ok(result.status === 'failed' && result.exitCode === 1, 'حالة الفشل تمرّ كما هي');
    ok(!out.includes('alpha noise 1'), 'الكونسول الصامت بلا ضجيج الناجحة');
    ok(out.includes('gamma noise 50'), 'الكونسول الصامت يحمل ذيل الساقطة');
    ok(out.includes('full-suite: ⚠ سطر من stderr'), 'أسطر المشغّل على stderr تمرّ');
    const log = fs.readFileSync(path.join(result.artifactDir, 'full-suite.log'), 'utf8');
    ok(log.includes('alpha noise 1') && log.includes('gamma noise 1'), 'السجل في الملف كامل');
    ok(log.includes('console_mode: quiet'), 'رأس السجل يعلن الوضع');
    const summary = JSON.parse(fs.readFileSync(path.join(result.artifactDir, 'summary.json'), 'utf8'));
    ok(summary.console_mode === 'quiet', 'summary.json يعلن console_mode=quiet');
  });

  // ── (٥) الوضع المفصّل الافتراضي لم يتغيّر ──
  await withTemp(async (temp) => {
    let out = '';
    const result = await evidence.run({
      runner: createFakeRunner(buildTranscript(), 0),
      env: process.env,
      artifactRoot: temp,
      consoleWrite: (text) => { out += text; },
    });
    ok(out.includes('alpha noise 1') && out.includes('gamma noise 1'), 'المفصّل يبثّ كل شيء');
    const summary = JSON.parse(fs.readFileSync(path.join(result.artifactDir, 'summary.json'), 'utf8'));
    ok(summary.console_mode === 'verbose', 'summary.json يعلن console_mode=verbose');
  });

  console.log(`full-suite-quiet-test: ok — ${checks} فحصاً`);
}

main().catch((error) => {
  console.error('full-suite-quiet-test: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
