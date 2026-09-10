### حلقة التحقق وcheckpoint الدور (الأولوية 3)

- **إعداد صريح فقط**: لا يكتشف «سطر» أوامر من `package.json` ولا يخمّنها. المشروع يضيف:

  ```json
  {
    "version": 1,
    "commands": [
      { "id": "lint", "label": "فحص التنسيق", "command": "npm run lint", "timeout_seconds": 120 },
      { "id": "test", "label": "الاختبارات", "command": "npm test", "timeout_seconds": 300 }
    ],
    "preview": {
      "command": "npm run dev",
      "url": "http://localhost:5173/",
      "timeout_seconds": 60
    }
  }
  ```

  الملف `.satr/verify.json` داخل `cwd` حصراً، symlink مرفوض، ≤64KiB، ≤6 أوامر، وكل
  command سطر واحد ≤1000 محرف. `preview` اختياري، وأمره سطر واحد بالحد نفسه، وعنوانه
  `http|https` محلي فقط (`localhost|127.0.0.1|[::1]`) ومهلته 1–600 ثانية. قراءة `verification_config` بلا إذن ولا تنفيذ؛
  `verify_project` طبقة `exec` فيعرض مربع الإذن العربي الأوامر الفعلية ثم يشغّل snapshot
  نفسه في طرفية النموذج. لا «موافقة دائمة» للتحقق.
- **معالج الإنشاء اليدوي**: زر «إعداد التحقق» داخل غرفة العمليات يفتح
  `satr-verify-config-dialog` لإدخال `id/label/command/timeout` يدوياً (لا قراءة
  `package.json` ولا اكتشاف scripts). يعرض JSON للمراجعة قبل الكتابة؛ الملف القائم يفرض
  تأكيد استبدال ثانياً. `satr:verifyConfigCreate` منقّى في `main.js`، والكاتب الذرّي في
  `verify.js` يثبت المسار `.satr/verify.json` داخل cwd، ويرفض root/`.satr`/الهدف الرمزي
  والخروج والكتابة فوق ملف بلا `overwrite:true`. الإنشاء لا يشغّل شيئاً، ويبقى الملف مطلوباً
  داخل `HEAD` قبل غرفة قابلة للدمج.
- **مهارة المراجعة النوعية**: المعالج نفسه يتيح اختيارياً معاينة
  `review_skill:{name}` داخل JSON قبل أي كتابة. عقد preload المحدد هو
  `verifyConfigCreate(cwd, commands, overwrite, confirmed, reviewSkill)`؛ تنقّي قناة
  `satr:verifyConfigCreate` المرجع ثم تمرّره إلى `verify.createConfig`، وهو الكاتب الوحيد
  لـ`.satr/verify.json`. إنشاء المصدر مستقل وصريح عبر
  `reviewSkillCreate(cwd, skill, overwrite, confirmed)` وقناة `satr:reviewSkillCreate`، حيث
  `skill={name,description,criteria}` ولا يمرّر renderer مسار الهدف. `electron/skillwriter.js`
  يثبت الهدف في `.agents/skills/<name>/SKILL.md`، والاسم يطابق
  `[A-Za-z0-9._-]{1,64}`، والمعايير لا تتجاوز 16KiB وتُزال منها محارف التحكم/Bidi وتُرفض
  كلياً إن التقطها `memory.hasSecret`. يفحص الكاتب `realpath` لكل مكوّن ويرفض
  symlink/junction والخروج بلا كشف المسار الخارجي، ولا يستبدل بلا `overwrite:true`، ويكتب
  ذرياً عبر temp+rename مع استعادة الملف السابق عند فشل الاستبدال. غياب المهارة يبقي العقد
  السابق بلا تغيير، وأي فشل في التنقية أو المسار مغلق ولا يتحول إلى كتابة جزئية.
- **المحرّكات**: Claude SDK يملك خادم MCP مستقل `satr-verify` خارج `satr-terminal`؛
  Kimi ACP والمحوّلات يملكون الأداتين عبر `tools.js` (Kimi من MCP المحلي). Codex لم يُعدّل: `main.js` يجمع تعديلاته مثل
  غيره، وزر التحقق اليدوي يعيد ملخص النتيجة إلى دوره التالي مرة واحدة عبر
  `<satr_verification_result>` ثم يعلّمها مستهلكة.
- **checkpoint**: يبدأ مع الدور ولا يظهر/يُحفظ حتى أول `file_edit`. يجمع ≤50 edit ID
  وملخص الملفات، ويربط تلقائياً بالمهمة فقط حين توجد مهمة `in_progress` وحيدة. عند
  التحقق تُضاف evidence من نوع `verification_pass|verification_fail` إلى المهمة المطابقة
  بالعنوان دون تغيير حالتها خفيةً.
- **الاستعادة**: زر ظاهر مع تأكيد؛ آخر checkpoint الحي فقط، وفي cwd نفسه، ويستدعي undo
  لكل edit ID بالعكس. لا `git reset` ولا commit ولا لمس history. بعد إعادة تشغيل التطبيق
  تبقى metadata وhashes للمقارنة لكن `restorable=false` لأن snapshots الذاكرية انتهت.
  الفشل يوقف السلسلة فوراً ويعلّم checkpoint `partial` بدلاً من متابعة قد تفسد الملفات.
- **IPC**: `satr:checkpointLatest(engine,sessionId)` قراءة فقط؛
  `satr:verifyCheckpoint(...)` يفتح permission_request؛ `satr:checkpointRestore(...)`
  يتحقق من engine/session/checkpoint/cwd في `main.js` ثم يستخدم undo الموحّدة.
- **التحقق**: `npm run test:verify` يغطي schema/رفض الأسطر المتعددة/runner/حدود الخرج/
  persistence/reverse restore/cwd/عودة النتيجة مرة واحدة. `npm run eval:agent` يبقى 12/12.
