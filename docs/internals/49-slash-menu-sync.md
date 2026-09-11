### مزامنة أوامر CLI في قائمة «/» (المرحلة 14.1)

- IPC قراءة فقط `satr:listCommands(cwd)` → `{ok, commands:[{name, description, argumentHint,
  aliases}]}` عبر `q.supportedCommands()` في تشغيل عابر (`withControlQuery`). يعيد ما يفهمه
  CLI في هذا المشروع: مهارات مضمّنة (verify/code-review/init/review/security-review/…)
  ومهارات المستخدم/المشروع وأوامر أساسية.
- الواجهة: جلب كسول لكل cwd عند فتح قائمة «/» (الأصلية تظهر فوراً وأوامر CLI تلحق بلون
  مميز)؛ الاختيار **يُدرج** `/name ` في المحرّر (يتيح الوسائط) والإرسال كدور عادي —
  نمط `/ضغط` المثبت. المستبعد: `clear/compact/context` (نسخ عربية أصلية أفضل).
- تحديث منتصف الجلسة: حدث `system/commands_changed` (يمرّ عبر بث system القائم) يستبدل
  الكاش كاملاً — supportedCommands تُلتقط عند init ولا تعكس تغييرات لاحقة.

