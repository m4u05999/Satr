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
const { sessionMessage, cleanThreadTitle, userDisplayText, listCodexSessionsWith, continuityMessages } = require('../electron/codexsessions');

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

// ── أغلفة محقونة وكلام المستخدم في عنصر واحد ─────────────────────────────────
check('العنوان: AGENTS وenvironment وسطر تُحذف ويبقى طلب المستخدم من العنصر نفسه', () => {
  const raw = '# AGENTS.md instructions for D:\\proj\n<INSTRUCTIONS>قواعد</INSTRUCTIONS>\n'
    + '<environment_context>سياق</environment_context>\n'
    + '<satr_lang>مرساة</satr_lang>\nافحص القائمة';
  assert.strictEqual(cleanThreadTitle(raw), 'افحص القائمة');
});

check('عرض المستخدم: الحقن البادئ لا يسقط الطلب اللاحق في الجزء نفسه', () => {
  const content = [{ type: 'text',
    text: '<environment_context>سياق</environment_context>\n<satr_lang>مرساة</satr_lang>\nرسالة المستخدم' }];
  assert.strictEqual(userDisplayText(content), 'رسالة المستخدم');
});

check('السجل الحديث: الحقن البادئ لا يسقط الطلب اللاحق في input_text نفسه', () => {
  const line = modern('user', '<satr_project_memory>ذاكرة</satr_project_memory>\nسؤال حقيقي');
  assert.deepStrictEqual(sessionMessage(line), { role: 'user', text: 'سؤال حقيقي' });
});

const ALL_SOURCES = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview',
  'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];
const normalThread = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  cwd: 'D:\\proj', preview: 'جلسة عادية', updatedAt: 10, status: 'idle', source: 'appServer',
};
const childThread = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  cwd: 'D:\\proj', preview: '# AGENTS.md instructions for D:\\proj\n<INSTRUCTIONS>x</INSTRUCTIONS>\nمهمة فرعية',
  recencyAt: 20, status: 'idle',
  source: { subAgent: { thread_spawn: { depth: 1, parent_thread_id: normalThread.id } } },
  parentThreadId: normalThread.id,
};

async function checkAsync(name, fn) {
  checks += 1;
  try { await fn(); } catch (e) { failures.push(name + ' — ' + (e && e.message)); }
}
const asyncChecks = [];

asyncChecks.push(checkAsync('القائمة: تتبع nextCursor وتحفظ source/parent وتصنّف subagent', async () => {
  const calls = [];
  const rpc = async (method, params) => {
    calls.push({ method, params });
    return calls.length === 1
      ? { data: [normalThread], nextCursor: 'page-2' }
      : { data: [childThread], nextCursor: null };
  };
  const rows = await listCodexSessionsWith(rpc, async () => { throw new Error('unexpected legacy'); });
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[1].params.cursor, 'page-2');
  assert.deepStrictEqual(calls[0].params.sourceKinds, ALL_SOURCES);
  assert.strictEqual(rows[0].toolTagged, false);
  assert.strictEqual(rows[1].toolTagged, true);
  assert.deepStrictEqual(rows[1].source, childThread.source);
  assert.strictEqual(rows[1].parentThreadId, normalThread.id);
  assert.strictEqual(rows[1].title, 'مهمة فرعية');
}));

asyncChecks.push(checkAsync('القائمة: فشل الصفحة الأولى وحدها يستعمل legacy', async () => {
  const legacy = [{ id: 'legacy' }];
  const rows = await listCodexSessionsWith(async () => { throw new Error('old cli'); }, async () => legacy);
  assert.strictEqual(rows, legacy);
}));

asyncChecks.push(checkAsync('القائمة: فشل صفحة لاحقة صريح ولا يخلط legacy', async () => {
  let calls = 0;
  let legacyCalls = 0;
  await assert.rejects(
    listCodexSessionsWith(async () => {
      calls += 1;
      if (calls === 1) return { data: [normalThread], nextCursor: 'page-2' };
      throw new Error('page failed');
    }, async () => { legacyCalls += 1; return []; }),
    (error) => error && error.code === 'codex_session_list_page_failed',
  );
  assert.strictEqual(legacyCalls, 0);
}));

asyncChecks.push(checkAsync('القائمة: cursor المكرر يفشل صراحةً', async () => {
  await assert.rejects(
    listCodexSessionsWith(async () => ({ data: [], nextCursor: 'same' }), async () => []),
    (error) => error && error.code === 'codex_session_list_invalid_cursor',
  );
}));

asyncChecks.push(checkAsync('القائمة: بلوغ حد 50 صفحة مع استمرار cursor يفشل ولا يعيد جزءاً', async () => {
  let calls = 0;
  await assert.rejects(
    listCodexSessionsWith(async () => {
      calls += 1;
      return { data: [], nextCursor: 'cursor-' + calls };
    }, async () => []),
    (error) => error && error.code === 'codex_session_list_page_limit',
  );
  assert.strictEqual(calls, 50);
}));

check('النقل الكامل: يحفظ النص الخام وdisplayText المنقّى وphase المساعد', () => {
  const raw = '<environment_context>سياق</environment_context>\nطلب المستخدم';
  const value = continuityMessages({ cwd: 'D:\\proj', turns: [{ status: 'completed', items: [
    { type: 'userMessage', content: [{ type: 'text', text: raw }] },
    { type: 'agentMessage', text: 'أعمل الآن', phase: 'commentary' },
  ] }] });
  assert.strictEqual(value.messages[0].text, raw);
  assert.strictEqual(value.messages[0].displayText, 'طلب المستخدم');
  assert.strictEqual(value.messages[1].phase, 'commentary');
});
asyncChecks.push(checkAsync('القائمة: فشل RPC وlegacy معاً يرمي listError صريحاً', async () => {
  await assert.rejects(
    listCodexSessionsWith(async () => { throw new Error('rpc'); }, async () => { throw new Error('disk'); }),
    (error) => error && error.code === 'codex_session_list_unavailable',
  );
}));

asyncChecks.push(checkAsync('القائمة: رد RPC المشوّه لا يتحول إلى قائمة فارغة', async () => {
  await assert.rejects(
    listCodexSessionsWith(async () => ({ data: null }), async () => []),
    (error) => error && error.code === 'codex_session_list_invalid_response',
  );
}));
check('عرض المستخدم: يحفظ الأسطر والمسافات الداخلية بعد حذف الغلاف', () => {
  const raw = '<environment_context>سياق</environment_context>\nfunction example() {\n  return 1;\n}';
  assert.strictEqual(userDisplayText([{ type: 'text', text: raw }]),
    'function example() {\n  return 1;\n}');
});

check('العنوان وحده يطوي الأسطر والفراغات بعد التنظيف', () => {
  assert.strictEqual(cleanThreadTitle(
    '<satr_lang>مرساة</satr_lang>\nراجع   هذا\n  العنوان'), 'راجع هذا العنوان');
});

check('عنوان AGENTS المبتور قبل INSTRUCTIONS يسقط إلى الافتراضي', () => {
  assert.strictEqual(cleanThreadTitle('# AGENTS.md instructions for D:\\proj'), 'جلسة Codex');
});

check('النقل الكامل: الغلاف وحده يحمل displayText فارغاً كي لا يعود raw للعرض', () => {
  const raw = '<environment_context>سياق فقط</environment_context>';
  const value = continuityMessages({ cwd: 'D:\\proj', turns: [{ status: 'completed', items: [
    { type: 'userMessage', content: [{ type: 'text', text: raw }] },
  ] }] });
  assert.strictEqual(value.messages[0].text, raw);
  assert.ok(Object.prototype.hasOwnProperty.call(value.messages[0], 'displayText'));
  assert.strictEqual(value.messages[0].displayText, '');
});
// ── الخاتمة ──────────────────────────────────────────────────────────────────
Promise.all(asyncChecks).then(() => {
  if (failures.length) {
    console.error('codexsessions-test: فشل ' + failures.length + ' من ' + checks);
    for (const f of failures) console.error('  ✗ ' + f);
    process.exit(1);
  }
  console.log('codexsessions-test: ok — ' + checks + ' فحصاً (السجل والترقيم والميتاداتا والترشيح).');
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
