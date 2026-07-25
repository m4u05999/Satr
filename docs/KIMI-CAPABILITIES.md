# KIMI-CAPABILITIES.md — خط أساس قدرات Kimi Code ACP

> هذا الملف خط أساس (baseline) لقدرات Kimi Code ACP المثبَّت فعلياً. يقارنه
> `scripts/kimi-capability-probe.js` بعد كل ترقية Kimi، ويطبع أي فرق واضح.

## كيفية التشغيل

```bash
node scripts/kimi-capability-probe.js
```

لا يدخل المسبار في `test:full` — يُشغَّل يدوياً بعد ترقية Kimi Code CLI.

## خط الأساس الحالي

| القدرة | الحالة | ملاحظات |
|---|---|---|
| steering (session/prompt أثناء دور جارٍ) | **غير مدعوم** | يرد `-32600` إن أُرسل أثناء دور حي. |
| session/fork | **غير مدعوم** | يرد `-32601 Method not found`. |
| session/undo | **غير مدعوم** | يرد `-32601 Method not found`. |
| effort في configOptions | **غير معلن** | لا يوجد خيار `effort`/`reasoning_effort`. |
| thinking في configOptions | **معلن** | خيار `thinking` متاح (Kimi 0.27.0 يعلن `on`). |
| mode في configOptions | **معلن** | خيار `mode` متاح (يستعمل لوضع التخطيط). |
| terminal reverse-RPC | **غير موصول** | `initialize` لا يعلن دعم terminal. |
| الأوامر المائلة المعلنة | **محدودة** | الأساسي: `compact`, `status`, `usage`, `mcp`, `tasks`, `help`؛ إضافية: `check-kimi-code-docs`, `custom-theme`, `import-from-cc-codex`, `mcp-config`, `sub-skill*`, `update-config`, `write-goal`. |

## كيفية التعامل مع الفروق

- إذا ظهرت قدرة جديدة: راجع ما إذا كانت آمنة لإضافتها إلى «سطر»، ثم حدّث هذا
  الملف و`CLAUDE.md` ووسّع `test:kimi` بالمحاكاة المناسبة.
- إذا اختفت قدرة كانت مستخدمة: لا تكسر الدور الحي — يجب أن يتدهور المحرك
  برسالة عربية واضحة ويستمر بدونها.
