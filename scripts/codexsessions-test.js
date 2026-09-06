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
const { sessionMessage } = require('../electron/codexsessions');

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
