#!/usr/bin/env node
/**
 * سطر — حارس تحصين استدعاءات git (‏OBS-136).
 *
 * **العطل المحروس**: `.git/config` جزء من المستودع، وفيه مفاتيح **يشغّل git برنامجاً**
 * مسمّى فيها. فمستودعٌ يصل المستخدم ملفاتٍ ومعه `.git` (‏zip · USB · قرص مشترك) ينفّذ
 * ما فيه بمجرّد أن يشغّل «سطر» أمر git ليعرف أين هو — و«افتح مجلداً» أول فعل فيه.
 *
 * **الفحص سلوكيّ لا نصّي**: يبني مستودعاً حقيقياً، يزرع فيه `core.fsmonitor` و
 * `diff.external` يكتبان ملفاً على القرص، ثم يشغّل دوال الإنتاج (‏`gitdiff.changes`)
 * ويشترط أن **الملف لم يُكتب**. زرعُ فخٍّ لا يُنفَّذ خيرٌ من grep على سطر.
 */

'use strict';

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const gitsafe = require('../electron/gitsafe');
const gitdiff = require('../electron/gitdiff');

let checks = 0;
const failures = [];
function check(name, fn) {
  checks += 1;
  try { fn(); } catch (e) { failures.push(name + ' — ' + (e && e.message)); }
}

// ── ① الوحدة النقية ──────────────────────────────────────────────────────────
check('gitArgs يسبق الأمر الفرعي بـ-c (‏git يتجاهلها بعده)', () => {
  const out = gitsafe.gitArgs(['status', '--porcelain']);
  assert.strictEqual(out[0], '-c', 'أول وسيطة ليست -c');
  const commandIndex = out.indexOf('status');
  const lastConfig = out.lastIndexOf('-c');
  assert.ok(lastConfig < commandIndex, 'أحد مفاتيح -c جاء بعد الأمر الفرعي فيُتجاهل');
  assert.deepStrictEqual(out.slice(commandIndex), ['status', '--porcelain'], 'الوسائط الأصلية تغيّرت');
});

check('‏fsmonitor يُبطَل بـ-c، ولا مفتاح ثالث بلا قياس', () => {
  assert.ok(gitsafe.gitArgs([]).join(' ').includes('core.fsmonitor=false'), 'fsmonitor غير مُبطَل');
  // العدد مثبَّت عمداً: `core.pager` أُسقط لأن المسبار أثبت أنه لا يقع مع execFile
  // (بلا tty) وكسر `test:reviewchanges`؛ و`diff.external` انتقل إلى علم الأمر.
  assert.strictEqual(gitsafe.SAFE_CONFIG.length, 1,
    'تغيّر عدد مفاتيح -c — أي إضافة تحتاج قياساً يثبت أنها تقع فعلاً ولا تكسر أمراً');
  assert.ok(Object.isFrozen(gitsafe.SAFE_CONFIG), 'القائمة غير مجمَّدة');
});

check('‏diff.external يُبطَل بعلم الأمر لا بـ-c (‏-c الفارغ يكسر git برمز 128)', () => {
  const d = gitsafe.gitArgs(['diff', '--binary', 'HEAD']);
  assert.ok(!d.join(' ').includes('diff.external'), '-c diff.external= يكسر git diff — استُبدل بالعلم');
  assert.strictEqual(d[d.indexOf('diff') + 1], '--no-ext-diff', 'العلم ليس بعد الأمر الفرعي');
  assert.deepStrictEqual(d.slice(d.indexOf('--no-ext-diff') + 1), ['--binary', 'HEAD'], 'الوسائط الأصلية تغيّرت');
  for (const cmd of ['log', 'show']) {
    assert.ok(gitsafe.gitArgs([cmd, 'HEAD']).includes('--no-ext-diff'), cmd + ' بلا --no-ext-diff');
  }
  // ولا يُضاف لما لا يقبله: `git status --no-ext-diff` يفشل
  for (const cmd of ['status', 'rev-parse', 'commit', 'apply', 'ls-files']) {
    assert.ok(!gitsafe.gitArgs([cmd]).includes('--no-ext-diff'), cmd + ' لا يقبل --no-ext-diff');
  }
});

check('المدخل غير المصفوفة يعود كما هو (لا يُخفي خطأ استدعاء)', () => {
  assert.strictEqual(gitsafe.gitArgs(undefined), undefined);
  assert.strictEqual(gitsafe.gitArgs('status'), 'status');
});

// ── ② الوصل: النقاط الخمس تمرّ بالوحدة ───────────────────────────────────────
// فحص ساكن مقصود: الفخّ السلوكي أدناه يغطّي `gitdiff` وحده (هو المسار القرائي
// الآمن)، أما `gitactions`/`merger` فيكتبان و`worktrees` ينشئ نسخاً — فلا تُشغَّل
// هنا. فيبقى الوصل محروساً نصّياً كي لا يسقط ملفٌ من التحصين صامتاً.
check('الملفات الخمسة تستدعي git عبر gitArgs', () => {
  for (const name of ['gitdiff', 'gitactions', 'worktrees', 'merger', 'reviewchanges']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'electron', name + '.js'), 'utf8');
    assert.ok(/require\('\.\/gitsafe'\)/.test(source), name + '.js لا يستورد gitsafe');
    assert.ok(/\(\s*'git'\s*,\s*gitArgs\(/.test(source),
      name + '.js يستدعي git بوسائط غير محصَّنة — مرّرها عبر gitArgs');
    assert.ok(!/\(\s*'git'\s*,\s*args\s*,/.test(source),
      name + '.js ما زال فيه استدعاء git خام (args بلا gitArgs)');
  }
});

// ── ③ الفخّ: مستودع حقيقي بإعداد مُنفِّذ ─────────────────────────────────────
function gitInit(dir) {
  const run = (args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore', windowsHide: true });
  run(['init', '--quiet']);
  run(['config', 'user.email', 'guard@satr.test']);
  run(['config', 'user.name', 'satr guard']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'أول سطر\n', 'utf8');
  run(['add', 'a.txt']);
  run(['commit', '--quiet', '-m', 'seed']);
}

async function trapTest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'obs136-'));
  const repo = path.join(root, 'repo');
  const marker = path.join(root, 'PWNED.txt');
  fs.mkdirSync(repo, { recursive: true });
  try {
    gitInit(repo);

    // الحمولة سكربتٌ يكتب ملفاً — لا أمرٌ مضمّن.
    // ⚠️ `git config` يعامل «\» كمحرف هروب، فمسار ويندوز الخام يعطي
    // `fatal: bad config line` فيصير الفخّ عاجزاً والفحص أعمى (وقع فعلاً أثناء بناء
    // هذا الحارس). الشرطة الأمامية مقبولة على ويندوز وتتفادى التهريب كلياً.
    const slash = (p) => p.split(path.sep).join('/');
    const script = path.join(root, process.platform === 'win32' ? 'pwn.bat' : 'pwn.sh');
    fs.writeFileSync(script, process.platform === 'win32'
      ? '@echo off\r\necho pwned > "' + marker + '"\r\n'
      : '#!/bin/sh\necho pwned > "' + marker + '"\n', 'utf8');
    if (process.platform !== 'win32') fs.chmodSync(script, 0o755);
    const payload = slash(script);
    // نكتبه في `.git/config` مباشرةً — تماماً كما يصل في مستودع مضغوط.
    fs.appendFileSync(path.join(repo, '.git', 'config'),
      '\n[core]\n\tfsmonitor = ' + payload + '\n[diff]\n\texternal = ' + payload + '\n', 'utf8');

    // تغيير يجعل `changes` يشغّل status وdiff فعلاً
    fs.writeFileSync(path.join(repo, 'a.txt'), 'أول سطر\nثانٍ\n', 'utf8');

    const result = await gitdiff.changes(repo);
    check('الفخّ: gitdiff.changes يعمل على مستودع مسموم', () => {
      assert.ok(result && result.ok, 'changes فشل: ' + JSON.stringify(result));
      assert.strictEqual(result.repo, true, 'لم يُتعرَّف على المستودع');
    });
    check('الفخّ: لم يُنفَّذ برنامج الإعداد (‏لا ملف PWNED)', () => {
      assert.ok(!fs.existsSync(marker),
        'نُفِّذ برنامج من .git/config — التحصين لا يعمل. الملف: ' + marker);
    });

    // برهان مضاد: بلا تحصين يقع الفخّ فعلاً — وإلا كان الفحص أعلاه بلا معنى.
    try { fs.rmSync(marker, { force: true }); } catch { /* لم يوجد */ }
    let fired = false;
    try {
      execFileSync('git', ['status', '--porcelain'], { cwd: repo, stdio: 'ignore', windowsHide: true });
    } catch { /* قد يفشل الأمر نفسه — المهم أثر الفخّ */ }
    fired = fs.existsSync(marker);
    check('برهان مضاد: git بلا تحصين ينفّذ الفخّ (وإلا فالفحص أعمى)', () => {
      assert.ok(fired,
        'لم يقع الفخّ حتى بلا تحصين — فالفحص أعلاه لا يثبت شيئاً. ' +
        'قد يكون git يرفض المفتاح في هذه البيئة (‏نسخة أحدث أو سياسة أمان).');
    });
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* أفضل جهد */ }
  }
}

(async () => {
  await trapTest();
  if (failures.length) {
    console.error('gitsafe-test: فشل ' + failures.length + ' من ' + checks);
    for (const f of failures) console.error('  ✗ ' + f);
    process.exit(1);
  }
  console.log('gitsafe-test: ok — ' + checks + ' فحصاً (الوحدة، وصل الملفات الخمسة، وفخّ .git/config لا يُنفَّذ).');
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
