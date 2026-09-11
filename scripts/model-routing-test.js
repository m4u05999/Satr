#!/usr/bin/env node
'use strict';

/**
 * سطر — حارس سياسة توجيه النماذج (‏docs/MODEL-ROUTING.md + .claude/settings.json + AGENTS.md).
 *
 * ما يعضّ عليه: (١) `.claude/settings.json` JSON صالح، الافتراضي رخيص (‏`opusplan`/`sonnet`/`haiku`)
 * والجهد الافتراضي ليس أعلى من `medium`، والوكلاء الفرعيون على نموذج رخيص؛ (٢) خطّاف PreToolUse مسجَّل
 * ويشير إلى ملف موجود؛ (٣) `docs/MODEL-ROUTING.md` يحمل الطبقات الأربع وقواعد التصعيد؛ (٤) AGENTS.md
 * فيه قسم «توجيه النماذج» يحيل إلى المستند؛ (٥) وكلاء `.claude/agents/*.md` يعلنون نموذجاً صراحةً
 * (لا وراثة صامتة للغالي).
 *
 * الحدّ المُصرَّح به: يحرس الإعدادات المكتوبة لا السلوك الفعلي للوكيل — من يختار `/model fable` لمهمة
 * روتينية لا يمسكه هذا الحارس؛ يمسكه `/usage`.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const CHEAP_DEFAULTS = new Set(['opusplan', 'sonnet', 'haiku', 'default']);
const CHEAP_SUBAGENTS = new Set(['haiku', 'sonnet']);
const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];

let checks = 0;
function ok(condition, message) { assert.ok(condition, message); checks += 1; }

// ── (١)(٢) الإعدادات ──
const settings = JSON.parse(read('.claude/settings.json'));
ok(CHEAP_DEFAULTS.has(settings.model), `الافتراضي «${settings.model}» ليس من المسار الرخيص (${[...CHEAP_DEFAULTS].join('/')})`);
ok(EFFORT_ORDER.indexOf(settings.effortLevel) <= EFFORT_ORDER.indexOf('medium'),
  `الجهد الافتراضي «${settings.effortLevel}» أعلى من medium — الغالي بسبب مكتوب لا افتراضاً`);
ok(settings.env && CHEAP_SUBAGENTS.has(settings.env.CLAUDE_CODE_SUBAGENT_MODEL),
  'CLAUDE_CODE_SUBAGENT_MODEL يجب أن يكون haiku أو sonnet');
ok(settings.modelSettings && settings.modelSettings['claude-fable-5-1'], 'Fable له إعداد جهد صريح في modelSettings');
const pre = settings.hooks && settings.hooks.PreToolUse;
ok(Array.isArray(pre) && pre.length >= 1, 'خطّاف PreToolUse مسجَّل');
const hookCommands = [];
for (const entry of pre || []) for (const h of entry.hooks || []) hookCommands.push(String(h.command));
const filterHook = hookCommands.find((c) => c.includes('scripts/hooks/filter-test-output.js'));
ok(!!filterHook, 'خطّاف filter-test-output.js مسجَّل في PreToolUse');
ok(fs.existsSync(path.join(ROOT, 'scripts', 'hooks', 'filter-test-output.js')), 'ملف الخطّاف موجود');
ok(/^node /.test(filterHook || ''), 'الخطّاف يُشغَّل بـnode (لا bash — ويندوز أولاً)');
ok((pre || []).every((entry) => /Bash/.test(String(entry.matcher))), 'matcher الخطّاف يشمل Bash');

// ── (٣) المستند ──
const doc = read('docs/MODEL-ROUTING.md');
for (const tier of ['T0', 'T1', 'T2', 'T3']) ok(doc.includes('**' + tier + ' '), `المستند يعرّف الطبقة ${tier}`);
ok(/اصعد إلى T3/.test(doc) && /اهبط إلى T2\/T1/.test(doc), 'قواعد التصعيد والهبوط موجودة');
ok(/opusplan/.test(doc) && /gpt-5\.6-luna/.test(doc), 'الإعدادات المرجعية مذكورة (opusplan، luna)');
ok(/test:full:evidence -- --quiet/.test(doc), 'المستند يوجّه إلى الطقم الصامت');

// ── (٤) AGENTS.md ──
const agents = read('AGENTS.md');
ok(/^## توجيه النماذج/m.test(agents), 'AGENTS.md فيه قسم «توجيه النماذج»');
ok(/docs\/MODEL-ROUTING\.md/.test(agents), 'AGENTS.md يحيل إلى docs/MODEL-ROUTING.md');

// ── (٥) الوكلاء الفرعيون يعلنون نموذجهم ──
const agentsDir = path.join(ROOT, '.claude', 'agents');
for (const file of fs.readdirSync(agentsDir).filter((f) => f.endsWith('.md'))) {
  const head = read(path.join('.claude', 'agents', file)).split('\n').slice(0, 12).join('\n');
  ok(/^model: \S+/m.test(head), `.claude/agents/${file} بلا سطر model: صريح`);
}

console.log(`model-routing-test: ok — ${checks} فحصاً (الافتراضي ${settings.model}/${settings.effortLevel}، الفرعيون ${settings.env.CLAUDE_CODE_SUBAGENT_MODEL})`);
