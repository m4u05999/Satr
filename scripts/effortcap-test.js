#!/usr/bin/env node
/**
 * سطر — حارس سقف الجهد (OBS-196).
 *
 * يغطّي `electron/effortcap.js` النقي: القصّ بالسقف، وأسبقية سقف النموذج داخل الملف
 * الواحد، و«الأدنى يغلب» عبر ملفات الإعدادات، وتجاهل القيمة الفاسدة، ووسم `max` جلسياً.
 * وقارئُ الملفات يُختبر بـ`io` محقون (‏`lstatSync`/`readFileSync`) — بلا قرص ولا شبكة.
 *
 * ويُثبَّت الوصل بـ`main.js` نصّياً: حارسٌ لا يرى المستهلك يخضرّ بينما المنطق معزول
 * عن التطبيق (درس «وصول البيانات لا استهلاكها»).
 *
 * التشغيل: node scripts/effortcap-test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const effortcap = require('../electron/effortcap');

let passed = 0;
let total = 0;
function check(label, cond) {
  total++;
  assert.ok(cond, 'فشل: ' + label);
  passed++;
  console.log('✓ ' + label);
}

const ALL = ['low', 'medium', 'high', 'xhigh', 'max'];
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── 1) بلا سقف = كما كان ─────────────────────────────────────────────────
check('بلا أي سقف تبقى القائمة حرفياً',
  eq(effortcap.clampEffortLevels(ALL, {}), ALL));
check('caps غائبة كلياً ⇒ القائمة كما هي',
  eq(effortcap.clampEffortLevels(ALL, null), ALL));
check('قائمة فارغة تبقى فارغة',
  eq(effortcap.clampEffortLevels([], { maxEffortLevel: 'high' }), []));
check('ما ليس نصاً في المستويات يُسقَط',
  eq(effortcap.clampEffortLevels(['low', 7, null, 'high', 'ultra'], {}), ['low', 'high']));

// ── 2) سقف عام ───────────────────────────────────────────────────────────
check('سقف عام high يحذف xhigh وmax',
  eq(effortcap.clampEffortLevels(ALL, { maxEffortLevel: 'high' }), ['low', 'medium', 'high']));
check('سقف عام max لا يحذف شيئاً (أعلى الرتب)',
  eq(effortcap.clampEffortLevels(ALL, { maxEffortLevel: 'max' }), ALL));
check('سقف عام low يبقي low وحده',
  eq(effortcap.clampEffortLevels(ALL, { maxEffortLevel: 'low' }), ['low']));

// ── 3) سقف النموذج يغلب السقف العام (داخل المصدر الواحد) ─────────────────
check('modelMax=medium يغلب maxEffortLevel=xhigh',
  eq(effortcap.clampEffortLevels(ALL, { maxEffortLevel: 'xhigh', modelMax: 'medium' }), ['low', 'medium']));
check('modelMax=max يعفي النموذج من سقف عام أدنى («max exempts it»)',
  eq(effortcap.clampEffortLevels(ALL, { maxEffortLevel: 'low', modelMax: 'max' }), ALL));
check('modelMax فاسد ⇒ يسقط إلى السقف العام',
  eq(effortcap.clampEffortLevels(ALL, { maxEffortLevel: 'medium', modelMax: 'insane' }), ['low', 'medium']));

// ── 4) قيمة فاسدة تُتجاهل ────────────────────────────────────────────────
for (const bad of ['ultra', 'MAX', '', 'high ', 42, null, {}, ['high']]) {
  check('سقف فاسد (' + JSON.stringify(bad) + ') يُتجاهل فلا يقصّ شيئاً',
    eq(effortcap.clampEffortLevels(ALL, { maxEffortLevel: bad }), ALL));
}

// ── 5) القصّ لا يُفرغ القائمة (فارغة = «لم يعلن» في العقد) ────────────────
check('سقف أدنى من كل المعلَن يعيد أدنى رتبة لا مصفوفة فارغة',
  eq(effortcap.clampEffortLevels(['high', 'xhigh'], { maxEffortLevel: 'low' }), ['high']));

// ── 6) الأدنى يغلب عبر الملفات ───────────────────────────────────────────
const MODEL = 'claude-opus-5';
check('الأدنى يغلب: ملف high وملف medium ⇒ medium',
  effortcap.effectiveCap([{ maxEffortLevel: 'high' }, { maxEffortLevel: 'medium' }], MODEL) === 'medium');
check('الترتيب لا يغيّر النتيجة (medium ثم high ⇒ medium)',
  effortcap.effectiveCap([{ maxEffortLevel: 'medium' }, { maxEffortLevel: 'high' }], MODEL) === 'medium');
check('بلا سقف في أي ملف ⇒ null',
  effortcap.effectiveCap([{}, { modelSettings: {} }], MODEL) === null);
// العضّة التي تفرض الحساب داخل الملف قبل الدمج: سقف عام منخفض في ملف، وسقف
// نموذجي مرتفع في ملف آخر — الصحيح `low` (الأدنى)، والخاطئ `xhigh` (أسبقية عالمية).
check('سقف عام low في ملف + سقف نموذجي xhigh في آخر ⇒ low (لا xhigh)',
  effortcap.effectiveCap([
    { maxEffortLevel: 'low' },
    { modelSettings: { 'claude-opus-5': { maxEffortLevel: 'xhigh' } } },
  ], MODEL) === 'low');
check('سقف نموذجي يحلّ محلّ العام داخل الملف الواحد',
  effortcap.fileCap({ maxEffortLevel: 'low', modelSettings: { 'claude-opus-5': { maxEffortLevel: 'xhigh' } } }, MODEL) === 'xhigh');
check('سقف نموذجي لنموذج آخر لا يمسّ نموذجنا',
  effortcap.fileCap({ maxEffortLevel: 'high', modelSettings: { 'claude-haiku-4-5': { maxEffortLevel: 'low' } } }, MODEL) === 'high');
check('ملف غير كائن ⇒ null',
  effortcap.fileCap(['not', 'an', 'object'], MODEL) === null && effortcap.fileCap(null, MODEL) === null);

// ── 7) مطابقة اسم النموذج بصيغه المختلفة ─────────────────────────────────
check('صيغة [1m] تطابق الاسم القانوني',
  effortcap.fileCap({ modelSettings: { 'claude-opus-5': { maxEffortLevel: 'low' } } }, 'claude-opus-5[1m]') === 'low');
check('الصيغة المؤرَّخة تطابق',
  effortcap.fileCap({ modelSettings: { 'claude-haiku-4-5': { maxEffortLevel: 'low' } } }, 'claude-haiku-4-5-20251001') === 'low');
check('صيغة Bedrock تطابق',
  effortcap.fileCap({ modelSettings: { 'claude-opus-5': { maxEffortLevel: 'medium' } } }, 'us.anthropic.claude-opus-5-v1:0') === 'medium');
check('نموذج مختلف لا يطابق',
  effortcap.canonicalModel('claude-opus-5') !== effortcap.canonicalModel('claude-sonnet-5'));

// ── 8) وسم max جلسياً ────────────────────────────────────────────────────
const info = effortcap.describeEffortLevels(['low', 'high', 'max']);
check('max يُوسم sessionOnly:true',
  info.some((entry) => entry.level === 'max' && entry.sessionOnly === true));
check('ما دون max يُوسم sessionOnly:false',
  info.filter((entry) => entry.level !== 'max').every((entry) => entry.sessionOnly === false));
check('الوسم يحافظ على الترتيب ولا يزيد عناصر',
  eq(info.map((entry) => entry.level), ['low', 'high', 'max']));
check('مستوى فاسد لا يدخل الوسم',
  eq(effortcap.describeEffortLevels(['low', 'ultra', 9]).map((e) => e.level), ['low']));

// ── 9) القارئ: سقف حجم ورابط رمزي وتلف ومحرف BOM ─────────────────────────
function fakeIo(files) {
  return {
    lstatSync(file) {
      const entry = files[file];
      if (!entry) { const error = new Error('ENOENT'); error.code = 'ENOENT'; throw error; }
      return {
        isSymbolicLink: () => entry.symlink === true,
        isFile: () => entry.symlink !== true && entry.dir !== true,
        size: entry.size !== undefined ? entry.size : Buffer.byteLength(entry.text || '', 'utf8'),
      };
    },
    readFileSync(file) {
      const entry = files[file];
      if (!entry) { const error = new Error('ENOENT'); error.code = 'ENOENT'; throw error; }
      return entry.text;
    },
  };
}

const HOME = path.join('X:', 'home');
const CWD = path.join('X:', 'proj');
const userFile = path.join(HOME, '.claude', 'settings.json');
const projectFile = path.join(CWD, '.claude', 'settings.json');
const localFile = path.join(CWD, '.claude', 'settings.local.json');

check('settingsPaths يعيد الملفات الثلاثة بالترتيب',
  eq(effortcap.settingsPaths({ homeDir: HOME, cwd: CWD }), [userFile, projectFile, localFile]));
check('بلا cwd يُقرأ ملف المستخدم وحده',
  eq(effortcap.settingsPaths({ homeDir: HOME }), [userFile]));

const readOpts = (files) => ({ homeDir: HOME, cwd: CWD, io: fakeIo(files) });

check('الأدنى عبر الملفات الثلاثة المقروءة فعلاً',
  effortcap.effectiveCap(effortcap.readSettings(readOpts({
    [userFile]: { text: '{"maxEffortLevel":"xhigh"}' },
    [projectFile]: { text: '{"maxEffortLevel":"high"}' },
    [localFile]: { text: '{"maxEffortLevel":"medium"}' },
  })), MODEL) === 'medium');

check('ملف غائب لا يُسقط القراءة (fail-open)',
  effortcap.effectiveCap(effortcap.readSettings(readOpts({
    [userFile]: { text: '{"maxEffortLevel":"high"}' },
  })), MODEL) === 'high');

check('JSON تالف يُتجاهل ولا يرمي',
  effortcap.effectiveCap(effortcap.readSettings(readOpts({
    [userFile]: { text: '{ not json' },
    [projectFile]: { text: '{"maxEffortLevel":"high"}' },
  })), MODEL) === 'high');

check('محرف BOM في أول الملف لا يكسر التحليل',
  effortcap.effectiveCap(effortcap.readSettings(readOpts({
    [userFile]: { text: '\uFEFF{"maxEffortLevel":"low"}' },
  })), MODEL) === 'low');

check('ملف فوق سقف الحجم لا يُقرأ',
  eq(effortcap.readSettings(readOpts({
    [userFile]: { text: '{"maxEffortLevel":"low"}', size: effortcap.MAX_SETTINGS_BYTES + 1 },
  })), []));

check('رابط رمزي يُرفض قبل القراءة',
  eq(effortcap.readSettings(readOpts({
    [userFile]: { text: '{"maxEffortLevel":"low"}', symlink: true },
  })), []));

check('مجلد باسم الملف يُرفض',
  eq(effortcap.readSettings(readOpts({
    [userFile]: { text: '{}', dir: true },
  })), []));

check('clampForModel يجمع القراءة والقصّ',
  eq(effortcap.clampForModel(ALL, effortcap.readSettings(readOpts({
    [userFile]: { text: '{"modelSettings":{"claude-opus-5":{"maxEffortLevel":"medium"}},"maxEffortLevel":"xhigh"}' },
  })), MODEL), ['low', 'medium']));

// ── 10) الوصل بـmain.js — الحارس يرى المستهلك لا الوحدة وحدها ────────────
const mainSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
check('main.js يستورد effortcap',
  /require\('\.\/effortcap'\)/.test(mainSource));
check('main.js يقرأ الإعدادات مرة واحدة لبناء القائمة',
  /effortcap\.readSettings\(\{\s*homeDir: os\.homedir\(\), cwd\s*\}\)/.test(mainSource));
check('main.js يقصّ مستويات المنتقي بـclampForModel',
  /effortcap\.clampForModel\(levels, settingsFiles,/.test(mainSource));
check('main.js يضيف وسم المستويات الجلسيّة إلى عقد المنتقي',
  /model\.effortLevelInfo = effortcap\.describeEffortLevels\(effortLevels\);/.test(mainSource));

console.log('\nالنتيجة: ' + passed + '/' + total + ' ناجحة.');
