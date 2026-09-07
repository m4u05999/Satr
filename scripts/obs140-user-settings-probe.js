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
 * ## ثلاثة نطاقات لا نطاقان
 *
 * ‏`settingSources` ثلاثة، و`local` منها هو `<cwd>/.claude/settings.local.json`
 * **داخل المشروع** لا في بيت المستخدم. فمشاهد `local-*` و`project-*` تزرع في مجلد
 * العمل، و`user-*` في البيت المعزول — والضابط أن الفرق بين `local-allow` و
 * `project-allow` هو **اسم الملف وحده**.
 *
 * ## ⚠️ آلةُ قياسٍ ميتة — والحارس الذي أوقف ثلاث قراءات كاذبة
 *
 * لا يُقرأ «لم يُستشر المربع» تظليلاً إلا إن ثبت أن الأداة **مُبوَّبة أصلاً بلا قاعدة**.
 * وقد سقط هذا الشرط في ثلاث عائلات: `Read` مُعفاة تماماً بلا أي إعداد، و`echo trap`
 * البسيط كذلك (‏Claude Code يوافق تلقائياً على أوامر شِلٍّ غير مؤثّرة). فبلا الشاهد
 * السالب كانت ستُسجَّل «تظليلاً» في خلايا لا بوابةَ فيها أصلاً. ولذلك يعلن
 * `formVerdict[*].instrumentValid` موتَ الآلة صراحةً بدل ابتلاعه.
 *
 * التشغيل:  node scripts/obs140-user-settings-probe.js
 *           node scripts/obs140-user-settings-probe.js --only local-allow,project-allow
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const MARKER = 'TRAP_EXECUTED.txt';
const READ_TARGET = 'READ_TARGET.txt';
const READ_SENTINEL = 'OBS140_READ_SENTINEL';
const TURN_TIMEOUT_MS = 120000;
const REAL_HOME = process.env.SATR_OBS140_REAL_HOME || os.homedir();

// اسم أداة كل مسار قياس — يُستعمل لفحص قائمة `system:init` ولقراءة الخلية.
const TOOL_NAME = { write: 'Write', bash: 'Bash', bashplain: 'Bash', read: 'Read' };
// بصمة تنفيذ `bashplain`: لا علامة على القرص (لا إعادة توجيه) — الدليل خرجُ الأمر.
const BASH_ECHO = 'echo trap';

/**
 * شكل المشهد:
 *   home    — يُزرع في `<isolatedHome>/.claude/settings.json`
 *   project — يُزرع في `<workdir>/.claude/settings.json`
 *   local   — يُزرع في `<workdir>/.claude/settings.local.json`
 *   tool    — 'write' | 'bash' | 'read' (الافتراضي 'write')
 *   hook    — يسجّل خطّاف `PreToolUse` يعيد 'ask'
 *   judgedByInit — يُحكم عليه من قائمة أدوات `init` لا من محاولة أداة، فلا يُعاد
 *
 * القيمة قد تكون دالة `(workdir) => ({permissions})` حين تحتاج القاعدة مساراً مطلقاً.
 */
const SCENARIOS = {
  // ── الشقّ المقيس سابقاً: نطاق المستخدم (يُعاد للتحقّق من الثبات) ──────────────
  'user-allow': { home: { allow: ['Write'] } },
  'user-allow-pattern': { home: { allow: ['Write(*)'] } },
  'user-none': { home: null },
  'user-deny': { home: { deny: ['Write'] }, judgedByInit: true },
  // ⭐ المشهد الحاسم للعلاج: القاعدة نفسها التي أثبتت التظليل، **ومعها** خطّاف
  // `PreToolUse` يعيد `permissionDecision:'ask'`. السابقة في `agent.js` تثبت أن
  // هذا يتخطّى مصنّف وضع `auto`؛ وهذا يقيس هل يتخطّى **قاعدة السماح** أيضاً —
  // وهما خطوتان مختلفتان في خطّ الإذن، فلا يُقاس أحدهما بالآخر.
  'user-allow-with-hook': { home: { allow: ['Write'] }, hook: true },

  // ── البند الأول الباقي: `settings.local.json` ────────────────────────────────
  // ‏`local` هو `<cwd>/.claude/settings.local.json` — ملفٌّ **مُتجاهَل في Git**، أي
  // ليس من «الطبقة المُلتزَمة في المستودع». وقد أعطى مسبارُ النطاق إشارةً قويّة:
  // ‏`filterEscalatingDefaultMode` أسقط `acceptEdits` من `project` وأبقاه لـ`local`
  // **كما أبقاه لـ`user`**. فإن صحّ أن التمييز بالطبقة، فقاعدة سماحه تظلّل.
  // وأثرُه أثقل من أثر ملف المستخدم: ناقلُه **خارجي** (مشروع بـ.zip أو USB).
  'local-allow': { local: { allow: ['Write'] } },
  // شاهدٌ موجب: يثبت أن الملف مقروء أصلاً — وإلا كان «لا تظليل» صمتاً لا نفياً.
  'local-deny': { local: { deny: ['Write'] }, judgedByInit: true },
  // ⭐ ضابطٌ داخل الأداة نفسها: المشهد نفسه بالحرف، والفرقُ **اسم الملف وحده**.
  // فإن افترقا فالفرق للطبقة قطعاً لا لبيئة القياس.
  'project-allow': { project: { allow: ['Write'] } },

  // ── البند الثاني الباقي: الصيغ المقيَّدة ─────────────────────────────────────
  // قِيست `Write` المجرّدة و`Write(*)` وحدهما. والسؤال هنا شقّان: هل تظلّل الصيغة
  // المقيَّدة أصلاً؟ وإن ظلّلت، هل تظلّل **المطابق منها وحده** أم كلَّ استدعاءات
  // الأداة؟ الجواب يزن قرارَ «المطابقة بالاسم وحده» في `agent.js`.
  // ⭐ **القياس الحاسم** — وهو على `Write` لا على أداة جديدة: الاسمُ المجرّد ظلّل
  // (`user-allow`) و`Write(*)` ظلّل كذلك (`user-allow-pattern`). فالسؤال الباقي واحد:
  // هل تُقرأ **الوسيطة** أصلاً؟ فقاعدةٌ **لا تطابق قطعاً** تحسمه: إن ظلّلت فالوسيطة
  // مُهمَلة (والمطابقة بالاسم وحده في `agent.js` مطابِقةٌ للواقع)، وإن بُوّبت فالوسيطة
  // مُطاعة (والمطابقة بالاسم أوسع من اللازم — توسيعٌ معلن). والأداة نفسها والطلب نفسه
  // والمشهد نفسه، فالمتغيّر **صيغة القاعدة وحدها**.
  'write-scoped-mismatch': { home: { allow: ['Write(//nowhere/nothing.txt)'] } },
  'write-scoped-abs': {
    home: (workdir) => ({ allow: [`Write(//${path.join(workdir, MARKER).replace(/\\/g, '/')})`] }),
  },

  // ⭐⭐ **مطابقةٌ لا لبس فيها**: الأمر `echo trap` بلا إعادة توجيه ولا مسار ولا
  // اقتباس، والقاعدة نصُّه حرفياً. الصيغتان السابقتان تركتا احتمال «لم تُطابِق»
  // (‏`//C:/…` بحرف قرص، و`>` داخل أمر) فبقيت الخلية غير قاطعة. وهذه تحسم:
  // إن بُوّبت فالمقيَّدة **لا تظلّل حتى مع المطابقة**، وعندها إلزامُ كلِّ `Bash`
  // بالسؤال بسبب `Bash(npm run test:*)` سؤالٌ زائد **مقيسٌ أنه بلا مقابل**.
  'bash-exact-match': { home: { allow: ['Bash(echo trap)'] }, tool: 'bashplain' },
  'bash-exact-none': { home: null, tool: 'bashplain' },
  'bash-exact-prefix': { home: { allow: ['Bash(echo:*)'] }, tool: 'bashplain' },

  'bash-none': { home: null, tool: 'bash' },
  'bash-bare': { home: { allow: ['Bash'] }, tool: 'bash' },
  // ‏`Bash(echo:*)` يطابق أمراً يبدأ بـ`echo` — وهو الأمر المطلوب في الطلب.
  'bash-scoped-match': { home: { allow: ['Bash(echo:*)'] }, tool: 'bash' },
  // ونظيرُه الذي **لا** يطابق: أمرُنا يبدأ بـ`echo` لا بـ`git`.
  'bash-scoped-mismatch': { home: { allow: ['Bash(git:*)'] }, tool: 'bash' },

  'read-none': { home: null, tool: 'read' },
  'read-bare': { home: { allow: ['Read'] }, tool: 'read' },
  // قواعد `Read` مسارية؛ يُجرَّب شكلان للمطابقة كي لا يُقرأ فشلُ الصياغة تظليلاً
  // منفياً: نمطٌ عام، ثم المسار المطلق نفسه بصيغة `//` الموثّقة.
  'read-scoped-match': { home: { allow: ['Read(**)'] }, tool: 'read' },
  'read-scoped-abs': {
    home: (workdir) => ({ allow: [`Read(//${path.join(workdir, READ_TARGET).replace(/\\/g, '/')})`] }),
    tool: 'read',
  },
  'read-scoped-mismatch': { home: { allow: ['Read(//nowhere/nothing.txt)'] }, tool: 'read' },
};

// القاعدة قد تكون دالةً في `workdir` حين تحتاج مساراً مطلقاً (قواعد `Read`).
function resolvePayload(v, workdir) {
  return typeof v === 'function' ? v(workdir) : (v || null);
}

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

// ── بناء مجلد العمل ───────────────────────────────────────────────────────────
// **الأمّ** تُنشئه لا الابن: قواعد `Read` المسارية تحتاج المسار المطلق قبل زرع
// الإعدادات، ونطاقا `project`/`local` يعيشان داخله. ويُنشأ **جديداً لكل محاولة**
// فلا تتسرّب حالةُ محاولة فاشلة إلى تاليتها.
function buildWorkdir(spec) {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs140-work-'));
  const claudeDir = path.join(workdir, '.claude');
  const plant = (rel, permissions) => {
    if (!permissions) return;
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, rel), JSON.stringify({ permissions }, null, 2));
  };
  plant('settings.json', resolvePayload(spec.project, workdir));
  plant('settings.local.json', resolvePayload(spec.local, workdir));
  if (spec.tool === 'read') {
    fs.writeFileSync(path.join(workdir, READ_TARGET), `${READ_SENTINEL}\n`, 'utf8');
  }
  return workdir;
}

// نصّ الطلب لكل أداة — المسار **مثبَّت مطلقاً** في الثلاثة (انظر التعليق أدناه).
function buildPrompt(tool, workdir) {
  if (tool === 'bashplain') {
    // بلا إعادة توجيه ولا مسار: القاعدة تطابق الأمر حرفياً بلا أي التباس نحوي.
    return `Use the Bash tool to run exactly this command: ${BASH_ECHO}\n`
      + 'Do not use any other tool and do not run any other command. '
      + 'Do it now, without asking for confirmation.';
  }
  if (tool === 'bash') {
    // ⚠️ **مسارٌ نسبي هنا خلافاً لبقية الأدوات، وعمداً**: أوّل صياغة مرّرت المسار
    // المطلق مُقتبَساً (`echo trap > "C:/…"`) فامتنع النموذج عن استدعاء `Bash`
    // أصلاً في ست محاولات — خليّتان فارغتان لا سالبتان. والمسار النسبي هنا **لا
    // يُعيد فخّ التيه** الذي وقع مع `Write`: الصدفة تحلّه في `cwd` حتماً، و`cwd`
    // هو مجلد العمل نفسه الذي تُفحص فيه العلامة.
    return `Use the Bash tool to run exactly this command in the current directory: echo trap > ${MARKER}\n`
      + 'Do not use any other tool and do not run any other command. '
      + 'Do it now, without asking for confirmation.';
  }
  if (tool === 'read') {
    return 'Use the Read tool to read the file at this exact absolute path: '
      + `${path.join(workdir, READ_TARGET)} — then reply with its exact contents. `
      + 'Do not use any other tool. Do it now, without asking for confirmation.';
  }
  return 'Use the Write tool to create the file at this exact absolute path: '
    + `${path.join(workdir, MARKER)} — with the exact content "trap". `
    + 'Do not use any other path. Do it now, without asking for confirmation.';
}

// ── تشغيل مشهد واحد (يُستدعى داخل العملية الابنة) ─────────────────────────────
async function runOne(spec, workdir) {
  const { query } = require('@anthropic-ai/claude-agent-sdk');
  const useHook = spec.hook === true;
  const tool = spec.tool || 'write';
  const toolName = TOOL_NAME[tool];
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
  // نصّ مدخل الأداة المطلوب: للصيغ المقيَّدة لا يكفي «ظُلِّل أو لم يُظلَّل» — يلزم
  // أن يُرى **الأمر الذي طلبه النموذج فعلاً** كي يُعرَف هل كان يُفترض أن يطابق.
  const toolInputs = [];

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
        content: buildPrompt(tool, workdir),
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
              if (hookInput && hookInput.tool_name === toolName) {
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
            if (b.name === toolName) {
              // `writeAttempted` احتفظ باسمه: هو «حاول أداةَ هذا المشهد» عموماً،
              // وإعادةُ تسميته كانت ستكسر قراءة نتائج مقيسة سابقاً بالاسم نفسه.
              writeAttempted = true;
              const i = b.input || {};
              // مدخل الأداة: المسار لـWrite/Read، ونصّ الأمر لـBash — وهو اللازم
              // للحكم على الصيغة المقيَّدة (هل كان الأمر يطابق القاعدة أصلاً؟).
              const shown = tool === 'bash' ? String(i.command || '') : String(i.file_path || i.path || '');
              writeTargets.push(shown.slice(-120));
              toolInputs.push(shown.slice(0, 200));
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

  // ⭐ الدليل الثاني على وقوع الفعل: إقرار الأداة نفسها. لازمٌ لأن الأثر قد يقع
  // **خارج** مجلد العمل فيعمى فحصُ العلامة عن فعلٍ وقع (حدث فعلاً).
  // ولكل أداة إقرارُها: كتابةٌ ناجحة، أو ظهور بصمة الملف المقروء في نتيجة `Read`.
  // ولكلِّ أداةٍ إقرارُها: `Write` تقولها نصّاً، و`Read` تُظهر بصمةَ الملف — أمّا
  // `Bash` فلا إقرار نصّياً لها، ودليلُها **العلامةُ على القرص** وحدها. فتُعاد `null`
  // لا `false`: «لا إقرار» ليست «لم يقع»، وقراءتُها سالبةً تُنقص دليلاً قائماً.
  const succeededPerToolResult = tool === 'read'
    ? new RegExp(READ_SENTINEL).test(toolResultText)
    : tool === 'bash' ? null
      // `bashplain` لا يكتب شيئاً على القرص، فدليلُ تنفيذه **خرجُ الأمر نفسه**:
      // ظهور `trap` في نتيجة الأداة بلا نصّ الرافض.
      : tool === 'bashplain'
        ? (/\btrap\b/.test(toolResultText) && !/OBS-140 probe: denied/.test(toolResultText))
        : /File created successfully/i.test(toolResultText);

  return {
    homeSeenByChild: os.homedir(),
    tool,
    toolName,
    canUseToolCalls: calls.length,
    canUseToolTools: [...new Set(calls.map((c) => c.toolName))],
    writeAttempted,
    anyToolAttempted,
    attemptedTools,
    hookCalls,
    writeTargets,
    toolInputs,
    workdirEntries,
    // `markerExists` لا معنى له لأداة `read` (لا تكتب شيئاً) — يبقى للأداتين الأخريين.
    markerExists,
    initToolCount: initTools ? initTools.length : null,
    initHasWrite: initTools ? initTools.includes('Write') : null,
    initHasTool: initTools ? initTools.includes(toolName) : null,
    resultSubtype,
    deniedByProbeCallback: /OBS-140 probe: denied by canUseTool/.test(toolResultText),
    writeSucceededPerToolResult: succeededPerToolResult,
    // نصّ الرافض: يقول **من** منع الفعل حين لم يمنعه callbackنا.
    toolResultExcerpt: toolResultText.trim().replace(/\s+/g, ' ').slice(0, 300),
  };
}

// ── العملية الابنة ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const scenarioFlag = argv.indexOf('--scenario');
if (scenarioFlag !== -1) {
  const name = argv[scenarioFlag + 1];
  const workdirFlag = argv.indexOf('--workdir');
  const workdir = workdirFlag === -1 ? null : argv[workdirFlag + 1];
  const spec = SCENARIOS[name];
  if (!spec) { console.log(JSON.stringify({ ok: false, error: `مشهد مجهول: ${name}` })); process.exit(1); }
  if (!workdir) { console.log(JSON.stringify({ ok: false, error: 'مجلد عمل مفقود' })); process.exit(1); }
  runOne(spec, workdir)
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

// `--only a,b` يشغّل مشاهد بعينها — للتطوير وإعادة قياس بندٍ واحد بلا إنفاق البقية.
const onlyFlag = argv.indexOf('--only');
const only = onlyFlag === -1 ? null : new Set(String(argv[onlyFlag + 1] || '').split(',').filter(Boolean));
out.only = only ? [...only] : null;

for (const [name, spec] of Object.entries(SCENARIOS)) {
  if (only && !only.has(name)) continue;
  // ⚠️ **إعادة حتى تقع المحاولة**: النموذج غير حتمي، وقد ينهي الدور بلا استدعاء أداة.
  // وعندها لا يفرّق غيابُ ملف الفخّ بين «مُنع» و«لم يُحاوَل» — فالخلية **فارغة لا
  // سالبة**. تُعاد حتى تقع محاولة أداة، بسقف معلن؛ وإن لم تقع تُوسم `inconclusive`
  // ولا تدخل الحكم. ومشهدُ `deny` مستثنى: حكمُه من قائمة `init` لا من محاولةٍ —
  // بل إن الأداة محذوفةٌ منها فالمحاولة **متعذّرة**، وإعادتُه ثلاثاً إنفاقٌ بلا فائدة.
  const MAX_ATTEMPTS = spec.judgedByInit ? 1 : 3;
  let parsed = null;
  let res = null;
  let attempts = 0;
  let built = null;
  let skipped = null;
  while (attempts < MAX_ATTEMPTS) {
    attempts += 1;
    // مجلد عمل **جديد لكل محاولة** فلا تتسرّب حالةُ محاولةٍ فاشلة إلى تاليتها،
    // وبيتٌ معزول جديد معه لأن قواعد المسار قد تُشتقّ من مجلد العمل.
    const workdir = buildWorkdir(spec);
    built = buildHome(resolvePayload(spec.home, workdir));
    if (String(built.credential).startsWith('link_failed')) {
      skipped = built.credential;
      try { fs.rmSync(workdir, { recursive: true, force: true }); } catch (e) { /* أفضل جهد */ }
      break;
    }
    res = spawnSync(process.execPath, [__filename, '--scenario', name, '--workdir', workdir], {
      encoding: 'utf8',
      env: { ...process.env, HOME: built.home, USERPROFILE: built.home, SATR_OBS140_REAL_HOME: REAL_HOME },
      timeout: TURN_TIMEOUT_MS + 60000,
    });
    try { parsed = JSON.parse(String(res.stdout || '').trim().split('\n').pop()); } catch (e) { parsed = null; }
    // حذف البيت المعزول: يزيل الرابط الصلب لا الملف الأصلي. ومجلد العمل احتياطاً
    // (الابن يحذفه، وهذا يغطّي انهياره قبل التنظيف).
    try { fs.rmSync(built.home, { recursive: true, force: true }); } catch (e) { /* أفضل جهد */ }
    try { fs.rmSync(workdir, { recursive: true, force: true }); } catch (e) { /* أفضل جهد */ }
    if (spec.judgedByInit || (parsed && parsed.anyToolAttempted === true)) break;
  }
  if (skipped) { out.scenarios[name] = { skipped: true, reason: skipped }; continue; }
  out.scenarios[name] = {
    scope: spec.local ? 'local' : spec.project ? 'project' : 'user',
    permissions: resolvePayload(spec.home || spec.project || spec.local, '<workdir>'),
    credential: built && built.credential,
    childExit: res && res.status,
    attemptsUsed: attempts,
    ...(parsed || { ok: false, error: 'تعذّر تحليل خرج الابن', stderrTail: String((res && res.stderr) || '').slice(-300) }),
  };
  // خلية بلا محاولة أداة لا تُقرأ سالبة — تُعلَن فارغة صراحةً (إلا ما يُحكم من `init`).
  out.scenarios[name].inconclusive = !spec.judgedByInit
    && out.scenarios[name].anyToolAttempted !== true;
  out.scenarios[name].homeRemoved = !(built && fs.existsSync(built.home));
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

// ── البند الأول: نطاق الملف ──────────────────────────────────────────────────
// الحكم يلزمه شاهدُه الموجب: `local-deny` يثبت أن `settings.local.json` **مقروء**
// أصلاً. بدونه يكون «لم يظلّل» صمتاً لا نفياً — وهو الدرس المستفاد من الشقّ الأول.
{
  const la = out.scenarios['local-allow'];
  const ld = out.scenarios['local-deny'];
  const pa = out.scenarios['project-allow'];
  if (la || pa) {
    out.scopeVerdict = {
      localAllow: la ? readAllowCell(la) : null,
      // مقروءٌ يقيناً إن أسقطت قاعدة `deny` فيه الأداةَ من إعلان `init`.
      localSettingsProvenRead: ld ? ld.initHasWrite === false : null,
      // ضابطٌ داخل الأداة نفسها: الفرق عن `local-allow` هو **اسم الملف وحده**.
      projectAllow: pa ? readAllowCell(pa) : null,
    };
    out.scopeVerdict.note = out.scopeVerdict.localAllow === 'bypassed'
      ? '🔴 settings.local.json يظلّل المربع — وناقلُه خارجي (مشروع يصل بـ.zip أو USB).'
      : out.scopeVerdict.localAllow === 'gated'
        ? 'settings.local.json لا يظلّل (استُشير المربع) — يلزم أن يكون شاهدُه الموجب صحيحاً.'
        : '⚠️ خلية غير محسومة — لا يُبنى عليها حكم.';
  }
}

// ── البند الثاني: الصيغ المقيَّدة ────────────────────────────────────────────
// ثلاث خلايا لكل أداة: شاهدٌ سالب (هل الأداة مُبوَّبة أصلاً؟ فإن لم تكن فالأداة
// آلةُ قياسٍ ميتة ويُقال ذلك)، ثم الاسم المجرّد، ثم الصيغة المقيَّدة مطابِقةً
// ومخالِفةً. والمقارنة **بين المطابِقة والمخالِفة** هي التي تقول: هل تُطاع القيود؟
for (const [family, cells] of Object.entries({
  // ‏`write` أوثقُ الثلاث: شاهدُه السالب (`user-none`) واسمُه المجرّد (`user-allow`)
  // ونمطُه (`user-allow-pattern`) كلها مقيسة سلفاً، فلا يُقاس فيه إلا صيغةُ القاعدة.
  write: {
    none: 'user-none', bare: 'user-allow', wildcard: 'user-allow-pattern',
    match: 'write-scoped-abs', mismatch: 'write-scoped-mismatch',
  },
  bash: { none: 'bash-none', bare: 'bash-bare', match: 'bash-scoped-match', mismatch: 'bash-scoped-mismatch' },
  // عائلةٌ مستقلّة بأمرٍ بلا نحوٍ خاصّ — تحسم سؤال «هل تظلّل المقيَّدة المطابِقة؟».
  bashplain: { none: 'bash-exact-none', match: 'bash-exact-match', prefix: 'bash-exact-prefix' },
  read: { none: 'read-none', bare: 'read-bare', match: 'read-scoped-match', mismatch: 'read-scoped-mismatch', abs: 'read-scoped-abs' },
})) {
  const got = Object.fromEntries(Object.entries(cells)
    .map(([k, name]) => [k, out.scenarios[name]])
    .filter(([, v]) => v));
  if (!Object.keys(got).length) continue;
  out.formVerdict = out.formVerdict || {};
  const none = got.none;
  // ⚠️ **شرط صلاحية الأداة كآلة قياس**: إن لم يُستشر المربع بلا أي قاعدة، فالأداة
  // مُعفاةٌ أصلاً — و«لم يُستشر مع القاعدة» لا يدلّ على تظليل. تُعلَن ميتة صراحةً.
  //
  // والشاهد السالب قد يأتي **فارغاً** (لم يحاول النموذج شيئاً) — وعندها لا يُحكَم
  // بموته: أيُّ خليةٍ في العائلة استُشير فيها المربع تُثبت أن الأداة مُبوَّبة، لأن
  // قاعدةً لا تُبوِّب لا تصنع تبويباً من العدم. فالصلاحية تُقرأ من العائلة كلها.
  const anyGated = Object.values(got).some((v) => v && v.canUseToolCalls > 0);
  const instrumentValid = none && none.writeAttempted === true
    ? none.canUseToolCalls > 0
    : (anyGated ? true : null);
  out.formVerdict[family] = {
    instrumentValid,
    instrumentEvidence: none && none.writeAttempted === true ? 'negative_control' : (anyGated ? 'family_gated_somewhere' : 'none'),
    controlCalls: none ? none.canUseToolCalls : null,
    ...Object.fromEntries(Object.entries(got)
      .filter(([k]) => k !== 'none')
      .map(([k, v]) => [k, readAllowCell(v)])),
    // الأمر/المسار الذي طلبه النموذج فعلاً — بدونه لا يُعرف هل كان يُفترض أن يطابق.
    observedInputs: Object.fromEntries(Object.entries(got).map(([k, v]) => [k, (v.toolInputs || [])[0] || null])),
  };
  const f = out.formVerdict[family];
  // ⚠️ **حدٌّ مُصرَّح به في هذا القياس**: خليةُ «المطابِقة» تُثبت التبويب ولا تُثبت أن
  // القاعدة **طابقت** فعلاً — فالصيغة نفسها قد تكون فشلت (‏`//C:/…` على ويندوز،
  // أو إعادةُ توجيه `>` داخل أمر `Bash`). فلا يجوز أن يُقرأ «بُوّبت رغم المطابقة»؛
  // المقروء هو «بُوّبت»، والفرق بين الأمرين هو الفرق بين نتيجةٍ وادّعاء.
  f.matchCellCaveat = f.match === 'gated'
    ? 'بُوّبت — ولم يثبت أن القاعدة طابقت الاستدعاء، فقد تكون الصيغة نفسها لم تُطابِق.'
    : null;
  // ⭐ ‏`Write(*)` صيغةٌ مقيَّدة **ظلّلت** — فهي البرهان القاطع أن المقيَّدة تظلّل حين
  // تطابق وسيطتُها. ولذلك تبقى المطابقة بالاسم وحده في `agent.js` **لازمةً لا زائدة**:
  // تضييقُها إلى الاسم المجرّد كان سيفوّت هذه الحالة بالضبط.
  if (f.wildcard === 'bypassed') {
    f.scopedFormCanShadow = true;
    f.scopedFormEvidence = 'Write(*) — صيغة مقيَّدة ظلّلت فعلاً';
  }
  f.note = instrumentValid === false
    ? `⚠️ ${family}: الأداة غير مُبوَّبة بلا قاعدة (canUseToolCalls=${f.controlCalls}) ⇒ آلةُ قياسٍ ميتة، ولا يُقرأ منها تظليل.`
    : instrumentValid === null
      ? `⚠️ ${family}: لم يثبت أن الأداة مُبوَّبة أصلاً — لا يُقرأ منها حكم.`
      : f.mismatch === 'bypassed'
        ? `🔴 ${family}: الوسيطة **مُهمَلة** — حتى قاعدةٌ لا تطابق ظلّلت ⇒ المطابقة بالاسم وحده مصيبةٌ لا توسيع.`
        : f.mismatch === 'gated' && f.bare === 'bypassed'
          ? `${family}: **الاسم المجرّد وحده هو الذي ظلّل**؛ والمقيَّدةُ المخالِفة بُوّبت ⇒ `
            + 'الوسيطة تُقرأ فعلاً (وإلا لظلّلت المخالِفة كما ظلّل المجرّد). '
            + 'ولا يُقاس من هذا أن المقيَّدة لا تظلّل أبداً — انظر matchCellCaveat.'
          : f.mismatch === 'gated'
            ? `${family}: الصيغة المقيَّدة بُوّبت بشقّيها، والاسم المجرّد غير محسوم هنا.`
            : `⚠️ ${family}: خلايا غير محسومة — لا يُبنى عليها حكم.`;
}

console.log(JSON.stringify(out, null, 2));
process.exit(0);
