### موثوقية الإرسال — مهلات الإقلاع والإيقاف (إصلاح 2026-07-30)

- **العلة المشخّصة**: عملية `codex app-server` حيّة غير مستجيبة كانت تعلّق الدور في
  «يستعد» بلا نهاية (`request()` وعد عارٍ بلا مهلة في تسلسل الإقلاع)، وتعليق
  `turn/interrupt` عند الإيقاف كان يعلّق `stopAll` فيحبس قفل `sendRequestBusy` في
  `main.js` إلى الأبد — كل رسالة لاحقة ترتد «انتظر اكتمال بدء الطلب السابق» حتى
  إعادة تشغيل التطبيق. نفس البنية في مسار SDK حين يعلق `agent.start` قبل الحسم.
- **الإصلاح**: `request(method, params, timeoutMs?)` في `codex.js` صار يقبل مهلة
  اختيارية (الطلبات بلا مهلة كما كانت)؛ طلبات الإقلاع الخمسة
  (initialize/thread-resume/thread-start/compact/turn-start) مقيدة بـ
  `BOOT_REQUEST_TIMEOUT_MS=60000` فتفشل صريحاً في مسار catch القائم
  (spawn_error + result خطأ + cleanup يقتل العملية)، و`turn/interrupt` في `stop()`
  مقيد بـ`INTERRUPT_TIMEOUT_MS=5000` ثم cleanup (نمط forceClose في SDK). وفي
  `main.js`: `stopAll(false)` داخل مسار الإرسال داخل `Promise.race` بسقف
  `STOP_ALL_SEND_TIMEOUT_MS=15000` (المقابض تُسحب مزامنةً وأحداث الدور القديم
  محجوبة بـ`runSeq`)، و`await agent.start` بسقف `SDK_START_TIMEOUT_MS=90000` —
  التجاوز يعيد رسالة عربية ويوقف التشغيل اليتيم عند حسمه المتأخر. تجاوز البيئة
  `SATR_CODEX_BOOT_TIMEOUT_MS`/`SATR_CODEX_INTERRUPT_TIMEOUT_MS` (‏100..600000)
  للاختبار القطعي حصراً.
- **التحقق**: `npm run test:send-liveness` (قطعي، بلا شبكة — fixtures بنمط
  `CODEX_BIN=node`): إقلاع صامت يفشل خلال المهلة بدل الصمت الأبدي، إيقاف على قناة
  ميتة يُحسم خلال المهلة، وحرس نصية على حصون main وحدود تجاوز البيئة؛ مسجل في
  `test:full`. عقود Codex الخمسة (contract/steer/compact/account/mcp-panel) أعيد
  تشغيلها خضراء بعد التعديل، و`eval:agent` ‏12/12.

