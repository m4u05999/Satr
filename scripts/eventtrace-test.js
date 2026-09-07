/**
 * حارس أثر أحداث الدور (‏OBS-142) — قطعي بلا شبكة ولا قرص ولا Electron.
 *
 * يحرس عقدين: **أن العدّاد يعدّ فعلاً**، و**ألّا يتسرّب منه نصّ**. والثاني أهمّ:
 * أداةُ تشخيصٍ تحمل نصّ المحادثة تصير تسريباً في كل جلسة بدل أن تكون قياساً في
 * حادثة نادرة.
 *
 * ويحرس معه **مواضع الوصل الثلاثة** نصّياً في المصدر — لأن عدّاداً غير موصول
 * يعطي «صفر إسقاط» فيُقرأ نفياً وهو صمت. وهذا هو الفخّ نفسه الذي أبقى OBS-142
 * مفتوحة: `return` صامت لا يفرَّق عن حدث لم يُنتَج.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const trace = require(path.join(ROOT, 'electron', 'eventtrace.js'));

let passed = 0;
function ok(cond, msg) { passed += 1; assert(cond, msg); }

// ── (١) العدّ الأساسي ────────────────────────────────────────────────────────
{
  const t = trace.create();
  t.emitted(1, { type: 'assistant', message: { content: [{ type: 'text', text: 'abc' }] } });
  t.sent(1);
  t.emitted(1, { type: 'stream_text', text: 'xy', phase: 'final_answer' });
  t.dropped(1, { type: 'stream_text', text: 'xy' }, 'stale_token', 2);
  const s = t.snapshot();
  const r = s.runs.find((x) => x.token === '1');
  ok(r.emitted === 2 && r.sent === 1 && r.dropped === 1, 'العدّادات الثلاثة تعدّ');
  ok(r.byType.assistant === 1 && r.byType.stream_text === 1, 'التصنيف بالنوع');
  ok(r.droppedByReason.stale_token === 1, 'سبب الإسقاط مسجَّل');
  ok(s.schema_version === 1, 'schema معلن');
}

// ── (٢) ⭐ لا نصّ يتسرّب — العقد الجوهري ──────────────────────────────────────
{
  const t = trace.create();
  const secret = 'SENTINEL_' + 'A'.repeat(40);
  t.emitted(3, { type: 'assistant', message: { content: [{ type: 'text', text: secret }] } });
  t.dropped(3, { type: 'stream_text', text: secret, phase: 'final_answer' }, 'stale_token', 4);
  t.dropped(3, { type: 'user', message: { content: [{ type: 'tool_result', content: secret }] } }, 'no_window', 4);
  const dump = JSON.stringify(t.snapshot());
  ok(!dump.includes('SENTINEL_'), 'لا نصّ محادثة في اللقطة إطلاقاً');
  ok(!dump.includes('AAAA'), 'ولا جزءٌ منه');
  // الطول يُحفظ — وهو ما يفرّق «حدثٌ فارغ» عن «حدثٌ حمل 1194 محرفاً».
  ok(t.snapshot().drops.some((d) => d.textLen === secret.length), 'الطول محفوظ بلا النصّ');
}

// ── (٣) تنقية الاسم: محارف تحكم/Bidi تُزال، والاسم يُقصّ ─────────────────────
{
  const bidi = 'To‮ol‏';
  const s = trace.shape({ type: 'assistant', message: { content: [{ type: 'tool_use', name: bidi }] } });
  ok(s.tools[0] === 'Tool', 'محارف التحكم وBidi تُزال من اسم الأداة');
  const long = trace.shape({ type: 'T'.repeat(500) });
  ok(long.type.length === 64, 'الاسم مقصوص بسقفه المعلن');
}

// ── (٤) سببٌ غير معلن ⇒ `other` ولا يُخترع له اسم ────────────────────────────
{
  const t = trace.create();
  t.dropped(9, { type: 'x' }, 'سبب-مخترع', 10);
  ok(t.snapshot().runs[0].droppedByReason.other === 1, 'السبب المجهول يصير other');
  ok(trace.REASONS.has('stale_token') && trace.REASONS.has('no_window'), 'الأسباب المعلنة مصدَّرة');
}

// ── (٥) الحلقة مسقوفة، والقصّ **يُعلَن** ولا يمرّ صامتاً ─────────────────────
{
  const t = trace.create();
  for (let i = 0; i < trace.MAX_RING + 25; i += 1) t.dropped(1, { type: 'x' }, 'stale_token', 2);
  const s = t.snapshot();
  ok(s.drops.length === trace.MAX_RING, 'الحلقة عند سقفها');
  ok(s.dropsOverflow === 25, 'والمُسقَط معلن بعدده — لا قصّ صامت');
}

// ── (٦) مدخلات مشوّهة لا تُسقط العدّاد ───────────────────────────────────────
{
  const t = trace.create();
  for (const bad of [null, undefined, 0, 'نص', [], { message: 'ليس كائناً' }]) {
    t.emitted(1, bad);
    t.dropped(1, bad, 'stale_token', 2);
  }
  ok(t.snapshot().runs[0].emitted === 6, 'المدخل المشوّه يُعدّ ولا يرمي');
  ok(trace.textLen(null) === 0 && trace.textLen('x') === 0, 'textLen يتحمّل غير الكائن');
}

// ── (٧) ⭐ مواضع الوصل الثلاثة — عدّادٌ غير موصول يكذب بالصمت ────────────────
{
  const main = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'app.js'), 'utf8');
  const pre = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8');

  ok(/require\('\.\/eventtrace'\)\.create\(\)/.test(main), 'main.js ينشئ العدّاد');
  ok(/eventTrace\.emitted\(token, obj\)/.test(main), 'النقطة ١: العدّ قبل أي مرشّح');
  // النقطة ٢: الإسقاط بسبب معلن **بدل `return` الصامت** الذي كان.
  ok(/eventTrace\.dropped\(token, obj, 'stale_token', runSeq\);\s*\n\s*return;/.test(main),
    'النقطة ٢: إسقاط الحدث القديم يُسجَّل بسببه قبل return');
  ok(/eventTrace\.sent\(runSeq\)/.test(main) && /eventTrace\.dropped\(runSeq, obj, 'no_window'/.test(main),
    'النقطة ٣: الإرسال وغياب النافذة كلاهما مسجَّل');
  ok(/ipcMain\.handle\('satr:eventTrace'/.test(main), 'قناة القراءة مسجَّلة');
  ok(/eventTrace: \(\) => ipcRenderer\.invoke\('satr:eventTrace'\)/.test(pre), 'preload يكشفها بلا مدخلات');
  ok(/uiEventCounts\.total \+= 1/.test(app), 'النقطة ٤: الواجهة تعدّ ما وصلها');

  // ولا يمرّ نصّ من الواجهة إلى العدّاد: النوع وحده، مقصوصاً.
  ok(/ev\.type\.slice\(0, 64\)/.test(app), 'عدّاد الواجهة يأخذ النوع مقصوصاً لا الحمولة');
}

// ── (٨) لا محارف تحكم/Bidi حرفية في المصدر — درسٌ عضّ في hookguard.js ────────
{
  const src = fs.readFileSync(path.join(ROOT, 'electron', 'eventtrace.js'), 'utf8');
  const literal = Array.from(src).some((ch) => {
    const c = ch.codePointAt(0);
    return (c < 32 && c !== 10 && c !== 9) || (c >= 127 && c <= 159)
      || c === 0x061C || c === 0x200E || c === 0x200F
      || (c >= 0x202A && c <= 0x202E) || (c >= 0x2066 && c <= 0x2069);
  });
  ok(!literal, 'لا محرف تحكم/Bidi حرفي في المصدر — الهروب أو مُسنِد النقاط فقط');
}

console.log('\neventtrace-test: ok — ' + passed + ' فحصاً (العدّ · لا تسريب نصّ · التنقية · السقوف · مواضع الوصل الأربعة).');
