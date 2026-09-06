#!/usr/bin/env node
'use strict';

/**
 * مسبار OBS-140 — هل تظلّل قواعد السماح في `.claude/settings.json` مربعَ الإذن؟
 *
 * ⚠️ **مسبار قياس لا حارس ولا علاج**: خارج `test:full` عمداً، ولا يعدّل حرفاً في
 * `electron/`. يجيب سؤالاً واحداً بفخّ حيّ:
 *
 *   إن حمل مشروعٌ يفتحه المستخدم `.claude/settings.json` فيه `permissions.allow`،
 *   فهل يُنفَّذ الفعل **قبل** أن يصل الطلبُ إلى `canUseTool` — أي قبل مربع الإذن
 *   العربي في «سطر»؟
 *
 * **لماذا فخّ حيّ لا استنتاج**: `OBS-140` وُلد من نصّ تحذير upstream
 * (`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`) الذي يقول إن قواعد ملفات الإعدادات تظلّل
 * الـcallback و«‏are not visible here». فالنصّ يصف احتمالاً، والقياس وحده يحسمه —
 * وقد يتبيّن أن `canUseTool` يُستدعى رغم القاعدة فتُغلق الملاحظة.
 *
 * **الطريقة — برهانٌ مستقل عن دفتر الاستدعاءات**: `canUseTool` هنا **يرفض كل شيء**.
 * فإن استُشير فُقد الفعل ولم يُكتب الملف؛ وإن ظُلِّل نُفِّذ الفعل وظهر الملف على
 * القرص. أي أن **وجود الملف هو الدليل**، لا عدّاد نثق به. ومعه شاهد سالب: المشهد
 * نفسه في مجلد **بلا** ملف إعدادات — إن ظهر الملف هناك أيضاً فالمسبار معطوب لا
 * الإنتاج.
 *
 * **يطابق الإنتاج**: `settingSources: ['user','project','local']` و
 * `permissionMode: 'default'` و**بلا `allowedTools`** — كما يبنيها
 * `electron/agent.js:1036` للتشغيل العادي. (السياقات المعزولة تمرّر `[]` فهي خارج
 * السؤال أصلاً.)
 *
 * التشغيل:  node scripts/obs140-settings-allow-probe.js
 * الخرج: JSON واحد. ولا يلمس المسبار مجلد المستخدم — الفخّ في `os.tmpdir()` ويُحذف.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const SDK_VERSION = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'),
  'utf8',
)).version;

const MARKER = 'TRAP_EXECUTED.txt';
const TURN_TIMEOUT_MS = 120000;

// تحذيرات upstream تُلتقط لا تُطبع: نصُّها جزء من القياس.
const warnings = [];
process.on('warning', (w) => {
  warnings.push({ name: String(w.name || ''), message: String(w.message || '').slice(0, 400) });
});

function makeTrapDir(label, permissions) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `obs140-${label}-`));
  if (permissions) {
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.claude', 'settings.json'),
      JSON.stringify({ permissions }, null, 2),
    );
  }
  return dir;
}

function rmDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* أفضل جهد */ }
}

async function runScenario({ label, permissions, prompt }) {
  const { query } = require('@anthropic-ai/claude-agent-sdk');
  const dir = makeTrapDir(label, permissions);
  const calls = [];
  let resultSubtype = null;
  let toolUseSeen = false;
  let toolResultText = '';
  let initTools = null;   // ← الدليل القطعي: ما يعلنه SDK نفسه لا ما يختاره النموذج
  const warnBefore = warnings.length;

  // مولّد إدخال يبقى مفتوحاً حتى نهاية الدور (شرط عمل المقاطعة — نمط الإنتاج).
  let closeInput = null;
  const inputClosed = new Promise((resolve) => { closeInput = resolve; });
  async function* promptStream() {
    yield {
      type: 'user',
      message: { role: 'user', content: prompt },
      parent_tool_use_id: null,
      session_id: '',
    };
    await inputClosed;
  }

  const q = query({
    prompt: promptStream(),
    options: {
      cwd: dir,
      model: 'haiku',
      permissionMode: 'default',
      // مطابقة الإنتاج حرفياً: بلا allowedTools، وبمصادر الإعدادات الثلاثة.
      settingSources: ['user', 'project', 'local'],
      canUseTool: async (toolName, input) => {
        calls.push({ toolName, inputKeys: Object.keys(input || {}).sort() });
        // الرفض هو المفتاح: إن استُشير هذا الـcallback فلن يُكتب الملف.
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
        for (const block of msg.message.content) {
          if (block && block.type === 'tool_use') toolUseSeen = true;
        }
      }
      // نصّ نتيجة الأداة: هو ما يميّز «رفَضه canUseTool» عن «رفَضته قاعدة deny».
      if (msg.type === 'user' && Array.isArray(msg.message && msg.message.content)) {
        for (const block of msg.message.content) {
          if (block && block.type === 'tool_result') {
            const c = block.content;
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

  // ── الدليل: هل وقع الفعل على القرص فعلاً؟ ──
  const markerPath = path.join(dir, MARKER);
  const markerExists = fs.existsSync(markerPath);
  const markerBytes = markerExists ? fs.statSync(markerPath).size : 0;
  const settingsPlanted = permissions
    ? fs.existsSync(path.join(dir, '.claude', 'settings.json'))
    : false;

  rmDir(dir);

  const text = toolResultText.trim();
  return {
    label,
    permissions: permissions || null,
    settingsFilePlanted: settingsPlanted,
    canUseToolCalls: calls.length,
    canUseToolTools: [...new Set(calls.map((c) => c.toolName))],
    toolUseSeenInStream: toolUseSeen,
    markerExists,           // ← الدليل المستقل
    markerBytes,
    resultSubtype,
    initToolCount: initTools ? initTools.length : null,
    initHasWrite: initTools ? initTools.includes('Write') : null,
    // بصمة الرافض: نصّنا نحن أم نصّ من الإعدادات؟ (لا يُطبع النصّ كاملاً)
    toolResultLength: text.length,
    deniedByProbeCallback: /OBS-140 probe: denied by canUseTool/.test(text),
    toolResultExcerpt: text.slice(0, 160),
    newWarnings: warnings.slice(warnBefore).map((w) => w.name),
  };
}

(async () => {
  const prompt =
    `Create a file named ${MARKER} in the current directory with the exact content "trap". ` +
    'Use the Write tool. Do it now, without asking for confirmation.';

  const out = { ok: true, sdkVersion: SDK_VERSION, scenarios: {} };
  try {
    out.cliVersion = require('child_process')
      .execFileSync('claude', ['--version'], { encoding: 'utf8', shell: true }).trim();
  } catch (e) { out.cliVersion = null; }

  // ① الفخّ: قاعدة سماح صريحة على الأداة نفسها التي سنطلبها.
  out.scenarios.trapWrite = await runScenario({
    label: 'trap-write',
    permissions: { allow: ['Write'] },
    prompt,
  });

  // ② الشاهد السالب: المشهد نفسه بلا ملف إعدادات إطلاقاً.
  out.scenarios.control = await runScenario({ label: 'control', permissions: null, prompt });

  // ③ صيغة النمط المُقيَّد — قد تُعامَل غير الاسم المجرّد.
  out.scenarios.trapPattern = await runScenario({
    label: 'trap-pattern',
    permissions: { allow: ['Write(*)'] },
    prompt,
  });

  // ④ ⭐ **الشاهد الموجب — وهو الذي يقرّر إن كان القياس قياساً أصلاً**: قاعدة `deny`
  // في الملف نفسه وبالموضع نفسه. إن حُجبت الأداة بها فالملف **مقروء**، فيصحّ عندها
  // أن يُقرأ عدمُ التجاوز في ①/③ نتيجةً. وإن لم تحجب فالملف **غير مقروء** أصلاً،
  // وكل ما سبقه قياسٌ لملفٍّ لا يراه أحد — لا نفيٌ للثغرة.
  out.scenarios.positiveControlDeny = await runScenario({
    label: 'deny',
    permissions: { deny: ['Write'] },
    prompt,
  });

  const t1 = out.scenarios.trapWrite;
  const t3 = out.scenarios.trapPattern;
  const c = out.scenarios.control;
  const d = out.scenarios.positiveControlDeny;

  // ⭐ **الدليل القطعي على أن الملف مقروء**: قائمة أدوات `system:init` يعلنها SDK
  // نفسه قبل أي اختيار من النموذج. إن حملت `Write` في الشاهد السالب وأسقطتها في
  // مشهد `deny` فالملف **مقروء يقيناً** — بلا اعتماد على أيّ أداة اختار النموذج
  // (وهو اختيار غير حتمي لا يصلح دليلاً وحده).
  const denyTookEffect = c.initHasWrite === true && d.initHasWrite === false;

  out.verdict = {
    controlSane: c.markerExists === false && c.canUseToolCalls > 0,
    settingsFileProvenRead: denyTookEffect,
    bypassedByBareName: t1.markerExists === true,
    bypassedByPattern: t3.markerExists === true,
  };
  out.verdict.confirmed = out.verdict.bypassedByBareName || out.verdict.bypassedByPattern;
  out.verdict.measurementValid = out.verdict.controlSane && out.verdict.settingsFileProvenRead;
  out.verdict.note = out.verdict.confirmed
    ? '⚠️ تجاوزٌ مثبَت: نُفِّذ الفعل رغم رفض canUseTool.'
    : out.verdict.measurementValid
      ? 'لا تجاوز — والقياس صالح: الشاهد السالب سليم، وقاعدة deny أثبتت أن الملف مقروء.'
      : '⚠️ لا يُبنى على هذه النتيجة نفيٌ: لم يثبت أن SDK يقرأ ملف الإعدادات أصلاً '
        + '(الشاهد الموجب لم يعمل)، فقد يكون المقيس ملفاً لا يراه أحد.';

  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
})().catch((err) => {
  console.log(JSON.stringify({ ok: false, error: String((err && err.message) || err) }, null, 2));
  process.exit(1);
});
