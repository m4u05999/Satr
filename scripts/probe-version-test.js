#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const claudeauth = require('../electron/claudeauth');

function makeFixtureRoot() {
  const tempRoot = path.resolve(os.tmpdir());
  const candidates = [tempRoot, path.parse(tempRoot).root, path.resolve(process.cwd())];
  for (const candidate of candidates) {
    if (/\s/.test(candidate)) continue;
    try {
      return fs.mkdtempSync(path.join(candidate, 'obs130-'));
    } catch {}
  }
  throw new Error('probe-version-test: لم يُعثر على جذر مؤقت قابل للكتابة بلا مسافات');
}

function removeFixtureRoot(root) {
  const resolved = path.resolve(root);
  const base = path.basename(resolved);
  if (!base.startsWith('obs130-') || resolved === path.parse(resolved).root) {
    throw new Error('probe-version-test: رُفض تنظيف مسار fixture غير متوقّع');
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

function buildFixtures(dir) {
  fs.mkdirSync(dir, { recursive: true });

  const exe = path.join(dir, 'fixture.exe');
  const exeScript = path.join(dir, 'fixture-exe.js');
  fs.copyFileSync(process.execPath, exe);
  fs.writeFileSync(exeScript, "process.stdout.write('fixture-exe');\n", 'utf8');

  const cmd = path.join(dir, 'fixture.cmd');
  const cmdSource = process.platform === 'win32'
    ? '@echo off\r\necho fixture-cmd\r\n'
    : '#!/bin/sh\nprintf "fixture-cmd\\n"\n';
  fs.writeFileSync(cmd, cmdSource, 'utf8');

  if (process.platform !== 'win32') {
    fs.chmodSync(exe, 0o755);
    fs.chmodSync(cmd, 0o755);
  }
  return { exe, exeScript, cmd };
}

async function main() {
  const root = makeFixtureRoot();
  try {
    const plainDir = path.join(root, 'plain');
    const spacedDir = path.join(root, 'Program Files');
    const plain = buildFixtures(plainDir);
    const spaced = buildFixtures(spacedDir);
    const cases = [
      { label: '.cmd داخل مسار بلا مسافة', command: plain.cmd, args: ['--version'], expected: 'fixture-cmd' },
      { label: '.exe داخل مسار بلا مسافة', command: plain.exe, args: [plain.exeScript], expected: 'fixture-exe' },
      { label: '.cmd داخل مسار بمسافة', command: spaced.cmd, args: ['--version'], expected: 'fixture-cmd' },
      { label: '.exe داخل مسار بمسافة', command: spaced.exe, args: [spaced.exeScript], expected: 'fixture-exe' },
    ];
    const failures = [];
    for (const item of cases) {
      const result = await claudeauth.probeVersion(item.command, item.args);
      if (!result.ok || result.version !== item.expected) {
        failures.push(`${item.label}: ${JSON.stringify(result)}`);
      }
    }
    const projectRoot = path.resolve(__dirname, '..');
    const mainSource = fs.readFileSync(path.join(projectRoot, 'electron', 'main.js'), 'utf8');
    const authSource = fs.readFileSync(path.join(projectRoot, 'electron', 'claudeauth.js'), 'utf8');
    if (!mainSource.includes('const probeVersion = claudeauth.probeVersion;')) {
      failures.push('main.js لا يستعمل probeVersion المصدّرة');
    }
    if (!authSource.includes("spawnCommand(command, ['auth', 'status']")) {
      failures.push('claudeauth.probe لا يستعمل مشغّل الأوامر المشترك');
    }
    if (failures.length) {
      throw new Error(`probe-version-test: FAIL — ${failures.join(' · ')}`);
    }
    console.log('probe-version-test: نجح — .cmd و.exe في مسارين بلا مسافة وبمسافة عبر دالة الإنتاج نفسها.');
  } finally {
    removeFixtureRoot(root);
  }
}

main().catch((error) => {
  console.error(error && error.message ? error.message : error);
  process.exitCode = 1;
});
