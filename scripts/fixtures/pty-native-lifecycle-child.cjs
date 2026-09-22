'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const Module = require('module');
const { app } = require('electron');
const [out, root, dependency] = process.argv.slice(2);
app.setPath('userData', path.join(out, 'profile'));
// يستعمل الحارس term.js الحقيقي؛ الاستبدال الوحيد حزمة PTY عند تجربة النسخة المعيبة.
const originalLoad = Module._load;
Module._load = function(request, parent, ...args) {
  if (request === 'node-pty' && parent?.filename === path.join(root, 'electron/term.js')) {
    return originalLoad.call(this, dependency, parent, ...args);
  }
  return originalLoad.call(this, request, parent, ...args);
};
const term = require(path.join(root, 'electron/term.js'));
const events = [], waves = [];
let resizeCalls = 0;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const note = (stage, data) => fs.appendFileSync(path.join(out, 'pty-native-stages.jsonl'), JSON.stringify({ stage, data, time: new Date().toISOString() }) + '\n');
term.setNotifier(event => {
  if (event.type === 'exit') {
    const item = { id: event.id, code: event.exitCode, marker: event.tail.includes('BARRIER_READY'), at: Date.now() };
    events.push(item); note('exit', item);
  }
});
app.whenReady().then(async () => {
  for (let wave = 0; wave < 12; wave++) {
    const gate = path.join(out, 'workspace', 'barrier-' + wave).replace(/\\/g, '/').replace(/'/g, "''");
    const ids = [];
    for (let i = 0; i < 6; i++) {
      const script = "Write-Output BARRIER_READY; $deadline=[DateTime]::UtcNow.AddSeconds(25); while(-not [IO.File]::Exists('" + gate + "')) { if([DateTime]::UtcNow -gt $deadline) {exit 7}; Start-Sleep -Milliseconds 5 }; exit 0";
      const result = term.startTerm(path.join(out, 'workspace'), 100, 25, { script });
      assert(result.ok, 'barrier_spawn_failed'); ids.push(result.id);
    }
    const deadline = Date.now() + 20000;
    while (!ids.every(id => term.readBuffer(id, 4096).data?.includes('BARRIER_READY'))) {
      assert(Date.now() < deadline, 'barrier_ready_timeout'); await delay(15);
    }
    note('barrier-release', { wave, ids });
    fs.writeFileSync(path.join(out, 'workspace', 'barrier-' + wave), 'exit');
    while (term.listTerms().some(item => ids.includes(item.id))) {
      assert(Date.now() < deadline, 'barrier_exit_timeout');
      for (const id of ids) { term.resizeTerm(id, 90 + resizeCalls % 10, 25 + resizeCalls % 3); resizeCalls++; }
      await delay(1);
    }
    const exits = events.filter(item => ids.includes(item.id));
    assert.equal(exits.length, 6); assert(exits.every(item => item.code === 0 && item.marker));
    waves.push({ wave, exited: exits.length, eventSpreadMs: Math.max(...exits.map(e => e.at)) - Math.min(...exits.map(e => e.at)) });
    console.log('BARRIER_WAVE_PASS', wave + 1);
    await delay(50);
  }
  fs.writeFileSync(path.join(out, 'pty-native-result.json'), JSON.stringify({ exited: events.length, goodOutput: events.filter(e => e.marker && e.code === 0).length, resizeCalls, waves }, null, 2));
  setTimeout(() => app.quit(), 1500);
}).catch(error => { note('failed', { message: error.message }); console.error(error.message); term.killAll(); app.exit(1); });
