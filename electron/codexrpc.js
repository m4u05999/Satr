/**
 * عميل JSON-RPC قصير العمر لواجهات Codex الإدارية التي لا تحتاج دور محادثة حيّاً.
 */

const os = require('os');
const { spawn } = require('child_process');

const MAX_BUFFER = 4 * 1024 * 1024;

function queryCodex(bin, method, params, options = {}) {
  if (!bin || typeof method !== 'string') return Promise.reject(new Error('codex_unavailable'));
  const timeoutMs = Number.isInteger(options.timeoutMs) ? options.timeoutMs : 8000;
  const cwd = typeof options.cwd === 'string' && options.cwd ? options.cwd : os.homedir();

  return new Promise((resolve, reject) => {
    const proc = spawn(bin, ['app-server'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: process.env,
    });
    let buffer = '';
    let stderr = '';
    let settled = false;
    let initialized = false;

    const timer = setTimeout(() => finish(new Error('codex_rpc_timeout')), timeoutMs);

    function write(message) {
      try { proc.stdin.write(JSON.stringify(message) + '\n'); }
      catch { finish(new Error('codex_rpc_closed')); }
    }

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { proc.stdin.end(); } catch {}
      setTimeout(() => { try { proc.kill(); } catch {} }, 100);
      if (error) {
        if (stderr.trim() && !error.detail) error.detail = stderr.trim().slice(0, 1000);
        reject(error);
      } else resolve(value);
    }

    function handle(message) {
      if (message && message.method && message.id != null) {
        write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported one-shot client request' } });
        return;
      }
      if (!initialized && message && message.id === 1) {
        if (message.error) return finish(new Error(message.error.message || 'codex_initialize_failed'));
        initialized = true;
        write({ method: 'initialized', params: {} });
        write({ jsonrpc: '2.0', id: 2, method, params: params == null ? null : params });
        return;
      }
      if (message && message.id === 2) {
        if (message.error) return finish(new Error(message.error.message || 'codex_rpc_failed'));
        finish(null, message.result);
      }
    }

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > MAX_BUFFER) return finish(new Error('codex_rpc_response_too_large'));
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try { handle(JSON.parse(line)); } catch { /* يتجاهل سطراً غير صالح ولا يوسّع السطح */ }
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => { if (stderr.length < 4000) stderr += chunk; });
    proc.on('error', (error) => finish(error));
    proc.on('exit', (code) => {
      if (!settled) finish(new Error('codex_rpc_exit_' + code));
    });

    write({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'satr', title: 'Satr', version: '1.0.0' } },
    });
  });
}

module.exports = { queryCodex };
