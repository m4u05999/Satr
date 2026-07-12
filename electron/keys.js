/**
 * مخزن مفاتيح «سطر» — يقرأ/يكتب `~/.satr/keys.json` (كائن اسم→مُدخَل).
 *
 * 🌱 بذرة إدارة أسرار المزوّدين للنسخة Enterprise: بدل الاعتماد على متغيّرات بيئة النظام
 * (هشّة مع وراثة العمليات وإعادة التشغيل)، «سطر» يملك مصدر مفاتيحه ويقرؤه لحظة الطلب.
 * القيم أسرار — تُمرَّر لترويسات HTTP فقط، لا لوسائط spawn ولا لأي صدفة.
 *
 * 🔒 التشفير (safeStorage): القيم تُخزَّن مشفّرة عبر Electron safeStorage (DPAPI على
 * ويندوز / Keychain على ماك / libsecret على لينكس) بدل النصّ الصريح. صيغة كل مُدخَل:
 *   { enc: true,  v: "<base64 لنص مشفّر>" }   ← الحالة المعتادة
 *   { enc: false, v: "<نص صريح>" }            ← عند تعذّر التشفير (لينكس بلا keyring)
 *   "<نص صريح>"                                ← صيغة قديمة (قبل التشفير) — تُقرأ وتُرحَّل
 * التشفير يتطلب جهوزية التطبيق (app ready)؛ migrate() تُستدعى بعد الجهوز لترحيل القديم.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { safeStorage } = require('electron');

const KEYS_PATH = path.join(os.homedir(), '.satr', 'keys.json');

// هل التشفير متاح؟ (قد يكون false على لينكس بلا خدمة مفاتيح، أو قبل جهوزية التطبيق)
function encAvailable() {
  try { return safeStorage.isEncryptionAvailable(); } catch (e) { return false; }
}

// يبني مُدخَلاً مخزَّناً من قيمة صريحة: مشفّراً إن أمكن، وإلا صريحاً موسوماً
function toEntry(plain) {
  const s = String(plain);
  if (encAvailable()) {
    try { return { enc: true, v: safeStorage.encryptString(s).toString('base64') }; }
    catch (e) { /* يسقط للصريح أدناه */ }
  }
  return { enc: false, v: s };
}

// يفكّ مُدخَلاً مخزَّناً إلى قيمة صريحة (يتسامح مع الصيغة القديمة النصّية)
function fromEntry(entry) {
  if (typeof entry === 'string') return entry; // صيغة قديمة: نصّ صريح مباشرة
  if (entry && typeof entry === 'object' && typeof entry.v === 'string') {
    if (entry.enc === false) return entry.v; // صريح موسوم (تعذّر التشفير وقت الحفظ)
    if (entry.enc === true) {
      if (!encAvailable()) return ''; // مشفّر ولا مفتاح لفكّه الآن
      try { return safeStorage.decryptString(Buffer.from(entry.v, 'base64')); }
      catch (e) { return ''; } // تلِف/مفتاح مختلف — نتجاهل بدل الكسر
    }
  }
  return '';
}

// قراءة الخريطة الخام (اسم→مُدخَل) أو {} إن غاب/تلِف الملف
function readRaw() {
  try {
    const j = JSON.parse(fs.readFileSync(KEYS_PATH, 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch (e) {
    return {};
  }
}

// كتابة الخريطة الخام كاملةً (تُنشئ ~/.satr إن لزم). ترمي عند الفشل — يلتقطها main.js.
function writeRaw(map) {
  const dir = path.dirname(KEYS_PATH);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* موجود مسبقاً */ }
  // mode 0o600: دفاع بعمق على المنصّات التي تحترمه (يُتجاهل على ويندوز)
  fs.writeFileSync(KEYS_PATH, JSON.stringify(map, null, 2), { mode: 0o600 });
}

// هل للمُدخَل قيمة فعلية غير فارغة؟ (بلا فكّ تشفير — فحص وجود للأسماء)
function hasValue(entry) {
  if (typeof entry === 'string') return !!entry.trim();
  return !!(entry && typeof entry === 'object' && typeof entry.v === 'string' && entry.v);
}

// يعيد قيمة المفتاح المطلوب (نص مقصوص) أو '' إن غاب الملف/المفتاح أو تلِف
function get(name) {
  const v = fromEntry(readRaw()[name]);
  return typeof v === 'string' ? v.trim() : '';
}

// أسماء المفاتيح المضبوطة فعلاً (بلا قيمها — أمان: لا تُكشف الأسرار للواجهة)
function names() {
  const j = readRaw();
  return Object.keys(j).filter((k) => hasValue(j[k]));
}

// ضبط/تحديث مفتاح (يحفظ بقية المفاتيح؛ يُخزَّن مشفّراً إن أمكن)
function set(name, value) {
  const j = readRaw();
  j[name] = toEntry(value);
  writeRaw(j);
}

// حذف مفتاح
function remove(name) {
  const j = readRaw();
  if (name in j) { delete j[name]; writeRaw(j); }
}

/**
 * ترحيل المفاتيح القائمة إلى الصيغة المشفّرة (بعد جهوزية التطبيق). أفضل جهد:
 * يحوّل القديم النصّي والمُدخَلات الصريحة الموسومة إلى مشفّرة إن أصبح التشفير متاحاً،
 * ولا يكتب إلا عند وجود تغيير فعلي. الفشل لا يكسر الإقلاع.
 */
function migrate() {
  try {
    if (!encAvailable()) return; // لا تشفير متاح — أبقِ الصريح كما هو (تدهور رشيق)
    const j = readRaw();
    let changed = false;
    for (const k of Object.keys(j)) {
      const entry = j[k];
      const legacyPlain = typeof entry === 'string';
      const markedPlain = entry && typeof entry === 'object' && entry.enc === false;
      if (legacyPlain || markedPlain) {
        const plain = fromEntry(entry);
        if (plain) { j[k] = toEntry(plain); changed = true; }
      }
    }
    if (changed) writeRaw(j);
  } catch (e) { /* أفضل جهد — الترحيل الفاشل لا يمنع العمل */ }
}

module.exports = { get, names, set, remove, migrate, KEYS_PATH };
