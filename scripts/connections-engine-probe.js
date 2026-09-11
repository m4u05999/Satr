#!/usr/bin/env node
'use strict';

// محرك Codex المثبت فعلاً، مع طرف HTTP اصطناعي عبر نقل الخدمة الإنتاجي.
// لا يثبت حساب خدمة حياً أو DPAPI؛ يثبت مسار المحرك والجسر والمنع عند التنفيذ.
// خارج test:full: كل مرحلة تستهلك دوراً حقيقياً من اشتراك المحرك.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const connections = require('../electron/connections');
const { createServices } = require('../electron/connection-services');
const codex = require('../electron/codex');

const ROOT = path.resolve(__dirname, '..');
const PHASES = ['allowed', 'forbidden', 'expired', 'disconnected', 'other_project', 'write_denied'];
const MODEL = process.env.SATR_CONNECTIONS_PROBE_MODEL || 'gpt-5.6-sol';
const TIMEOUT_MS = 180000;
const ALLOWED = 'satr-fixture/allowed';
const FORBIDDEN = 'satr-fixture/other';

function fakeEncryption() {
  const key = crypto.randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(text) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      return Buffer.concat([iv, cipher.update(text, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    },
    decryptString(bytes) {
      const cipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString('utf8');
    },
  };
}

async function runPhase(phase, cwd, token) {
  const names = new Map();
  const results = [];
  const permissions = [];
  const waiting = [];
  let handle;
  let finish;
  let timedOut = false;
  let resultError = false;
  let leaked = false;
  let doneSeen = false;
  let diagnostics = 0;
  const done = new Promise((resolve) => { finish = resolve; });
  const request = { service: 'github', resource: phase === 'forbidden' ? FORBIDDEN : ALLOWED,
    action: phase === 'write_denied' ? 'create_issue' : 'inspect' };
  if (phase === 'write_denied') request.params = { title: 'Satr synthetic permission probe', body: 'Synthetic service fixture only.' };
  const prompt = [
    'اختبار توصيلات حتمي ومصرح به. الخدمة طرف تجريبي، والمحرك هو الحقيقي. لا تقرأ الملفات ولا تستخدم shell أو المتصفح أو أي أدوات أخرى.',
    'استخدم فقط أدوات خادم satr_preview المدمج: list_project_connections وuse_project_connection.',
    ...(phase === 'allowed' ? ['استدع list_project_connections مرة واحدة أولاً.'] : []),
    'ثم استدع use_project_connection مرة واحدة بهذه الوسائط حرفياً: ' + JSON.stringify(request),
    'المرحلة تختبر النجاح أو رفض مورد أو انتهاء مصادقة؛ محاولة الاستدعاء ذاتها هي الاختبار. لا تتخطها باستنتاج من القائمة أو بكتابة جواب نصي.',
    'إذا رُفض المورد أو الإذن أو المصادقة فلا تعاود المحاولة ولا تطلب حساباً أو رمزاً؛ أنهِ الدور بعد نتيجة الأداة. لا تنفذ أي فعل بديل.',
    'بعد استلام نتيجة الأداة أجب بكلمة تم فقط.',
  ].join('\n');
  const timer = setTimeout(() => {
    timedOut = true;
    if (handle) void handle.stop().catch(() => {});
    finish();
  }, TIMEOUT_MS);
  try {
    handle = await codex.start({ prompt, images: [], sessionId: null, model: MODEL,
      permissionMode: 'bypassPermissions', skills: [], effort: 'low', browserControl: null }, cwd, (event) => {
      // تقرير الاختبار يحتفظ بمؤشرات فقط؛ لا يطبع المحادثة أو stdout الخام.
      if (JSON.stringify(event).includes(token)) leaked = true;
      if (event.type === 'stderr' || event.type === 'spawn_error') diagnostics += 1;
      if (event.type === 'permission_request') {
        permissions.push(String(event.tool || '').slice(0, 100));
        if (handle) handle.resolvePermission(event.id, false, false);
        else waiting.push(event.id);
      }
      if (event.type === 'assistant' && event.message && Array.isArray(event.message.content)) {
        for (const block of event.message.content) {
          if (block && block.type === 'tool_use') names.set(block.id, String(block.name || ''));
        }
      }
      if (event.type === 'user' && event.message && Array.isArray(event.message.content)) {
        for (const block of event.message.content) {
          if (!block || block.type !== 'tool_result') continue;
          const name = names.get(block.tool_use_id) || '';
          if (!/^satr_preview:(?:list_project_connections|use_project_connection)$/.test(name)) continue;
          let payload = null;
          try { payload = JSON.parse(String(block.content || '')); } catch {}
          results.push({ name: name.split(':')[1], payload });
        }
      }
      if (event.type === 'result') resultError = !!event.is_error;
      if (event.type === 'proc_done') { doneSeen = true; finish(); }
    });
    for (const id of waiting) handle.resolvePermission(id, false, false);
    await done;
    assert.equal(timedOut, false, 'engine_phase_timeout');
    assert.equal(resultError, false, 'engine_turn_failed');
    assert.equal(leaked, false, 'synthetic_token_leaked_to_engine_events');
    const used = results.filter((entry) => entry.name === 'use_project_connection');
    assert.equal(used.length, 1, 'expected_one_real_connection_tool_result');
    assert(used[0].payload && typeof used[0].payload.ok === 'boolean', 'missing_structured_connection_result');
    if (phase === 'allowed') {
      assert(results.some((entry) => entry.name === 'list_project_connections' && entry.payload && entry.payload.ok), 'missing_real_list_result');
    }
    assert(permissions.every((name) => name === 'use_project_connection'), 'unexpected_engine_permission');
    const summary = { phase, tool_results: results.length, ok: used[0].payload.ok,
      error: used[0].payload.error || null, permission_requests: permissions.length, diagnostic_events: diagnostics };
    return { summary, payload: used[0].payload };
  } finally {
    clearTimeout(timer);
    if (handle && !doneSeen) await handle.stop().catch(() => {});
  }
}

async function main() {
  const argument = process.argv.slice(2).find((item) => item.startsWith('--phase='));
  const selected = argument ? [argument.slice(8)] : PHASES;
  assert(selected.every((phase) => PHASES.includes(phase)), 'bad_phase');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-connections-engine-'));
  const project = path.join(temp, 'project-a');
  const otherProject = path.join(temp, 'project-b');
  fs.mkdirSync(project); fs.mkdirSync(otherProject);
  const token = 'synthetic-' + crypto.randomBytes(24).toString('hex');
  const calls = [];
  let expired = false;
  const services = createServices({ fetchImpl: async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer ' + token, 'missing_service_authorization');
    assert.equal(options.redirect, 'error', 'unsafe_service_redirect');
    const endpoint = new URL(url);
    assert.equal(endpoint.origin, 'https://api.github.com', 'unexpected_service_origin');
    calls.push({ path: endpoint.pathname, method: options.method });
    if (expired) return new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } });
    let value;
    if (endpoint.pathname === '/user') value = { id: 17, login: 'satr-fixture' };
    else if (endpoint.pathname.startsWith('/repos/')) {
      const fullName = endpoint.pathname.slice('/repos/'.length);
      assert([ALLOWED, FORBIDDEN].includes(fullName), 'unexpected_service_endpoint');
      value = { id: fullName === ALLOWED ? 101 : 102, full_name: fullName, name: fullName.split('/')[1],
        private: true, default_branch: 'main', html_url: 'https://github.com/' + fullName };
    } else throw new Error('unexpected_service_endpoint');
    return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
  } });
  const manager = connections.createManager({ storeDir: path.join(temp, 'store'), safeStorage: fakeEncryption(), services });
  const originalGetManager = connections.getManager;
  connections.getManager = () => manager; // عملية المسبار وحدها؛ لا منفذ اختبار في الإنتاج.
  const report = { ok: false, date: new Date().toISOString(), engine: 'codex', model: MODEL,
    service_transport: 'injected-fetch-production-services', encryption: 'synthetic-aes-gcm-not-dpapi',
    live_service_account: false, phases: [] };
  const reportPath = path.join(ROOT, 'dist', 'connections-engine-probe' + (argument ? '-' + selected[0] : '') + '.json');
  try {
    const bin = codex.resolveCodexBin();
    assert(bin, 'codex_not_installed');
    const version = spawnSync(bin, ['--version'], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
    const versionMatch = /codex-cli\s+([0-9.]+)/.exec(version.stdout || '');
    report.cli_version = versionMatch ? versionMatch[1] : 'unknown';
    for (const phase of selected) {
      process.stdout.write('PHASE ' + phase + ' START\n');
      expired = false;
      assert((await manager.authenticate(project, 'github', token)).ok, 'fixture_auth_failed');
      assert((await manager.select(project, 'github', ALLOWED, ['read', 'write'])).ok, 'fixture_selection_failed');
      const previousUse = (await manager.list(project, 'codex')).services.find((entry) => entry.id === 'github').lastEngineUse;
      if (phase === 'expired') expired = true;
      if (phase === 'disconnected') assert((await manager.disconnect(project, 'github')).ok, 'fixture_disconnect_failed');
      const before = calls.length;
      const observed = await runPhase(phase, phase === 'other_project' ? otherProject : project, token);
      const delta = calls.slice(before);
      const state = (await manager.list(project, 'codex')).services.find((entry) => entry.id === 'github');
      if (phase === 'allowed') {
        assert.equal(observed.payload.ok, true, 'allowed_resource_failed');
        assert.equal(delta.length, 1, 'expected_one_allowed_service_request');
        assert.equal(delta[0].path, '/repos/' + ALLOWED, 'wrong_allowed_service_resource');
        assert.equal(state.lastEngineUse.engine, 'codex', 'missing_engine_use_receipt');
      } else {
        const expected = { forbidden: 'bad_resource', expired: 'needs_auth', disconnected: 'not_connected',
          other_project: 'not_connected', write_denied: 'permission_denied' }[phase];
        assert.equal(observed.payload.error, expected, 'unexpected_connection_rejection');
        assert.equal(delta.length, phase === 'expired' ? 1 : 0, 'blocked_action_reached_service');
        assert.deepEqual(state.lastEngineUse, previousUse, 'failed_use_recorded_success');
        if (phase === 'expired') assert.equal(state.authStatus, 'needs-auth', 'expiration_not_visible');
      }
      assert.equal(observed.summary.permission_requests, phase === 'write_denied' ? 1 : 0, 'wrong_explicit_permission_count');
      report.phases.push({ ...observed.summary, service_requests: delta.length, assertions_passed: true });
      process.stdout.write('PHASE ' + phase + ' PASS\n');
    }
    report.ok = true;
  } catch (error) {
    report.failure = String(error && error.message || 'probe_failed').split(token).join('[redacted]').slice(0, 500);
    process.exitCode = 1;
  } finally {
    connections.getManager = originalGetManager;
    // نطاق الحذف مثبت من mkdtemp وتحت TEMP حصراً. التنظيف غير متزامن حتى يعمل
    // مؤقت إنهاء app-server؛ rmSync كان يحبس المؤقت فتفشل إزالة cwd على Windows.
    try {
      const resolved = path.resolve(temp);
      assert.equal(path.dirname(resolved).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase(), 'unsafe_cleanup_path');
      assert(path.basename(resolved).startsWith('satr-connections-engine-'), 'unsafe_cleanup_name');
      await fs.promises.rm(resolved, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
      report.cleanup = 'completed';
    } catch (error) {
      report.ok = false;
      report.cleanup = 'failed';
      report.failure = 'probe_cleanup_failed';
      report.cleanup_code = ['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(error && error.code) ? error.code : 'unknown';
      process.exitCode = 1;
    }
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
    process.stdout.write('REPORT ' + path.relative(ROOT, reportPath) + '\n');
    process.stdout.write(report.ok ? 'PASS\n' : 'FAIL ' + report.failure + '\n');
  }
}

main().catch(() => { process.stderr.write('PROBE_FATAL\n'); process.exitCode = 1; });
