#!/usr/bin/env node
'use strict';
/**
 * test:neterror — انقطاع الشبكة أثناء الدور (2026-09-13).
 *
 * قطعي بلا شبكة: (١) المصنّف يلتقط نصوص الأخطاء الفعلية من المحرّكات ويرفض غير الشبكي؛
 * (٢) `annotate` يُلحق `net` بنسخة لا بالأصل؛ (٣) المراقب يعلن الانقطاع مرة ثم العودة بمدتها
 * بمؤقّتات محقونة، ويستسلم معلناً بعد سقفه؛ (٤) حرس نصية على الوصلات: agent.js يطبّع api_retry
 * ويوسم الخروج التابع، وmain.js يصنّف في قُمع emit، والواجهة تستهلك الثلاثة (درس «يصل ولا يُستهلك»).
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const neterror = require(path.join(ROOT, 'electron', 'neterror.js'));
const connectivity = require(path.join(ROOT, 'electron', 'connectivity.js'));

let checks = 0;
function check(name, fn) {
  fn();
  checks++;
  console.log('  ✓ ' + name);
}

console.log('neterror — المصنّف');

check('نصّ Claude Code الفعلي (ENOTFOUND) ⇒ dns برمزه', () => {
  const cls = neterror.classify("API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)");
  assert.deepEqual(cls, { kind: 'dns', code: 'ENOTFOUND' });
});
check('«Can\'t reach the API server» بلا رمز ⇒ offline', () => {
  assert.deepEqual(neterror.classify("API Error: Can't reach the API server"), { kind: 'offline', code: 'OFFLINE' });
});
check('محوّل REST: «تعذّر الاتصال بـ Groq: getaddrinfo EAI_AGAIN api.groq.com» ⇒ dns', () => {
  assert.equal(neterror.classify('فشل طلب Groq: تعذّر الاتصال بـ Groq: getaddrinfo EAI_AGAIN api.groq.com').code, 'EAI_AGAIN');
});
check('fetch failed (undici) ⇒ offline', () => {
  assert.equal(neterror.classify('TypeError: fetch failed').kind, 'offline');
});
check('ECONNREFUSED ⇒ refused (مزوّد محلي)', () => {
  assert.equal(neterror.classify('connect ECONNREFUSED 127.0.0.1:11434').kind, 'refused');
});
check('ECONNRESET / socket hang up ⇒ reset', () => {
  assert.equal(neterror.classify('read ECONNRESET').kind, 'reset');
  assert.equal(neterror.classify('Error: socket hang up').kind, 'reset');
});
check('ETIMEDOUT ⇒ timeout', () => {
  assert.equal(neterror.classify('connect ETIMEDOUT 160.79.104.10:443').code, 'ETIMEDOUT');
});
check('كيمي (OBS-189) — نصّ الحصة لا يُصنَّف شبكة', () => {
  assert.equal(neterror.classify("Authentication required: 403 You've reached your 5-hour usage limit."), null);
});
check('أخطاء غير شبكية ⇒ null', () => {
  for (const t of ['Claude Code process exited with code 1', 'رفض المستخدم استخدام هذه الأداة',
    'Invalid API key · Please run /login', 'No conversation found with session ID', '', null, undefined, 42]) {
    assert.equal(neterror.classify(t), null, JSON.stringify(t));
  }
});
check('كائن خطأ بـmessage يُقبل', () => {
  assert.equal(neterror.classify(new Error('getaddrinfo ENOTFOUND api.anthropic.com')).code, 'ENOTFOUND');
});
check('الرسالة العربية تحمل اسم المحرك والرمز وتوجيه الإعادة', () => {
  const msg = neterror.messageFor({ kind: 'dns', code: 'ENOTFOUND' }, 'Claude Code');
  assert.match(msg, /Claude Code/);
  assert.match(msg, /ENOTFOUND/);
  assert.match(msg, /DNS/);
  assert.match(msg, /أعد المحاولة/);
  assert.doesNotMatch(msg, /مسجّل دخوله|مثبت/);
});

console.log('neterror — annotate');

check('result بخطأ شبكي ⇒ نسخة تحمل net والأصل بلا تغيير', () => {
  const original = { type: 'result', is_error: true, result: 'API Error: (ENOTFOUND)' };
  const out = neterror.annotate(original, 'Claude Code');
  assert.notEqual(out, original);
  assert.equal(original.net, undefined);
  assert.equal(out.net.code, 'ENOTFOUND');
  assert.equal(out.result, original.result);
});
check('result ناجح وspawn_error غير شبكي وأنواع أخرى تعود كما هي', () => {
  const ok = { type: 'result', is_error: false, result: 'ENOTFOUND mentioned in prose' };
  assert.equal(neterror.annotate(ok, 'x'), ok);
  const spawn = { type: 'spawn_error', text: 'Claude Code process exited with code 1' };
  assert.equal(neterror.annotate(spawn, 'x'), spawn);
  const other = { type: 'assistant', message: { content: [{ type: 'text', text: 'ENOTFOUND' }] } };
  assert.equal(neterror.annotate(other, 'x'), other);
});
check('api_retry يُلحق net من نصّ خطئه', () => {
  const out = neterror.annotate({ type: 'api_retry', attempt: 2, max_retries: 10, retry_delay_ms: 4000, error: 'Connection error. (ENOTFOUND)' }, 'Claude Code');
  assert.equal(out.net.code, 'ENOTFOUND');
});

console.log('connectivity — المراقب بمؤقّتات محقونة');

function fakeClock() {
  let t = 1_000_000;
  const timers = [];
  return {
    now: () => t,
    setTimer(fn, ms) { const h = { fn, at: t + ms, live: true }; timers.push(h); return h; },
    clearTimer(h) { if (h) h.live = false; },
    async advance(ms) {
      const target = t + ms;
      for (;;) {
        const due = timers.filter((h) => h.live && h.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        t = due.at; due.live = false;
        due.fn();
        await new Promise((r) => setImmediate(r)); // دع الوعود تُحسم
        await new Promise((r) => setImmediate(r));
      }
      t = target;
    },
  };
}

async function watcherScenario() {
  const clock = fakeClock();
  const events = [];
  let lookups = 0;
  let failuresLeft = 3;
  const watcher = connectivity.create({
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    intervalMs: 1000, maxMs: 60_000, hosts: ['a.example', 'b.example'],
    lookup: async () => { lookups++; if (failuresLeft > 0) { failuresLeft--; throw new Error('ENOTFOUND'); } return { address: '1.1.1.1' }; },
    onChange: (e) => events.push(e),
  });
  assert.equal(watcher.noteFailure({ code: 'ENOTFOUND', engine: 'sdk' }), true);
  assert.equal(watcher.noteFailure({ code: 'ENOTFOUND', engine: 'sdk' }), false, 'الاستدعاء الثاني لا يبدأ مراقبة ثانية');
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  // الفحص الأول: مضيفان فشلا ⇒ إعلان الانقطاع مرة واحدة
  assert.equal(events.length, 1);
  assert.equal(events[0].online, false);
  assert.equal(events[0].code, 'ENOTFOUND');
  assert.equal(events[0].engine, 'sdk');
  assert.equal(lookups, 2);
  // الفحص الثاني: المضيف الأول يفشل (آخر فشل) والثاني ينجح ⇒ عودة بمدة ثانية واحدة
  await clock.advance(1000);
  assert.equal(events.length, 2, 'لا تكرار لإعلان الانقطاع');
  assert.equal(events[1].online, true);
  assert.equal(events[1].recovered, true);
  assert.equal(events[1].downMs, 1000);
  assert.equal(watcher.isWatching(), false);
  await clock.advance(5000);
  assert.equal(events.length, 2, 'بعد العودة لا فحص ولا أحداث');
}

async function transientScenario() {
  const clock = fakeClock();
  const events = [];
  const watcher = connectivity.create({
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    lookup: async () => ({ address: '1.1.1.1' }), onChange: (e) => events.push(e),
  });
  watcher.noteFailure({ code: 'ECONNRESET', engine: 'codex' });
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  assert.equal(events.length, 1);
  assert.equal(events[0].online, true);
  assert.equal(events[0].recovered, false, 'شبكة سليمة عند الفحص الأول = خطأ عابر لا انقطاع');
  assert.equal(watcher.isWatching(), false);
}

async function gaveUpScenario() {
  const clock = fakeClock();
  const events = [];
  const watcher = connectivity.create({
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    intervalMs: 1000, maxMs: 3000,
    lookup: async () => { throw new Error('EAI_AGAIN'); }, onChange: (e) => events.push(e),
  });
  watcher.noteFailure({ code: 'EAI_AGAIN', engine: 'sdk' });
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  await clock.advance(10_000);
  const kinds = events.map((e) => (e.gaveUp ? 'gaveUp' : e.online ? 'online' : 'offline'));
  assert.deepEqual(kinds, ['offline', 'gaveUp'], 'انقطاع مرة ثم استسلام معلن — لا صمت ولا تكرار');
  assert.equal(events[1].downMs >= 3000, true);
  assert.equal(watcher.isWatching(), false);
  // بعد الاستسلام يجوز إيقاظه بخطأ جديد
  assert.equal(watcher.noteFailure({ code: 'EAI_AGAIN' }), true);
  watcher.stop();
}

console.log('حرس الوصلات (نصية)');

function guardSources() {
  const agent = fs.readFileSync(path.join(ROOT, 'electron', 'agent.js'), 'utf8');
  const main = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'app.js'), 'utf8');
  const chat = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'components', 'chat.js'), 'utf8');
  check('agent.js يطبّع system/api_retry إلى حدث api_retry', () => {
    assert.match(agent, /msg\.subtype === 'api_retry'\)\s*\{\s*emit\(apiRetryEvent\(msg\)\)/);
  });
  check('agent.js يوسم خروج Query بعد result بـexit_after_result', () => {
    assert.match(agent, /kind: 'exit_after_result'/);
    assert.match(agent, /resultEmitted = true;/);
  });
  check('main.js يصنّف في قُمع emit لكل المحرّكات ويوقظ المراقب', () => {
    assert.match(main, /neterror\.annotate\(obj, netEngineLabel\(runEngine\)\)/);
    assert.match(main, /connectivity\.noteFailure\(\{ code: obj\.net\.code, engine: runEngine \}\)/);
    assert.match(main, /require\('\.\/connectivity'\)\.create\(\{ onChange: \(event\) => emitToWindow\(event\) \}\)/);
  });
  check('الواجهة تستهلك connectivity وapi_retry وexit_after_result وnet', () => {
    assert.match(app, /ev\.type === 'connectivity'/);
    assert.match(app, /ev\.type === 'api_retry'/);
    assert.match(app, /ev\.kind === 'exit_after_result'/);
    assert.match(app, /ev\.net && ev\.net\.message/);
    assert.match(chat, /apiRetry\(ev\)/);
    assert.match(chat, /retry-note/);
  });
  check('test:neterror مسجّل في الطقم الكامل', () => {
    const suite = fs.readFileSync(path.join(ROOT, 'scripts', 'full-suite.js'), 'utf8');
    assert.match(suite, /'test:neterror'/);
  });
  check('لا محارف تحكّم خامة في apiRetryEvent (درس BOM الخام)', () => {
    const fnStart = agent.indexOf('function apiRetryEvent');
    const body = agent.slice(fnStart, agent.indexOf('\n}\n', fnStart));
    // الأسطر والمسافات مسموحة؛ المحظور محارف التحكم الخامة غير المرئية
    assert.equal(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body), false);
    assert.match(body, /\\u0000-\\u001f/);
  });
}

(async () => {
  await watcherScenario(); checks++; console.log('  ✓ انقطاع ثم عودة: إعلانان فقط ومدة صحيحة');
  await transientScenario(); checks++; console.log('  ✓ خطأ عابر وشبكة سليمة: عودة بلا إعلان انقطاع');
  await gaveUpScenario(); checks++; console.log('  ✓ استسلام معلن بعد السقف ويقبل إيقاظاً جديداً');
  guardSources();
  console.log('\nneterror: ' + checks + '/' + checks + ' ✓');
})().catch((e) => { console.error('✗ ' + (e && e.stack || e)); process.exit(1); });
