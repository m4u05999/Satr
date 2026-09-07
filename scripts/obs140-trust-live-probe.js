#!/usr/bin/env node
'use strict';

/**
 * مسبار OBS-140 (سبب افتراق النطاقين) — هل **ثقة مساحة العمل** هي المفتاح؟
 *
 * ⚠️ **مسبار حيّ خارج `test:full`**: يستهلك دورَي SDK حقيقيين.
 *
 * ## ما ثبت قبله
 *
 * - قاعدة `allow` في إعداد **المستخدم** تتخطّى `canUseTool` (‏`probe:obs140-user`).
 * - القاعدة نفسها في إعداد **المشروع** لا تتخطّاه (‏`probe:obs140`).
 * - و**الدمج يعامل النطاقين سواءً**: `resolveSettings` يُظهر `allow` من المشروع في
 *   `effective` تماماً كما من المستخدم، والمُصفّي الموثّق `filterEscalatingDefaultMode`
 *   يمسّ `defaultMode` وحده (‏`probe:obs140-scope`). ⇒ التصفية **بعد الدمج**.
 *
 * ## الفرضية هنا
 *
 * أن المُقيِّم يفرّق بـ**ثقة مساحة العمل**: مشروعٌ لم يُقبَل حوار ثقته تُهمَل قواعد
 * سماحه. والمفتاح موجود في `~/.claude.json` ⇒ `projects[<cwd>].hasTrustDialogAccepted`
 * (مرصود على جهاز المالك). فإن صار المشروع موثوقاً وتخطّت قاعدتُه المربعَ ⇒ **الثقة
 * هي المفتاح**؛ وإن لم تتخطَّ ⇒ الفرضية ساقطة والسبب شيء آخر.
 *
 * البيت معزول والاعتماد بـ**رابط صلب لا نسخة** — بعقد `obs140-user-settings-probe.js`.
 * ولا يُلمس `~/.claude.json` الحقيقي للمالك.
 *
 * التشغيل:  node scripts/obs140-trust-live-probe.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const MARKER = 'TRAP_TRUST.txt';
const REAL_HOME = process.env.SATR_OBS140_REAL_HOME || os.homedir();
const TURN_TIMEOUT_MS = 120000;

// ── العملية الابنة ───────────────────────────────────────────────────────────
async function runChild(workdir) {
  const { query } = require('@anthropic-ai/claude-agent-sdk');
  const calls = [];
  let writeAttempted = false;
  let toolResultText = '';

  let closeInput = null;
  const inputClosed = new Promise((r) => { closeInput = r; });
  async function* promptStream() {
    yield {
      type: 'user',
      message: {
        role: 'user',
        content: 'Use the Write tool to create the file at this exact absolute path: '
          + path.join(workdir, MARKER) + ' — with the exact content "trap". '
          + 'Do not use any other path. Do it now, without asking for confirmation.',
      },
      parent_tool_use_id: null,
      session_id: '',
    };
    await inputClosed;
  }

  const q = query({
    prompt: promptStream(),
    options: {
      cwd: workdir,
      model: 'haiku',
      permissionMode: 'default',
      settingSources: ['user', 'project', 'local'],
      canUseTool: async (toolName) => {
        calls.push(toolName);
        return { behavior: 'deny', message: 'OBS-140 trust probe: denied' };
      },
    },
  });

  const timer = setTimeout(() => { try { q.interrupt(); } catch (e) { /* تجاهل */ } }, TURN_TIMEOUT_MS);
  try {
    for await (const msg of q) {
      if (msg.type === 'assistant' && Array.isArray(msg.message && msg.message.content)) {
        for (const b of msg.message.content) {
          if (b && b.type === 'tool_use' && b.name === 'Write') writeAttempted = true;
        }
      }
      if (msg.type === 'user' && Array.isArray(msg.message && msg.message.content)) {
        for (const b of msg.message.content) {
          if (b && b.type === 'tool_result') {
            const c = b.content;
            toolResultText += (typeof c === 'string' ? c
              : Array.isArray(c) ? c.map((p) => (p && p.text) || '').join(' ') : '') + ' ';
          }
        }
      }
      if (msg.type === 'result') break;
    }
  } finally {
    clearTimeout(timer);
    closeInput();
    try { await q.close?.(); } catch (e) { /* تجاهل */ }
  }

  return {
    homeSeenByChild: os.homedir(),
    canUseToolCalls: calls.length,
    canUseToolTools: [...new Set(calls)],
    writeAttempted,
    markerExists: fs.existsSync(path.join(workdir, MARKER)),
    writeSucceededPerToolResult: /File created successfully/i.test(toolResultText),
  };
}

const idx = process.argv.indexOf('--child');
if (idx !== -1) {
  runChild(process.argv[idx + 1])
    .then((r) => { console.log('__RESULT__' + JSON.stringify(r)); process.exit(0); })
    .catch((e) => { console.log('__RESULT__' + JSON.stringify({ error: String((e && e.message) || e) })); process.exit(1); });
  return;
}

// ── العملية الأمّ ─────────────────────────────────────────────────────────────
const out = { ok: true, scenarios: {} };
out.sdkVersion = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), 'utf8',
)).version;

for (const trusted of [false, true]) {
  const name = trusted ? 'project-allow-trusted' : 'project-allow-untrusted';
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'obs140-trust-home-'));
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs140-trust-work-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });

  // رابط صلب للاعتماد — لا نسخ؛ وفشلُه يوقف المشهد ولا يسقط إلى النسخ.
  const realCred = path.join(REAL_HOME, '.claude', '.credentials.json');
  let credential = 'absent';
  if (fs.existsSync(realCred)) {
    try {
      fs.linkSync(realCred, path.join(home, '.claude', '.credentials.json'));
      credential = 'hardlink';
    } catch (e) { credential = 'link_failed:' + ((e && e.code) || 'unknown'); }
  }
  if (String(credential).startsWith('link_failed')) {
    out.scenarios[name] = { skipped: true, reason: credential };
    continue;
  }

  // القاعدة في **المشروع** لا في البيت — هذا محلّ القياس.
  fs.mkdirSync(path.join(workdir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(workdir, '.claude', 'settings.json'),
    JSON.stringify({ permissions: { allow: ['Write'] } }, null, 2));

  // وسم الثقة في `~/.claude.json` المعزول — المتغيّر الوحيد بين المشهدين.
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify(
    trusted ? { projects: { [workdir]: { hasTrustDialogAccepted: true } } } : { projects: {} },
    null, 2));

  // إعادة حتى تقع محاولة Write: النموذج غير حتمي، وخليةٌ بلا محاولة **فارغةٌ لا
  // سالبة**. وقع ذلك فعلاً في أوّل تشغيل لهذا المسبار — الخليتان فارغتان معاً.
  const MAX_ATTEMPTS = 4;
  let res = null;
  let parsed = null;
  let attempts = 0;
  while (attempts < MAX_ATTEMPTS) {
    attempts += 1;
    res = spawnSync(process.execPath, [__filename, '--child', workdir], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home, SATR_OBS140_REAL_HOME: REAL_HOME },
      timeout: TURN_TIMEOUT_MS + 60000,
    });
    const line = String(res.stdout || '').split('\n').find((l) => l.startsWith('__RESULT__'));
    try { parsed = JSON.parse(line.slice('__RESULT__'.length)); } catch (e) { parsed = null; }
    if (parsed && parsed.writeAttempted === true) break;
    // ملفٌّ ربما كُتب في محاولة سابقة يُزال كي لا تُقرأ بقيّةٌ قديمة أثراً جديداً.
    try { fs.rmSync(path.join(workdir, MARKER), { force: true }); } catch (e) { /* أفضل جهد */ }
  }
  out.scenarios[name] = {
    trusted,
    credential,
    childExit: res && res.status,
    attemptsUsed: attempts,
    ...(parsed || { error: 'تعذّر تحليل خرج الابن', stderrTail: String((res && res.stderr) || '').slice(-300) }),
  };

  try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) { /* أفضل جهد */ }
  try { fs.rmSync(workdir, { recursive: true, force: true }); } catch (e) { /* أفضل جهد */ }
}

const un = out.scenarios['project-allow-untrusted'] || {};
const tr = out.scenarios['project-allow-trusted'] || {};
const shadowed = (c) => c.canUseToolCalls === 0
  && (c.markerExists === true || c.writeSucceededPerToolResult === true);

out.verdict = {
  bothAttempted: un.writeAttempted === true && tr.writeAttempted === true,
  untrustedShadowed: shadowed(un),
  trustedShadowed: shadowed(tr),
};
out.verdict.trustIsTheKey = out.verdict.bothAttempted
  && out.verdict.untrustedShadowed === false && out.verdict.trustedShadowed === true;
out.verdict.note = !out.verdict.bothAttempted
  ? '⚠️ لا يُبنى على هذا حكم: لم يحاول النموذج Write في أحد المشهدين — خليةٌ فارغة لا سالبة.'
  : out.verdict.trustIsTheKey
    ? 'ثقة مساحة العمل هي المفتاح: قاعدة المشروع تُطاع بعد وسم الثقة ولا تُطاع قبله.'
    : out.verdict.trustedShadowed === false && out.verdict.untrustedShadowed === false
      ? 'الفرضية ساقطة: الثقة لا تُغيّر شيئاً — قاعدة المشروع لا تتخطّى المربع في الحالتين.'
      : 'نتيجة غير متوقّعة — تُقرأ الحقول أعلاه ولا تُلخَّص.';

console.log(JSON.stringify(out, null, 2));
process.exit(0);
