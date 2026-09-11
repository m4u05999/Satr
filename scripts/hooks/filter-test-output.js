#!/usr/bin/env node
'use strict';

/**
 * خطّاف PreToolUse لـClaude Code — «الطقم الكامل يُشغَّل صامتاً من داخل الوكيل».
 *
 * يقرأ حمولة الخطّاف من stdin (JSON فيه `tool_input.command`)، وإن كان الأمر هو الطقم
 * الكامل بصيغته المفصّلة أعاد كتابته إلى مشغّل الأدلة بالوضع الصامت:
 *     npm run test:full            →  npm run test:full:evidence -- --quiet
 *     npm run test:full:evidence   →  npm run test:full:evidence -- --quiet
 * وكل أمر آخر يمرّ كما هو (`{}`) — بما فيه أمر يحمل `--quiet` أصلاً.
 *
 * لماذا خطّاف لا تعليمة في CLAUDE.md: التعليمة سياق قد يُنسى بعد /compact، والخطّاف يُنفَّذ
 * قبل كل أمر Bash/PowerShell مهما قرّر النموذج (قياس 2026-09-10 على لينكس: المفصّل 1,933 سطراً
 * مقابل 292 صامتاً لطقم من 104 مجموعات، وكل سطر يدخل السياق يُعاد إرساله في كل دور تالٍ).
 *
 * العقد: لا يقرّر إذناً (لا permissionDecision) — مربع الإذن يبقى كما هو؛ يخرج بـ0 دائماً
 * ويطبع `{}` عند أي عطب، فلا يعطّل أمراً أبداً (fail-open). بلا اعتماديات، ويعمل بـnode
 * على ويندوز ولينكس (لا bash).
 */

const FULL_SUITE = /^\s*npm\s+run\s+test:full(?::evidence)?\s*$/;
const QUIET_COMMAND = 'npm run test:full:evidence -- --quiet';

/** يعيد الأمر المعدَّل أو null إن لم يكن الأمر من شأن الخطّاف. */
function rewriteCommand(command) {
  if (typeof command !== 'string') return null;
  if (!FULL_SUITE.test(command)) return null;
  return QUIET_COMMAND;
}

/** يبني ردّ الخطّاف من الحمولة الخام (نصّ JSON). أي عطب ⇒ `{}`. */
function respond(rawInput) {
  try {
    const payload = JSON.parse(rawInput);
    const command = payload && payload.tool_input && payload.tool_input.command;
    const updated = rewriteCommand(command);
    if (!updated) return {};
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: { ...payload.tool_input, command: updated },
      },
    };
  } catch {
    return {};
  }
}

function main() {
  const chunks = [];
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => chunks.push(chunk));
  process.stdin.on('end', () => {
    process.stdout.write(JSON.stringify(respond(chunks.join(''))) + '\n');
  });
  process.stdin.on('error', () => process.stdout.write('{}\n'));
}

if (require.main === module) main();

module.exports = { rewriteCommand, respond, QUIET_COMMAND, FULL_SUITE };
