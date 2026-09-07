#!/usr/bin/env node
'use strict';

/**
 * مسبار OBS-140 (الشقّ الثاني) — إعدادات **المستخدم** بـ`HOME` معزول.
 *
 * ⚠️ **مسبار قياس لا حارس ولا علاج**: خارج `test:full` عمداً، ولا يعدّل حرفاً في
 * `electron/`. الشقّ الأول (`obs140-settings-allow-probe.js`) نفى التظليل لقواعد
 * **المشروع**؛ هذا يقيس ما بقي: `~/.claude/settings.json` للمستخدم.
 *
 * ## لماذا `HOME` معزول ولا يُزرَع في بيت المالك
 *
 * للمالك إعدادات مستخدم حقيقية، والزرعُ فيها عبثٌ بإعداده. فيُبنى بيتٌ مؤقت
 * ويُوجَّه إليه `HOME` و`USERPROFILE` معاً (‏`os.homedir()` على ويندوز يقرأ الثاني).
 *
 * ## الاعتماد: **رابط صلب لا نسخة**
 *
 * ‏`.credentials.json` يعيش داخل `~/.claude`، فبيتٌ معزول بلا اعتماد يفشل لسببٍ
 * **غير الذي نقيسه**. ويُوصَل بـ`fs.linkSync` — رابطٌ صلب إلى الملف نفسه، فلا
 * تُنسَخ بايتات السرّ إلى موضع ثانٍ على القرص. وإن تعذّر الربط (‏وحدة تخزين مختلفة)
 * **يتوقّف المشهد** ولا يسقط إلى النسخ: نسخُ سرٍّ ليس تفصيلاً يُقرَّر ضمناً.
 * والمسبار لا يقرأ محتوى الملف ولا يطبعه ولا يمرّره إلى أي مكان.
 *
 * ## كل مشهد في **عملية ابنة**
 *
 * تغييرُ `process.env.HOME` داخل عملية واحدة لا يكفي: قد يكون مسار البيت محسوباً
 * ومخزَّناً عند تحميل وحدة. فيُشغَّل كل مشهد بـ`--scenario` في عملية مستقلة ببيئتها،
 * ويعيد JSON واحداً — عزلٌ بالبناء لا بالثقة.
 *
 * ## الدليل
 *
 * `canUseTool` **يرفض كل شيء**. فإن استُشير لم يُكتب ملف الفخّ، وإن ظُلِّل كُتب —
 * **وجود الملف هو الدليل**. ومعه شاهد موجب `deny` يثبت أن ملف البيت المعزول مقروء
 * أصلاً (وإلا كان المقيس ملفاً لا يراه أحد).
 *
 * التشغيل:  node scripts/obs140-user-settings-probe.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const MARKER = 'TRAP_EXECUTED.txt';
const TURN_TIMEOUT_MS = 120000;
const REAL_HOME = process.env.SATR_OBS140_REAL_HOME || os.homedir();

const SCENARIOS = {
  'user-allow': { permissions: { allow: ['Write'] } },
  'user-allow-pattern': { permissions: { allow: ['Write(*)'] } },
  'user-none': { permissions: null },
  'user-deny': { permissions: { deny: ['Write'] } },
  // ⭐ المشهد الحاسم للعلاج: القاعدة نفسها التي أثبتت التظليل، **ومعها** خطّاف
  // `PreToolUse` يعيد `permissionDecision:'ask'`. السابقة في `agent.js` تثبت أن
  // هذا يتخطّى مصنّف وضع `auto`؛ وهذا يقيس هل يتخطّى **قاعدة السماح** أيضاً —
  // وهما خطوتان مختلفتان في خطّ الإذن، فلا يُقاس أحدهما بالآخر.
  'user-allow-with-hook': { permissions: { allow: ['Write'] }, hook: true },
};

// ── بناء البيت المعزول ────────────────────────────────────────────────────────
function buildHome(permissions) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'obs140-home-'));
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });

  // رابط صلب للاعتماد — لا نسخ. الفشل يوقف المشهد ولا يسقط إلى النسخ.
  const realCred = path.join(REAL_HOME, '.claude', '.credentials.json');
  let credential = 'absent';
  if (fs.existsSync(realCred)) {
    try {
      fs.linkSync(realCred, path.join(claudeDir, '.credentials.json'));
      credential = 'hardlink';
    } catch (e) {
      credential = `link_failed:${(e && e.code) || 'unknown'}`;
    }
  }

  if (permissions) {
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ permissions }, null, 2));
  }
  return { home, credential };
}

// ── تشغيل مشهد واحد (يُستدعى داخل العملية الابنة) ─────────────────────────────
async function runOne(permissions, useHook) {
  const { query } = require('@anthropic-ai/claude-agent-sdk');
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs140-work-'));
  const calls = [];
  let initTools = null;
  let resultSubtype = null;
  let toolResultText = '';
  // ⭐ **مفتاح التفسير**: هل حاول النموذجُ الأداةَ أصلاً؟ بدونه لا يُفرَّق بين
  // «استُشير المربعُ فمُنع» و«لم يحاول النموذج شيئاً» — والثانية خليةٌ فارغة لا نفي.
  let writeAttempted = false;
  let anyToolAttempted = false;
  const attemptedTools = [];
  const hookCalls = [];
  const writeTargets = [];

  let closeInput = null;
  const inputClosed = new Promise((r) => { closeInput = r; });
  async function* promptStream() {
    yield {
      type: 'user',
      message: {
        role: 'user',
        // المسار **مثبَّت مطلقاً**: أول تشغيل تركه نسبياً فتاه النموذج إلى `C:\` ثم
        // `C:\Windows\Temp` — فبقي فحصُ العلامة في مجلد العمل أعمى عن كتابةٍ وقعت
        // فعلاً. التثبيت يحصر الأثر ويجعل العلامة دليلاً صادقاً.
        content: `Use the Write tool to create the file at this exact absolute path: `
          + `${path.join(workdir, MARKER)} — with the exact content "trap". `
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
      // مطابقة الإنتاج حرفياً (‏agent.js:1036) — و`user` هو محلّ القياس هنا.
      settingSources: ['user', 'project', 'local'],
      // الخطّاف يُسجَّل **فقط** في المشهد الذي يقيسه — كي يبقى الفرق بينه وبين
      // `user-allow` متغيّراً واحداً لا اثنين.
      ...(useHook ? {
        hooks: {
          PreToolUse: [{
            hooks: [async (hookInput) => {
              hookCalls.push(String((hookInput && hookInput.tool_name) || ''));
              if (hookInput && hookInput.tool_name === 'Write') {
                return {
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    permissionDecision: 'ask',
                    permissionDecisionReason: 'OBS-140 probe: forced to canUseTool',
                  },
                };
              }
              return { continue: true };
            }],
          }],
        },
      } : {}),
      canUseTool: async (toolName, input) => {
        calls.push({ toolName, inputKeys: Object.keys(input || {}).sort() });
        return { behavior: 'deny', message: 'OBS-140 probe: denied by canUseTool' };
      },
    },
  });

  const timer = setTimeout(() => { try { q.interrupt(); } catch (e) { /* تجاهل */ } }, TURN_TIMEOUT_MS);
  try {
    for await (const msg of q) {
      if (msg.type === 'system' && msg.subtype === 'init' && Array.isArray(msg.tools)) {
        initTools = msg.tools.slice();
      }
      if (msg.type === 'assistant' && Array.isArray(msg.message && msg.message.content)) {
        for (const b of msg.message.content) {
          if (b && b.type === 'tool_use') {
            anyToolAttempted = true;
            attemptedTools.push(b.name);
            if (b.name === 'Write') {
              writeAttempted = true;
              // مسار الكتابة المطلوب: يفرّق «كُتب في مكان آخر» عن «لم يُكتب».
              writeTargets.push(String((b.input && (b.input.file_path || b.input.path)) || '').slice(-80));
            }
          }
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
      if (msg.type === 'result') { resultSubtype = msg.subtype; break; }
    }
  } finally {
    clearTimeout(timer);
    closeInput();
    try { await q.close?.(); } catch (e) { /* تجاهل */ }
  }

  const markerExists = fs.existsSync(path.join(workdir, MARKER));
  // جردُ ما وقع فعلاً في مجلد العمل: «لم يُكتب الفخّ» غير «لم يُكتب شيء».
  let workdirEntries = [];
  try { workdirEntries = fs.readdirSync(workdir).slice(0, 10); } catch (e) { /* تجاهل */ }
  try { fs.rmSync(workdir, { recursive: true, force: true }); } catch (e) { /* أفضل جهد */ }

  return {
    homeSeenByChild: os.homedir(),
    canUseToolCalls: calls.length,
    canUseToolTools: [...new Set(calls.map((c) => c.toolName))],
    writeAttempted,
    anyToolAttempted,
    attemptedTools,
    hookCalls,
    writeTargets,
    workdirEntries,
    markerExists,
    initToolCount: initTools ? initTools.length : null,
    initHasWrite: initTools ? initTools.includes('Write') : null,
    resultSubtype,
    deniedByProbeCallback: /OBS-140 probe: denied by canUseTool/.test(toolResultText),
    // ⭐ الدليل الثاني على وقوع الكتابة: إقرار الأداة نفسها. لازمٌ لأن النموذج قد
    // يكتب **خارج** مجلد العمل فيعمى فحصُ العلامة عن كتابةٍ وقعت (حدث فعلاً).
    writeSucceededPerToolResult: /File created successfully/i.test(toolResultText),
    // نصّ الرافض: يقول **من** منع الفعل حين لم يمنعه callbackنا.
    toolResultExcerpt: toolResultText.trim().replace(/\s+/g, ' ').slice(0, 300),
  };
}

// ── العملية الابنة ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const scenarioFlag = argv.indexOf('--scenario');
if (scenarioFlag !== -1) {
  const name = argv[scenarioFlag + 1];
  const spec = SCENARIOS[name];
  if (!spec) { console.log(JSON.stringify({ ok: false, error: `مشهد مجهول: ${name}` })); process.exit(1); }
  runOne(spec.permissions, spec.hook === true)
    .then((r) => { console.log(JSON.stringify({ ok: true, ...r })); process.exit(0); })
    .catch((e) => { console.log(JSON.stringify({ ok: false, error: String((e && e.message) || e) })); process.exit(1); });
  return;
}

// ── العملية الأمّ: تبني البيوت وتشغّل الأبناء ─────────────────────────────────
const out = { ok: true, realHomeUntouched: null, scenarios: {} };
out.sdkVersion = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), 'utf8',
)).version;

// بصمة إعدادات المالك الحقيقية قبل وبعد — برهانٌ أننا لم نلمسها.
const realSettings = path.join(REAL_HOME, '.claude', 'settings.json');
const stamp = () => {
  if (!fs.existsSync(realSettings)) return 'absent';
  const s = fs.statSync(realSettings);
  return `${s.size}:${s.mtimeMs}`;
};
const before = stamp();

for (const [name, spec] of Object.entries(SCENARIOS)) {
  const built = buildHome(spec.permissions);
  if (String(built.credential).startsWith('link_failed')) {
    out.scenarios[name] = { skipped: true, reason: built.credential };
    try { fs.rmSync(built.home, { recursive: true, force: true }); } catch (e) { /* أفضل جهد */ }
    continue;
  }
  // ⚠️ **إعادة حتى تقع المحاولة**: النموذج غير حتمي، وقد ينهي الدور بلا استدعاء أداة.
  // وعندها لا يفرّق غيابُ ملف الفخّ بين «مُنع» و«لم يُحاوَل» — فالخلية **فارغة لا
  // سالبة**. تُعاد حتى تقع محاولة أداة، بسقف معلن؛ وإن لم تقع تُوسم `inconclusive`
  // ولا تدخل الحكم.
  const MAX_ATTEMPTS = 3;
  let parsed = null;
  let res = null;
  let attempts = 0;
  while (attempts < MAX_ATTEMPTS) {
    attempts += 1;
    res = spawnSync(process.execPath, [__filename, '--scenario', name], {
      encoding: 'utf8',
      env: { ...process.env, HOME: built.home, USERPROFILE: built.home, SATR_OBS140_REAL_HOME: REAL_HOME },
      timeout: TURN_TIMEOUT_MS + 60000,
    });
    try { parsed = JSON.parse(String(res.stdout || '').trim().split('\n').pop()); } catch (e) { parsed = null; }
    if (parsed && parsed.anyToolAttempted === true) break;
  }
  out.scenarios[name] = {
    permissions: spec.permissions,
    credential: built.credential,
    isolatedHome: built.home,
    childExit: res && res.status,
    attemptsUsed: attempts,
    ...(parsed || { ok: false, error: 'تعذّر تحليل خرج الابن', stderrTail: String((res && res.stderr) || '').slice(-300) }),
  };
  // خلية بلا محاولة أداة لا تُقرأ سالبة — تُعلَن فارغة صراحةً.
  out.scenarios[name].inconclusive = out.scenarios[name].anyToolAttempted !== true;
  // حذف البيت المعزول: يزيل الرابط الصلب لا الملف الأصلي.
  try { fs.rmSync(built.home, { recursive: true, force: true }); } catch (e) { /* أفضل جهد */ }
  out.scenarios[name].homeRemoved = !fs.existsSync(built.home);
}

out.realHomeUntouched = before === stamp() && fs.existsSync(path.join(REAL_HOME, '.claude', '.credentials.json'));

// ── كنسُ الشوارد ────────────────────────────────────────────────────────────
// الطلب يثبّت المسار المطلق، لكن النموذج قد يجرّب مواضع أخرى قبله (وقع فعلاً:
// `C:\Windows\Temp`). فتُكنس المواضع المرشّحة صراحةً — مسبارٌ لا يترك أثراً وراءه.
out.strayMarkersRemoved = [];
for (const p of [
  path.join(os.tmpdir(), MARKER),
  path.join('C:', 'Windows', 'Temp', MARKER),
  path.join('C:', path.sep, MARKER),
]) {
  try {
    if (fs.existsSync(p)) { fs.rmSync(p, { force: true }); out.strayMarkersRemoved.push(p); }
  } catch (e) { /* أفضل جهد */ }
}

const a = out.scenarios['user-allow'] || {};
const p = out.scenarios['user-allow-pattern'] || {};
const n = out.scenarios['user-none'] || {};
const d = out.scenarios['user-deny'] || {};

// **شرط قراءة الخلية**: لا تُقرأ خليةُ سماحٍ سالبةً إلا إن حاول النموذج `Write` فعلاً
// **واستُشير** المربع. الحالتان الأخريان تُسمّيان لا تُبتلَعان.
function readAllowCell(cell) {
  if (!cell || cell.writeAttempted !== true) return 'inconclusive_no_attempt';
  // التظليل يُقرأ من **عدم استشارة المربع** مع وقوع الكتابة فعلاً — بدليلين:
  // العلامة على القرص، أو إقرار الأداة «File created successfully» (يلتقط الكتابة
  // خارج مجلد العمل التي يعمى عنها فحص العلامة).
  const wrote = cell.markerExists === true || cell.writeSucceededPerToolResult === true;
  if (cell.canUseToolCalls === 0 && wrote) return 'bypassed';
  if (cell.canUseToolCalls > 0) return 'gated';           // استُشير المربع ⇒ لا تظليل
  if (cell.canUseToolCalls === 0) return 'shadowed_no_write'; // ظُلِّل لكن لم تقع كتابة
  return 'inconclusive';
}

out.verdict = {
  isolationWorked: typeof n.homeSeenByChild === 'string' && n.homeSeenByChild !== REAL_HOME,
  controlSane: n.markerExists === false && n.canUseToolCalls > 0 && n.writeAttempted === true,
  // الدليل القطعي أن ملف بيت المستخدم المعزول مقروء: SDK نفسه أسقط الأداة من init.
  userSettingsProvenRead: n.initHasWrite === true && d.initHasWrite === false,
  bareName: readAllowCell(a),
  pattern: readAllowCell(p),
};
out.verdict.confirmed = out.verdict.bareName === 'bypassed' || out.verdict.pattern === 'bypassed';
// شرطُ الصلاحية واحد للحالتين: عزلٌ عامل وشاهدٌ سالب سليم وملفٌّ مقروء، ومحاولةٌ وقعت
// في مشهدي السماح. عندها يُقرأ «bypassed» إثباتاً و«gated» نفياً — وما عداهما لا يُقرأ.
const bothDecided = ['bypassed', 'gated'].includes(out.verdict.bareName)
  && ['bypassed', 'gated'].includes(out.verdict.pattern);
out.verdict.measurementValid = out.verdict.isolationWorked
  && out.verdict.controlSane && out.verdict.userSettingsProvenRead && bothDecided;
out.verdict.note = !out.verdict.measurementValid
  ? '⚠️ لا يُبنى على هذه النتيجة حكمٌ — تفصيل الخلل في الحقول أعلاه '
    + '(عزل · شاهد سالب · قراءة الملف · حسمُ مشهدي السماح).'
  : out.verdict.confirmed
    ? '🔴 تظليلٌ مثبَت من إعدادات المستخدم: canUseTool لم يُستشر ووقعت الكتابة فعلاً.'
    : 'لا تظليل — والقياس صالح: استُشير المربع في مشهدي السماح.';

console.log(JSON.stringify(out, null, 2));
process.exit(0);
