#!/usr/bin/env node
'use strict';

/**
 * اختبار قطعي لحساب Codex واستهلاكه (الدفعة C4). بلا شبكة وبلا codex حقيقي: نستبدل
 * الثنائي بـ node عبر CODEX_BIN ونشغّل fixture باسم `app-server` داخل cwd (نمط
 * codex-contract-test.js المثبّت).
 *
 * يغطي:
 *  - تطبيع account/usage/read وaccount/rateLimits/read إلى عقد عام مغلق.
 *  - **عدم تسريب رابط تسجيل الدخول أو loginId من قناة البدء** (قائمة سماح {ok,id}).
 *  - تحقق الرابط fail-closed بـsafeOauthUrl قبل أي فتح.
 *  - دورة الدخول: نجاح، رفض، إلغاء، رابط غير آمن، وبلا رابط.
 *  - عدم قراءة ~/.codex/auth.json وعدم مرور أي token/بريد في أي رد أو رسالة خطأ.
 *  - التدهور الرشيق برسالة عربية بلا نص خطأ upstream الخام.
 *  - ثبات مجموعة أنواع satr:event (الدفعة لا تضيف نوعاً).
 */

const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const AUTH_URL = 'https://auth.openai.com/authorize?client_id=abc&state=xyz';
const LOGIN_ID = '019f9300-0000-7000-8000-00000000abcd';
const UPSTREAM_LEAK = 'usage exploded: bearer eyJhbGciOiJIUzI1NiJ9.SECRET token=sk-ant-api03-AAAABBBB';

function fixtureSource() {
  return String.raw`'use strict';
const fs = require('fs');
const readline = require('readline');
const mode = process.env.SATR_CODEX_ACCT_MODE || 'ok';
function send(v) { process.stdout.write(JSON.stringify(v) + '\n'); }
function reply(id, r) { send({ jsonrpc: '2.0', id, result: r }); }
function fail(id, m) { send({ jsonrpc: '2.0', id, error: { code: -32600, message: m } }); }
function log(v) { fs.appendFileSync(process.env.SATR_CODEX_ACCT_LOG, JSON.stringify(v) + '\n', 'utf8'); }
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') { reply(m.id, { userAgent: 'fixture' }); return; }
  if (m.method === 'initialized') return;

  if (m.method === 'account/usage/read') {
    log({ type: 'usage', params: m.params === undefined ? 'undefined' : m.params });
    if (mode === 'usage_fail') { fail(m.id, process.env.SATR_CODEX_ACCT_LEAK); return; }
    if (mode === 'usage_empty') { reply(m.id, {}); return; }
    reply(m.id, {
      summary: { lifetimeTokens: 2900081886, peakDailyTokens: 218627916, currentStreakDays: 16,
        longestStreakDays: 16, longestRunningTurnSec: 6379 },
      dailyUsageBuckets: [
        { startDate: '2026-07-01', tokens: 10 },
        { startDate: '2026-07-02', tokens: 20 },
        { startDate: '2026-07-03', tokens: 'bad' },
      ],
    });
    return;
  }

  if (m.method === 'account/rateLimits/read') {
    log({ type: 'limits', params: m.params === undefined ? 'undefined' : m.params });
    if (mode === 'limits_fail') { fail(m.id, process.env.SATR_CODEX_ACCT_LEAK); return; }
    if (mode === 'limits_empty') { reply(m.id, {}); return; }
    reply(m.id, {
      rateLimits: {
        planType: 'prolite', limitId: 'codex', limitName: null, individualLimit: null,
        rateLimitReachedType: null, secondary: null,
        primary: { usedPercent: 12.4, windowDurationMins: 10080, resetsAt: 1785629852 },
        credits: { hasCredits: false, unlimited: false, balance: '0' },
      },
      rateLimitResetCredits: { availableCount: 1, credits: [{ id: 'c1' }] },
      rateLimitsByLimitId: { codex: { planType: 'prolite' } },
    });
    return;
  }

  if (m.method === 'account/login/start') {
    log({ type: 'login_start', params: m.params });
    if (mode === 'login_nourl') { reply(m.id, { type: 'chatgpt', loginId: process.env.SATR_CODEX_ACCT_LOGIN_ID }); return; }
    if (mode === 'login_badurl') {
      reply(m.id, { type: 'chatgpt', loginId: process.env.SATR_CODEX_ACCT_LOGIN_ID, authUrl: 'http://evil.example.com/cb' });
      return;
    }
    if (mode === 'login_fail') { fail(m.id, process.env.SATR_CODEX_ACCT_LEAK); return; }
    reply(m.id, { type: 'chatgpt', loginId: process.env.SATR_CODEX_ACCT_LOGIN_ID,
      authUrl: process.env.SATR_CODEX_ACCT_AUTH_URL });
    if (mode === 'login_ok') {
      setTimeout(() => send({ jsonrpc: '2.0', method: 'account/login/completed',
        params: { success: true, loginId: process.env.SATR_CODEX_ACCT_LOGIN_ID } }), 150);
    }
    if (mode === 'login_denied') {
      setTimeout(() => send({ jsonrpc: '2.0', method: 'account/login/completed',
        params: { success: false, loginId: process.env.SATR_CODEX_ACCT_LOGIN_ID,
          error: 'denied: token=sk-ant-api03-ZZZZYYYY' } }), 150);
    }
    return;
  }

  if (m.method === 'account/login/cancel') { log({ type: 'login_cancel', params: m.params }); reply(m.id, { status: 'canceled' }); return; }
});
`;
}

const readLog = async (file) => {
  let raw = '';
  try { raw = await fs.readFile(file, 'utf8'); } catch { return []; }
  return raw.trim() ? raw.trim().split(/\r?\n/).map(JSON.parse) : [];
};

const noSecrets = (value, label) => {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  assert(!/https?:\/\//.test(s), 'تسرّب رابط في ' + label + ': ' + s.slice(0, 200));
  assert(!/(sk-|eyJ|Bearer )/.test(s), 'تسرّب رمز في ' + label + ': ' + s.slice(0, 200));
  assert(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(s), 'تسرّب بريد في ' + label);
};

// ---------- تطبيع حدود الاستهلاك (نقي) ----------
function testNormalizeLimits(codex) {
  const n = codex.normalizeRateLimits;
  assert.strictEqual(n(null), null, 'null');
  assert.strictEqual(n({}), null, 'بلا rateLimits');
  assert.strictEqual(n({ rateLimits: null }), null, 'rateLimits null');
  const out = n({
    rateLimits: {
      planType: 'prolite', limitName: null, rateLimitReachedType: null, secondary: null,
      primary: { usedPercent: 12.4, windowDurationMins: 10080, resetsAt: 1785629852 },
      credits: { hasCredits: false, unlimited: false, balance: '0' },
    },
    rateLimitResetCredits: { availableCount: 1 },
  });
  assert.strictEqual(out.planType, 'prolite', 'planType');
  assert.strictEqual(out.primary.usedPercent, 12, 'تقريب usedPercent');
  assert.strictEqual(out.primary.windowDurationMins, 10080, 'مدة النافذة');
  assert.strictEqual(out.secondary, null, 'secondary غائبة');
  assert.strictEqual(out.credits.balance, '0', 'balance نص كما يعلنه upstream');
  assert.strictEqual(out.resetCredits, 1, 'رصيد إعادة الضبط');
  // القصّ والحدود
  const clamped = n({ rateLimits: { primary: { usedPercent: 999 } } });
  assert.strictEqual(clamped.primary.usedPercent, 100, 'قصّ النسبة عند 100');
  const negative = n({ rateLimits: { primary: { usedPercent: -5 } } });
  assert.strictEqual(negative.primary.usedPercent, 0, 'قصّ النسبة عند 0');
  const noPct = n({ rateLimits: { primary: { windowDurationMins: 10 } } });
  assert.strictEqual(noPct.primary, null, 'نافذة بلا usedPercent تُسقَط');
  // حقول غير معلنة لا تعبر
  assert.deepStrictEqual(Object.keys(out).sort(),
    ['credits', 'limitName', 'planType', 'primary', 'reachedType', 'resetCredits', 'secondary'],
    'حقول غير معلنة في تطبيع الحدود: ' + Object.keys(out).join(','));
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'satr-codex-acct-'));
  const project = path.join(root, 'project');
  const logFile = path.join(root, 'acct.jsonl');
  try {
    await fs.mkdir(project);
    await fs.writeFile(path.join(project, 'app-server'), fixtureSource(), 'utf8');
    process.env.CODEX_BIN = process.execPath;
    process.env.SATR_CODEX_ACCT_LOG = logFile;
    process.env.SATR_CODEX_ACCT_AUTH_URL = AUTH_URL;
    process.env.SATR_CODEX_ACCT_LOGIN_ID = LOGIN_ID;
    process.env.SATR_CODEX_ACCT_LEAK = UPSTREAM_LEAK;
    delete require.cache[require.resolve('../electron/codex')];
    const codex = require('../electron/codex');
    codex.resolveCodexBin(true);

    testNormalizeLimits(codex);

    // ---------- (1) الاستهلاك ----------
    process.env.SATR_CODEX_ACCT_MODE = 'ok';
    const usage = await codex.accountUsage(project);
    assert.strictEqual(usage.ok, true, 'فشل accountUsage: ' + JSON.stringify(usage));
    assert.deepStrictEqual(Object.keys(usage.usage).sort(),
      ['currentStreakDays', 'lifetimeTokens', 'longestRunningTurnSec', 'longestStreakDays',
        'peakDailyTokens', 'recentDays', 'recentTokens'],
      'حقول غير معلنة في الاستهلاك: ' + Object.keys(usage.usage).join(','));
    assert.strictEqual(usage.usage.lifetimeTokens, 2900081886, 'الإجمالي التراكمي');
    assert.strictEqual(usage.usage.recentDays, 2, 'الحاوية ذات الرموز غير الرقمية تُسقَط');
    assert.strictEqual(usage.usage.recentTokens, 30, 'مجموع الرموز الحديثة');
    noSecrets(usage, 'accountUsage');
    // params = null كما يوجب الـschema
    const usageLog = (await readLog(logFile)).find((r) => r.type === 'usage');
    assert(usageLog, 'لم يُستدعَ account/usage/read');
    assert.strictEqual(usageLog.params, null, 'params ليست null');

    // ---------- (2) الحدود عبر السلك ----------
    const limits = await codex.accountRateLimits(project);
    assert.strictEqual(limits.ok, true, 'فشل accountRateLimits: ' + JSON.stringify(limits));
    assert.strictEqual(limits.limits.primary.usedPercent, 12, 'نسبة النافذة');
    assert.strictEqual(limits.limits.planType, 'prolite', 'الخطة');
    noSecrets(limits, 'accountRateLimits');
    const limitsLog = (await readLog(logFile)).find((r) => r.type === 'limits');
    assert.strictEqual(limitsLog.params, null, 'params الحدود ليست null');

    // ---------- (3) التدهور الرشيق بلا نص upstream خام ----------
    for (const [mode, call, label] of [
      ['usage_fail', () => codex.accountUsage(project), 'usage_fail'],
      ['usage_empty', () => codex.accountUsage(), 'usage_empty'],
      ['limits_fail', () => codex.accountRateLimits(project), 'limits_fail'],
      ['limits_empty', () => codex.accountRateLimits(), 'limits_empty'],
    ]) {
      process.env.SATR_CODEX_ACCT_MODE = mode;
      const r = await call();
      assert.strictEqual(r.ok, false, 'نجح رغم ' + label);
      assert(typeof r.error === 'string' && /[؀-ۿ]/.test(r.error), 'رسالة غير عربية في ' + label);
      assert(!r.error.includes('exploded'), 'تسرّب نص upstream في ' + label);
      noSecrets(r, label);
    }

    // ---------- (4) دورة تسجيل الدخول: النجاح ----------
    await fs.writeFile(logFile, '', 'utf8');
    process.env.SATR_CODEX_ACCT_MODE = 'login_ok';
    const started = await codex.accountLoginStart(project);
    assert.strictEqual(started.ok, true, 'فشل بدء الدخول: ' + JSON.stringify(started));
    assert.deepStrictEqual(Object.keys(started).sort(), ['id', 'ok'],
      'قناة البدء تعيد حقولاً زائدة: ' + Object.keys(started).join(','));
    assert(/^cxlogin_[0-9]+_[a-z0-9]+$/.test(started.id), 'صيغة المعرّف: ' + started.id);
    // **فحص صريح لعدم تسريب الرابط أو loginId من قناة البدء**
    noSecrets(started, 'accountLoginStart');
    assert(!JSON.stringify(started).includes(LOGIN_ID), 'تسرّب loginId الداخلي من قناة البدء');
    assert(!JSON.stringify(started).includes('auth.openai.com'), 'تسرّب مضيف الرابط من قناة البدء');
    // main.js وحدها تقرأ الرابط، وبعد تحقق fail-closed
    assert.strictEqual(codex.accountLoginUrl(started.id), AUTH_URL, 'main.js لا يقرأ الرابط');
    const startLog = (await readLog(logFile)).find((r) => r.type === 'login_start');
    assert.deepStrictEqual(startLog.params, { type: 'chatgpt' }, 'حقول account/login/start');
    const done = await codex.accountLoginAwait(started.id, 5000);
    assert.deepStrictEqual(done, { ok: true, success: true }, 'نتيجة الاكتمال: ' + JSON.stringify(done));
    assert.strictEqual(codex.accountLoginUrl(started.id), null, 'بقي الرابط بعد الحسم');

    // ---------- (5) الرفض: لا يتسرّب نص خطأ upstream ----------
    process.env.SATR_CODEX_ACCT_MODE = 'login_denied';
    const denied = await codex.accountLoginStart(project);
    assert.strictEqual(denied.ok, true, 'فشل بدء الدخول (denied)');
    const deniedDone = await codex.accountLoginAwait(denied.id, 5000);
    assert.strictEqual(deniedDone.ok, true, 'لم يصل إشعار الرفض');
    assert.strictEqual(deniedDone.success, false, 'اعتُبر الرفض نجاحاً');
    assert.deepStrictEqual(Object.keys(deniedDone).sort(), ['ok', 'success'],
      'حقول زائدة في نتيجة الرفض: ' + Object.keys(deniedDone).join(','));
    noSecrets(deniedDone, 'login_denied');

    // ---------- (6) الإلغاء يُسقط الطلب ويلغيه لدى Codex ----------
    await fs.writeFile(logFile, '', 'utf8');
    process.env.SATR_CODEX_ACCT_MODE = 'login_ok';
    const toCancel = await codex.accountLoginStart(project);
    assert.strictEqual(typeof codex.accountLoginUrl(toCancel.id), 'string', 'لا رابط قبل الإلغاء');
    codex.accountLoginCancel(toCancel.id);
    assert.strictEqual(codex.accountLoginUrl(toCancel.id), null, 'بقي الرابط بعد الإلغاء');
    const afterCancel = await codex.accountLoginAwait(toCancel.id, 1000);
    assert.strictEqual(afterCancel.ok, false, 'انتظار طلب ملغى نجح');
    await new Promise((resolve) => setTimeout(resolve, 500));
    const cancelLog = (await readLog(logFile)).find((r) => r.type === 'login_cancel');
    assert(cancelLog, 'لم يُرسل account/login/cancel إلى Codex عند الإلغاء');
    assert.deepStrictEqual(cancelLog.params, { loginId: LOGIN_ID }, 'حقول الإلغاء');

    // ---------- (7) رابط غير آمن أو غائب أو فشل ⇒ fail-closed ----------
    process.env.SATR_CODEX_ACCT_MODE = 'login_badurl';
    const bad = await codex.accountLoginStart(project);
    assert.strictEqual(bad.ok, true, 'بدء الدخول برابط غير آمن');
    assert.strictEqual(codex.accountLoginUrl(bad.id), null, 'أُعيد رابط http خارجي غير آمن');
    codex.accountLoginCancel(bad.id);

    process.env.SATR_CODEX_ACCT_MODE = 'login_nourl';
    const noUrl = await codex.accountLoginStart(project);
    assert.strictEqual(noUrl.ok, false, 'نجح البدء بلا رابط');
    assert(!('id' in noUrl), 'أُعيد معرّف طلب بلا رابط');

    process.env.SATR_CODEX_ACCT_MODE = 'login_fail';
    const loginFail = await codex.accountLoginStart(project);
    assert.strictEqual(loginFail.ok, false, 'نجح البدء رغم خطأ upstream');
    assert(!loginFail.error.includes('exploded'), 'تسرّب نص upstream من البدء');
    noSecrets(loginFail, 'login_fail');

    // معرّف مجهول لا يعيد رابطاً ولا ينتظر
    assert.strictEqual(codex.accountLoginUrl('cxlogin_9999_zzzz'), null, 'معرّف مجهول أعاد رابطاً');
    const unknown = await codex.accountLoginAwait('cxlogin_9999_zzzz', 500);
    assert.strictEqual(unknown.ok, false, 'انتظار معرّف مجهول نجح');

    // ---------- (8) عقود main.js وpreload وثبات الأحداث ----------
    const mainSrc = await fs.readFile(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
    assert(/const SAFE_CODEX_LOGIN_ID = \/\^cxlogin_/.test(mainSrc), 'حارس معرّف الدخول مفقود');
    assert(/return \{ ok: true, id: started\.id \};/.test(mainSrc),
      'قناة بدء الدخول لا تقتصر على المعرّف');
    assert(/const url = codex\.accountLoginUrl\(p\.id\);/.test(mainSrc), 'الفتح لا يقرأ الرابط داخلياً');
    assert(/if \(!url\) \{ codex\.accountLoginCancel\(p\.id\); return \{ ok: false, error: 'bad_url' \}; \}/.test(mainSrc),
      'الفتح لا يفشل مغلقاً عند رابط غير صالح');
    // main.js لا يقرأ حقل authUrl الخام ولا يمرّره (يقرأ الرابط عبر accountLoginUrl فقط).
    // ملاحظة: `safeOauthUrl` تحوي «authUrl» كسلسلة فرعية، فنطابق الاستعمال الفعلي للحقل.
    assert(!/\.authUrl|authUrl\s*:/.test(mainSrc), 'main.js يلمس حقل authUrl الخام');
    const preloadSrc = await fs.readFile(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8');
    for (const name of ['codexUsage', 'codexLimits', 'codexLoginStart', 'codexLoginOpen', 'codexLoginCancel']) {
      assert(new RegExp(name + ':').test(preloadSrc), 'preload لا يكشف ' + name);
    }
    assert(/codexLoginOpen: \(id\) => ipcRenderer\.invoke\('satr:codexLoginOpen', \{ id \}\)/.test(preloadSrc),
      'preload يمرّر أكثر من المعرّف للفتح');

    // auth.json لا يُقرأ في مسار C4 (authStatus القائم يبقى احتياطاً لـaccountStatus)
    const codexSrc = await fs.readFile(path.join(__dirname, '..', 'electron', 'codex.js'), 'utf8');
    // نحدّ الكتلة بدقّة: من ترويسة C4 إلى آخر دوالها (accountLoginCancel)، كي لا تلتقط
    // المطابقة تعليقاً يذكر auth.json أو readFileSync في أقسام أخرى من الملف.
    const c4Start = codexSrc.indexOf('حساب Codex واستهلاكه (C4)');
    const c4End = codexSrc.indexOf('function accountLoginCancel(id)');
    assert(c4Start > 0 && c4End > c4Start, 'تعذّر تحديد كتلة C4');
    const c4Block = codexSrc.slice(c4Start, c4End);
    assert(!/path\.join\([^)]*auth/.test(c4Block), 'مسار C4 يبني مسار auth.json');
    assert(!/readFileSync|readFile\(/.test(c4Block), 'مسار C4 يقرأ ملفاً من القرص');
    assert(!/OPENAI_API_KEY|id_token|access_token|accessToken/.test(c4Block),
      'مسار C4 يلمس حقول اعتماد');

    // الدفعة لا تضيف نوع حدث جديد إلى satr:event
    const emitTypes = new Set();
    const emitRe = /emit\(\{\s*type:\s*'([a-z_]+)'/g;
    for (let hit = emitRe.exec(codexSrc); hit; hit = emitRe.exec(codexSrc)) emitTypes.add(hit[1]);
    assert(emitTypes.size > 0, 'تعذّر استخراج أنواع الأحداث من codex.js');
    const known = new Set(['system', 'assistant', 'user', 'result', 'stream_text', 'permission_request',
      'question_request', 'file_edit', 'task_update', 'usage_update', 'rate_limits', 'stderr',
      'spawn_error', 'proc_done', 'preview_open', 'handoff_request', 'handoff_end', 'testsprite_progress']);
    for (const t of emitTypes) assert(known.has(t), 'نوع حدث جديد أضافته الدفعة: ' + t);

    console.log('codex-account: نجح — تطبيع الاستهلاك والحدود، حجب رابط الدخول وloginId،'
      + ' fail-closed للرابط، والتدهور الرشيق بلا تسريب upstream أو auth.json.');
  } finally {
    delete process.env.CODEX_BIN;
    delete process.env.SATR_CODEX_ACCT_LOG;
    delete process.env.SATR_CODEX_ACCT_MODE;
    delete process.env.SATR_CODEX_ACCT_AUTH_URL;
    delete process.env.SATR_CODEX_ACCT_LOGIN_ID;
    delete process.env.SATR_CODEX_ACCT_LEAK;
    // جلسات app-server العابرة تُغلق بـstdin.end ثم kill — نمهلها كي لا يقع EBUSY (درس C3)
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
      .catch(() => { /* التنظيف أفضل جهد */ });
  }
}

main().catch((error) => { console.error(error && error.stack || error); process.exitCode = 1; });
