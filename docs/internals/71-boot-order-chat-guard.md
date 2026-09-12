## ٧١ — ترتيب الإقلاع وحارس `<satr-chat>`: نداءات القشرة قبل ترقية المكوّن (OBS-172)

**التاريخ**: 2026-09-12 · **الدفعة**: (هـ) من جولة اختبار الواجهة · **الملفات**:
`src/ui/app.js` · `scripts/testsprite-harness-live-test.js`.

## العلّة

`src/index.html` يحمّل `ui/app.js` **قبل** `ui/components/chat.js` **عمداً**: القشرة تربط
مستمعيها على العناصر الثابتة قبل ترقية المكوّنات (نمط ت-10)، فلا يضيع حدث يقع أثناء الترقية.
الثمن أن `document.querySelector('satr-chat')` يعيد عنصراً **غير مُرقّى** خلال تنفيذ `app.js`:
عنصر `HTMLElement` عادي بلا `addNotice` ولا `clearThread`.

مسار الإقلاع يمرّ فعلاً بهذا الحقل: `loadProviders()` ⇐ `restoreCurrentConversation()` تستدعي
`window.satr.conversationCurrent(cwd)` ثم — إن لم يعد `ok` — `addNotice(...)` وهي حرفياً
`chatEl.addNotice(text)`. الشرط أن يكون `#cwd` غير فارغ عند الإقلاع، وهو يُملأ من
`localStorage.satr_cwd` في الحلقة العامة للإعدادات المحفوظة (`app.js` أعلى الملف).

ما يحسم المسألة هو **زمن وصول الجواب**:

- في الإنتاج يمرّ الجواب بـIPC حقيقي، فيصل حدثاً متأخراً بعد ترقية المكوّنات ⇒ لم يُرصد قط.
- على حاضن TestSprite يعيد الجسر المزيّف (`electron/testspriteharness-client.js`، الـProxy
  يردّ على أي `window.satr.X` بـ`{ ok:false, error:'not_implemented_in_harness' }`) وعداً
  **محلولاً فوراً**، فتُصرَّف المتابعة في microtask **قبل** تنفيذ `chat.js` ⇒
  `Uncaught (in promise) TypeError: chatEl.addNotice is not a function`، ويُبتلع كل ما بعده
  في `loadProviders` ومنه `applyGateEngineSwitch()`.

أي أن الشجرة كانت تعتمد على افتراض «IPC أبطأ من الترقية» — وهو **افتراض لا عقد**.

## الحلّ (بلا قلب ترتيب التحميل)

طبقتان صغيرتان في `src/ui/app.js` وحده؛ `index.html` والمكوّنات لم تُمسّ:

1. **طابور تأجيل في `addNotice`**: إن لم يكن المكوّن مُرقّى يُؤجَّل النداء إلى
   `customElements.whenDefined('satr-chat')`. الترتيب محفوظ لأن الوعد واحد و`then` تُصرَّف
   بالتسلسل. هذه تغطّي **النمط**: كل نداءات `addNotice` في مسار الإقلاع (‏`checkCodexReady`،
   `checkKimiReady`، `applyGateEngineSwitch`، …) لا الحالة المقيسة وحدها.
2. **انتظار واحد قبل مسار الاستعادة** في `loadProviders`: `await customElements.whenDefined('satr-chat')`
   قبل `restoreCurrentConversation()`. سببه أن المسار يلمس المكوّن **مباشرةً** لا عبر
   `addNotice` فقط (`clearThread` · `showConversationHistory` · `scrollToEnd`)، وحراسة كل
   نداء منها على حدة أكبر من حارس واحد عند المدخل.

النمط نفسه مستعمل أصلاً في `app.js` لمكوّنات أخرى (`whenDefined('satr-composer')` ·
`'satr-topbar'` · `'satr-preview-panel'`) — فالحلّ من جنس ما في الملف لا اختراع.

## القياس

حالة ثانية في `scripts/testsprite-harness-live-test.js` (`caseSavedCwdBoot`): تكتب
`localStorage.satr_cwd` ثم **تعيد تحميل** الصفحة، فيقلع التطبيق بمجلد محفوظ — بخلاف الحالة
الأولى التي تضبط `#cwd` بعد التحميل فلا تمرّ بالمسار أصلاً. ثم تنتظر أثراً **ملموساً**:
هبوط نصّ «تعذرت استعادة المحادثة المحفوظة لهذا المشروع» في `<satr-chat>` بعد ترقيته، مع
`consoleErrors` فارغة.

- **قبل الإصلاح**: `انتهت مهلة هبوط إشعار تعذّر الاستعادة على <satr-chat> بعد ترقيته — أخطاء
  console: Uncaught (in promise) TypeError: chatEl.addNotice is not a function`.
- **بعد الإصلاح**: خضراء، والإشعار يهبط.
- **العضّة**: إعادة الحارسين معاً إلى الصورة القديمة تُسقط الحالة بالرسالة نفسها حرفياً.

## الحدود — مُصرَّح بها

- **الحالة مقيسة على الحاضن**: الحاضن يجعل الجسر متزامناً عملياً؛ الإنتاج يمرّ بـIPC حقيقي
  فالعطل لم يُرصد فيه. الاختبار يحرس **العقد** (لا تفترض ترتيباً بين الجسر والترقية) لا
  انفجاراً إنتاجياً مشهوداً.
- **إعادة تحميل لا نافذة ثانية**: نافذة ثانية بقسم تخزين جديد على الخادم نفسه عادت
  `ERR_FAILED (-2)` في هذه البيئة (مقيس مرتين)؛ وإعادة التحميل تكفي لأن المطلوب إقلاع جديد
  لا قسم تخزين جديد. السبب البيئي لـ`ERR_FAILED` لم يُشخّص.
- **الحارسان ليسا متعامدين في هذه الحالة**: الانتظار قبل `restoreCurrentConversation` وحده
  يكفي للحالة المقيسة (مقيس: بعضّة أُعيدت فيها `addNotice` وحدها بقيت الحالة خضراء)؛ طابور
  `addNotice` يبقى لأنه يغطّي نداءات إقلاع أخرى **لا تمرّ** بهذا المدخل.
- **`applyGateEngineSwitch()` لم يُقَس أثره مباشرةً**: على الحاضن تكون البوابة جاهزة بـ`sdk`
  فتخرج الدالة مبكراً بلا أثر في DOM. الدليل على أن ما بعد `addNotice` صار يعمل هو غياب
  الرفض غير المعالَج + هبوط الإشعار.
