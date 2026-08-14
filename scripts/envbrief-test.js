'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const envbrief = require('../electron/envbrief');
const codexmcp = require('../electron/codexmcp');
const kimi = require('../electron/kimi');
const tools = require('../electron/tools');

const root = path.resolve(__dirname, '..');
const agentSource = fs.readFileSync(path.join(root, 'electron', 'agent.js'), 'utf8');
const sdkActual = Array.from(agentSource.matchAll(/sdk\.tool\(\s*['"]([^'"]+)['"]/g), (match) => match[1]);
const codexActual = codexmcp.buildTools({ preview: {} }).map((tool) => tool.name);
const kimiActual = codexmcp.buildTools({
  preview: {}, extraTools: kimi._internals.buildSatrMcpTools(root, { enabled: [] }, () => {}),
}).map((tool) => tool.name);
const adapterActual = tools.defs().map((def) => def.function.name);

function sameNames(actual, declared, engine) {
  assert.deepStrictEqual([...new Set(declared)].sort(), [...new Set(actual)].sort(), 'انحرف جرد أدوات ' + engine);
  const brief = envbrief.build(engine, 'test-model');
  for (const name of actual) assert(brief.includes(name), 'موجز ' + engine + ' لا يذكر ' + name);
  assert(brief.includes('سياسة التنفيذ في سطر'));
  assert(brief.includes('list_background_tasks'));
  assert(brief.includes('run_in_background'));
  assert(brief.includes('get_background_output'));
  assert(brief.includes('بيئة سطر:'));
  assert(brief.includes('فضّل API/CLI') && brief.includes('gh') && brief.includes('netlify'), 'الموجز يفضّل الواجهة البرمجية لكل المحركات');
}

sameNames(sdkActual, envbrief.toolNames('sdk'), 'sdk');
sameNames(codexActual, envbrief.toolNames('codex'), 'codex');
sameNames(kimiActual, envbrief.toolNames('kimi-code'), 'kimi-code');
sameNames(adapterActual, envbrief.toolNames('adapter'), 'adapter');

for (const engine of ['sdk', 'codex', 'kimi-code']) {
  const brief = envbrief.build(engine, 'test-model');
  assert(brief.includes('نطاق خارجي جديد') && brief.includes('localhost موثوق دائماً'), 'موجز ' + engine + ' لا يشرح سياسة النطاقات الموثوقة');
  assert(brief.includes('browser_set_viewport') && brief.includes('دليلاً'), 'موجز ' + engine + ' لا يفرض تحقق التجاوب بدليل');
  for (const tool of ['browser_evaluate', 'browser_set_viewport', 'browser_perf', 'browser_back', 'browser_forward']) {
    assert(brief.includes(tool), 'موجز ' + engine + ' لا يذكر ' + tool);
  }
  for (const tool of ['browser_fill_form', 'browser_transfer_field', 'browser_request_secret', 'browser_handoff_step']) {
    assert(brief.includes(tool), 'موجز ' + engine + ' لا يذكر ' + tool);
  }
  assert(brief.includes('لا تمرّر مفتاح API') && brief.includes('تُؤكّد كل مرة'), 'موجز ' + engine + ' لا يثبت قاعدة الأسرار والفعل الحسّاس');
  assert(brief.includes('Task Ledger') && brief.includes('task_update'), 'موجز ' + engine + ' لا يثبت أثر مهمة الإعداد');
}

for (const file of [
  'electron/agent.js', 'electron/codex.js', 'electron/kimi.js',
  'electron/adapters/openai-compatible.js', 'electron/adapters/gemini.js',
  // فجوتا العصف الثلاثي (OBS-001، 2026-08-15): هذان السطحان كانا **بلا موجز
  // إطلاقاً** — فلا هوية «سطر» ولا تعليمة العربية. لا يخرجان من القائمة ثانية.
  'electron/adapters/openai-responses.js', 'electron/adapters/claude-cli.js',
]) {
  assert(fs.readFileSync(path.join(root, file), 'utf8').includes('envbrief.build('), file + ' لا يستهلك envbrief');
}

// غلاف الذاكرة يُحقن كل دور يلتقط ذاكرة: بقاؤه عربياً جزء من عقد اللغة (OBS-001) —
// كان «Treat it as contextual knowledge…» غرزاً إنجليزياً في كل دور.
{
  const memorySource = fs.readFileSync(path.join(root, 'electron', 'memory.js'), 'utf8');
  assert(!memorySource.includes('Treat it as contextual knowledge'),
    'غلاف الذاكرة عاد إنجليزياً — قناة تخفيف التعليمة العربية بعينها');
  assert(memorySource.includes('ذاكرة مشروع شخصية اعتمدها المستخدم'),
    'غلاف الذاكرة العربي غائب');
}

console.log('envbrief: نجح — جرد الأدوات الفعلي والسياسات موحّدان لكل المحركات.');
