#!/usr/bin/env node
'use strict';

/**
 * حارس «مجلد المشروع = أول cwd لا آخره» — قطعي بلا قرص ولا شبكة.
 *
 * **العطل المحروس** (بلاغ مالك بلقطة، 2026-08-30): أداة Bash في Claude Code تملك
 * صدفة معمّرة، فحين ينتقل الوكيل بـ`cd` إلى مجلد فرعي يسجّل CLI المجلد الجديد في كل
 * سطر تالٍ. قياس على جلسة حقيقية: **37 انزياحاً** داخل جلسة واحدة بدأت في
 * `D:\alulama` وانتهى تسجيلها عند `D:\alulama\packages\erp-poc`.
 *
 * وكان `buildMessages` يأخذ **آخر** cwd بينما `listSessions` يأخذ **الأول**. فعند
 * استئناف الجلسة تكتب `app.js` القيمة المنزاحة في حقل المجلد وفي `localStorage`،
 * فيتغيّر مجلد عمل المستخدم صامتاً ويبقى بعد إعادة التشغيل، وتُولد كل جلسة تالية في
 * المجلد الخطأ فتصنع «مشروعاً» وهمياً في الأرشيف.
 *
 * ولذلك يحرس هذا الملف **الطرفين معاً**: الدالة النقية، وعقد `listSessions` نصّاً —
 * لأن العطل لم يكن في أحدهما بل في **اختلافهما**.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const sessions = require(path.join(ROOT, 'electron', 'sessions.js'));

let checks = 0;
function ok(label, cond, detail) {
  checks++;
  if (cond) { console.log('  ✓ ' + label); return; }
  console.error('  ✗ ' + label + (detail ? ' — ' + detail : ''));
  throw new assert.AssertionError({ message: label + (detail ? ' — ' + detail : '') });
}

// سطر jsonl واحد بصيغة Claude Code
const line = (o) => JSON.stringify(o);
const userLine = (cwd, text) => line({ type: 'user', cwd, uuid: undefined, message: { role: 'user', content: text } });
const asstLine = (cwd, text) => line({ type: 'assistant', cwd, message: { role: 'assistant', content: [{ type: 'text', text }] } });

console.log('\n— انزياح cwd داخل الجلسة —');
{
  // جلسة بدأت في الجذر ثم تجوّلت في مجلدات فرعية (نمط جولة عمل حقيقية)
  const raw = [
    userLine('D:\\alulama', 'ابدأ العمل'),
    asstLine('D:\\alulama', 'حسناً'),
    userLine('D:\\alulama\\apps\\web', 'تابع'),
    asstLine('D:\\alulama\\apps\\web', 'تمام'),
    userLine('D:\\alulama\\packages\\erp-poc', 'وهنا أيضاً'),
    asstLine('D:\\alulama\\packages\\erp-poc', 'انتهيت'),
  ].join('\n');

  const built = sessions.buildMessages(raw);
  ok('يعيد **أول** cwd — مجلد المشروع الذي بدأت فيه الجلسة',
    built.cwd === 'D:\\alulama', 'أعاد: ' + built.cwd);
  ok('ولا يعيد آخر cwd — مجلد الصدفة العابر',
    built.cwd !== 'D:\\alulama\\packages\\erp-poc');
  ok('والرسائل لم تتأثر بالتغيير', built.messages.length === 6,
    'عدد الرسائل: ' + built.messages.length);
}

console.log('\n— حالات حدّية —');
{
  const noDrift = sessions.buildMessages([
    userLine('D:\\one', 'أ'), asstLine('D:\\one', 'ب'),
  ].join('\n'));
  ok('جلسة بلا انزياح تعيد مجلدها كما هو', noDrift.cwd === 'D:\\one');

  // أول سطر بلا cwd (‏queue-operation وأمثاله يتصدّر الملف فعلاً — رُصد حيّاً)
  const lateCwd = sessions.buildMessages([
    line({ type: 'queue-operation' }),
    userLine('D:\\two', 'أ'),
    userLine('D:\\two\\deep', 'ب'),
  ].join('\n'));
  ok('سطر متصدّر بلا cwd لا يمنع التقاط الأول الحقيقي', lateCwd.cwd === 'D:\\two',
    'أعاد: ' + lateCwd.cwd);

  const empty = sessions.buildMessages('');
  ok('نصّ فارغ يعيد cwd فارغاً بلا انهيار', empty.cwd === '' && empty.messages.length === 0);

  const blankCwd = sessions.buildMessages([
    line({ type: 'user', cwd: '', message: { role: 'user', content: 'أ' } }),
    userLine('D:\\three', 'ب'),
  ].join('\n'));
  ok('cwd فارغ لا يُحتسب أولاً', blankCwd.cwd === 'D:\\three');
}

console.log('\n— اتفاق الطرفين (العطل كان في اختلافهما) —');
{
  const src = fs.readFileSync(path.join(ROOT, 'electron', 'sessions.js'), 'utf8');
  ok('listSessions يأخذ أول cwd (‏حارس `!cwd &&`)',
    /if \(!cwd && typeof e\.cwd === 'string'\)/.test(src));
  ok('buildMessages يأخذ أول cwd كذلك — لا إسناد غير محروس',
    /if \(!cwd && typeof e\.cwd === 'string' && e\.cwd\) cwd = e\.cwd;/.test(src));
  ok('ولا إسناد `cwd = e.cwd` بلا حارس في الملف كلّه',
    !/(^|\n)\s*(if \(typeof e\.cwd === 'string' && e\.cwd\) )?cwd = e\.cwd;(?!.*!cwd)/.test(
      src.split('\n').filter((l) => /cwd = e\.cwd;/.test(l) && !/!cwd/.test(l)).join('\n') || 'صفر'),
    'وُجد إسناد بلا حارس — سيعود العطل');
  ok('التعليق التفسيري باقٍ فلا يُعاد «آخر cwd» اجتهاداً',
    /أول\*\* cwd لا آخره|أول cwd لا آخره/.test(src));
}

console.log('\n— المعقل الثاني: الاستئناف لا يبدّل مجلدك صامتاً —');
{
  const app = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'app.js'), 'utf8');

  ok('مسارات الاستئناف الثلاثة تمرّ بدالة واحدة',
    (app.match(/applyResumedCwd\(data\.cwd\)/g) || []).length === 3,
    'العدد: ' + (app.match(/applyResumedCwd\(data\.cwd\)/g) || []).length);
  ok('ولا كتابة مباشرة لـsatr_cwd في مسار استئناف',
    !/if \(data\.cwd\) \{[\s\S]{0,160}localStorage\.setItem\('satr_cwd'/.test(app),
    'عاد التكرار الصامت');

  const fn = (app.match(/function applyResumedCwd[\s\S]*?\n  \}\n/) || [''])[0];
  ok('الدالة موجودة وغير فارغة', fn.length > 200);
  ok('تُعلم المستخدم بزرّ فعل لا بإشعار صامت',
    /addActionNotice\(/.test(fn) && /أعِد مجلدي/.test(fn));
  ok('تعرض المجلدين معاً — الجديد والسابق',
    /nextCwd/.test(fn) && /كان: /.test(fn));
  ok('لا تُزعج بفرق حالة الأحرف (‏ويندوز لا يميّزها)',
    /toLowerCase\(\) === String\(nextCwd\)\.toLowerCase\(\)/.test(fn));
  ok('ولا تُعلم حين لا مجلد سابق (‏أول تشغيل)', /!prev \|\|/.test(fn));
  ok('التراجع يستعيد المجلد **ويصفّر الجلسة** صراحةً',
    /setCwd\(prev\)/.test(fn) && /sessionCwd = prev/.test(fn) && /sessionId = null/.test(fn),
    'التراجع ناقص — جلسة مرتبطة بمجلد آخر ستفشل عند الإرسال');
  ok('ولا مربع تأكيد حاجب (‏قرار معلن: أخبِر ولا تسأل)',
    !/confirm\(/.test(fn));
}

console.log('\nsessions-cwd: نجح — ' + checks
  + ' فحصاً (مجلد المشروع هو أول cwd، والطرفان متفقان، والاستئناف يُعلم ويتيح التراجع).');
