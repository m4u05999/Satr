#!/usr/bin/env node
'use strict';

/**
 * مسبار حيّ لحساب Codex واستهلاكه (الدفعة C4) — سلك خام بنمط codex-mcp-panel-probe.
 *
 * مبدأ «المسبار أولاً»: نثبت عقد البروتوكول على codex-cli المثبّت فعلياً قبل بناء
 * الميزة. الطرق والأسماء كلها من الـschema المولّد من الثنائي (v2/) — لا تخمين:
 *   account/read            → GetAccountResponse { requiresOpenaiAuth, account? }
 *   account/usage/read      → GetAccountTokenUsageResponse { summary, dailyUsageBuckets? }
 *   account/rateLimits/read → GetAccountRateLimitsResponse { rateLimits, ... }
 *   account/login/start     → LoginAccountResponse (اتحاد موسوم؛ chatgpt ⇒ authUrl+loginId)
 *   account/login/cancel    → CancelLoginAccountResponse { status: canceled|notFound }
 *   إشعار account/login/completed → { success, loginId?, error? }
 *
 * **سلامة الاعتماد القائم**: المسبار يبدأ دورة تسجيل دخول ثم **يلغيها فوراً**، ولا
 * يكمل OAuth ولا يفتح متصفحاً. ولا يطبع رابط المصادقة ولا أي حقل هوية (بريد/معرّف
 * حساب/رمز) — البنية والأطوال والحضور فقط.
 *
 * حيّ فيبقى خارج test:full. التشغيل: npm run test:codex-account-probe
 */

const assert = require('assert');
const os = require('os');
const { spawn } = require('child_process');

const codex = require('../electron/codex');

const CANCEL_AFTER_MS = 1500;

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
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && replies.has(msg.id)) {
        const pending = replies.get(msg.id); replies.delete(msg.id);
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
  const write = (obj) => { try { proc.stdin.write(JSON.stringify(obj) + '\n'); } catch {} };
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
    close() { try { proc.stdin.end(); } catch {} setTimeout(() => { try { proc.kill(); } catch {} }, 200); },
  };
}

// وصف بنيوي بلا قيم: نوع الحقل وطوله فقط (لا بريد ولا معرّف حساب ولا رمز)
function shapeOf(value, depth) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array[' + value.length + ']'
    + (value.length && depth > 0 ? '<' + shapeOf(value[0], depth - 1) + '>' : '');
  const t = typeof value;
  if (t === 'string') return 'string(' + value.length + ')';
  if (t === 'number') return Number.isInteger(value) ? 'int' : 'float';
  if (t === 'boolean') return 'bool';
  if (t === 'object') {
    if (depth <= 0) return 'object{' + Object.keys(value).length + '}';
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = shapeOf(value[k], depth - 1);
    return out;
  }
  return t;
}

async function main() {
  const bin = codex.resolveCodexBin();
  assert(bin, 'لم يُعثر على ثنائي codex — ثبّته: npm install -g @openai/codex');
  const server = openAppServer(bin, os.homedir());
  const report = { ok: true };
  try {
    const loginCompleted = [];
    const accountUpdated = [];
    const rateLimitNotifications = [];
    server.onNotification((method, params) => {
      if (method === 'account/login/completed') {
        loginCompleted.push({
          success: params.success === true,
          hasLoginId: typeof params.loginId === 'string' && params.loginId.length > 0,
          hasErrorText: typeof params.error === 'string' && params.error.length > 0,
        });
      }
      if (method === 'account/updated') accountUpdated.push(Object.keys(params).sort());
      if (method === 'account/rateLimits/updated') rateLimitNotifications.push(Object.keys(params).sort());
    });

    await server.request('initialize', { clientInfo: { name: 'satr-account-probe', title: 'Satr', version: '1.0.0' } });
    server.notify('initialized', {});

    // ---------- (1) account/read ----------
    const readAt = Date.now();
    const account = await server.request('account/read', { refreshToken: false });
    report.account_read = {
      elapsed_ms: Date.now() - readAt,
      top_keys: Object.keys(account || {}).sort(),
      requiresOpenaiAuth: account && account.requiresOpenaiAuth,
      has_account: !!(account && account.account),
      account_keys: account && account.account ? Object.keys(account.account).sort() : null,
      account_type: account && account.account ? account.account.type : null,
      plan_type_present: !!(account && account.account && account.account.planType),
      shape: shapeOf(account, 3),
    };

    // ---------- (2) account/usage/read (params = null في الـschema) ----------
    let usage = null;
    let usageError = null;
    const usageAt = Date.now();
    try { usage = await server.request('account/usage/read', null); }
    catch (error) { usageError = error.rpc || { message: String(error.message || error) }; }
    report.usage_read = {
      elapsed_ms: Date.now() - usageAt,
      error: usageError,
      top_keys: usage ? Object.keys(usage).sort() : null,
      summary_keys: usage && usage.summary ? Object.keys(usage.summary).sort() : null,
      summary_shape: usage && usage.summary ? shapeOf(usage.summary, 2) : null,
      daily_buckets: usage && Array.isArray(usage.dailyUsageBuckets) ? usage.dailyUsageBuckets.length : null,
      bucket_keys: usage && Array.isArray(usage.dailyUsageBuckets) && usage.dailyUsageBuckets[0]
        ? Object.keys(usage.dailyUsageBuckets[0]).sort() : null,
      // القيم العددية العامة (استهلاك رموز — ليست هوية)
      lifetimeTokens_type: usage && usage.summary ? typeof usage.summary.lifetimeTokens : null,
    };

    // ---------- (3) account/rateLimits/read ----------
    let limits = null;
    let limitsError = null;
    const limitsAt = Date.now();
    try { limits = await server.request('account/rateLimits/read', null); }
    catch (error) { limitsError = error.rpc || { message: String(error.message || error) }; }
    const snapshot = limits && limits.rateLimits;
    report.rate_limits_read = {
      elapsed_ms: Date.now() - limitsAt,
      error: limitsError,
      top_keys: limits ? Object.keys(limits).sort() : null,
      snapshot_keys: snapshot ? Object.keys(snapshot).sort() : null,
      planType: snapshot ? snapshot.planType : null,
      has_primary: !!(snapshot && snapshot.primary),
      has_secondary: !!(snapshot && snapshot.secondary),
      primary_keys: snapshot && snapshot.primary ? Object.keys(snapshot.primary).sort() : null,
      primary_usedPercent_type: snapshot && snapshot.primary ? typeof snapshot.primary.usedPercent : null,
      reset_credits_keys: limits && limits.rateLimitResetCredits
        ? Object.keys(limits.rateLimitResetCredits).sort() : null,
      shape: shapeOf(limits, 3),
    };

    // ---------- (4) دورة تسجيل الدخول فوق اعتماد قائم ثم إلغاؤها ----------
    // لا نكمل OAuth ولا نفتح متصفحاً ولا نطبع الرابط — الحضور والبنية فقط.
    let login = null;
    let loginError = null;
    const loginAt = Date.now();
    try {
      login = await server.request('account/login/start', { type: 'chatgpt' });
    } catch (error) { loginError = error.rpc || { message: String(error.message || error) }; }
    const authUrl = login && typeof login.authUrl === 'string' ? login.authUrl : '';
    let urlProtocol = null;
    let urlHost = null;
    try { if (authUrl) { const u = new URL(authUrl); urlProtocol = u.protocol; urlHost = u.hostname; } }
    catch { urlProtocol = 'invalid'; }
    report.login_start = {
      elapsed_ms: Date.now() - loginAt,
      error: loginError,
      // مهم: البدء فوق اعتماد قائم — هل يرفض أم يبدأ دورة جديدة؟
      accepted_while_logged_in: !!login && !loginError,
      response_keys: login ? Object.keys(login).sort() : null,
      response_type: login ? login.type : null,
      has_login_id: !!(login && typeof login.loginId === 'string' && login.loginId.length > 0),
      login_id_length: login && typeof login.loginId === 'string' ? login.loginId.length : null,
      returned_auth_url: authUrl.length > 0,
      auth_url_protocol: urlProtocol,
      auth_url_host_is_openai: urlHost ? /(^|\.)openai\.com$|(^|\.)chatgpt\.com$/.test(urlHost) : null,
      auth_url_length: authUrl.length || null,
      // هل يقبله حارس «سطر» fail-closed (safeOauthUrl من C3)؟
      passes_satr_url_guard: authUrl ? codex.safeOauthUrl(authUrl) === authUrl : null,
    };

    await new Promise((resolve) => setTimeout(resolve, CANCEL_AFTER_MS));

    let cancel = null;
    let cancelError = null;
    if (login && typeof login.loginId === 'string') {
      const cancelAt = Date.now();
      try { cancel = await server.request('account/login/cancel', { loginId: login.loginId }); }
      catch (error) { cancelError = error.rpc || { message: String(error.message || error) }; }
      report.login_cancel = {
        elapsed_ms: Date.now() - cancelAt,
        error: cancelError,
        status: cancel ? cancel.status : null,
        response_keys: cancel ? Object.keys(cancel).sort() : null,
      };
      // إلغاء معرّف مجهول — سلوك الحد
      let unknown = null;
      try { unknown = await server.request('account/login/cancel', { loginId: 'satr-probe-unknown-login-id' }); }
      catch (error) { unknown = { error: (error.rpc && error.rpc.code) || 'threw' }; }
      report.login_cancel_unknown = unknown;
    } else {
      report.login_cancel = { skipped: 'لم يُعِد البدء loginId' };
    }

    await new Promise((resolve) => setTimeout(resolve, 800));
    report.notifications = {
      login_completed: loginCompleted,
      account_updated_key_sets: accountUpdated,
      rate_limits_updated_key_sets: rateLimitNotifications,
    };

    // ---------- (5) الاعتماد القائم لم يتأثر ----------
    const after = await server.request('account/read', { refreshToken: false });
    report.credentials_intact = {
      still_has_account: !!(after && after.account),
      same_account_type: !!(after && after.account) && !!(account && account.account)
        && after.account.type === account.account.type,
      requiresOpenaiAuth_after: after && after.requiresOpenaiAuth,
    };
    assert.strictEqual(report.credentials_intact.still_has_account, true,
      'أفسد المسبار الاعتماد القائم — راجع فوراً');

    // حارس ذاتي: لا رابط ولا رمز ولا بريد في التقرير
    const serialized = JSON.stringify(report);
    report.leak_check = {
      report_has_url: /https?:\/\//.test(serialized),
      report_has_at_sign: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/.test(serialized),
      report_has_bearer_like: /\b(sk-|eyJ|Bearer )/.test(serialized),
    };
    assert.strictEqual(report.leak_check.report_has_url, false, 'تسرّب رابط إلى التقرير');
    assert.strictEqual(report.leak_check.report_has_at_sign, false, 'تسرّب بريد إلى التقرير');
    assert.strictEqual(report.leak_check.report_has_bearer_like, false, 'تسرّب رمز إلى التقرير');

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
