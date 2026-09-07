#!/usr/bin/env node
'use strict';

/**
 * مسبار OBS-140 (لماذا يفترق المشروع عن المستخدم) — **قطعي بلا دور واحد**.
 *
 * ⚠️ **مسبار قياس لا حارس**: خارج `test:full` عمداً. ولا يستهلك أدواراً: يستدعي
 * `resolveSettings()` المُصدَّرة من SDK — وهي «‏the same merge engine as the CLI,
 * without spawning the Claude CLI» — فيرى ما يراه `query()` بلا نموذج ولا شبكة.
 *
 * ## السؤال
 *
 * قِيس أن قاعدة `permissions.allow` في **إعداد المستخدم** تتخطّى `canUseTool`، وأن
 * القاعدة نفسها في **إعداد المشروع** لا تتخطّاه — بينما `deny` من المشروع **يُطاع**
 * (أسقط الأداة من `system:init`). فالملف مقروء، والفرق في **ماذا يُطاع منه**.
 *
 * ## الفرضية التي تُختبَر
 *
 * الفرضية: التمييز **بحسب اتجاه القاعدة لا بحسب الملف** — `deny` تقييدية فتُطاع من
 * أي مصدر، و`allow` توسيعية فتُصفّى من المصادر المُلتزَمة في المستودع. وسندُها من
 * `sdk.d.ts` نفسه: `filterEscalatingDefaultMode` توثّق «‏trust-tier filter … if
 * `permissions.defaultMode` is escalating … AND was set by a repo-committed tier
 * (`project`), drop it». وعدّة مفاتيح أخرى تقول صراحةً «‏Only honored from user,
 * managed/policy, or CLI settings — project settings … are ignored».
 *
 * ⚠️ **لكن التوثيق يخصّ `defaultMode` لا `allow`** — فالتشابه فرضية لا نتيجة،
 * وهذا المسبار يقيسها بدل تعميمها.
 *
 * ## ماذا يُقاس بالضبط
 *
 * `resolveSettings` يعيد `effective` (المدموج) و`sources` (الخام لكل مصدر بالسبقية).
 * فإن ظهرت قاعدة المشروع في `sources` **وغابت أو بقيت** في `effective` عرفنا **أين**
 * تقع التصفية: في دمج الإعدادات، أم بعده في مُقيِّم الأذونات.
 *
 * التشغيل:  node scripts/obs140-scope-diff-probe.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const REAL_HOME = os.homedir();

function plant(dir, rel, value) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
  return file;
}

function pick(settings) {
  const p = (settings && settings.permissions) || {};
  return {
    allow: Array.isArray(p.allow) ? p.allow.slice() : null,
    deny: Array.isArray(p.deny) ? p.deny.slice() : null,
    ask: Array.isArray(p.ask) ? p.ask.slice() : null,
    defaultMode: p.defaultMode == null ? null : String(p.defaultMode),
  };
}

// ── العملية الابنة: تقيس نطاق المستخدم ببيتها المعزول ───────────────────────
const childIdx = process.argv.indexOf('--child');
if (childIdx !== -1) {
  (async () => {
    const { resolveSettings, filterEscalatingDefaultMode } = require('@anthropic-ai/claude-agent-sdk');
    const cwd = process.argv[childIdx + 1];
    const r = await resolveSettings({ cwd, settingSources: ['user', 'project', 'local'] });
    const userSource = (r.sources || []).find((s) => s.source === 'user');
    const userPerms = userSource && userSource.settings && userSource.settings.permissions;
    console.log('__RESULT__' + JSON.stringify({
      homeSeenByChild: os.homedir(),
      rawInUserSource: userSource ? pick(userSource.settings) : null,
      effective: pick(r.effective),
      provenanceOfPermissions: (r.provenance && r.provenance.permissions
        && r.provenance.permissions.source) || null,
      afterEscalatingFilter: pick(filterEscalatingDefaultMode(r)),
      sourceNames: (r.sources || []).map((s) => s.source),
      // برهان أن العزل عمل: المصدر user يحمل قواعدنا المزروعة لا قواعد المالك.
      isolationWorked: Array.isArray(userPerms && userPerms.allow),
    }));
    process.exit(0);
  })().catch((e) => {
    console.log('__RESULT__' + JSON.stringify({ error: String((e && e.message) || e) }));
    process.exit(1);
  });
  return;
}

(async () => {
  const { resolveSettings, filterEscalatingDefaultMode } = require('@anthropic-ai/claude-agent-sdk');
  const out = { ok: true, scenarios: {} };
  out.sdkVersion = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'),
    'utf8',
  )).version;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'obs140-scope-'));

  // القواعد الأربع في مشهد واحد لكل نطاق: توسيعيتان (allow/defaultMode) وتقييديتان
  // (deny/ask). إن صحّت الفرضية سقطت التوسيعيتان من المشروع وبقيت التقييديتان.
  const payload = {
    permissions: {
      allow: ['Write'],
      deny: ['Bash'],
      ask: ['Edit'],
      defaultMode: 'acceptEdits',
    },
  };

  // ① نطاق المشروع: `.claude/settings.json` داخل cwd.
  {
    const cwd = path.join(root, 'proj');
    fs.mkdirSync(cwd, { recursive: true });
    plant(cwd, path.join('.claude', 'settings.json'), payload);
    const r = await resolveSettings({ cwd, settingSources: ['user', 'project', 'local'] });
    const projectSource = (r.sources || []).find((s) => s.source === 'project');
    out.scenarios.project = {
      rawInProjectSource: projectSource ? pick(projectSource.settings) : null,
      effective: pick(r.effective),
      provenanceOfPermissions: (r.provenance && r.provenance.permissions
        && r.provenance.permissions.source) || null,
      afterEscalatingFilter: pick(filterEscalatingDefaultMode(r)),
      sourceNames: (r.sources || []).map((s) => s.source),
    };
  }

  // ② نطاق المستخدم: **عملية ابنة** ببيت معزول.
  //
  // ⚠️ أوّل صياغة غيّرت `process.env.HOME` داخل العملية نفسها — و**لم تعمل**:
  // ‏`isolationWorked:false` وقُرئت إعدادات المالك الحقيقية بدل المزروعة. مسار البيت
  // محسوبٌ قبل التغيير، وهو الفخّ عينه الذي تجنّبه مسبار إعدادات المستخدم بعملية
  // ابنة — ثم أُخذ هنا الطريقُ القصير فبيّته. العزل بالبناء لا بالثقة.
  {
    const home = path.join(root, 'home');
    plant(home, path.join('.claude', 'settings.json'), payload);
    const cwd = path.join(root, 'proj2');
    fs.mkdirSync(cwd, { recursive: true });
    const res = require('child_process').spawnSync(
      process.execPath, [__filename, '--child', cwd], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, USERPROFILE: home },
        timeout: 60000,
      },
    );
    const line = String(res.stdout || '').split('\n').find((l) => l.startsWith('__RESULT__'));
    try {
      out.scenarios.user = JSON.parse(line.slice('__RESULT__'.length));
    } catch (e) {
      out.scenarios.user = { error: 'تعذّر تحليل خرج الابن', stderrTail: String(res.stderr || '').slice(-300) };
    }
  }

  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* أفضل جهد */ }

  const p = out.scenarios.project || {};
  const u = out.scenarios.user || {};
  const has = (v, name) => Array.isArray(v) && v.includes(name);
  out.verdict = {
    // هل تصل قاعدة المشروع إلى `effective` أصلاً؟ الجواب يحدّد **موضع** التصفية.
    projectAllowReachesEffective: has(p.effective && p.effective.allow, 'Write'),
    projectDenyReachesEffective: has(p.effective && p.effective.deny, 'Bash'),
    userAllowReachesEffective: has(u.effective && u.effective.allow, 'Write'),
    projectDefaultModeInEffective: (p.effective && p.effective.defaultMode) || null,
    projectDefaultModeAfterFilter: (p.afterEscalatingFilter && p.afterEscalatingFilter.defaultMode) || null,
    userDefaultModeAfterFilter: (u.afterEscalatingFilter && u.afterEscalatingFilter.defaultMode) || null,
    userIsolationWorked: u.isolationWorked === true,
  };
  out.verdict.note = out.verdict.projectAllowReachesEffective
    ? 'قاعدة المشروع **تصل** إلى الإعدادات الفعّالة ⇒ التصفية ليست في دمج الإعدادات بل بعده، في مُقيِّم الأذونات.'
    : 'قاعدة المشروع **لا تصل** إلى الإعدادات الفعّالة ⇒ التصفية تقع في دمج الإعدادات نفسه.';

  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
})().catch((err) => {
  console.log(JSON.stringify({ ok: false, error: String((err && err.message) || err) }, null, 2));
  process.exit(1);
});
