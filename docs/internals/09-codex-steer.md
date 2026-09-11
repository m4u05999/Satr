### التوجيه أثناء الدور لمحرك Codex (turn/steer — الدفعة C1، 2026-07-26)

- **المسبار أولاً**: `scripts/codex-steer-probe.js` على codex-cli ‏0.144.3 (نموذج
  `gpt-5.6-sol`). طبقتان: **سلك خام** (المسبار يشغّل `codex app-server` بنفسه ويتكلم
  JSON-RPC مباشرةً، فالنتيجة توثّق عقد upstream مستقلاً عن تنفيذ «سطر») ثم **تكامل** عبر
  مقبض `codex.start()`. مصدر العقد هو الـschema المولّد من الثنائي المثبّت
  (`codex app-server generate-json-schema --out <dir> --experimental`، ملفات `v2/` حصراً):
  `TurnSteerParams` يوجب `{threadId, expectedTurnId, input:[UserInput]}` و`TurnSteerResponse`
  يعيد `{turnId}`. لم يُبنَ شيء على `thread/rollback` (موسوم DEPRECATED في الـschema).
- **نتائج المسبار الفعلية**: التوجيه أثناء دور جارٍ نجح ووصل إلى النموذج في الدور نفسه
  (ظهرت العلامة في الإجابة النهائية، طولها `3283` محرفاً بعد `1012` إشعاراً، وحالة
  `turn/completed` = `completed`). **التوجيه لا ينشئ دوراً جديداً**: `turn/steer` أعاد
  معرّف الدور نفسه (`steer_turn_id_equals_start:true`) وكذلك `turn/completed`، لذلك
  مرشّح `belongsToRootTurn` وعزل أحداث الوكلاء الفرعيين يبقيان صحيحين **بلا أي تعديل**.
- **حدّ upstream مثبّت (أمني)**: `expectedTurnId` شرط مسبق إلزامي لا تحسين — عدم المطابقة
  يردّ `-32600` برسالة `expected active turn id \`X\` but found \`Y\``، **وهي تحمل معرّف
  الدور النشط الفعلي**. لذلك لا تُمرَّر رسالة upstream الخام إلى renderer إطلاقاً؛ يعيد
  المحرك رموزاً ثابتة (`rejected`) فقط. وبعد `turn/completed` يردّ `-32600`
  ‏`no active turn to steer`.
- **المحرك**: `electron/codex.js` يضيف `steer(text)` إلى مقبض التشغيل (بجانب
  `resolvePermission`/`resolveQuestion`/`resolveHandoff`/`stop`). يرفض محلياً قبل السلك إن
  كان النص فارغاً أو لا دور نشطاً (`finished || stopping || !threadId || !turnId`)، ويرسل
  `expectedTurnId: turnId` النشط. ويصدّر `sanitizeSteerText` النقية و`MAX_STEER_CHARS`.
- **IPC**: `satr:steer {text}` — التنقية تُفرض في `main.js` عبر `codex.sanitizeSteerText`
  (نمط `nonSdkPerm` من autogate.js: منطق نقي مختبَر وحده، ونقطة الفرض في العملية
  الرئيسية): نص فقط، تطبيع CRLF، إزالة محارف التحكم ومحارف Bidi
  (`U+061C/200E/200F/202A-202E/2066-2069`)، وسقف `32000` محرف. ثم بوابتان: `lastEngine`
  يجب أن يكون `codex` (غيره ⇒ `unsupported`) ووجود `currentRun.steer` (وإلا
  `no_active_turn`). `preload.js` يكشف `steer(text)` المحددة فقط. **لا نوع حدث جديد في
  `satr:event`** ولا تغيير في أي عقد قائم.
- **الواجهة**: أثناء دور Codex الجاري لا يُقفل المؤلّف. كتابة نص تحوّل زرّ الإرسال إلى
  «↪ وجّه» ويستدعي `satr:steer`؛ الحقل الفارغ يبقيه «إيقاف» فلا يضيع فعل الإيقاف ولا
  يلزم زرّ ثالث. المرجع هو `runningEngine` (المحرك الجاري فعلاً) لا منتقي الواجهة، فتبديل
  المنتقي أثناء دور جارٍ لا يضلّل الزر. الرسالة المُوجَّهة تظهر كفقاعة مستخدم موسومة
  «↪ توجيه أثناء الدور» (`meta.steer` في `chat.addUserMsg`) وبلا أزرار تحرير/تفريع/
  استرجاع/غرفة عمليات لأنها ليست حدّ دور. بقية المحركات بلا تغيير سلوكي.
- **لماذا Codex وحده**: Kimi ACP يرفض دوراً ثانياً أثناء دور جارٍ (‏`-32600` — موثّق في
  قسم Kimi)، ومحرك SDK لا يملك عقد steer. لذلك `unsupported` صريحة لا محاكاة.
- **إعادة تحقّق (2026-08-27، ‏codex-cli ‏`0.149.1`)**: عقد السلك **صامد حرفياً** —
  `steer_turn_id_equals_start:true`، وعدم المطابقة يردّ `-32600` **ومعه معرّف الدور
  النشط** (فيبقى حجب نص upstream لازماً لا احتياطاً)، وبعد الاكتمال `no active turn to
  steer`. العلامة بلغت الإجابة النهائية (`3269` محرفاً بعد `996` إشعاراً).
- **إعادة تحقّق (2026-09-03، ‏`0.153.0` — ترقية بقرار مالك بعد رادار ٠٠١)**: **صامد** بالثلاثة
  نفسها؛ العلامة بلغت الإجابة النهائية (`3386` محرفاً بعد `1071` إشعاراً)، ومقبض
  `codex.start()` أعاد معرّف الدور نفسه ورفض ما بعد الاكتمال بـ`no_active_turn`.
- **التحقق**: `npm run test:codex-steer` (قطعي، بلا شبكة — fixture عبر `CODEX_BIN=node`
  بنمط `codex-contract-test.js`) يغطي التنقية النقية (النوع، الفراغ، السقف، CRLF،
  محارف التحكم، اثني عشر محرف Bidi)، وعقد السلك (`threadId`/`expectedTurnId` النشط/شكل
  `UserInput` وعدم تسرّب حقول زائدة)، ورفض الفارغ بلا حركة على السلك، ورفض ما بعد نهاية
  الدور، وتطبيع خطأ upstream إلى `rejected` مع **فحص صريح لعدم تسرّب معرّف الدور أو نص
  الخطأ**، وثبات مجموعة أنواع `satr:event`. وهو داخل `test:full`. المسبار الحيّ
  `npm run test:codex-steer-probe` يبقى خارج `test:full` عمداً مثل بقية مسابير Codex
  (يستهلك دورين حقيقيين؛ `--raw-only` يشغّل عقد السلك وحده).

