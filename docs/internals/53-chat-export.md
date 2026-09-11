### تصدير المحادثة 📤 (الدفعة 4.8 — «مشاركة»)

- **الفتح**: زرّ 📤 في الشريط العلوي (نمط ± — لا أمر `/`) يصدّر **المحادثة الحالية**
  ملف Markdown: ترويسة (تاريخ/مشروع/محرك/جلسة) + «👤 المستخدم / 🤖 النموذج» بالتناوب
  وأدوات المساعد سطر اقتباس. يتطلب جلسة قائمة (قبل أول رسالة ⇒ تنبيه هادئ).
- **IPC قراءة فقط**: `satr:exportChat {engine, sessionId, cwd}` → `{ok, markdown, filename,
  messages, truncated}` أو `{ok:false, error: notfound|empty|bad_input|error}` — تنقية
  بـ `SAFE_ENGINE`/`SAFE_SESSION` القائمين، وcwd للترويسة الوصفية فقط. المحرك في
  `electron/exporter.js` (انظر خريطة الملفات): عائلة claude (sdk/cli) من
  `sessions.readFullSession` (كامل — لا سقف الـ40 الخاص بالعرض)، وغيرها من
  `chats.read(provider, sid, 0)`. سقف الناتج 2م.ب (`truncated`).
- **الحفظ بلا IPC كتابة**: الواجهة تبني Blob وتنقر `<a download>` — حوار الحفظ الافتراضي
  في Electron يتولى الوجهة. preload يكشفه `exportChat(engine, sessionId, cwd)`.
- **حدود**: الجلسة الحالية فقط (تصدير جلسة تاريخية من اللوحة توسعة إن طُلبت)؛
  الصيغة Markdown حصراً.

