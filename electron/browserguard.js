/**
 * حارس المتصفح الخارجي (browserguard) — موديول نقي بلا اعتماديات (نمط diff.js/autogate.js).
 *
 * متصفح «سطر» المدمج هو المسار الصحيح للمعاينة والتصفح في أدوار الدردشة، لكن النماذج
 * «تنسى» التوجيه النصي في الجلسات الطويلة فتفتح كروم بـ Start-Process أو تطلب من
 * المستخدم التصفح بنفسه. هذا الموديول يعطي المحرّكين (SDK وCodex) حارسين مشتركين:
 *
 *  - isExternalBrowserLaunchCommand(command): هل أمر الصدفة يفتح متصفح نظام خارجي؟
 *    (استُخرجت من codex.js حرفياً كي لا تتباعد نسختان — أوامر خوادم التطوير العادية
 *    مثل npm run dev لا تتأثر).
 *  - promptRequestsExternalBrowser(prompt): هل ذكر المستخدم في رسالة هذا الدور متصفحاً
 *    خارجياً؟ (قرار مالك 2026-07-18 + ملاحظة مراجعة Codex المثبّتة): المطابقة **لا
 *    تعطّل الحاجب** — تحوّله إلى **مربع إذن قسري لمرة واحدة** في المحرّكين، يتخطى
 *    «الموافقة الدائمة» ووضع auto (وإلا تحوّل ذكر عابر مثل «المشكلة تظهر في كروم»
 *    مع موافقة Bash دائمة إلى تنفيذ صامت). فالخطأ الإيجابي أقصى أثره سؤال إضافي.
 *
 * ملاحظة regex: ‏\b في JS حدود ‎[A-Za-z0-9_]‎ فلا تعمل مع العربية — الحدود العربية
 * هنا صريحة عبر (?:^|[\s،:؛(«"']) قبل الكلمة.
 */
'use strict';

// أمر صدفة يفتح متصفح نظام خارجي (منقولة من codex.js — نفس الدلالة حرفياً)
function isExternalBrowserLaunchCommand(command) {
  if (typeof command !== 'string' || !command.trim()) return false;
  const text = command.trim();
  const directBrowser = /(?:^|[;&|]\s*)(?:"[^"\r\n]*[\\/])?(?:chrome|msedge|firefox|brave)(?:\.exe)?(?:"|\s|$)/i;
  const launcherWithBrowser = /\b(?:Start-Process|start)\b[^\r\n]*\b(?:chrome|msedge|firefox|brave)(?:\.exe)?\b/i;
  if (directBrowser.test(text) || launcherWithBrowser.test(text)) return true;
  if (!/(?:https?:\/\/|\blocalhost(?::\d+)?\b)/i.test(text)) return false;
  return /\b(?:Start-Process|Invoke-Item|explorer(?:\.exe)?|xdg-open|sensible-browser)\b/i.test(text)
    || /(?:^|[;&|]\s*)(?:start|open)\s+(?:""\s+)?/i.test(text);
}

// فاصل كلمات صالح للعربية والإنجليزية معاً (\b لا يعمل مع العربية)
const SEP = '[\\s،؛:.()«»"\'\\-]';
const B = '(?:^|' + SEP + ')';
// اسم متصفح خارجي أو عبارة تدل عليه (كروم/إيدج/فايرفوكس/بريف أو «المتصفح الخارجي/العادي/متصفح النظام»)
const BROWSER_WORD = '(?:جوجل\\s*كروم|كروم|chrome|إيدج|ايدج|edge|فايرفوكس|firefox|بريف|brave|' +
  '(?:ال)?متصفح(?:ي|ك)?\\s+(?:ال)?(?:خارجي|عادي|نظام)|external\\s+browser|system\\s+browser|real\\s+browser)';
// فعل فتح/استخدام يسبق اسم المتصفح ضمن مسافة قصيرة في الجملة نفسها
// (يمنع مطابقة ذكر عابر مثل «الموقع يدعم كروم» — الفعل شرط)
const VERB_THEN_BROWSER = new RegExp(
  B + '(?:افتح(?:ه|ها|هما)?|شغل|شغّل|استخدم|استعمل|اعرض(?:ه|ها)?|جرب|جرّب|open|launch|use|show|try)' +
  '[^.؟?!\\n]{0,50}?' + SEP + BROWSER_WORD, 'i');
// صيغة جرّ: «في كروم» / «بالمتصفح الخارجي» / in chrome / with firefox
const IN_BROWSER = new RegExp(
  B + '(?:(?:في|فى|عبر|داخل|in|with|via)\\s+(?:ال)?|بال|ب)' + BROWSER_WORD, 'i');

// هل ذكرت رسالة المستخدم متصفحاً خارجياً؟ (المطابقة ⇒ مربع إذن قسري لمرة واحدة في الدور)
function promptRequestsExternalBrowser(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim()) return false;
  const text = prompt.slice(0, 8000); // سقف حماية — الطلب الصريح يأتي في صدر الرسالة عادة
  return VERB_THEN_BROWSER.test(text) || IN_BROWSER.test(text);
}

module.exports = { isExternalBrowserLaunchCommand, promptRequestsExternalBrowser };
