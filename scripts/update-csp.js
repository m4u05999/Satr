/**
 * تحديث وسم CSP في src/index.html
 *
 * يحسب SHA-256 لمحتوى كتل <style> و <script> المضمّنة ويضع الهاشات في
 * style-src و script-src بدلاً من 'unsafe-inline' — هكذا نحافظ على بنية
 * الملف الواحد ونمنع تنفيذ أي سكربت أو ستايل مضمّن غير الذي كتبناه نحن.
 *
 * يعمل تلقائياً قبل start و dist عبر prestart/predist في package.json،
 * فلا حاجة لتحديث الهاشات يدوياً بعد أي تعديل على index.html.
 *
 * ملاحظة: تعديل التنسيقات من JS عبر CSSOM (مثل el.style.display = '...')
 * لا يتأثر بإزالة 'unsafe-inline' — المحظور هو وسوم وسمات مضمّنة جديدة فقط.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const file = path.join(__dirname, '..', 'src', 'index.html');
const html = fs.readFileSync(file, 'utf8');

const hashOf = (s) =>
  "'sha256-" + crypto.createHash('sha256').update(s, 'utf8').digest('base64') + "'";

// يلتقط الكتل المضمّنة فقط (<style> و <script> بدون سمات) — الملفات الخارجية تغطيها 'self'
function inlineHashes(tag) {
  const re = new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>', 'g');
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) out.push(hashOf(m[1]));
  return out;
}

const styleHashes = inlineHashes('style');
const scriptHashes = inlineHashes('script');
if (!styleHashes.length || !scriptHashes.length) {
  console.error('update-csp: لم يُعثر على كتلة <style> أو <script> مضمّنة في index.html');
  process.exit(1);
}

const csp = [
  "default-src 'self'",
  "style-src 'self' " + styleHashes.join(' '),
  "script-src 'self' " + scriptHashes.join(' '),
  "font-src 'self' data:",
  // الصور الملصقة تُعرض كـ data: URL في مصغّرات الإرفاق وفقاعة المستخدم (المرحلة 4)
  "img-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
].join('; ');

const metaRe = /<meta http-equiv="Content-Security-Policy" content="[^"]*">/;
if (!metaRe.test(html)) {
  console.error('update-csp: لم يُعثر على وسم CSP في index.html');
  process.exit(1);
}

const next = html.replace(metaRe, '<meta http-equiv="Content-Security-Policy" content="' + csp + '">');
if (next !== html) {
  fs.writeFileSync(file, next, 'utf8');
  console.log('update-csp: تم تحديث هاشات CSP');
} else {
  console.log('update-csp: CSP محدّث بالفعل');
}
