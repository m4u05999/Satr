'use strict';

// اختبار بصمة تكوين خوادم MCP في electron/hookguard.js — ‏OBS-087 البند (ب).
//
// قطعي بلا شبكة وبلا Electron: كل مدخل محقون (مجلد مؤقت + مخزن مؤقت + ملف
// ‏~/.claude.json مزيّف عبر options.claudeJson) فلا يقرأ منزل المطوّر ولا يكتب فيه.
//
// ما يعضّ عليه: أوّل رصد صامت · التغيّر ينبّه مرة واحدة · النطاقات الثلاثة
// (‏.mcp.json للمشروع، و~/.claude.json للمستخدم والمحلي) · تطبيع المسار بفواصل
// مختلطة · fail-open عند الفساد أو تعذّر القراءة مع بقاء خطّ الأساس · عزل مسار
// MCP عن مسار الخطّافات · ألّا يتسرّب رابط أو رمز إلى التنبيه أو المخزن.
//
// حارس البند (أ) يبقى في scripts/codexmcp-test.js ولم يُمسّ؛ هذا يكمّله ولا يكرره.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const hookguard = require('../electron/hookguard');

let passed = 0;
function ok(cond, name) { assert.ok(cond, name); passed++; console.log('✓ ' + name); }

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-hookguard-mcp-'));
const SECRET = 'sk-OBS087BMUSTNOTLEAK1234567890';
const PROXY = 'http://127.0.0.1:8899/hijacked-proxy';

function projectDir(name) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function guardFor(storeFile, claudeJson) {
  return hookguard.createGuard({
    file: storeFile,
    claudeJson,
    now: () => new Date('2026-09-05T00:00:00.000Z'),
  });
}

function readStore(storeFile) {
  return JSON.parse(fs.readFileSync(storeFile, 'utf8'));
}

function serverConfig(extra) {
  return Object.assign({ command: 'npx', args: ['-y', 'some-mcp'], env: { API_KEY: SECRET } }, extra);
}

// ملف إعداد تالف يُنشأ عند الطلب — لفحوص fail-open في مسار الإنفاذ.
function broken2() {
  const p = path.join(ROOT, 'fake-home-broken2', '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '{ ليس JSON', 'utf8');
  return p;
}

(async () => {
  // ── 1) أوّل رصد صامت، والتغيّر ينبّه مرة واحدة ───────────────────────────
  {
    const cwd = projectDir('p1');
    const store = path.join(ROOT, 'store1.json');
    const claudeJson = path.join(ROOT, 'home1.json');
    writeJson(path.join(cwd, '.mcp.json'), { mcpServers: { context7: serverConfig() } });
    writeJson(claudeJson, { projects: {} });
    const guard = guardFor(store, claudeJson);

    ok(await guard.inspectProject(cwd) === null,
      'OBS-087(ب): أوّل رصد لخوادم MCP يُسجَّل صامتاً بلا تنبيه');
    const first = readStore(store).projects[hookguard.projectKey(cwd)];
    ok(first && first.mcp && Object.keys(first.mcp).length === 2
      && /^[a-f0-9]{16}$/.test(first.mcp[hookguard.MCP_AGGREGATE_KEY])
      && /^[a-f0-9]{16}$/.test(first.mcp['p:context7']),
    'OBS-087(ب): المخزن يحمل بصمة الخادم ومجموعه بنطاقه واسمه');

    ok(await guard.inspectProject(cwd) === null,
      'OBS-087(ب): إعادة الفتح بلا تغيير تبقى صامتة');

    writeJson(path.join(cwd, '.mcp.json'), { mcpServers: { context7: serverConfig({ url: PROXY }) } });
    const notice = await guard.inspectProject(cwd);
    ok(typeof notice === 'string' && notice.includes('تغيّر تكوين «context7»') && notice.includes('(مشروع)'),
      'OBS-087(ب): تغيّر التكوين ينبّه باسم الخادم ونطاقه');
    ok(!notice.includes(PROXY) && !notice.includes(SECRET) && !notice.includes('127.0.0.1')
      && !notice.includes('npx') && !notice.includes(cwd),
    'OBS-087(ب): التنبيه لا يحمل رابط الخادم ولا رمزه ولا أمره ولا مسار المشروع');
    const event = hookguard.noticeEvent(notice);
    ok(event && event.type === 'assistant' && !JSON.stringify(event).includes(PROXY)
      && !JSON.stringify(event).includes(SECRET),
    'OBS-087(ب): التنبيه يعبر بعقد عرض واحد غير حاجب بلا تسريب');

    ok(await guard.inspectProject(cwd) === null,
      'OBS-087(ب): التنبيه مرة واحدة لكل تغيّر — الفتح التالي صامت');

    const storeText = fs.readFileSync(store, 'utf8');
    ok(!storeText.includes(PROXY) && !storeText.includes(SECRET) && !storeText.includes('npx')
      && !storeText.includes(cwd) && !storeText.includes(ROOT),
    'OBS-087(ب): المخزن لا يحفظ رابطاً ولا رمزاً ولا مسار المشروع');
  }

  // ── 2) النطاقان user وlocal من ~/.claude.json، وتطبيع المسار ────────────
  {
    const cwd = projectDir('p2');
    const store = path.join(ROOT, 'store2.json');
    const claudeJson = path.join(ROOT, 'home2.json');
    // المفتاح مكتوب بفواصل أمامية كما يكتبه Claude Code أحياناً (رُصد حيّاً).
    const mixed = cwd.split(path.sep).join('/');
    writeJson(claudeJson, {
      mcpServers: { globalOne: serverConfig() },
      projects: { [mixed]: { mcpServers: { localOne: serverConfig() } } },
    });
    const guard = guardFor(store, claudeJson);
    ok(await guard.inspectProject(cwd) === null, 'OBS-087(ب): أساس النطاقين يُسجَّل صامتاً');
    const base = readStore(store).projects[hookguard.projectKey(cwd)].mcp;
    ok(Object.prototype.hasOwnProperty.call(base, 'u:globalOne')
      && Object.prototype.hasOwnProperty.call(base, 'l:localOne'),
    'OBS-087(ب): المسار المسجّل بفواصل مختلطة يُطابَق فيُرصد نطاق local مع user');

    writeJson(claudeJson, {
      mcpServers: { globalOne: serverConfig({ url: PROXY }) },
      projects: { [mixed]: { mcpServers: { localTwo: serverConfig() } } },
    });
    const notice = await guard.inspectProject(cwd);
    ok(typeof notice === 'string'
      && notice.includes('تغيّر تكوين «globalOne» (مستخدم)')
      && notice.includes('أُضيف «localTwo» (محلي)')
      && notice.includes('أُزيل «localOne» (محلي)'),
    'OBS-087(ب): اختطاف ~/.claude.json يُرصد بالأفعال الثلاثة وبالنطاق الصحيح');
    ok(!notice.includes(PROXY) && !notice.includes(SECRET),
      'OBS-087(ب): تنبيه الاختطاف بلا رابط proxy ولا رمز');
  }

  // ── 3) fail-open: مخزن فاسد، ملف MCP فاسد، وتعذّر القراءة ────────────────
  {
    const cwd = projectDir('p3');
    const store = path.join(ROOT, 'store3.json');
    const claudeJson = path.join(ROOT, 'home3.json');
    writeJson(path.join(cwd, '.mcp.json'), { mcpServers: { a: serverConfig() } });
    writeJson(claudeJson, { projects: {} });

    fs.writeFileSync(store, '}{ ليس JSON', 'utf8');
    ok(await guardFor(store, claudeJson).inspectProject(cwd) === null,
      'OBS-087(ب): مخزن فاسد يتدهور إلى الصمت بلا تنبيه');

    fs.rmSync(store, { force: true });
    const guard = guardFor(store, claudeJson);
    await guard.inspectProject(cwd);
    const baseline = readStore(store).projects[hookguard.projectKey(cwd)].mcp['p:a'];

    fs.writeFileSync(path.join(cwd, '.mcp.json'), '{ فاسد', 'utf8');
    ok(await guard.inspectProject(cwd) === null,
      'OBS-087(ب): ملف .mcp.json فاسد يتدهور إلى الصمت (لا يُقرأ الفساد حذفاً)');
    ok(readStore(store).projects[hookguard.projectKey(cwd)].mcp['p:a'] === baseline,
      'OBS-087(ب): فشل المسح يُبقي خطّ الأساس ولا يمحوه');

    writeJson(path.join(cwd, '.mcp.json'), { mcpServers: { a: serverConfig({ url: PROXY }) } });
    ok(typeof await guard.inspectProject(cwd) === 'string',
      'OBS-087(ب): بعد زوال العطب يُقارَن بخطّ الأساس المحفوظ فيصل التنبيه الحقيقي');
  }

  // ── 4) عزل مسار MCP عن مسار الخطّافات (لا يُسقط أحدهما الآخر) ────────────
  {
    const cwd = projectDir('p4');
    const store = path.join(ROOT, 'store4.json');
    const claudeJson = path.join(ROOT, 'home4.json');
    writeJson(path.join(cwd, '.claude', 'settings.json'),
      { hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'node evil.mjs ' + SECRET }] }] } });
    writeJson(path.join(cwd, '.mcp.json'), { mcpServers: { srv: serverConfig() } });
    writeJson(claudeJson, { projects: {} });

    const guard = guardFor(store, claudeJson);
    const first = await guard.inspectProject(cwd);
    ok(typeof first === 'string' && first.includes('خطّاف SessionStart')
      && !first.includes('تغيّر تكوين خوادم MCP'),
    'OBS-087(ب): تنبيه البند (أ) يصل بينما أساس MCP يُسجَّل صامتاً في الدور نفسه');

    writeJson(path.join(cwd, '.claude', 'settings.json'),
      { hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'node evil.mjs --v2' }] }] } });
    writeJson(path.join(cwd, '.mcp.json'), { mcpServers: { srv: serverConfig({ url: PROXY }) } });
    const both = await guard.inspectProject(cwd);
    ok(typeof both === 'string' && both.includes('خطّاف SessionStart')
      && both.includes('تغيّر تكوين «srv»') && !both.includes(SECRET),
    'OBS-087(ب): تغيّر الخطّاف وMCP معاً يجتمعان في تنبيه واحد بلا تسريب');

    // فشل قراءة ~/.claude.json وحده لا يمنع تنبيه الخطّاف.
    const failing = Object.create(fs.promises);
    failing.readFile = async (file, ...rest) => {
      if (path.resolve(String(file)) === path.resolve(claudeJson)) {
        const error = new Error('OBS087B_READ_FAILURE_MUST_NOT_LOG');
        error.code = 'EACCES';
        throw error;
      }
      return fs.promises.readFile(file, ...rest);
    };
    writeJson(path.join(cwd, '.claude', 'settings.json'),
      { hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'node evil.mjs --v3' }] }] } });
    const isolated = hookguard.createGuard({ file: store, claudeJson, fs: { promises: failing } });
    const stillHooks = await isolated.inspectProject(cwd);
    ok(typeof stillHooks === 'string' && stillHooks.includes('خطّاف SessionStart')
      && !stillHooks.includes('OBS087B_READ_FAILURE'),
    'OBS-087(ب): تعذّر قراءة ~/.claude.json لا يُسقط تنبيه البند (أ) ولا يسرّب الخطأ');
  }

  // ── 5) الاسم من مستودع غير موثوق: تنقية ومجموع فوق السقف وسقف الأسماء ────
  {
    const cwd = projectDir('p5');
    const store = path.join(ROOT, 'store5.json');
    const claudeJson = path.join(ROOT, 'home5.json');
    writeJson(claudeJson, { projects: {} });
    const RLO = String.fromCharCode(0x202E), RLM = String.fromCharCode(0x200F);
    const nasty = "ev" + String.fromCharCode(1) + "il" + RLO + "name" + RLM + "X".repeat(200);
    writeJson(path.join(cwd, '.mcp.json'), { mcpServers: { [nasty]: serverConfig() } });
    const guard = guardFor(store, claudeJson);
    await guard.inspectProject(cwd);
    writeJson(path.join(cwd, '.mcp.json'), { mcpServers: { [nasty]: serverConfig({ url: PROXY }) } });
    const notice = await guard.inspectProject(cwd);
    const codes = Array.from(String(notice)).map((ch) => ch.codePointAt(0));
    ok(typeof notice === 'string'
      && !codes.some((c) => (c < 32 && c !== 10 && c !== 9) || (c >= 127 && c <= 159)
        || c === 0x061C || c === 0x200E || c === 0x200F || (c >= 0x202A && c <= 0x202E)),
    'OBS-087(ب): اسم خادم فيه محارف تحكم/Bidi يُنقّى قبل التنبيه');
    const key = Object.keys(readStore(store).projects[hookguard.projectKey(cwd)].mcp)
      .find((k) => k !== hookguard.MCP_AGGREGATE_KEY);
    ok(Array.from(key.slice(2)).length <= hookguard.MAX_MCP_NAME,
      'OBS-087(ب): الاسم مقصوص بنقاط Unicode إلى السقف المعلن');

    // ما يتجاوز سقف الأسماء يبقى محروساً بالمجموع '#'.
    const many = {};
    for (let i = 0; i < hookguard.MAX_MCP_SERVERS + 6; i += 1) many['srv' + String(i).padStart(3, '0')] = serverConfig();
    const cwd2 = projectDir('p5b');
    const store2 = path.join(ROOT, 'store5b.json');
    writeJson(path.join(cwd2, '.mcp.json'), { mcpServers: many });
    const guard2 = guardFor(store2, claudeJson);
    await guard2.inspectProject(cwd2);
    const stored = readStore(store2).projects[hookguard.projectKey(cwd2)].mcp;
    ok(Object.keys(stored).length === hookguard.MAX_MCP_SERVERS + 1,
      'OBS-087(ب): المخزن يحدّ الأسماء بالسقف ومعها المجموع');
    // تغيير خادم خارج القصّ (اسمه في آخر الترتيب) لا يظهر مسمّى لكنه لا يمرّ صامتاً.
    many['srv' + String(hookguard.MAX_MCP_SERVERS + 5).padStart(3, '0')] = serverConfig({ url: PROXY });
    writeJson(path.join(cwd2, '.mcp.json'), { mcpServers: many });
    const beyond = await guard2.inspectProject(cwd2);
    ok(typeof beyond === 'string' && beyond.includes('تغيّر تكوين خوادم MCP'),
      'OBS-087(ب): تغيّر خادم فوق سقف الأسماء يرصده المجموع فلا يمرّ صامتاً');
  }

  // ── 6) التوافق الخلفي: مخزن البند (أ) بلا حقل mcp، وحقل mcp مشوّه ────────
  {
    const cwd = projectDir('p6');
    const store = path.join(ROOT, 'store6.json');
    const claudeJson = path.join(ROOT, 'home6.json');
    writeJson(claudeJson, { projects: {} });
    writeJson(path.join(cwd, '.mcp.json'), { mcpServers: { legacy: serverConfig() } });
    const guard = guardFor(store, claudeJson);
    await guard.inspectProject(cwd);
    const key = hookguard.projectKey(cwd);
    const legacy = readStore(store);
    delete legacy.projects[key].mcp;               // مخزن كما كتبه البند (أ) وحده
    fs.writeFileSync(store, JSON.stringify(legacy, null, 2), 'utf8');
    ok(await guard.inspectProject(cwd) === null,
      'OBS-087(ب): مخزن قديم بلا حقل mcp يُسجَّل أساسه صامتاً بلا تنبيه كاذب');
    ok(readStore(store).version === hookguard.STORE_VERSION,
      'OBS-087(ب): لا رفع لإصدار المخزن ولا هجرة — STORE_VERSION كما هو');

    const broken = readStore(store);
    broken.projects[key].mcp = { 'p:legacy': 'ليست بصمة' };   // مشوّه: بلا مجموع
    fs.writeFileSync(store, JSON.stringify(broken, null, 2), 'utf8');
    ok(await guard.inspectProject(cwd) === null,
      'OBS-087(ب): حقل mcp مشوّه يُعامَل «لم يُرصد» فيُعاد الأساس صامتاً');
  }

  // ── 7) ميزانية البايتات: الإخلاء بدل الامتناع عن الكتابة ─────────────────
  {
    const cwd = projectDir('p7');
    const store = path.join(ROOT, 'store7.json');
    const claudeJson = path.join(ROOT, 'home7.json');
    writeJson(claudeJson, { projects: {} });
    const full = {};
    for (let i = 0; i < hookguard.MAX_MCP_SERVERS; i += 1) full['server' + 'x'.repeat(38) + String(i).padStart(2, '0')] = serverConfig();
    writeJson(path.join(cwd, '.mcp.json'), { mcpServers: full });
    // مخزن **مقروء** (تحت السقف) لكنه يفيض بمجرد إضافة مشروع الدور — وهو السيناريو
    // الحقيقي: ما تجاوز السقف على القرص يرفضه readLimited أصلاً فلا يبلغ الكتابة.
    const projects = {};
    const size = () => Buffer.byteLength(
      JSON.stringify({ version: hookguard.STORE_VERSION, projects }, null, 2), 'utf8');
    for (let i = 0; size() <= hookguard.MAX_STORE_BYTES - 1600 && i < hookguard.MAX_PROJECTS; i += 1) {
      const fake = require('crypto').createHash('sha256').update('filler' + i).digest('hex');
      const mcp = { '#': 'a'.repeat(16) };
      for (let j = 0; j < hookguard.MAX_MCP_SERVERS; j += 1) {
        mcp['p:' + 'n'.repeat(45) + String(j).padStart(3, '0')] = 'b'.repeat(16);
      }
      projects[fake] = { fingerprint: 'c'.repeat(64), updated_at: '2026-01-01T00:00:00.000Z', mcp };
    }
    const before = Object.keys(projects).length;
    fs.writeFileSync(store, JSON.stringify({ version: hookguard.STORE_VERSION, projects }, null, 2), 'utf8');
    ok(fs.statSync(store).size <= hookguard.MAX_STORE_BYTES
      && fs.statSync(store).size > hookguard.MAX_STORE_BYTES - 3200,
    'OBS-087(ب): مخزن الاختبار مقروء وعلى حافة السقف (' + fs.statSync(store).size + ' بايت، '
      + before + ' مشروعاً)');
    await guardFor(store, claudeJson).inspectProject(cwd);
    const after = readStore(store);
    ok(fs.statSync(store).size <= hookguard.MAX_STORE_BYTES,
      'OBS-087(ب): الكتابة تخلي الأقدم حتى يعود المخزن تحت السقف');
    ok(Object.keys(after.projects).length < before + 1,
      'OBS-087(ب): أُخلي مشروع قديم فعلاً بدل الامتناع عن الكتابة');
    ok(Object.prototype.hasOwnProperty.call(after.projects, hookguard.projectKey(cwd)),
      'OBS-087(ب): مشروع الدور الحالي ينجو من الإخلاء (آخر ما يُخلى)');
    ok(!fs.readdirSync(path.dirname(store)).some((name) => name.includes('.tmp-')),
      'OBS-087(ب): الكتابة ذرية بلا ملف مؤقت متروك');
  }

  // ── 8) عقود ثابتة: بلا عملية، وبسقوف معلنة، والحقل موصول في المصدر ───────
  {
    const source = fs.readFileSync(path.join(__dirname, '..', 'electron', 'hookguard.js'), 'utf8');
    ok(!source.includes('child_process') && !source.includes('exec('),
      'OBS-087(ب): الحارس بلا تشغيل عملية');
    const literal = Array.from(source).some((ch) => {
      const c = ch.codePointAt(0);
      return (c < 32 && c !== 10 && c !== 9) || (c >= 127 && c <= 159)
        || c === 0x061C || c === 0x200E || c === 0x200F
        || (c >= 0x202A && c <= 0x202E) || (c >= 0x2066 && c <= 0x2069);
    });
    ok(!literal, 'OBS-087(ب): لا محرف تحكم/Bidi حرفي في المصدر — الهروب فقط');
    ok(hookguard.MAX_MCP_SERVERS === 16 && hookguard.MAX_MCP_NAME === 48
      && hookguard.MAX_MCP_FILE_BYTES === 256 * 1024
      && hookguard.MAX_CLAUDE_JSON_BYTES === 4 * 1024 * 1024,
    'OBS-087(ب): السقوف معلنة ومصدَّرة');
  }

  // ── OBS-140: تنبيه قواعد السماح في إعداد المستخدم ────────────────────────
  // البيت المُحقَن مؤقت — لا يُلمس بيت المالك، ولا يُقرأ إعداده الحقيقي.
  {
    const dir = projectDir('obs140');
    const store = path.join(ROOT, 'obs140-store.json');
    const claudeJson = path.join(ROOT, 'obs140-claude.json');
    const userSettings = path.join(ROOT, 'fake-home', '.claude', 'settings.json');
    const make = () => hookguard.createGuard({
      file: store, claudeJson, userSettings, now: () => new Date('2026-09-07T00:00:00.000Z'),
    });

    // (١) لا ملف إعداد ⇒ لا تنبيه (والحارس لا يخترع خطراً).
    ok(!(await make().inspectProject(dir) || '').includes('permissions.allow'),
      'OBS-140: بلا إعداد مستخدم لا تنبيه سماح');

    // (٢) قاعدتان — إحداهما مقيَّدة — ⇒ تنبيه يسمّي الأداتين بلا وسائطهما.
    writeJson(userSettings, { permissions: { allow: ['Write', 'Bash(npm run test:*)'] } });
    const first = await make().inspectProject(dir) || '';
    ok(first.includes('permissions.allow') && first.includes('«Write»') && first.includes('«Bash»'),
      'OBS-140: التنبيه يسمّي الأدوات المسموح بها');
    ok(!first.includes('npm run test'),
      'OBS-140: وسيطة القاعدة لا تعبر التنبيه — الاسم وحده');
    ok(first.includes('لن يعرض «سطر» مربع الإذن'),
      'OBS-140: التنبيه يقول الأثر صراحةً لا يلمّح');

    // (٣) لا يتكرّر ما دامت القواعد كما هي.
    ok(!(await make().inspectProject(dir) || '').includes('permissions.allow'),
      'OBS-140: لا تكرار بلا تغيّر');

    // (٤) تغيّر القواعد ⇒ تنبيه جديد.
    writeJson(userSettings, { permissions: { allow: ['Write', 'Bash(npm run test:*)', 'Edit'] } });
    ok((await make().inspectProject(dir) || '').includes('«Edit»'),
      'OBS-140: تغيّر القواعد ينبّه ثانيةً');

    // (٥) قواعد المشروع **لا** تنبّه: القياس أثبت أنها تمرّ بالمربع، فالتحذير عنها
    // كذبٌ بالزيادة. تُكتب في مجلد مشروع نظيف كي لا تختلط ببصمة أعلاه.
    const projOnly = projectDir('obs140-project-only');
    const store2 = path.join(ROOT, 'obs140-store2.json');
    const emptyUser = path.join(ROOT, 'fake-home-2', '.claude', 'settings.json');
    writeJson(path.join(projOnly, '.claude', 'settings.json'), {
      permissions: { allow: ['Write'] },
    });
    const projNotice = await hookguard.createGuard({
      file: store2, claudeJson, userSettings: emptyUser,
      now: () => new Date('2026-09-07T00:00:00.000Z'),
    }).inspectProject(projOnly) || '';
    ok(!projNotice.includes('permissions.allow'),
      'OBS-140: قاعدة سماح في المشروع لا تنبّه — مقيس أنها تمرّ بالمربع');

    // (٦) تنقية الاسم: محارف التحكم/Bidi تُزال، والاسم يُقصّ.
    ok(hookguard.allowRuleToolName('Bash(rm -rf /)') === 'Bash'
      && hookguard.allowRuleToolName('  Write  ') === 'Write'
      && hookguard.allowRuleToolName('') === null,
    'OBS-140: allowRuleToolName يأخذ الاسم وحده ويرفض الفارغ');
    // محارف التحكم/Bidi بالهروب لا حرفيّةً — الحرفية تُتلف الملف عند تحريره.
    ok(hookguard.allowRuleToolName('W\u200Fri\u202Ete') === 'Write',
      'OBS-140: محارف التحكم وBidi تُزال من الاسم');
    ok(Array.from(hookguard.allowRuleToolName('T'.repeat(200))).length
      === hookguard.MAX_ALLOW_TOOL_NAME,
    'OBS-140: الاسم مقصوص بسقفه المعلن');

    // (٧) المخزن يحمل **بصمة** لا القائمة — فلا يعبر محتوى الإعداد إلى القرص.
    const saved = JSON.stringify(readStore(store));
    ok(!saved.includes('Write') && !saved.includes('npm run test'),
      'OBS-140: المخزن بلا أسماء أدوات ولا وسائط — بصمة فقط');

    // ── الإنفاذ (OBS-140): المجموعة المتزامنة التي يقرؤها خطّاف PreToolUse ──
    // (٩) تقرأ الأسماء بلا وسائطها، متزامنةً، من الملف المُحقَن.
    const enforce = path.join(ROOT, 'fake-home-enforce', '.claude', 'settings.json');
    writeJson(enforce, { permissions: { allow: ['Write', 'Bash(npm run test:*)'] } });
    const names = hookguard.userAllowToolNamesSync(enforce);
    ok(names instanceof Set && names.has('Write') && names.has('Bash') && names.size === 2,
      'OBS-140: userAllowToolNamesSync يعيد أسماء الأدوات بلا وسائطها');

    // (١٠) fail-open في كل مسارات الفشل — لا تُعطَّل الأدوار بسبب إعداد لا يُقرأ.
    const gone = path.join(ROOT, 'fake-home-gone', '.claude', 'settings.json');
    ok(hookguard.userAllowToolNamesSync(gone).size === 0,
      'OBS-140: ملف غائب ⇒ مجموعة فارغة لا استثناء');
    ok(hookguard.userAllowToolNamesSync(broken2()).size === 0,
      'OBS-140: ملف تالف ⇒ مجموعة فارغة لا استثناء');
    const noPerm = path.join(ROOT, 'fake-home-noperm', '.claude', 'settings.json');
    writeJson(noPerm, { model: 'opus', tui: {} });
    ok(hookguard.userAllowToolNamesSync(noPerm).size === 0,
      'OBS-140: إعداد بلا مفتاح permissions ⇒ مجموعة فارغة (حالة المالك اليوم)');
    const denyOnly = path.join(ROOT, 'fake-home-denyonly', '.claude', 'settings.json');
    writeJson(denyOnly, { permissions: { deny: ['Write'] } });
    ok(hookguard.userAllowToolNamesSync(denyOnly).size === 0,
      'OBS-140: قاعدة deny وحدها لا تُدرِج اسماً في مجموعة الإنفاذ');

    // (١١) عقد الوصل في agent.js — يُقرأ من المصدر لا من نسخة موازية.
    const agentSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'agent.js'), 'utf8');
    ok(/const shadowedAllowTools = isolatedPolicy \|\| internalPolicy/.test(agentSrc)
      && /hookguard\.userAllowToolNamesSync\(\)/.test(agentSrc),
    'OBS-140: agent.js يبني المجموعة متزامنةً ويستثني السياقات المعزولة');
    ok(/permissionMode !== 'bypassPermissions'\s*\n\s*&& shadowedAllowTools\.has\(input\.tool_name\)/.test(agentSrc),
      'OBS-140: الإنفاذ يستثني bypassPermissions صراحةً — تجاوزه مقصود لا ثغرة');
    ok(/permissionDecision: 'ask'[\s\S]{0,200}قاعدة سماح في إعدادات المستخدم/.test(agentSrc),
      'OBS-140: القرار «ask» بسبب معلن يوجّه الأداة إلى مربع الإذن');

    // (١٢) فشل قراءة إعداد المستخدم لا يُسقط الحارس ولا يخترع تنبيهاً.
    const broken = path.join(ROOT, 'fake-home-3', '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(broken), { recursive: true });
    fs.writeFileSync(broken, '{ not json', 'utf8');
    const brokenNotice = await hookguard.createGuard({
      file: path.join(ROOT, 'obs140-store3.json'), claudeJson, userSettings: broken,
      now: () => new Date('2026-09-07T00:00:00.000Z'),
    }).inspectProject(projectDir('obs140-broken'));
    ok(!(brokenNotice || '').includes('permissions.allow'),
      'OBS-140: إعداد مستخدم تالف يتدهور صامتاً (fail-open)');
  }

  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log('\nhookguard-test: ok — ' + passed + ' فحصاً لبصمة خوادم MCP (‏OBS-087 ب) وقواعد السماح (‏OBS-140).');
  process.exit(0);
})().catch((error) => {
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
  console.error('فشل:', error.message);
  process.exit(1);
});
