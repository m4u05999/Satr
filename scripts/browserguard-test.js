/**
 * اختبار browserguard.js النقي — حارسا المتصفح الخارجي المشتركان بين المحرّكين.
 * التشغيل: npm run test:browserguard (بلا شبكة ولا Electron).
 */
'use strict';

const { isExternalBrowserLaunchCommand, promptRequestsExternalBrowser } = require('../electron/browserguard');

let passed = 0;
let failed = 0;
function check(name, actual, expected) {
  if (actual === expected) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name + ' — توقعنا ' + expected + ' فجاء ' + actual); }
}

console.log('[1] isExternalBrowserLaunchCommand — أوامر تفتح متصفحاً خارجياً');
check('Start-Process chrome', isExternalBrowserLaunchCommand('Start-Process chrome http://localhost:3000'), true);
check('start msedge', isExternalBrowserLaunchCommand('start msedge https://example.com'), true);
check('chrome.exe مباشرة', isExternalBrowserLaunchCommand('chrome.exe http://localhost:5173'), true);
check('مسار كامل بعلامات اقتباس', isExternalBrowserLaunchCommand('"C:\\Program Files\\Google\\Chrome\\chrome" http://localhost:8080'), true);
check('Start-Process URL بلا اسم متصفح', isExternalBrowserLaunchCommand('Start-Process http://localhost:4600'), true);
check('start "" URL (نمط cmd)', isExternalBrowserLaunchCommand('start "" http://localhost:3000'), true);
check('xdg-open برابط', isExternalBrowserLaunchCommand('xdg-open http://localhost:3000'), true);
check('explorer برابط', isExternalBrowserLaunchCommand('explorer http://localhost:3000'), true);
check('أمر مركّب بعد &&', isExternalBrowserLaunchCommand('npm run build && start chrome http://localhost:3000'), true);

console.log('[2] isExternalBrowserLaunchCommand — أوامر بريئة لا تُحجب');
check('npm run dev', isExternalBrowserLaunchCommand('npm run dev'), false);
check('npm start', isExternalBrowserLaunchCommand('npm start'), false);
check('node server.js', isExternalBrowserLaunchCommand('node server.js --port 3000'), false);
check('curl على localhost', isExternalBrowserLaunchCommand('curl http://localhost:3000/api'), false);
check('git push', isExternalBrowserLaunchCommand('git push origin main'), false);
check('start اسم سكربت npm (لا رابط)', isExternalBrowserLaunchCommand('npm run start'), false);
check('نص فارغ', isExternalBrowserLaunchCommand(''), false);
check('غير نص', isExternalBrowserLaunchCommand(null), false);

console.log('[3] promptRequestsExternalBrowser — ذكر المتصفح الخارجي (المطابقة = مربع إذن قسري لمرة واحدة، لا تعطيل للحاجب)');
check('افتح كروم', promptRequestsExternalBrowser('افتح كروم على الموقع'), true);
check('افتحه في كروم', promptRequestsExternalBrowser('جرّب الصفحة ثم افتحها في كروم'), true);
check('بالمتصفح الخارجي', promptRequestsExternalBrowser('اعرض النتيجة بالمتصفح الخارجي'), true);
check('متصفح النظام', promptRequestsExternalBrowser('استخدم متصفح النظام هذه المرة'), true);
check('open in chrome', promptRequestsExternalBrowser('please open it in chrome'), true);
check('use firefox', promptRequestsExternalBrowser('use firefox to test this'), true);
check('شغّل فايرفوكس', promptRequestsExternalBrowser('شغّل فايرفوكس وجرب تسجيل الدخول'), true);
check('في إيدج', promptRequestsExternalBrowser('المطلوب تجربة الموقع في إيدج'), true);
// ملاحظة مراجعة Codex: ذكر عابر بصيغة جرّ يطابق أيضاً — وهذا مقبول لأن المطابقة
// تفرض مربع إذن لمرة واحدة (لا تعطّل الحاجب)، فأقصى أثر الخطأ الإيجابي سؤال إضافي.
check('ذكر عابر بصيغة جرّ (يفرض سؤالاً لا تعطيلاً)', promptRequestsExternalBrowser('أصلح المشكلة التي تظهر في كروم'), true);

console.log('[4] promptRequestsExternalBrowser — كلام عادي لا يفتح الباب');
check('مهمة تطوير عادية', promptRequestsExternalBrowser('شغّل المشروع وافتح المعاينة وتحقق من الصفحة'), false);
check('ذكر عابر لكروم بلا فعل', promptRequestsExternalBrowser('الموقع يدعم كروم وسفاري'), false);
check('متصفح سطر المدمج', promptRequestsExternalBrowser('افتح متصفح سطر المدمج على الصفحة'), false);
check('نص فارغ', promptRequestsExternalBrowser(''), false);
check('غير نص', promptRequestsExternalBrowser(undefined), false);
check('طلب إصلاح باج وصفي', promptRequestsExternalBrowser('أصلح الزر الذي لا يعمل في الصفحة الرئيسية'), false);

console.log('');
if (failed) { console.error('فشل ' + failed + ' من ' + (passed + failed)); process.exit(1); }
console.log('نجح الكل: ' + passed + '/' + passed);
