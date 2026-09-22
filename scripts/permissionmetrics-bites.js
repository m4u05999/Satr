'use strict';
// يزرع في نسخة من المصدر؛ يثبت السقوط ثم يعيد بايتات النسخة، ولا يلمس مصدر الإنتاج.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.join(__dirname, '..');
const dir = path.join(root, 'dist/permission-metrics-bites');
fs.mkdirSync(dir, { recursive: true });
const cases = [
 ['missing-request-must-pass', 'electron/permissionmetrics.js',
  'if (!record || record.finished || record.inFlight) return resolveCallback();',
  'if (!record || record.finished || record.inFlight) return false;', 'core'],
 ['private-tool', 'electron/permissionmetrics.js',
  "return TOOLS.has(bare) ? bare : 'other';", 'return bare;', 'core'],
 ['bounded-pending', 'electron/permissionmetrics.js',
  'if (pending.size >= MAX_PENDING) {', 'if (pending.size >= MAX_PENDING + 1) {', 'core'],
 ['synchronous-close', 'electron/permissionmetrics.js',
  'if (record.inFlight) record.deferredClose = true;', "if (record.inFlight) append(record, 'cancelled');", 'core'],
 ['main-request-connected', 'electron/main.js',
  'permissionMetrics.request(runId, obj.id, runEngine, obj.tool, obj.permissionReasons);',
  'void 0; // mutation: dropped metric request', 'main'],
 ['main-close-connected', 'electron/main.js',
  "if (obj.kind === 'permission') permissionMetrics.close(obj.id, runId);",
  'void 0; // mutation: dropped metric close', 'main'],
];
const report = [];
function count(text, needle) { return text.split(needle).length - 1; }
for (const [name, relative, original, mutant, kind] of cases) {
 const source = fs.readFileSync(path.join(root, relative), 'utf8');
 const target = path.join(dir, name + '.cjs');
 const before = [count(source, original), count(source, mutant)];
 assert.deepEqual(before, [1, 0]);
 const planted = source.replace(original, mutant);
 fs.writeFileSync(target, planted);
 const actual = fs.readFileSync(target, 'utf8');
 const after = [count(actual, original), count(actual, mutant)];
 assert.deepEqual(after, [0, 1]);
 const env = { ...process.env, [kind === 'core' ? 'SATR_METRICS_MODULE_FILE' : 'SATR_METRICS_MAIN_FILE']: target };
 let result;
 try {
  result = spawnSync(process.execPath, [path.join(root, 'scripts', kind === 'core' ? 'permissionmetrics-test.js' : 'subagent-permission-test.js')],
   { cwd: root, env, encoding: 'utf8', timeout: 30000 });
  assert.notEqual(result.status, 0, 'Mutation survived: ' + name);
  assert.ok(result.status !== null && /AssertionError/.test(result.stderr), 'Not an assertion failure: ' + name);
 } finally { fs.writeFileSync(target, source); }
 assert.equal(fs.readFileSync(target, 'utf8'), source);
 const lines = result.stderr.split(/\r?\n/);
 const start = lines.findIndex(line => line.includes('AssertionError'));
 const failure = lines.slice(Math.max(0, start), Math.max(0, start) + 8).join('\n');
 const entry = { name, command: 'node scripts/permissionmetrics-bites.js',
  plant: 'fs.writeFileSync(target, source.replace(original, mutant))', target, original, mutant, before, after,
  failure, restore: 'fs.writeFileSync(target, source)', restored: true };
 report.push(entry);
 console.log(JSON.stringify(entry));
}
fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
console.log('PASS bites ' + report.length + '/' + cases.length);
