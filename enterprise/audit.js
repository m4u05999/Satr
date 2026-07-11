/**
 * سطر Enterprise — سجل التدقيق (الدفعة 3.4، نقطة الربط §4.7).
 *
 * «من فعل ماذا»: يدوّن الأفعال الحسّاسة في `~/.satr/audit/YYYY-MM-DD.jsonl`
 * (سطر JSON لكل حدث — إلحاق فقط، ملف لكل يوم):
 *  - prompt            طلب المستخدم (مقتطع 500 حرف) + المحرك والمجلد
 *  - tool_use          نداء أداة من النموذج (الاسم + وسائط مقتطعة)
 *  - file_edit         تعديل/إنشاء/حذف ملف (المسار + حجم التغيير)
 *  - permission_request/permission_reply  طلب الإذن وقرار المستخدم
 *
 * أفضل جهد: فشل الكتابة لا يمسّ الدور. الملفات ملك المستخدم على جهازه.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = path.join(os.homedir(), '.satr', 'audit');
const CLIP = 500; // اقتطاع النصوص الطويلة في السجل

function fileFor(date) {
  return path.join(DIR, date.toISOString().slice(0, 10) + '.jsonl');
}

function clip(v) {
  if (typeof v !== 'string') return v;
  return v.length > CLIP ? v.slice(0, CLIP) + '…' : v;
}

function clipObj(obj) {
  const out = {};
  for (const k of Object.keys(obj || {})) out[k] = clip(obj[k]);
  return out;
}

function write(rec) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(fileFor(new Date()), JSON.stringify({ ts: Date.now(), ...rec }) + '\n');
  } catch (e) { /* أفضل جهد */ }
}

// مدوّن الأحداث — يُشترك به في مجرى المراقبة (features.subscribe)
function onEvent(ev, meta) {
  if (!ev) return;
  const engine = (meta && meta.engine) || 'sdk';
  if (ev.type === 'prompt') {
    write({ kind: 'prompt', engine: ev.engine || engine, cwd: ev.cwd || '', prompt: clip(ev.prompt || '') });
  } else if (ev.type === 'permission_request') {
    write({ kind: 'permission_request', engine, tool: ev.tool, input: clipObj(ev.input) });
  } else if (ev.type === 'permission_reply') {
    write({ kind: 'permission_reply', engine, id: ev.id, allow: !!ev.allow, always: !!ev.always });
  } else if (ev.type === 'file_edit') {
    write({
      kind: 'file_edit', engine, tool: ev.tool, rel: ev.rel,
      isNew: !!ev.isNew, isDelete: !!ev.isDelete, added: ev.added || 0, removed: ev.removed || 0,
    });
  } else if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
    for (const c of ev.message.content) {
      if (c.type === 'tool_use') write({ kind: 'tool_use', engine, tool: c.name, input: clipObj(c.input) });
    }
  }
}

// معلومات للوحة ⚙: عدد أحداث اليوم + مسار السجل
function info() {
  let count = 0;
  try {
    count = fs.readFileSync(fileFor(new Date()), 'utf8').split('\n').filter(Boolean).length;
  } catch { count = 0; }
  return { todayCount: count, path: DIR };
}

module.exports = { onEvent, info, DIR };
