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
| session/fork | **مدعوم منذ 0.38.0 — مستهلَك في «سطر» كتفريع من النهاية** | في 0.40.1 تتطلّب `{sessionId, cwd}` وتعيد `{sessionId, configOptions, modes}`. تقبل `upToMessageId` و`title` صياغياً، لكن المسبار الحي (2026-09-03) لم ينتج رسائل مستخدم يمكن التحقق من نقطة التفريع عليها، فتُستعمل في «سطر» كتفريع من النهاية فقط (OBS-048). |
| session/undo | **غير مدعوم** | يرد `-32601 Method not found`. |
| effort في configOptions | **غير معلن** | لا يوجد خيار `effort`/`reasoning_effort`. |
| thinking في configOptions | **معلن** | خيار `thinking` متاح (Kimi 0.27.0 يعلن `on`). |
| mode في configOptions | **معلن** | خيار `mode` متاح (يستعمل لوضع التخطيط). |
| terminal reverse-RPC | **غير موصول** | `initialize` لا يعلن دعم terminal. |
| الأوامر المائلة المعلنة | **محدودة** | الأساسي: `compact`, `status`, `usage`, `mcp`, `tasks`, `help`؛ إضافية: `check-kimi-code-docs`, `custom-theme`, `import-from-cc-codex`, `mcp-config`, `sub-skill*`, `update-config`, `write-goal`. |
| إطلاق cron بين الأدوار على قناة الجلسة | **غير مرصود — حدّ upstream** | قناة keep-alive تبقى حية بعد end_turn (مؤكد بسجل `ks_*`)، لكن Kimi 0.27.0 لم يبث أي `session/update` عند إطلاق cron خلال 150 ثانية من الانتظار (مسبار K3-ب 2026-07-27، `dist/kimi-cron-probe-log.txt`). جسر `kimi_keepalive_event` في سطر جاهز ومختبَر بإشعارات مصطنعة؛ يُفعَّل فعلياً فور بثّ Kimi للحدث. |
| استمرار «الهدف» (CreateGoal) بين الأدوار | **غير مرصود — حدّ upstream** | نفس النمط: القناة بقيت حية في السجل ونشاط الهدف رُصد أثناء الدور، لكن لم يصل أي `kimi_keepalive_event` خلال 150 ثانية (مسبار K5-ب 2026-07-27، `dist/kimi-goal-probe-log.txt`). |

## كيفية التعامل مع الفروق

- إذا ظهرت قدرة جديدة: راجع ما إذا كانت آمنة لإضافتها إلى «سطر»، ثم حدّث هذا
  الملف و`CLAUDE.md` ووسّع `test:kimi` بالمحاكاة المناسبة.
- إذا اختفت قدرة كانت مستخدمة: لا تكسر الدور الحي — يجب أن يتدهور المحرك
  برسالة عربية واضحة ويستمر بدونها.
