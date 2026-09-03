#!/usr/bin/env node
'use strict';

/**
 * حارس تغييرات git وتنبيه «لا شبكة استرجاع» (‏OBS-034) — قطعي، بلا شبكة،
 * بمستودعات git حقيقية مؤقتة.
 *
 * طبقتان:
 * 1) `electron/gitdiff.js`: الحقل الإضافي `head` (‏هل للمستودع commit واحد على
 *    الأقل) في الحالات الثلاث — مستودع بلا التزام، مستودع بعد التزام، ومجلد ليس
 *    مستودعاً — مع عقد عدم تراجع على الحقول القائمة (‏repo/files/more/partial
 *    وشكل الصف)، وأن `head` مشتق من `hasHead` نفسه لا من مصدر حقيقة ثانٍ.
 * 2) منطق التنبيه **المستخرَج من `src/ui/app.js` وقت التشغيل** (نمط منتقي الجهد في
 *    claude-models-test) داخل بيئة مصغّرة: أي انحراف في الكود الإنتاجي يكسر
 *    الاختبار بدل أن يمرّ صامتاً. يغطي: مرة واحدة لكل مشروع، صفر استعلام بعد
 *    التنبيه، صمت المستودع السليم بلا مفتاح، فشل الاستعلام لا يُسكت الجلسة ولا
 *    يرمي، وتوصيل الاستدعاء في فرع `file_edit`.
 */

const assert = require('assert');
const { execFile } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const vm = require('vm');

const gitdiff = require('../electron/gitdiff');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || stdout || error.message).trim())); else resolve(stdout);
    });
  });
}

const commit = (cwd, message) => git(cwd, [
  '-c', 'user.name=Satr Test', '-c', 'user.email=satr@example.invalid', 'commit', '-m', message,
]);

// ---------- استخراج منطق التنبيه من app.js الإنتاجي (لا نسخة موازية) ----------
function loadGitSafetyLogic() {
  const source = read('src/ui/app.js');
  const start = source.indexOf("  const GIT_SAFETY_KEY = 'satr_git_safety_notice::'");
  const end = source.indexOf('  // منسّق الأسطح الواحد:', start);
  assert.ok(start >= 0 && end > start, 'تعذّر استخراج منطق تنبيه git من app.js');

  const notices = [];
  const store = new Map();
  const calls = [];
  const sandbox = {
    exported: {},
    notices,
    calls,
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => { store.set(key, String(value)); },
    },
    window: {},
  };
  vm.runInNewContext(`
    const addNotice = (text) => { notices.push(text); };
    ${source.slice(start, end)}
    exported.gitSafetyState = gitSafetyState;
    exported.warn = warnIfNoGitSafetyNet;
    exported.NOTICES = GIT_SAFETY_NOTICES;
    exported.KEY = GIT_SAFETY_KEY;
  `, sandbox, { filename: 'ui-git-safety-extract.js' });

  // ردّ gitChanges قابل للبرمجة: دالة أو قيمة، ويعدّ النداءات
  const setReply = (reply) => {
    sandbox.window.satr = {
      gitChanges: async (cwd) => {
        calls.push(cwd);
        if (typeof reply === 'function') return reply(cwd);
        return reply;
      },
    };
  };
  const dropBridge = () => { sandbox.window.satr = {}; };
  return Object.assign(sandbox.exported, { notices, calls, store, setReply, dropBridge });
}

async function main() {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'satr-gitdiff-'));
  try {
    // ================= 1) عقد `head` في gitdiff.js =================

    // 1-أ) مستودع بلا أي commit ⇒ repo:true و head:false، وملفاته «جديدة»
    const fresh = path.join(temp, 'fresh-repo');
    await fsp.mkdir(fresh, { recursive: true });
    await git(fresh, ['init']);
    await fsp.writeFile(path.join(fresh, 'a.txt'), 'سطر أول\n', 'utf8');
    const before = await gitdiff.changes(fresh);
    assert.strictEqual(before.ok, true, 'مستودع بلا commit أعاد فشلاً');
    assert.strictEqual(before.repo, true, 'مستودع بلا commit لم يُعدّ مستودعاً');
    assert.strictEqual(before.head, false, 'مستودع بلا commit يجب أن يعيد head:false');
    assert.strictEqual(typeof before.head, 'boolean', 'head ليس boolean');
    // عدم تراجع: الحقول القائمة كما كانت وشكل الصف لم يتغير
    assert(Array.isArray(before.files) && before.files.length === 1, 'قائمة الملفات تغيّرت');
    assert.strictEqual(before.files[0].rel, 'a.txt');
    assert.strictEqual(before.files[0].kind, 'new', 'بلا HEAD يجب أن يكون كل ملف جديداً');
    assert.strictEqual(before.files[0].staged, false);
    // العدد الدقيق يتبع computeDiff القائمة (تعدّ المقطع الفارغ بعد سطر جديد أخير)؛
    // المقصود هنا أن الفرق حُسب فعلاً لا تثبيت ذلك السلوك
    assert(before.files[0].added > 0 && before.files[0].removed === 0, 'فرق الملف الجديد لم يُحسب');
    assert.strictEqual(before.more, 0);
    assert.strictEqual(before.partial, false);

    // 1-ب) بعد أول commit ⇒ head:true (والقيمة الوحيدة التي تغيّرت)
    await git(fresh, ['add', '.']);
    await commit(fresh, 'أول التزام');
    const afterCommit = await gitdiff.changes(fresh);
    assert.strictEqual(afterCommit.ok, true);
    assert.strictEqual(afterCommit.repo, true);
    assert.strictEqual(afterCommit.head, true, 'مستودع بعد commit يجب أن يعيد head:true');
    assert.deepStrictEqual(afterCommit.files, [], 'شجرة نظيفة بعد الالتزام يجب أن تكون بلا ملفات');

    // 1-ج) تعديل بعد الالتزام: head يبقى true والفرق يُحسب من HEAD
    await fsp.writeFile(path.join(fresh, 'a.txt'), 'سطر أول\nسطر ثانٍ\n', 'utf8');
    const modified = await gitdiff.changes(fresh);
    assert.strictEqual(modified.head, true, 'head انقلب بعد تعديل شجرة العمل');
    assert.strictEqual(modified.files[0].kind, 'mod');
    assert.strictEqual(modified.files[0].added, 1, 'فرق التعديل غير دقيق');
    assert.strictEqual(modified.files[0].removed, 0);

    // 1-د) مجلد ليس مستودعاً ⇒ repo:false ويصحبه دائماً head:false
    const plain = path.join(temp, 'plain');
    await fsp.mkdir(plain, { recursive: true });
    await fsp.writeFile(path.join(plain, 'b.txt'), 'x\n', 'utf8');
    const notRepo = await gitdiff.changes(plain);
    assert.strictEqual(notRepo.ok, true);
    assert.strictEqual(notRepo.repo, false, 'مجلد بلا git عُدّ مستودعاً');
    assert.strictEqual(notRepo.head, false, 'repo:false يجب أن يصحبه head:false صراحةً');
    assert.ok(!('files' in notRepo), 'ردّ غير المستودع كسب حقولاً لم تكن فيه');

    // 1-هـ) مصدر حقيقة واحد: head هو hasHead نفسه الذي يحكم حساب الفروقات
    const gitdiffSource = read('electron/gitdiff.js');
    assert(/return \{ ok: true, repo: true, head: hasHead,/.test(gitdiffSource),
      'head لا يُشتق من hasHead — مصدر حقيقة ثانٍ يتباعد بصمت');

    // 1-و) main.js يمرر ردّ gitdiff كما هو (لا قائمة سماح تُسقط الحقل الجديد)
    const mainSource = read('electron/main.js');
    const handler = mainSource.slice(mainSource.indexOf("ipcMain.handle('satr:gitChanges'"));
    assert(handler.slice(0, 700).includes('return await gitdiff.changes(cwd);'),
      'قناة satr:gitChanges لم تعد تمرر ردّ gitdiff كما هو');

    // ================= 2) منطق التنبيه المستخرَج من app.js =================
    const ui = loadGitSafetyLogic();

    // 2-أ) الدالة النقية: الحالات الثلاث + fail-open للصمت
    assert.strictEqual(ui.gitSafetyState({ ok: true, repo: false, head: false }), 'no-repo');
    assert.strictEqual(ui.gitSafetyState({ ok: true, repo: true, head: false }), 'no-head');
    assert.strictEqual(ui.gitSafetyState({ ok: true, repo: true, head: true }), null);
    assert.strictEqual(ui.gitSafetyState({ ok: false, error: 'no_git' }), null, 'ردّ فاشل يجب ألا يُنبّه');
    assert.strictEqual(ui.gitSafetyState({ ok: false, error: 'bad_cwd' }), null);
    assert.strictEqual(ui.gitSafetyState(null), null);
    assert.strictEqual(ui.gitSafetyState(undefined), null);
    assert.strictEqual(ui.gitSafetyState({}), null);
    // بناء أقدم بلا الحقل الجديد ⇒ صمت لا ادّعاء (توافق خلفي)
    assert.strictEqual(ui.gitSafetyState({ ok: true, repo: true }), null,
      'ردّ بلا حقل head يجب أن يصمت لا أن يدّعي غياب الالتزامات');

    // 2-ب) نصّا الإشعارين: عربيان، يميّزان الحالتين، ولا يبدآن بحرف لاتيني قوي
    for (const [state, text] of Object.entries(ui.NOTICES)) {
      assert(/[\u0600-\u06FF]/.test(text), 'إشعار ' + state + ' بلا نص عربي');
      const firstStrong = /[A-Za-z\u0600-\u06FF]/.exec(text);
      assert(firstStrong && /[\u0600-\u06FF]/.test(firstStrong[0]),
        'إشعار ' + state + ' يبدأ بحرف لاتيني قوي فيرسو LTR');
      assert(text.includes('commit'), 'إشعار ' + state + ' لا يذكر العلاج');
    }
    assert(ui.NOTICES['no-repo'].includes('git init'), 'إشعار «ليس مستودعاً» لا يذكر git init');
    assert(!ui.NOTICES['no-head'].includes('git init'), 'إشعار «بلا commit» يطلب git init بلا داعٍ');
    assert.notStrictEqual(ui.NOTICES['no-repo'], ui.NOTICES['no-head'], 'الحالتان بنص واحد');

    // 2-ج) مجلد ليس مستودعاً ⇒ إشعار واحد + مفتاح المشروع
    ui.setReply({ ok: true, repo: false, head: false });
    await ui.warn('D:\\projects\\no-git');
    assert.strictEqual(ui.notices.length, 1, 'لم يظهر التنبيه لمجلد بلا git');
    assert.strictEqual(ui.notices[0], ui.NOTICES['no-repo']);
    assert.strictEqual(ui.store.get(ui.KEY + 'D:\\projects\\no-git'), 'no-repo', 'مفتاح المشروع لم يُكتب');
    assert.strictEqual(ui.calls.length, 1);

    // 2-د) نداء ثانٍ في الجلسة نفسها ⇒ صفر استعلام وصفر إشعار
    await ui.warn('D:\\projects\\no-git');
    assert.strictEqual(ui.notices.length, 1, 'تكرّر التنبيه داخل الجلسة');
    assert.strictEqual(ui.calls.length, 1, 'استُعلم git ثانيةً رغم الفحص السابق');

    // 2-هـ) مشروع نُبّه سابقاً (مفتاح على القرص) ⇒ **بلا أي استعلام** أصلاً
    const warned = 'D:\\projects\\already-warned';
    ui.store.set(ui.KEY + warned, 'no-head');
    await ui.warn(warned);
    assert.strictEqual(ui.notices.length, 1, 'أُعيد التنبيه لمشروع نُبّه سابقاً');
    assert.strictEqual(ui.calls.length, 1, 'استُعلم git رغم وجود مفتاح التنبيه — كلفة بلا فائدة');

    // 2-و) مستودع بلا commit ⇒ الإشعار الثاني تحديداً
    ui.setReply({ ok: true, repo: true, head: false });
    await ui.warn('D:\\projects\\empty-repo');
    assert.strictEqual(ui.notices.length, 2);
    assert.strictEqual(ui.notices[1], ui.NOTICES['no-head']);
    assert.strictEqual(ui.store.get(ui.KEY + 'D:\\projects\\empty-repo'), 'no-head');

    // 2-ز) مستودع سليم ⇒ صمت **وبلا مفتاح** (يُعاد الفحص في جلسة لاحقة)
    ui.setReply({ ok: true, repo: true, head: true });
    await ui.warn('D:\\projects\\healthy');
    assert.strictEqual(ui.notices.length, 2, 'ظهر تنبيه لمستودع سليم');
    assert.strictEqual(ui.store.has(ui.KEY + 'D:\\projects\\healthy'), false,
      'كُتب مفتاح لمستودع سليم — يُلغي فحصاً مستقبلياً بلا داعٍ');

    // 2-ح) فشل الاستعلام: صمت، بلا رمي، ولا يُسكت بقية الجلسة
    const before2 = ui.calls.length;
    ui.setReply(() => { throw new Error('IPC مقطوع'); });
    await ui.warn('D:\\projects\\flaky'); // لا يرمي
    assert.strictEqual(ui.notices.length, 2, 'ظهر تنبيه رغم فشل الاستعلام');
    assert.strictEqual(ui.calls.length, before2 + 1);
    ui.setReply({ ok: true, repo: false, head: false });
    await ui.warn('D:\\projects\\flaky'); // الباب أُعيد فتحه بعد الفشل
    assert.strictEqual(ui.calls.length, before2 + 2, 'فشل عابر أسكت المشروع لبقية الجلسة');
    assert.strictEqual(ui.notices.length, 3, 'التنبيه لم يظهر بعد نجاح إعادة المحاولة');

    // 2-ط) غياب الجسر أو cwd فارغ ⇒ صمت بلا رمي وبلا استعلام
    const before3 = ui.calls.length;
    ui.dropBridge();
    await ui.warn('D:\\projects\\no-bridge');
    assert.strictEqual(ui.calls.length, before3, 'استُعلم رغم غياب window.satr.gitChanges');
    assert.strictEqual(ui.notices.length, 3);
    ui.setReply({ ok: true, repo: false, head: false });
    await ui.warn('   ');
    await ui.warn('');
    await ui.warn(null);
    assert.strictEqual(ui.calls.length, before3, 'cwd فارغ أطلق استعلاماً');
    assert.strictEqual(ui.notices.length, 3);

    // ================= 3) التوصيل في مجرى الأحداث =================
    const appSource = read('src/ui/app.js');
    const fileEditBranch = appSource.slice(
      appSource.indexOf("} else if (ev.type === 'file_edit') {"),
      appSource.indexOf("} else if (ev.type === 'result') {"),
    );
    assert(fileEditBranch.includes('warnIfNoGitSafetyNet('),
      'فرع file_edit لا يستدعي فحص شبكة الاسترجاع');
    assert(fileEditBranch.indexOf('recordSessionChange(ev)') < fileEditBranch.indexOf('warnIfNoGitSafetyNet('),
      'الفحص يسبق عرض الفرق — يجب أن يكون كسولاً بعده');
    assert(!/await\s+warnIfNoGitSafetyNet\(/.test(fileEditBranch),
      'الفحص مُنتظَر بـawait فيؤخّر معالجة الدور');
    assert(fileEditBranch.includes("sessionCwd || $('cwd').value.trim()"),
      'الفحص لا يستعمل cwd الجلسة نفسه الذي تستعمله بقية الأحداث');

    console.log('✓ head يميّز مستودعاً بلا commit من مستودع ملتزم ومن مجلد ليس مستودعاً');
    console.log('✓ حقول gitdiff القائمة وشكل الصف بلا تراجع، وhead مشتق من hasHead وحده');
    console.log('✓ التنبيه مرة واحدة لكل مشروع، وبعده صفر استعلام، والمستودع السليم صامت بلا مفتاح');
    console.log('✓ فشل الاستعلام وغياب الجسر وcwd الفارغ كلها صامتة بلا رمي ولا إسكات للجلسة');
    console.log('✓ الاستدعاء موصول في فرع file_edit كسولاً بعد عرض الفرق بلا await');
    process.exit(0);
  } finally {
    await fsp.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }).catch(() => {});
  }
}

main().catch((error) => {
  console.error('gitdiff:', error && error.stack ? error.stack : error);
  process.exit(1);
});
