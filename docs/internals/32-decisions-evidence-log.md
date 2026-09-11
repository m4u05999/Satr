### سجل القرارات والأدلة (غرفة العمليات — المرحلة 6)

- **التخزين والعقد**: `electron/opsroom.js` يحفظ كل غرفة في
  `~/.satr/opsroom/<room_id>.json` بـschema v1: `room_id` ومصفوفة `entries` فقط. الكتابة ذرية
  `temp→rename`، والقراءة تعيد تنقية الملف كاملاً. السقف 200 إدخال و512KiB للملف و1000 محرف للنص؛
  عند بلوغ السقف يُرفض الإدخال الجديد ولا يُحذف قديم، لذلك يبقى السجل append-only فعلياً عبر إعادة التشغيل.
- **فصل السلطة fail-closed**: للمحرك مدخل `appendEngine` لا يقبل إلا `proposal|note` ويثبت actor إلى
  `sdk|codex`. قرار المستخدم يمر حصراً عبر `appendUserDecision` ثم IPC
  `satr:opsRoomDecision {roomId,text,teamId,artifactId?,confirmed:true}`؛ أي `id/type/actor` وارد من
  renderer يُرفض، وكذلك غياب التأكيد. النظام وحده يسجل `review|verification|phase_gate|note` عبر
  `appendSystem`. لا API حذف أو تعديل، ولا تحمل النواة runner أو merger أو أي قدرة تشغيلية.
- **التنقية والحجب**: `room_id/entry.id/team_id/artifact_id` تخضع regex صارماً في `main.js` والنواة.
  النص يزال منه محارف التحكم ويُقتطع، مع إعادة استخدام `memory.hasSecret` قبل الكتابة؛ patch markers
  والحمولات الأطول من 64KiB تُرفض. أحداث `ops_room_update` العامة تحمل الإدخال المنقّى فقط، ولا تحمل
  patch أو summaries أو commands أو output خاماً.
- **الربط بالانتقالات**: `executionteam.js` ينشر `room_id` مع snapshot الفريق والأثر فقط، بلا منطق سجل.
  `main.js` ينشئ الغرفة عند بدء الفريق ويسجل مهام العوامل المنقّاة، وكل نهاية فعلية للفريق
  (`completed|failed|timed_out|stopped|conflict|cleanup_failed`) مع taxonomy من رموز ثابتة بلا
  `stderr` خام، وجاهزية الأثر، وكل حالة فعلية مميزة للمراجعة والتحقق، ثم `phase_gate` نظامية بعد
  نجاح الدمج الفعلي؛ كل entry ترتبط بـ`team_id` وبـ
  `artifact_id` متى أصبح متاحاً. السجل سلبي ولا يبدأ مراجعة أو تحققاً أو دمجاً بذاته.
- **IPC والاختبار**: القراءة عبر `satr:opsRoomLoad(roomId)` والقرار المؤكد عبر
  `satr:opsRoomDecision(...)` في preload. `npm run test:opsroom` يستدعي النواة الفعلية وعقد
  `executionteam` لإثبات persistence، append-only والسقوف، رفض انتحال قرار/مستخدم/بوابة مرحلة، حجب
  الأسرار والـpatch والخرج الطويل، التنقية الصارمة، وربط room/team/artifact بلا تسريب الفرق.
- **الفهرس والاستمرارية**: `opsroomindex.js` يحفظ `room/team/state/artifact` حسب بصمة SHA-256
  داخلية للمسار ولا يعيد البصمة أو المسار إلى renderer. عند الإقلاع تتحول حالات
  `preparing|running|stopping` القديمة إلى `interrupted`. قنوات `satr:opsRoomHistory` و
  `satr:opsRoomRestore` و`satr:opsRoomArtifactDelete` تتحقق من cwd والغرفة والأثر والتأكيد؛
  الاستعادة تعيد فريقاً مكتمل الأثر إلى الذاكرة لكن تصفّر المراجعة والتحقق، فلا يُعاد استعمال دليل قديم.
- **خزنة الأثر**: الملف المشفّر ذري ومفصول ببصمة المشروع وبسقف 18MiB، والـpatch حتى 12MiB، وتُعاد مطابقة
  `sha256(head+'\0'+patch)` وكل المراجع والمسارات بعد فكّه. لا fallback صريح عند غياب التشفير.
  يُحذف الأثر بعد الدمج أو بطلب مستخدم مؤكد، وتزيل سياسة الاحتفاظ ما تجاوز 30 يوماً أو أحدث 50 أثراً.
  ولأن البصمة مشتقة من HEAD+patch فقد تتشاركها غرف عدة (صقل أ‑1 البند 29): كل حذف — بعد
  الدمج أو يدوياً أو بالاحتفاظ — يعلّم عبر `markArtifactsUnavailable` كل مدخلات الفهرس
  المتشاركة البصمة غير قابلة للاستعادة، وفشل `opsartifacts.load` عند الاستعادة بغياب/فساد
  الملف يعلّمها دفاعاً ثانياً؛ وإن أعادت غرفة حية حفظ الأثر من ذاكرتها يعود مدخلها صادقاً.
  `npm run test:opscontinuity` يغطي غياب التشفير والعبث والفهرسة والاستعادة والتسوية والاحتفاظ.

