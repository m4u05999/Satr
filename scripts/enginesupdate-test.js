/**
 * اختبار كشف تأخّر إصدارات المحرّكات (2.16.3).
 * قطعي بالكامل: لا شبكة (يُحقن `get` مزيف) ولا قرص (noCache).
 * التشغيل: node scripts/enginesupdate-test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const eu = require('../electron/enginesupdate');

let passed = 0;
function check(label, cond) { assert.ok(cond, 'فشل: ' + label); passed++; console.log('✓ ' + label); }

// ---------- مقارنة النسخ ----------
check('نسخة أقدم تُكشف', eu.compareVersions('2.1.220', '2.1.241') === -1);
check('نسخة مطابقة', eu.compareVersions('0.149.0', '0.149.0') === 0);
check('نسخة أحدث لا تُعدّ تأخّراً', eu.compareVersions('2.2.0', '2.1.241') === 1);
check('لاحقة beta تُتجاهل', eu.compareVersions('1.2.3-beta.1', '1.2.3') === 0);
check('نص فاسد ⇒ null', eu.compareVersions('nope', '1.0.0') === null);
check('فجوة patch تُحسب', eu.patchGap('2.1.220', '2.1.241') === 21);
check('قفزة minor بلا عدد', eu.patchGap('0.27.0', '0.38.0') === null);
check('لا فجوة عند التطابق', eu.patchGap('1.0.0', '1.0.0') === null);

// ---------- عقد المحرّكات ----------
check('ثلاثة محرّكات بمعرّفاتها', eu.ENGINE_IDS.join(',') === 'claude,codex,kimi');
check('Kimi قناته سكربت لا npm — «kimi upgrade» يرفض على ويندوز',
  eu.ENGINES.find((e) => e.id === 'kimi').channel === 'script');
check('Claude وCodex عبر npm',
  eu.ENGINES.filter((e) => e.channel === 'npm').map((e) => e.id).join(',') === 'claude,codex');
check('أمر Kimi هو سكربت التثبيت الرسمي',
  eu.commandFor('kimi').includes('code.kimi.com/kimi-code/install.ps1'));
// النصّ لم يعد مثبَّتاً حرفياً لأن مُشغِّل npm صار يختلف بالمنصّة (‏`npm.cmd` على
// ويندوز — انظر `readiness.NPM_BIN`). المحروس هو المعنى: npm لا المثبّت الأصلي.
check('أمر Claude عبر npm لا المثبّت الأصلي',
  eu.commandFor('claude').endsWith(' i -g @anthropic-ai/claude-code@latest')
  && /^npm(\.cmd)? /.test(eu.commandFor('claude')));
check('معرّف مجهول لا يعيد أمراً', eu.commandFor('../evil') === null && eu.commandFor('') === null);
check('العقد مجمَّد', Object.isFrozen(eu.ENGINES) && Object.isFrozen(eu.ENGINES[0]));

// ---------- مزيّف شبكة ----------
function fakeGet(versions) {
  return (url, opts, cb) => {
    const res = new EventEmitter();
    res.statusCode = 200;
    res.setEncoding = () => {};
    res.resume = () => {};
    res.destroy = () => {};
    const pkg = decodeURIComponent(String(url)).replace('https://registry.npmjs.org/', '').replace('/latest', '');
    const version = versions[pkg];
    process.nextTick(() => {
      if (version === undefined) { res.statusCode = 404; cb(res); res.emit('end'); return; }
      cb(res);
      res.emit('data', JSON.stringify({ version }));
      res.emit('end');
    });
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.destroy = () => {};
    return req;
  };
}

const LATEST = {
  '@anthropic-ai/claude-code': '2.1.241',
  '@openai/codex': '0.149.0',
  '@moonshot-ai/kimi-code': '0.38.0',
};

(async () => {
  // الحالة الحقيقية المرصودة على جهاز التطوير 2026-08-24
  const r = await eu.check({ claude: '2.1.220', codex: '0.149.0', kimi: '0.27.0' },
    { noCache: true, get: fakeGet(LATEST) });
  const by = Object.fromEntries(r.engines.map((e) => [e.id, e]));
  check('Claude المتأخر يُكشف', by.claude.behind === true && by.claude.gap === 21);
  check('Codex المطابق لا يُعدّ متأخراً', by.codex.behind === false);
  check('Kimi المتأخر يُكشف بلا عدد (قفزة minor)', by.kimi.behind === true && by.kimi.gap === null);
  check('anyBehind يعكس المجموع', r.anyBehind === true);
  check('اللقطة تحمل أمر التحديث لكل محرك', r.engines.every((e) => typeof e.command === 'string' && e.command));

  // fail-open: تعذّر معرفة الأحدث لا يعني تأخّراً — لا ننبّه على شكّ
  const offline = await eu.check({ claude: '2.1.220', codex: '', kimi: '0.27.0' },
    { noCache: true, get: fakeGet({}) });
  check('فشل الشبكة ⇒ لا ادّعاء تأخّر', offline.anyBehind === false);
  check('فشل الشبكة ⇒ latest فارغ لا مخترع', offline.engines.every((e) => e.latest === ''));

  // محرك غير مثبّت لا يُعرض متأخراً
  const missing = await eu.check({ claude: '', codex: '', kimi: '' },
    { noCache: true, get: fakeGet(LATEST) });
  check('غير المثبّت لا يُعدّ متأخراً', missing.anyBehind === false);
  check('غير المثبّت يعرض الأحدث للإرشاد', missing.engines.every((e) => e.latest !== ''));

  // ---------- عقد main/preload الساكن ----------
  const ROOT = path.resolve(__dirname, '..');
  const main = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8');
  check('معالج القراءة موجود', main.includes("ipcMain.handle('satr:engineUpdates'"));
  check('معالج التشغيل موجود', main.includes("ipcMain.handle('satr:engineUpdateRun'"));
  check('الأمر يُشتق من المعرّف لا من renderer', main.includes('enginesupdate.commandFor(id)'));
  check('لا نص أمر يعبر من renderer', !/engineUpdateRun[\s\S]{0,600}p\.command/.test(main));
  check('التشغيل يوجب تأكيداً صريحاً', /engineUpdateRun[\s\S]{0,600}confirmed !== true/.test(main));
  check('التشغيل مرفوض أثناء دور جارٍ', /engineUpdateRun[\s\S]{0,700}currentRun \|\| currentCliRun/.test(main));
  check('التشغيل في طرفية مرئية لا في الخفاء', /engineUpdateRun[\s\S]{0,900}termjobs\.startJob/.test(main));
  check('preload يكشف الدالتين المحددتين',
    preload.includes('engineUpdates:') && preload.includes('engineUpdateRun:'));

  console.log('\nالنتيجة: ' + passed + '/' + passed + ' ناجحة.');
})().catch((error) => { console.error('enginesupdate-test:', error && error.message); process.exit(1); });
