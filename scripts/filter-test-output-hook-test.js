#!/usr/bin/env node
'use strict';

/**
 * سطر — حارس خطّاف الطقم الصامت (‏scripts/hooks/filter-test-output.js).
 *
 * ما يعضّ عليه: (١) `npm run test:full` و`npm run test:full:evidence` يُعاد توجيههما إلى
 * الوضع الصامت مع الإبقاء على بقية حقول tool_input؛ (٢) أمر يحمل `--quiet` أصلاً وأي أمر
 * آخر (git، اختبار مفرد، أمر مركّب) يمرّ بلا تغيير `{}`؛ (٣) لا يُصدر الخطّاف قرار إذن
 * أبداً؛ (٤) حمولة تالفة أو فارغة ⇒ `{}` ورمز خروج 0 (fail-open)؛ (٥) العملية الحقيقية عبر
 * stdin تطابق الدالة النقية — لا اختبار «يقارن الشيء بنفسه».
 */

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const hook = require('./hooks/filter-test-output');
const HOOK_FILE = path.join(__dirname, 'hooks', 'filter-test-output.js');

let checks = 0;
function ok(condition, message) { assert.ok(condition, message); checks += 1; }

// ── (١) إعادة الكتابة ──
assert.strictEqual(hook.rewriteCommand('npm run test:full'), hook.QUIET_COMMAND); checks += 1;
assert.strictEqual(hook.rewriteCommand('  npm run test:full  '), hook.QUIET_COMMAND); checks += 1;
assert.strictEqual(hook.rewriteCommand('npm run test:full:evidence'), hook.QUIET_COMMAND); checks += 1;

// ── (٢) ما يمرّ كما هو ──
for (const command of [
  hook.QUIET_COMMAND,
  'npm run test:full:evidence -- --quiet',
  'npm run test:skills',
  'npm run test:full && echo done',
  'git status',
  'npm run test:full-quiet',
  '',
]) {
  assert.strictEqual(hook.rewriteCommand(command), null, `يجب أن يمرّ كما هو: «${command}»`); checks += 1;
}
assert.strictEqual(hook.rewriteCommand(undefined), null); checks += 1;

// ── (٣) بنية الردّ ──
{
  const reply = hook.respond(JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command: 'npm run test:full', description: 'الطقم', timeout: 600000 },
  }));
  ok(reply.hookSpecificOutput && reply.hookSpecificOutput.hookEventName === 'PreToolUse', 'hookEventName صحيح');
  ok(reply.hookSpecificOutput.updatedInput.command === hook.QUIET_COMMAND, 'الأمر أُعيدت كتابته');
  ok(reply.hookSpecificOutput.updatedInput.description === 'الطقم', 'بقية الحقول محفوظة');
  ok(reply.hookSpecificOutput.updatedInput.timeout === 600000, 'المهلة محفوظة');
  ok(!('permissionDecision' in reply.hookSpecificOutput), 'لا قرار إذن — مربع الإذن كما هو');
}
assert.deepStrictEqual(hook.respond(JSON.stringify({ tool_input: { command: 'git status' } })), {}); checks += 1;

// ── (٤) fail-open ──
assert.deepStrictEqual(hook.respond('{not json'), {}); checks += 1;
assert.deepStrictEqual(hook.respond(''), {}); checks += 1;
assert.deepStrictEqual(hook.respond(JSON.stringify({ tool_input: {} })), {}); checks += 1;

// ── (٥) العملية الحقيقية عبر stdin ──
function runHook(input) {
  const result = spawnSync(process.execPath, [HOOK_FILE], { input, encoding: 'utf8' });
  return { status: result.status, out: result.stdout.trim() };
}
{
  const real = runHook(JSON.stringify({ tool_input: { command: 'npm run test:full' } }));
  ok(real.status === 0, 'رمز الخروج 0 عند إعادة الكتابة');
  assert.deepStrictEqual(JSON.parse(real.out), hook.respond(JSON.stringify({ tool_input: { command: 'npm run test:full' } }))); checks += 1;
}
{
  const real = runHook('garbage');
  ok(real.status === 0 && real.out === '{}', 'حمولة تالفة ⇒ {} ورمز 0');
}
{
  const real = runHook(JSON.stringify({ tool_input: { command: 'npm run test:skills' } }));
  ok(real.status === 0 && real.out === '{}', 'أمر خارج النطاق ⇒ {} ورمز 0');
}

console.log(`filter-test-output-hook-test: ok — ${checks} فحصاً`);
