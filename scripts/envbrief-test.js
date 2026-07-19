'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const envbrief = require('../electron/envbrief');
const codexmcp = require('../electron/codexmcp');
const tools = require('../electron/tools');

const root = path.resolve(__dirname, '..');
const agentSource = fs.readFileSync(path.join(root, 'electron', 'agent.js'), 'utf8');
const sdkActual = Array.from(agentSource.matchAll(/sdk\.tool\(\s*['"]([^'"]+)['"]/g), (match) => match[1]);
const codexActual = codexmcp.buildTools({ preview: {} }).map((tool) => tool.name);
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
}

sameNames(sdkActual, envbrief.toolNames('sdk'), 'sdk');
sameNames(codexActual, envbrief.toolNames('codex'), 'codex');
sameNames(adapterActual, envbrief.toolNames('adapter'), 'adapter');

for (const engine of ['sdk', 'codex']) {
  const brief = envbrief.build(engine, 'test-model');
  assert(brief.includes('نطاق خارجي جديد') && brief.includes('localhost موثوق دائماً'), 'موجز ' + engine + ' لا يشرح سياسة النطاقات الموثوقة');
  assert(brief.includes('browser_set_viewport') && brief.includes('دليلاً'), 'موجز ' + engine + ' لا يفرض تحقق التجاوب بدليل');
  for (const tool of ['browser_evaluate', 'browser_set_viewport', 'browser_perf', 'browser_back', 'browser_forward']) {
    assert(brief.includes(tool), 'موجز ' + engine + ' لا يذكر ' + tool);
  }
}

for (const file of [
  'electron/agent.js', 'electron/codex.js',
  'electron/adapters/openai-compatible.js', 'electron/adapters/gemini.js',
]) {
  assert(fs.readFileSync(path.join(root, file), 'utf8').includes('envbrief.build('), file + ' لا يستهلك envbrief');
}

console.log('envbrief: نجح — جرد الأدوات الفعلي والسياسات موحّدان لكل المحركات.');
