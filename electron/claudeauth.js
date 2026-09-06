'use strict';

const { spawn } = require('child_process');

function spawnCommand(command, args, options) {
  // ملف exe يُشغَّل مباشرةً؛ أما cmd والاسم المجرّد فيحتاجان صدفة ويندوز.
  // المسار الداخل إلى الصدفة يُقتبس لأن Node يربط الأمر والوسائط بلا اقتباس له.
  const useShell = process.platform === 'win32' && !/\.exe$/i.test(command.trim());
  const safeCommand = useShell && /[\\/\s]/.test(command) ? `"${command}"` : command;
  return spawn(safeCommand, args, {
    ...options,
    shell: useShell,
  });
}

// دالة إنتاج مشتركة مع بوابة أول التشغيل، ومصدّرة للحارس القطعي كي يشغّلها نفسها.
function probeVersion(command, args) {
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    const finish = (result) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    let child;
    try {
      child = spawnCommand(command, args, { windowsHide: true });
    } catch {
      return finish({ ok: false });
    }
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.on('error', () => finish({ ok: false }));
    child.on('close', (code) => finish(code === 0
      ? { ok: true, version: output.trim() }
      : { ok: false }));
    // حماية: بعض الأوامر قد تتعلّق — لا نُبقي البوابة منتظرة للأبد
    timer = setTimeout(() => { try { child.kill(); } catch {} finish({ ok: false }); }, 8000);
  });
}

function parseStatus(output) {
  try {
    const value = JSON.parse(String(output || '').trim());
    if (!value || typeof value !== 'object' || typeof value.loggedIn !== 'boolean') return null;
    const safeText = (text) => typeof text === 'string' ? text.slice(0, 64) : '';
    return {
      checked: true,
      loggedIn: value.loggedIn,
      authMethod: safeText(value.authMethod),
      apiProvider: safeText(value.apiProvider),
    };
  } catch {
    return null;
  }
}

function probe(command, options) {
  const settings = options && typeof options === 'object' ? options : {};
  const env = settings.env || process.env;
  if (env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN) {
    return Promise.resolve({ checked: true, loggedIn: true, authMethod: 'environment', apiProvider: '' });
  }
  if (typeof command !== 'string' || !command.trim()) {
    return Promise.resolve({ checked: false, loggedIn: null, authMethod: '', apiProvider: '' });
  }
  return new Promise((resolve) => {
    let done = false;
    let output = '';
    let timer = null;
    const finish = (result) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(result || { checked: false, loggedIn: null, authMethod: '', apiProvider: '' });
    };
    let child;
    try {
      child = spawnCommand(command, ['auth', 'status'], { windowsHide: true, env });
    } catch {
      finish();
      return;
    }
    child.stdout.on('data', (chunk) => {
      if (output.length < 65536) output += chunk.toString('utf8').slice(0, 65536 - output.length);
    });
    child.on('error', () => finish());
    child.on('close', () => finish(parseStatus(output)));
    const timeoutMs = Number.isInteger(settings.timeoutMs) && settings.timeoutMs >= 100
      ? settings.timeoutMs : 8000;
    timer = setTimeout(() => { try { child.kill(); } catch {} finish(); }, timeoutMs);
  });
}

module.exports = { parseStatus, probe, probeVersion };
