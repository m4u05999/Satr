/**
 * مخزن مفاتيح «سطر» — يقرأ `~/.satr/keys.json` (كائن اسم→قيمة).
 *
 * 🌱 بذرة إدارة أسرار المزوّدين للنسخة Enterprise: بدل الاعتماد على متغيّرات بيئة النظام
 * (هشّة مع وراثة العمليات وإعادة التشغيل)، «سطر» يملك مصدر مفاتيحه ويقرؤه لحظة الطلب.
 * لاحقاً تكتب فيه واجهة إعدادات؛ الآن قراءة فقط. القيم أسرار — تُمرَّر لترويسات HTTP فقط،
 * لا لوسائط spawn ولا لأي صدفة.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const KEYS_PATH = path.join(os.homedir(), '.satr', 'keys.json');

// قراءة الملف كاملاً ككائن (أو {} إن غاب/تلِف)
function readAll() {
  try {
    const j = JSON.parse(fs.readFileSync(KEYS_PATH, 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch (e) {
    return {};
  }
}

// كتابة الكائن كاملاً (تُنشئ ~/.satr إن لزم). ترمي عند الفشل — يلتقطها main.js.
function writeAll(obj) {
  const dir = path.dirname(KEYS_PATH);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* موجود مسبقاً */ }
  fs.writeFileSync(KEYS_PATH, JSON.stringify(obj, null, 2));
}

// يعيد قيمة المفتاح المطلوب (نص مقصوص) أو '' إن غاب الملف/المفتاح أو تلِف
function get(name) {
  const v = readAll()[name];
  return typeof v === 'string' ? v.trim() : '';
}

// أسماء المفاتيح المضبوطة فعلاً (بلا قيمها — أمان: لا تُكشف الأسرار للواجهة)
function names() {
  const j = readAll();
  return Object.keys(j).filter((k) => typeof j[k] === 'string' && j[k].trim());
}

// ضبط/تحديث مفتاح (يحفظ بقية المفاتيح)
function set(name, value) {
  const j = readAll();
  j[name] = String(value);
  writeAll(j);
}

// حذف مفتاح
function remove(name) {
  const j = readAll();
  if (name in j) { delete j[name]; writeAll(j); }
}

module.exports = { get, names, set, remove, KEYS_PATH };
