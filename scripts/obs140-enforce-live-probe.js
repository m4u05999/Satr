#!/usr/bin/env node
'use strict';

/**
 * مسبار OBS-140 (الإنفاذ) — هل يستعيد **مسار الإنتاج** مربعَ الإذن فعلاً؟
 *
 * ⚠️ **مسبار حيّ خارج `test:full`**: يستهلك دورَي SDK حقيقيين.
 *
 * المسابير السابقة قاست العطل ثم قاست أن خطّاف `PreToolUse` يعالجه — لكن بخطّافٍ
 * كتبه المسبار. هذا يقيس **`electron/agent.js` نفسه**: يُستدعى `agent.start()` ببيت
 * معزول فيه قاعدة سماح، ويُرصد هل يصل `permission_request` (مربع الإذن) وهل مُنعت
 * الكتابة. فحصٌ ساكن على المصدر يثبت وجود سطر؛ هذا يثبت **أن السطر يعضّ**.
 *
 * البيت المعزول والرابط الصلب للاعتماد بعقد `obs140-user-settings-probe.js` نفسه:
 * لا يُلمس بيت المالك، ولا تُنسَخ بايتات السرّ.
 *
 * التشغيل:  node scripts/obs140-enforce-live-probe.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const MARKER = 'TRAP_ENFORCE.txt';
const REAL_HOME = process.env.SATR_OBS140_REAL_HOME || os.homedir();
const TURN_TIMEOUT_MS = 120000;

function buildHome(permissions) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'obs140-enf-home-'));
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const realCred = path.join(REAL_HOME, '.claude', '.credentials.json');
  let credential = 'absent';
  if (fs.existsSync(realCred)) {
    try {
      fs.linkSync(realCred, path.join(claudeDir, '.credentials.json'));
      credential = 'hardlink';
    } catch (e) { credential = 'link_failed:' + ((e && e.code) || 'unknown'); }
  }
  if (permissions) {
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ permissions }, null, 2));
  }
  return { home, credential };
}

// ── العملية الابنة: تشغّل agent.start() الإنتاجي ─────────────────────────────
async function runChild(workdirFromParent) {
  const agent = require(path.join(__dirname, '..', 'electron', 'agent.js'));
  // مجلد العمل يأتي من الأمّ حين يزرع المشهد ملفاً داخله (النطاق المحلي)؛ وإلا يُنشأ هنا.
  const workdir = workdirFromParent || fs.mkdtempSync(path.join(os.tmpdir(), 'obs140-enf-work-'));
  const events = [];
  const permissionTools = [];
  const attemptedTools = [];
  let writeAttempted = false;
  let handle = null;

  const emit = (ev) => {
    if (!ev || typeof ev !== 'object') return;
    events.push(ev.type);
    // ⭐ هل حاول النموذجُ الأداةَ أصلاً؟ بدونه لا يُفرَّق بين «مُنع» و«لم يُحاوَل»،
    // والثانية خليةٌ فارغة لا سالبة (الدرس نفسه من مسبار إعدادات المستخدم).
    if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
      for (const b of ev.message.content) {
        if (b && b.type === 'tool_use') {
          attemptedTools.push(String(b.name || ''));
          if (b.name === 'Write') writeAttempted = true;
        }
      }
    }
    if (ev.type === 'permission_request') {
      permissionTools.push(String(ev.tool || ''));
      // الرفض هو الدليل: إن وصل المربع فُقد الفعل ولم يُكتب الملف.
      try { handle.resolvePermission(ev.id, false, false, false); } catch (e) { /* تجاهل */ }
    }
  };

  handle = await agent.start({
    prompt: 'Use the Write tool to create the file at this exact absolute path: '
      + path.join(workdir, MARKER) + ' — with the exact content "trap". '
      + 'Do not use any other path. Do it now, without asking for confirmation.',
    images: [],
    sessionId: null,
    model: 'haiku',
    permissionMode: 'default',
    skills: [],
    effort: '',
    extraDirs: [],
    browserControl: false,
  }, workdir, emit);

  await Promise.race([
    handle.done,
    new Promise((r) => setTimeout(r, TURN_TIMEOUT_MS)),
  ]).catch(() => {});
  try { await handle.stop(); } catch (e) { /* تجاهل */ }

  const markerExists = fs.existsSync(path.join(workdir, MARKER));
  try { fs.rmSync(workdir, { recursive: true, force: true }); } catch (e) { /* أفضل جهد */ }
  return {
    homeSeenByChild: os.homedir(),
    permissionRequests: permissionTools.length,
    attemptedTools,
    writeAttempted,
    permissionTools: [...new Set(permissionTools)],
    markerExists,
    sawFileEdit: events.includes('file_edit'),
  };
}

const argv = process.argv.slice(2);
if (argv.includes('--child')) {
  const wdFlag = argv.indexOf('--workdir');
  runChild(wdFlag === -1 ? null : argv[wdFlag + 1])
    .then((r) => { console.log('__RESULT__' + JSON.stringify({ ok: true, ...r })); process.exit(0); })
    .catch((e) => { console.log('__RESULT__' + JSON.stringify({ ok: false, error: String((e && e.message) || e) })); process.exit(1); });
  return;
}

// ── العملية الأمّ ─────────────────────────────────────────────────────────────
const out = { ok: true, scenarios: {} };
const before = fs.existsSync(path.join(REAL_HOME, '.claude', 'settings.json'))
  ? fs.statSync(path.join(REAL_HOME, '.claude', 'settings.json')).mtimeMs : null;

for (const [name, permissions, scope] of [
  ['allow-write', { allow: ['Write'] }, 'user'],  // القاعدة التي أثبت الفخّ أنها كانت تُظلّل
  // النطاق الثاني المقيس مُظلِّلاً — وناقلُه **خارجي**: ملفٌّ يصل مع المشروع نفسه.
  ['local-allow-write', { allow: ['Write'] }, 'local'],
  ['no-settings', null, 'user'],                  // شاهد سالب: المربع يعمل كالمعتاد
]) {
  const built = buildHome(scope === 'user' ? permissions : null);
  if (String(built.credential).startsWith('link_failed')) {
    out.scenarios[name] = { skipped: true, reason: built.credential };
    continue;
  }
  // إعادة حتى تقع محاولة Write — النموذج غير حتمي، وخليةٌ بلا محاولة **فارغةٌ لا
  // سالبة**: لا تفرّق بين «مُنع» و«لم يُحاوَل». السقف معلن، وما بقي بلا محاولة
  // يظهر في `writeAttempted:false` فلا يُقرأ نجاحاً.
  const MAX_ATTEMPTS = 3;
  let res = null;
  let parsed = null;
  let attempts = 0;
  while (attempts < MAX_ATTEMPTS) {
    attempts += 1;
    // مجلد عمل جديد لكل محاولة، وفيه ملفُّ النطاق المحلي إن كان المشهد يقيسه.
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs140-enf-work-'));
    if (scope === 'local') {
      fs.mkdirSync(path.join(workdir, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(workdir, '.claude', 'settings.local.json'),
        JSON.stringify({ permissions }, null, 2), 'utf8');
    }
    res = spawnSync(process.execPath, [__filename, '--child', '--workdir', workdir], {
      encoding: 'utf8',
      env: { ...process.env, HOME: built.home, USERPROFILE: built.home, SATR_OBS140_REAL_HOME: REAL_HOME },
      timeout: TURN_TIMEOUT_MS + 60000,
    });
    const line = String(res.stdout || '').split('\n').find((l) => l.startsWith('__RESULT__'));
    try { parsed = JSON.parse(line.slice('__RESULT__'.length)); } catch (e) { parsed = null; }
    try { fs.rmSync(workdir, { recursive: true, force: true }); } catch (e) { /* أفضل جهد */ }
    if (parsed && parsed.writeAttempted === true) break;
  }
  out.scenarios[name] = {
    scope,
    permissions,
    childExit: res && res.status,
    attemptsUsed: attempts,
    ...(parsed || { ok: false, error: 'تعذّر تحليل خرج الابن', stderrTail: String((res && res.stderr) || '').slice(-400) }),
  };
  try { fs.rmSync(built.home, { recursive: true, force: true }); } catch (e) { /* أفضل جهد */ }
}

const a = out.scenarios['allow-write'] || {};
const l = out.scenarios['local-allow-write'] || {};
const c = out.scenarios['no-settings'] || {};
// الإنفاذ يعمل إن وصل المربع **رغم** قاعدة السماح، ولم تقع الكتابة.
const enforcedIn = (cell) => cell.writeAttempted === true
  && cell.permissionRequests > 0 && cell.markerExists === false;
out.verdict = {
  isolationWorked: typeof a.homeSeenByChild === 'string' && a.homeSeenByChild !== REAL_HOME,
  controlSane: c.writeAttempted === true && c.permissionRequests > 0 && c.markerExists === false,
  enforcedUserScope: enforcedIn(a),
  enforcedLocalScope: enforcedIn(l),
};
out.verdict.pass = out.verdict.isolationWorked && out.verdict.controlSane
  && out.verdict.enforcedUserScope && out.verdict.enforcedLocalScope;
out.verdict.note = out.verdict.pass
  ? 'الإنفاذ يعمل في مسار الإنتاج للنطاقين: وصل مربع الإذن رغم قاعدة السماح، ولم تقع الكتابة.'
  : 'لا يُقرأ هذا نجاحاً — راجع الحقول: العزل، والشاهد السالب، ووصول المربع في النطاقين.';
out.realHomeUntouched = before === (fs.existsSync(path.join(REAL_HOME, '.claude', 'settings.json'))
  ? fs.statSync(path.join(REAL_HOME, '.claude', 'settings.json')).mtimeMs : null);

console.log(JSON.stringify(out, null, 2));
process.exit(out.verdict.pass ? 0 : 1);
