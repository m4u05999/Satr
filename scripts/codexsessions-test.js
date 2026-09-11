#!/usr/bin/env node
/**
 * سطر — حارس قارئ جلسات Codex (‏`electron/codexsessions.js`) — OBS-133.
 *
 * **لماذا هذا الحارس موجود**: كان القارئ يفهم صيغة سجلّ واحدة (`event_msg` بـ
 * `payload.type` ∈ {user_message, agent_message})، ثم نقل Codex الرسائل إلى
 * `response_item` (‏`payload.type='message'` بدور) — فصار أعمى **بلا أن يفشل شيء**:
 * الجلسة تُستأنف بمحادثة فارغة والمستخدم يظنّ عمله ضاع. قياس على جلسة حقيقية
 * (‏`01a0721d`، ‏codex-cli 0.153.4): صفر `event_msg/user_message` مقابل
 * `message/user × 101` و`message/assistant × 140`.
 *
 * ⚠️ **حدّ مُصرَّح به**: يحرس **منطق تفسير السطر** (نقيّ، بلا قرص ولا شبكة). لا يحرس
 * دورة القراءة الكاملة (`readCodexSessionLegacy`) لأنها مثبَّتة على `~/.codex/sessions`
 * بلا حقن — تلك غُطّيت بتحقّق حيّ على جلسة المالك: `total` انتقل من `0` إلى `149`
 * (‏`9` مستخدم + `140` مساعد) بلا تسرّب كتلة سياق واحدة.
 */

'use strict';

const assert = require('node:assert');
const { sessionMessage, cleanThreadTitle, userDisplayText } = require('../electron/codexsessions');

let checks = 0;
const failures = [];

function check(name, fn) {
  checks += 1;
  try { fn(); } catch (e) { failures.push(name + ' — ' + (e && e.message)); }
}

// ── مساعدات بناء أسطر السجلّ بالصيغتين ───────────────────────────────────────
const modern = (role, ...texts) => ({
  type: 'response_item',
  payload: { type: 'message', role, content: texts.map((text) => ({ type: 'input_text', text })) },
});
const legacy = (type, message) => ({ type: 'event_msg', payload: { type, message } });

// ── الصيغة الحديثة (‏response_item) ──────────────────────────────────────────
check('حديثة: رسالة مستخدم بلا وسم تُقرأ', () => {
  assert.deepStrictEqual(sessionMessage(modern('user', 'فامكوم ، الآخير')),
    { role: 'user', text: 'فامكوم ، الآخير' });
});

check('حديثة: رد المساعد يُقرأ', () => {
  assert.deepStrictEqual(sessionMessage(modern('assistant', 'سأتحقق من سجل النشر.')),
    { role: 'assistant', text: 'سأتحقق من سجل النشر.' });
});

check('حديثة: عناصر المحتوى المتعددة تُجمع بسطر فاصل', () => {
  assert.strictEqual(sessionMessage(modern('user', 'سطر أول', 'سطر ثانٍ')).text, 'سطر أول\nسطر ثانٍ');
});

check('حديثة: عنصر بلا `text` يُتخطّى ولا يكسر التجميع', () => {
  const line = { type: 'response_item', payload: { type: 'message', role: 'user',
    content: [{ type: 'image' }, { type: 'input_text', text: 'نصّ حقيقي' }] } };
  assert.strictEqual(sessionMessage(line).text, 'نصّ حقيقي');
});

// ── ترشيح السياق المحقون ─────────────────────────────────────────────────────
// مقيس على الجلسة الحقيقية: 92 من 101 رسالة `user` كانت سياقاً يبدأ بوسم زاوية.
for (const tag of ['<recommended_plugins>', '<satr_project_memory>', '<skill>']) {
  check('سياق محقون يُتخطّى: ' + tag, () => {
    assert.strictEqual(sessionMessage(modern('user', tag + '\nمحتوى السياق هنا')), null);
  });
}

check('السياق يُتخطّى بعد تشذيب الفراغ البادئ', () => {
  assert.strictEqual(sessionMessage(modern('user', '\n  <satr_project_memory>\nذاكرة')), null);
});

// ── الحقن عنصراً ملتصقاً بنصّ المستخدم (قياس 2026-09-10 على rollout حقيقي) ────
// المرساة الذيلية والذاكرة تصلان عناصر `input_text` إضافية في رسالة المستخدم
// نفسها لا رسائل منفصلة — فتجمعهما contentText مع النصّ الحقيقي وتظهران خاماً
// في فقاعة الاستعادة (بلاغ المالك: رد/طلب Codex بعد الإغلاق يختلف عنه حياً).
check('حديثة ملتصقة: مرساة `<satr_lang>` عنصراً ثانياً تُحذف ويبقى نصّ المستخدم', () => {
  const line = modern('user', 'نصّ المستخدم الحقيقي',
    '<satr_lang> تذكير: سردُ عملك بالعربية </satr_lang>');
  assert.deepStrictEqual(sessionMessage(line), { role: 'user', text: 'نصّ المستخدم الحقيقي' });
});

check('حديثة ملتصقة: كتلة `<satr_project_memory>` عنصراً ثانياً تُحذف ولا تُسقط الرسالة', () => {
  const line = modern('user', 'سؤال حقيقي', '<satr_project_memory>\nذاكرة\n</satr_project_memory>');
  assert.deepStrictEqual(sessionMessage(line), { role: 'user', text: 'سؤال حقيقي' });
});

check('حديثة ملتصقة: رسالة كل عناصرها سياق محقون تُسقط كاملة', () => {
  const line = modern('user', '<satr_project_memory>ذاكرة</satr_project_memory>',
    '<satr_lang>مرساة</satr_lang>');
  assert.strictEqual(sessionMessage(line), null);
});

// ── عنوان الخيط من thread/list (بلاغ المالك 2026-09-10: عناوين تبدأ بـ<satr_project_memory>) ──
// Codex يشتق name/preview من أول إدخال مستخدم — الذي قد يكون كتلتنا المحقونة.
check('عنوان الخيط: ذاكرة محقونة كاملةً تسقط إلى العنوان الافتراضي', () => {
  assert.strictEqual(cleanThreadTitle('<satr_project_memory> ذاكرة مشروع شخصية اعتمدها </satr_project_memory>'),
    'جلسة Codex');
});

check('عنوان الخيط: كتلة محقونة مبتورة (بلا وسم إغلاق) تُقطع ولا تبقى', () => {
  assert.strictEqual(cleanThreadTitle('<satr_project_memory> ذاكرة مشروع شخصية اعتمدها المستخدم'),
    'جلسة Codex');
});

check('عنوان الخيط: المرساة الذيلية تُحذف ويبقى نصّ العنوان الحقيقي', () => {
  assert.strictEqual(cleanThreadTitle('مراجعة خطة الفريق <satr_lang> تذكير </satr_lang>'),
    'مراجعة خطة الفريق');
});

check('عنوان الخيط: العنوان النظيف يمرّ كما هو', () => {
  assert.strictEqual(cleanThreadTitle('جلسة مراجعة الرادار'), 'جلسة مراجعة الرادار');
});

// ── نصّ عرض رسالة المستخدم من thread/read (بلاغ المالك 2026-09-10) ─────────────
check('عرض thread/read: الحقن بأشكاله الثلاثة يُحذف ويبقى نصّ المستخدم', () => {
  const content = [
    { type: 'skill', name: 'satr-radar', path: 'x' },
    { type: 'text', text: '<satr_project_memory>\nذاكرة\n</satr_project_memory>' },
    { type: 'text', text: '# AGENTS.md instructions for D:\\proj\n\n<INSTRUCTIONS>…' },
    { type: 'text', text: 'ما التالي؟' },
    { type: 'text', text: '<satr_lang> مرساة </satr_lang>' },
  ];
  assert.strictEqual(userDisplayText(content), 'ما التالي؟');
});

check('عرض thread/read: رسالة كلها حقناً تعيد نصاً فارغاً فتُتخطّى', () => {
  const content = [
    { type: 'skill', name: 'satr-guide', path: 'x' },
    { type: 'text', text: '<satr_project_memory>…</satr_project_memory>' },
  ];
  assert.strictEqual(userDisplayText(content), '');
});

check('عرض thread/read: نصّ مستخدم يبدأ بشرطة مائلة (أمر كتبه فعلاً) يبقى', () => {
  assert.strictEqual(userDisplayText([{ type: 'text', text: '/مساعدة' }]), '/مساعدة');
});

check('رد المساعد لا يُرشَّح بالوسم (الترشيح لرسائل المستخدم وحدها)', () => {
  const m = sessionMessage(modern('assistant', '<div> عنصر في الصفحة'));
  assert.ok(m && m.role === 'assistant', 'رد المساعد يجب أن يمرّ');
});

// ── ما يجب ألّا يُقرأ ────────────────────────────────────────────────────────
check('دور developer سياقٌ فيُتجاهل', () => {
  assert.strictEqual(sessionMessage(modern('developer', 'تعليمات النظام')), null);
});

check('agent_message داخل response_item يُتجاهل (تواصل وكلاء لا رسالة عرض)', () => {
  // مقيس: 40 منها في الجلسة الحقيقية بلا نصّ، ولا يطابق أيٌّ منها رداً معروضاً ⇒ لا ازدواج
  const line = { type: 'response_item', payload: { type: 'agent_message', author: 'a', recipient: 'b', content: [] } };
  assert.strictEqual(sessionMessage(line), null);
});

check('أنواع response_item الأخرى تُتجاهل', () => {
  for (const type of ['reasoning', 'function_call', 'custom_tool_call_output']) {
    assert.strictEqual(sessionMessage({ type: 'response_item', payload: { type } }), null, type);
  }
});

// ── الصيغة القديمة: عدم تراجع ────────────────────────────────────────────────
check('قديمة: user_message ما زالت تُقرأ', () => {
  assert.deepStrictEqual(sessionMessage(legacy('user_message', 'سؤال قديم')),
    { role: 'user', text: 'سؤال قديم' });
});

check('قديمة: agent_message ما زالت تُقرأ', () => {
  assert.deepStrictEqual(sessionMessage(legacy('agent_message', 'رد قديم')),
    { role: 'assistant', text: 'رد قديم' });
});

check('قديمة: السياق الموسوم ما زال يُتخطّى', () => {
  assert.strictEqual(sessionMessage(legacy('user_message', '<satr_project_memory>\nذاكرة')), null);
});

check('قديمة: token_count وأمثالها تُتجاهل', () => {
  assert.strictEqual(sessionMessage(legacy('token_count', 'x')), null);
});

// ── مدخلات مشوّهة: fail-closed بلا رمي ──────────────────────────────────────
check('المدخلات المشوّهة تعيد null ولا ترمي', () => {
  for (const bad of [null, undefined, {}, { type: 'response_item' }, { payload: {} },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: 'نصّ لا مصفوفة' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 42 } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [] } }]) {
    assert.strictEqual(sessionMessage(bad), null, JSON.stringify(bad));
  }
});

check('الرسالة الفارغة أو الفراغ المحض تُتجاهل', () => {
  assert.strictEqual(sessionMessage(modern('user', '   \n  ')), null);
  assert.strictEqual(sessionMessage(modern('assistant', '')), null);
});

// ── الخاتمة ──────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error('codexsessions-test: فشل ' + failures.length + ' من ' + checks);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log('codexsessions-test: ok — ' + checks + ' فحصاً (صيغتا السجلّ وترشيح السياق وعدم التراجع).');
