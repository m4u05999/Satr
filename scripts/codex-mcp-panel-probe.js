#!/usr/bin/env node
'use strict';

/**
 * مسبار حيّ للوحة موصّلات Codex (‏/موصلات) — الدفعة C3.
 *
 * مبدأ «المسبار أولاً»: نثبت عقد البروتوكول على codex-cli المثبّت فعلياً قبل بناء
 * الميزة. سلك خام: يشغّل `codex app-server` بنفسه ويتكلم JSON-RPC مباشرةً، فالنتيجة
 * توثّق عقد upstream مستقلاً عن تنفيذ «سطر».
 *
 * الطرق والأسماء كلها من الـschema المولّد من الثنائي (v2/) — لا تخمين:
 *   mcpServerStatus/list      → ListMcpServerStatusResponse { data: McpServerStatus[] }
 *   config/mcpServer/reload   → McpServerRefreshResponse (بلا حقول، params = null)
 *   mcpServer/oauth/login     → McpServerOauthLoginResponse { authorizationUrl }
 *   إشعارات: mcpServer/startupStatus/updated (starting|ready|failed|cancelled)
 *            mcpServer/oauthLogin/completed  { name, success, error? }
 *
 * **لا يفتح المسبار أي رابط مصادقة ولا يطبع قيمته** — يطبع حضوره وبنيته فقط.
 * حيّ (يشغّل خوادم MCP الحقيقية للمستخدم) فيبقى خارج test:full.
 * التشغيل: npm run test:codex-mcp-panel-probe
 */

const assert = require('assert');
const os = require('os');
const { spawn } = require('child_process');

const codex = require('../electron/codex');

const STARTUP_WAIT_MS = Number(process.env.SATR_CODEX_MCP_WAIT_MS || 25000);
const OAUTH_TIMEOUT_SECS = 5;

function openAppServer(bin, cwd) {
  const proc = spawn(bin, ['app-server'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const replies = new Map();
  const listeners = [];
  let reqId = 0;
  let buf = '';

  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && replies.has(msg.id)) {
        const pending = replies.get(msg.id);
        replies.delete(msg.id);
        if (msg.error) pending.reject(Object.assign(new Error(msg.error.message || 'rpc_error'), { rpc: msg.error }));
        else pending.resolve(msg.result);
        continue;
      }
      if (msg.id != null && msg.method) {
        try { proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unsupported' } }) + '\n'); } catch {}
        continue;
      }
      if (msg.method) for (const fn of listeners.slice()) { try { fn(msg.method, msg.params || {}); } catch {} }
    }
  });
  proc.stderr.on('data', () => {});

  function write(obj) { try { proc.stdin.write(JSON.stringify(obj) + '\n'); } catch {} }
  return {
    onNotification(fn) { listeners.push(fn); },
    request(method, params) {
      const id = ++reqId;
      return new Promise((resolve, reject) => {
        replies.set(id, { resolve, reject });
        write({ jsonrpc: '2.0', id, method, params: params === undefined ? {} : params });
      });
    },
    notify(method, params) { write({ method, params: params || {} }); },
    close() { try { proc.stdin.end(); } catch {} setTimeout(() => { try { proc.kill(); } catch {} }, 300); },
  };
}

async function main() {
  const bin = codex.resolveCodexBin();
  assert(bin, 'لم يُعثر على ثنائي codex — ثبّته: npm install -g @openai/codex');
  const cwd = os.homedir();
  const server = openAppServer(bin, cwd);
  const report = { ok: true };

  try {
    const startupEvents = [];
    const oauthCompleted = [];
    server.onNotification((method, params) => {
      if (method === 'mcpServer/startupStatus/updated') {
        startupEvents.push({
          name: String(params.name || ''),
          status: params.status,
          failureReason: params.failureReason || null,
          hasErrorText: typeof params.error === 'string' && params.error.length > 0,
        });
      }
      if (method === 'mcpServer/oauthLogin/completed') {
        oauthCompleted.push({
          name: String(params.name || ''), success: params.success === true,
          hasErrorText: typeof params.error === 'string' && params.error.length > 0,
        });
      }
    });

    await server.request('initialize', { clientInfo: { name: 'satr-mcp-probe', title: 'Satr', version: '1.0.0' } });
    server.notify('initialized', {});

    // ندع الخوادم تُقلع كي نلتقط حالات البدء الفعلية
    await new Promise((resolve) => setTimeout(resolve, STARTUP_WAIT_MS));

    // ---------- (1) mcpServerStatus/list ----------
    const listedAt = Date.now();
    const listed = await server.request('mcpServerStatus/list', {});
    const listMs = Date.now() - listedAt;
    const data = (listed && Array.isArray(listed.data)) ? listed.data : null;
    assert(data, 'لم يعد mcpServerStatus/list مصفوفة data');

    report.list = {
      elapsed_ms: listMs,
      server_count: data.length,
      has_next_cursor: listed.nextCursor != null,
      // نطبع البنية والحالات فقط (الأسماء عامة أصلاً في إعداد المستخدم)
      servers: data.map((s) => ({
        name: String(s.name || ''),
        authStatus: s.authStatus,
        tools: Array.isArray(s.tools) ? s.tools.length : null,
        resources: Array.isArray(s.resources) ? s.resources.length : null,
        resourceTemplates: Array.isArray(s.resourceTemplates) ? s.resourceTemplates.length : null,
        hasServerInfo: !!s.serverInfo,
        serverInfoKeys: s.serverInfo ? Object.keys(s.serverInfo).sort() : null,
      })),
      distinct_auth_status: Array.from(new Set(data.map((s) => s.authStatus))).sort(),
      // **حقيقة مهمة**: McpServerStatus في الـschema لا يحمل حقل status إطلاقاً
      entry_keys: Array.from(new Set(data.flatMap((s) => Object.keys(s)))).sort(),
      has_status_field: data.some((s) => 'status' in s),
    };

    // ---------- (1ب) هل يتغيّر الجرد مع detail صريح أو بعد بدء خيط؟ ----------
    const summarize = (rows) => (Array.isArray(rows) ? rows : []).map((s) => ({
      name: String(s.name || ''), authStatus: s.authStatus,
      toolsType: Array.isArray(s.tools) ? 'array:' + s.tools.length : (s.tools === null ? 'null' : typeof s.tools),
      resources: Array.isArray(s.resources) ? s.resources.length : null,
    }));
    const full = await server.request('mcpServerStatus/list', { detail: 'full' });
    const toolsOnly = await server.request('mcpServerStatus/list', { detail: 'toolsAndAuthOnly' });
    const startedThread = await server.request('thread/start', {
      cwd, approvalPolicy: 'on-request', sandbox: 'read-only',
      persistExtendedHistory: false, experimentalRawEvents: false,
    });
    const threadId = startedThread && startedThread.thread && startedThread.thread.id;
    await new Promise((resolve) => setTimeout(resolve, STARTUP_WAIT_MS));
    const afterThread = await server.request('mcpServerStatus/list', { detail: 'full', threadId });
    report.detail_variants = {
      default: summarize(data),
      full: summarize(full && full.data),
      toolsAndAuthOnly: summarize(toolsOnly && toolsOnly.data),
      after_thread_start: summarize(afterThread && afterThread.data),
      tools_ever_array: [full, toolsOnly, afterThread]
        .some((r) => (r && Array.isArray(r.data) ? r.data : []).some((s) => Array.isArray(s.tools))),
    };

    report.startup_notifications = {
      count: startupEvents.length,
      distinct_status: Array.from(new Set(startupEvents.map((e) => e.status))).sort(),
      distinct_failure_reason: Array.from(new Set(startupEvents.map((e) => e.failureReason).filter(Boolean))).sort(),
      any_error_text: startupEvents.some((e) => e.hasErrorText),
      events: startupEvents,
    };

    // ---------- (2) config/mcpServer/reload (params = null في الـschema) ----------
    let reloadResult = null;
    let reloadError = null;
    const reloadAt = Date.now();
    try { reloadResult = await server.request('config/mcpServer/reload', null); }
    catch (error) { reloadError = error.rpc || { message: String(error.message || error) }; }
    report.reload = {
      elapsed_ms: Date.now() - reloadAt,
      result: reloadResult,
      result_is_empty_object: reloadResult != null && typeof reloadResult === 'object'
        && Object.keys(reloadResult).length === 0,
      error: reloadError,
    };

    // ---------- (3) mcpServer/oauth/login على خادم يعلن حاجة المصادقة ----------
    const oauthCandidate = data.find((s) => s.authStatus === 'notLoggedIn')
      || data.find((s) => s.authStatus === 'oAuth');
    if (!oauthCandidate) {
      report.oauth = { attempted: false, reason: 'لا خادم يعلن notLoggedIn/oAuth في إعداد هذا الجهاز' };
    } else {
      const oauthAt = Date.now();
      let loginResult = null;
      let loginError = null;
      try {
        loginResult = await server.request('mcpServer/oauth/login', {
          name: oauthCandidate.name, timeoutSecs: OAUTH_TIMEOUT_SECS,
        });
      } catch (error) { loginError = error.rpc || { message: String(error.message || error) }; }
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const url = loginResult && loginResult.authorizationUrl;
      let urlScheme = null;
      try { if (typeof url === 'string') urlScheme = new URL(url).protocol; } catch { urlScheme = 'invalid'; }
      report.oauth = {
        attempted: true,
        server_auth_status: oauthCandidate.authStatus,
        elapsed_ms: Date.now() - oauthAt,
        // **لا نطبع الرابط** — حضوره وبنيته فقط
        returned_authorization_url: typeof url === 'string' && url.length > 0,
        authorization_url_scheme: urlScheme,
        response_keys: loginResult ? Object.keys(loginResult).sort() : null,
        error: loginError,
        completed_notifications: oauthCompleted,
      };
    }

    report.leak_check = {
      // حارس ذاتي: لا يحمل التقرير رابط مصادقة أو رمزاً
      report_has_http_url: /https?:\/\//.test(JSON.stringify(report)),
    };
    assert.strictEqual(report.leak_check.report_has_http_url, false,
      'تسرّب رابط إلى تقرير المسبار');

    console.log(JSON.stringify(report, null, 2));
  } finally {
    server.close();
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
