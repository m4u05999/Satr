### حساب Codex واستهلاكه ‏(⚙ + تسجيل دخول — الدفعة C4، 2026-07-27)

- **المسبار أولاً**: `scripts/codex-account-probe.js` (سلك خام) على codex-cli ‏0.144.3.
  الطرق من الـschema المولّد (v2/) حصراً: `account/read` و`account/usage/read`
  و`account/rateLimits/read` (كلاهما `params:null`) و`account/login/start` و
  `account/login/cancel`، وإشعار `account/login/completed`. المسبار **لا يكمل OAuth ولا
  يفتح متصفحاً ولا يطبع الرابط أو البريد** — البنية والأطوال فقط، ويتحقق في نهايته أن
  الاعتماد القائم لم يتأثر.
- **أرقام التشغيل الفعلي**: `account/read` في `4ms` أعاد
  `{requiresOpenaiAuth:true, account:{email,planType,type}}` بنوع `chatgpt`.
  `account/usage/read` في `903ms` أعاد `summary` بخمسة حقول
  (`currentStreakDays,lifetimeTokens,longestRunningTurnSec,longestStreakDays,peakDailyTokens`)
  و`42` حاوية يومية بمفتاحي `startDate,tokens`. `account/rateLimits/read` في `692ms`
  أعاد `planType:'prolite'` و`primary:{resetsAt,usedPercent,windowDurationMins}` و
  `secondary:null` و`rateLimitResetCredits.availableCount`.
- **حدّ upstream 1 — البدء فوق اعتماد قائم يُقبل**: `account/login/start {type:'chatgpt'}`
  **لم يُرفض** رغم أن الجهاز مسجَّل الدخول (`accepted_while_logged_in:true` في `1ms`)،
  وأعاد `{type,authUrl,loginId}` — الرابط `https` على مضيف OpenAI بطول `481` محرفاً،
  و`loginId` بطول `36`. لذلك تعرض الواجهة زرّ «سجّل دخول Codex» **فقط** عند
  `installed && !auth.ok` ولا تتيح بدء دورة تفسد اعتماداً صالحاً.
- **حدّ upstream 2 — الإلغاء يولّد إشعار اكتمال «فاشل»**: بعد `account/login/cancel`
  (‏`status:'canceled'` في `1ms`) وصل `account/login/completed` بـ`success:false` ومعه نص
  خطأ. لذلك «سطر» لا يعرض فشلاً حين يكون الإلغاء بطلب المستخدم؛ ولا يمرّر نص الخطأ.
- **حدّ upstream 3 — إلغاء معرّف مجهول يردّ خطأ لا حالة**: الـschema يعلن
  `CancelLoginAccountStatus: canceled|notFound`، لكن الاستدعاء بمعرّف غير موجود ردّ
  خطأ JSON-RPC ‏`-32600` بدل `status:'notFound'`. لا نعوّل على القيمة المعلنة.
- **حدّ upstream 4 — `credits.balance` نص لا رقم** (رُصد `"0"`)، و`limitName` و
  `rateLimitReachedType` قد تكونان `null`. التطبيع يمرّرها منقّاة بلا تأويل عددي.
- **المحرك**: `electron/codex.js` يضيف `accountUsage()` و`accountRateLimits()` فوق
  `rateLimits()` القائمة، و`normalizeRateLimits()` النقية (قصّ `usedPercent` إلى
  `0..100`، وإسقاط نافذة بلا `usedPercent`، وقائمة حقول مغلقة). ودورة الدخول
  `accountLoginStart/Url/Await/Cancel` **بنمط C3 حرفياً**. الثلاث الأُوَل تقبل `cwd`
  اختيارياً (الافتراضي المنزل) للاختبار القطعي فقط — **main.js لا يمرّره**، فلا يصل مسار
  من renderer إلى `spawn`.
- **أمان تسجيل الدخول**: الرابط لا يعبر IPC ولا يُبثّ؛ يبقى في `pendingAccountLogin`
  داخل `codex.js` بسقف عمر `5` دقائق. `satr:codexLoginStart` يعيد `{ok,id}` **فقط**
  (لا رابط ولا `loginId` الداخلي)، بمعرّف بنمط `^cxlogin_[0-9]{1,9}_[a-z0-9]{1,8}$`. بعد
  `confirm` عربي صريح يقرأ `satr:codexLoginOpen` الرابط عبر `accountLoginUrl` المنقّى
  بـ`safeOauthUrl` نفسها (C3) fail-closed ثم `shell.openExternal` وينتظر الإشعار. فشل
  الفتح يبقي الطلب معلّقاً لإعادة المحاولة، والإلغاء يُرسل `account/login/cancel` إلى
  Codex ثم يُسقط الطلب. **لا يُخزَّن أي token في «سطر»، ولا يُقرأ `auth.json` في مسار
  C4 إطلاقاً** (‏`authStatus()` القائمة تبقى احتياطاً لـ`accountStatus` كما كانت).
- **الواجهة**: قسم «حساب Codex» في ⚙ بنمط قسم «حساب Claude» (دفعة B): الحالة وطريقة
  الاعتماد والخطة ونسبة استهلاك النافذة ورموز آخر 30 يوماً والإجمالي التراكمي، بأرقام
  LTR وتحديث كسول عند فتح ⚙ فقط. زر تسجيل الدخول يظهر عند `installed && !auth.ok`.
  بوابة أول التشغيل تبقى خاصة بكلود بلا تغيير.
- **قرار: `review/start` أُسقط من هذه الدفعة** (كان اختيارياً). السبب من الـschema لا من
  ضيق الوقت: `ReviewStartResponse` يعيد `{reviewThreadId, turn}` — أي أن المراجعة تجري في
  **خيط منفصل**، وأحداثها تصل بـ`threadId` مختلف عن الجذر. عرضها يستلزم مسار توجيه أحداث
  لخيط ثانٍ يخترق مرشّح `belongsToRootThread/belongsToRootTurn` الذي يحرسه
  `test:codex-contract` (وهو عقد عدم تراجع ملزم)، ويستلزم كذلك عملاً في `chat.js` الحسّاس.
  ذلك دفعة مستقلة بحاجزها الخاص، لا ذيل دفعة. (تأكيد إضافي من الـschema:
  `NonSteerableTurnKind` يضم `review` — دور المراجعة صنف مستقل غير قابل للتوجيه.)
- **إعادة تحقّق (2026-08-27، ‏`0.149.1`)**: العقود **صامدة** (البدء فوق اعتماد قائم ما
  زال يُقبل، والإلغاء يولّد `completed` بـ`success:false`، والمعرّف المجهول يردّ `-32600`،
  و`credits.balance` نص). والانحراف **إضافي**: `usage/read` كسب `threadUsage`، و
  `rateLimits/read` كسب `rateLimitsByLimitId` و`individualLimit` و`limitId` و
  `spendControlReached`. قائمة الحقول المغلقة في `normalizeRateLimits` تُسقطها
  fail-closed فلا يتأثر العرض.
- **إعادة تحقّق (2026-09-03، ‏`0.153.0`)**: العقود صامدة، و**انحراف بالحذف**: `account/read`
  صار يعيد `account:{planType,type}` **بلا `email`**. لا أثر على سطر لأن العقد العام لم يمرّر
  البريد يوماً (بند «غياب أي بريد أو رمز في كل ردّ»)؛ يُذكر كي لا يُبنى عليه لاحقاً.
- **التحقق**: `npm run test:codex-account` (قطعي، بلا شبكة — fixture عبر `CODEX_BIN=node`)
  يغطي تطبيع الاستهلاك والحدود وقوائم الحقول المغلقة، `params:null` على السلك، دورة
  الدخول (نجاح/رفض/إلغاء يُرسل `account/login/cancel`/رابط غير آمن/بلا رابط/فشل)،
  **فحصاً صريحاً لعدم تسرّب الرابط أو `loginId` من قناة البدء**، غياب أي بريد أو رمز في
  كل ردّ، عدم قراءة ملف من القرص داخل كتلة C4، عقود `main.js` وpreload، التدهور الرشيق
  برسائل عربية بلا نص upstream، وثبات مجموعة أنواع `satr:event`. وهو داخل `test:full`.
  المسبار الحيّ `npm run test:codex-account-probe` خارجها عمداً.

