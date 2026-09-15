#!/usr/bin/env node
'use strict';
// حارس نزع كتل «سطر» المحقونة من نصّ المستخدم عند قراءة الجلسات (مذكور منفّذ الدفعة ب، 2026-09-15):
// الوحدة النقية satrblocks.js + قارئا sessions.js (العرض والنقل) بمنطق الإنتاج نفسه.
const assert = require('node:assert/strict');
const satrblocks = require('../electron/satrblocks');
const sessions = require('../electron/sessions');

let checks = 0;
const ok = (cond, msg) => { checks += 1; assert.ok(cond, msg); };

// ---------- الوحدة النقية ----------
{
  const plain = satrblocks.stripSatrBlocks('سؤال عادي بلا كتل');
  ok(plain.text === 'سؤال عادي بلا كتل' && plain.stripped.length === 0, 'نصّ بلا كتل يعود حرفياً');
  const ctx = satrblocks.stripSatrBlocks('<satr_turn_context>\nهذا سياق دورك\n</satr_turn_context>\n\nما حالة الاختبارات؟');
  ok(ctx.text === 'ما حالة الاختبارات؟', 'كتلة سياق الدور تُنزع مع فراغها: ' + JSON.stringify(ctx.text));
  ok(ctx.stripped.length === 1 && ctx.stripped[0] === 'satr_turn_context', 'اسم الوسم المنزوع يُبلَّغ');
  const multi = satrblocks.stripSatrBlocks('<satr_verification_result>\nنجح\n</satr_verification_result>\n\n<satr_turn_context>س</satr_turn_context>\n\nالطلب <satr_lang>عربي</satr_lang>');
  ok(multi.text === 'الطلب', 'ثلاث كتل مختلفة تُنزع معاً: ' + JSON.stringify(multi.text));
  ok(multi.stripped.length === 3, 'الوسوم الثلاثة تُبلَّغ بلا تكرار');
  const attrs = satrblocks.stripSatrBlocks('<satr_context_budget estimate="true" unit="tokens">1200</satr_context_budget>\nنص');
  ok(attrs.text === 'نص', 'وسم بسمات يُنزع');
  const open = satrblocks.stripSatrBlocks('طلب المستخدم\n<satr_project_memory>\nذاكرة مقصوصة بلا إغلاق');
  ok(open.text === 'طلب المستخدم' && open.stripped[0] === 'satr_project_memory', 'كتلة غير مغلقة تُنزع حتى النهاية');
  const history = satrblocks.stripSatrBlocks('<satr_conversation_history>قديم</satr_conversation_history>');
  ok(history.stripped.length === 0 && history.text.includes('<satr_conversation_history>'),
    'تاريخ المحادثة ليس كتلة تُنزع — علامة حقن يعلنها القارئ');
  const foreign = satrblocks.stripSatrBlocks('<satr_unknown_tag>x</satr_unknown_tag> نص');
  ok(foreign.stripped.length === 0 && foreign.text.startsWith('<satr_unknown_tag>'), 'وسم خارج القائمة المغلقة لا يُنزع');
  ok(satrblocks.stripSatrBlocks(null).text === '' && satrblocks.stripSatrBlocks(42).stripped.length === 0, 'غير النصّ يعود فارغاً بلا رمي');
  ok(satrblocks.TAGS.includes('satr_turn_context') && satrblocks.TAGS.includes('satr_verification_result')
    && satrblocks.TAGS.includes('satr_lang') && !satrblocks.TAGS.includes('satr_conversation_history'),
    'القائمة المغلقة تحمل الكتل المحقونة وتستثني علامة الحقن');
}

// ---------- قارئ العرض (buildMessages) ----------
{
  const lines = [
    { type: 'user', cwd: 'D:\\p', uuid: '11111111-1111-4111-8111-111111111111',
      message: { role: 'user', content: '<satr_turn_context>\nسياق\n</satr_turn_context>\n\nأين توقف الوكيل؟' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'توقف عند الإذن.' }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '<satr_lang>ar</satr_lang>' }] } },
  ].map((e) => JSON.stringify(e)).join('\n');
  const shown = sessions.buildMessages(lines);
  ok(shown.messages.length === 2, 'رسالة لا يبقى منها بعد النزع شيء تسقط من العرض: ' + shown.messages.length);
  ok(shown.messages[0].role === 'user' && shown.messages[0].text === 'أين توقف الوكيل؟',
    'رسالة تبدأ بكتلة سطر كانت تختفي كلها (تبدأ بـ<) — صارت تُعرض بنصّها: ' + JSON.stringify(shown.messages[0].text));
  ok(!JSON.stringify(shown).includes('satr_turn_context'), 'لا وسم خام في ناتج العرض');
}

// ---------- قارئ النقل (buildContinuityMessages) ----------
{
  const lines = [
    { type: 'user', cwd: 'D:\\p', message: { content: [{ type: 'text', text: '<satr_verification_result>\nنجح 5/5\n</satr_verification_result>\n\nتابع الدفعة' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'نصّ المساعد يذكر <satr_turn_context> حرفياً ويبقى' }] } },
  ].map((e) => JSON.stringify(e)).join('\n');
  const moved = sessions.buildContinuityMessages(lines);
  ok(moved.messages[0].text === 'تابع الدفعة', 'نصّ المستخدم المنقول بلا كتلة التحقق: ' + JSON.stringify(moved.messages[0].text));
  ok(moved.messages[1].text.includes('<satr_turn_context>'), 'نصّ المساعد لا يُمسّ (ليس حقناً منّا)');
  ok(moved.coverage.complete === true, 'النزع ليس نقصاً في التغطية');
  const onlyBlock = sessions.buildContinuityMessages(JSON.stringify({ type: 'user', message: { content: '<satr_turn_context>س</satr_turn_context>' } }));
  ok(onlyBlock.messages.length === 0, 'رسالة كلها كتلة لا تُنقل رسالةً فارغة');
}

console.log('satrblocks-test: ok — ' + checks + ' فحصاً (القائمة المغلقة، النزع في قارئَي العرض والنقل، وعلامة الحقن تبقى).');
