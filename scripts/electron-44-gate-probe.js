'use strict';

// مسبار قياس يدوي للدفعة الأولى؛ يطبع الأدلة ولا يصلح كود الإنتاج أو يزرع فيه أعطالاً.
const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const mode = process.argv[2] || 'pty';
const active = new Set();
const timeout = setTimeout(() => {
  console.error('GATE_TIMEOUT');
  for (const terminal of active) { try { terminal.kill(); } catch {} }
  app.exit(2);
}, 180000);
timeout.unref();

app.whenReady().then(async () => {
  console.log('VERSIONS ' + JSON.stringify(process.versions));
  console.log('RUNTIME ' + JSON.stringify({ executable: process.execPath, platform: process.platform, arch: process.arch }));
  if (mode === 'versions') return app.exit(0);
  if (mode === 'clipboard') {
    const { clipboard } = require('electron');
    console.log('AVAILABLE_FORMATS_TYPE ' + typeof clipboard.availableFormats);
    try { clipboard.availableFormats(); } catch (error) { console.log('CLIPBOARD_ERROR ' + error.toString()); }
    app.exit(0);
    return;
  }
  if (mode === 'test') {
    const name = process.argv[3];
    if (!['termjobs-test.js', 'termjobs-done-test.js', 'term-longline-test.js'].includes(name)) throw new Error('Unknown probe test');
    require(path.join(__dirname, name));
    return;
  }
  const pty = require('node-pty');
  console.log('REQUIRE_OK node-pty=' + require('node-pty/package.json').version);
  const pids = [];
  for (let cycle = 1; cycle <= 5; cycle++) {
    const arabic = 'مرحبا بالعربية';
    const script = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ' +
      "Write-Output '" + arabic + "'; Write-Output 'GATE_READY'; " +
      "$line = [Console]::ReadLine(); Write-Output ('INPUT=' + $line); " +
      "Write-Output ('WIDTH=' + $Host.UI.RawUI.WindowSize.Width); exit 7";
    const terminal = pty.spawn(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoLogo', '-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { name: 'xterm-256color', cols: 80, rows: 24, cwd: path.join(__dirname, '..'), env: process.env });
    active.add(terminal);
    pids.push(terminal.pid);
    console.log('SPAWN ' + JSON.stringify({ cycle, pid: terminal.pid }));
    let output = '';
    let written = false;
    const ended = new Promise((resolve) => terminal.onExit(resolve));
    terminal.onData((data) => {
      output += data;
      if (!written && output.includes('GATE_READY')) {
        written = true;
        terminal.resize(101, 31);
        terminal.write('gate-input-' + cycle + '\r');
      }
    });
    const exit = await ended;
    active.delete(terminal);
    console.log('CYCLE ' + JSON.stringify({ cycle, pid: terminal.pid, arabicExact: output.includes(arabic), written, cols: terminal.cols, rows: terminal.rows, exit, output }));
    await delay(500);
  }
  await delay(2000);
  console.log('PIDS ' + JSON.stringify(pids));
  const nativeFiles = Object.keys(require.cache).filter((file) => file.endsWith('.node'));
  for (const file of nativeFiles) console.log('NATIVE ' + JSON.stringify({ file, bytes: fs.statSync(file).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }));
  console.log('PTY_CYCLES_COMPLETE');
  app.exit(0);
}).catch((error) => {
  console.error('GATE_ERROR ' + (error.stack || error));
  for (const terminal of active) { try { terminal.kill(); } catch {} }
  app.exit(1);
});
