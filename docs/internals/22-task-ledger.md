### سجل المهام الدائم (Task Ledger — الأولوية 2)

- **التخزين**: `electron/tasks.js` يحفظ snapshot فقط تحت
  `~/.satr/tasks/<engine>/<session_id>.json`؛ لا prompt ولا transcript. المعرّفات منقّاة
  كمكوّن مسار واحد، والسجل ≤50 مهمة، والدليل ≤6 بنود للمهمة، والملف ≤512KiB.
  الكتابة عبر ملف مؤقت ثم rename وأفضل جهد؛ فشل القرص لا يكسر الدور.
- **المحرّكات**: Codex يطبّع `turn/plan/updated` المثبّت من schema v2، وKimi ACP يطبّع
  تحديث `plan` ويمكنه استعمال `update_task_ledger` عبر MCP. Claude SDK
  يطبّع أدوات `TodoWrite` و`TaskCreate` و`TaskUpdate` ورسائل النظام الحقيقية
  `task_started/task_updated/task_progress/task_notification` المثبتة من `sdk.d.ts`؛
  لا يعتمد على تخمين حدث غير موجود. المحوّلات تملك أداة `update_task_ledger` في حلقة الأدوات.
- **العرض**: `<satr-chat>` يعرض التقدم والحالات والاعتماديات والمالك ودليل التحقق في بطاقة
  خفيفة أعلى الخيط. `satr:taskLedger` يعيد snapshot عند استئناف جلسة، و`satr:taskAction`
  يقبل `pause|resume` فقط. الإيقاف زر ظاهر يوقف الدور ويحفظ ledger؛ الاستئناف ظاهر ولا
  يرسل prompt تلقائياً — يطلب من المستخدم إرسال متابعة.
- **مهام إعداد المنصات**: يوجّه `envbrief` المحرّكين إلى تحديث السجل بعد كل منصة بما اكتمل
  وما ينتظر المستخدم وما يلي، فتعيش خطة Brevo/Netlify/Gmail عبر الأدوار. لوحة المعاينة
  تضيف أثراً مرئياً مقتضباً للصفحات وآخر فعل وزر «إيقاف المهمة»؛ هذا أثر شفافية لا مخزن جديد.
- **التحقق**: `npm run test:tasks` يغطي schema/التخزين/merge/الأدلة/الإيقاف والاستئناف
  وحدود الإدخال وأداة المحوّلات. و`npm run test:task-ledger-ui` (حي، ضمن test:full) يغطي
  بطاقة السجل في `<satr-chat>` الإنتاجي داخل Chromium تحت CSP صارم: عتبة الظهور (≥3 مهام)،
  التقدم LTR، الحالات الأربع، الاعتماديات/المالك/الأدلة، الطي المحفوظ، أحداث pause/resume
  بعقدها، وتبديل الجلسة بلا تكديس. `npm run eval:agent` يبقى baseline ‏12/12.

