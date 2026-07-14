# خارطة تنفيذ موحّدة: قدرات المنصّات (Claude + OpenAI)

> **المصدر:** توليف تقريرَي `RESEARCH-claude-platform.md` (Claude) و`OPENAI-PLATFORM-COVERAGE.md` (Codex) بعد تقييم متبادل.
> **المبدأ:** مرحلة واحدة في الجلسة (قاعدة `PLAN.md`)، تُتحقّق معاييرها ثم تُلخَّص قبل التالية.
> **الحوكمة الثابتة لكل بند:** تنقية المدخلات في `main.js` (allowlist/regex)، الأمان أولاً (fail-safe)، العربية، صفر اعتماديات جديدة قدر الإمكان، و`npm run eval:agent` يبقى 12/12.

## توزيع الملكية (حدّ الفريق الثلاثي)

| المالك | الملفات | البنود |
|---|---|---|
| **Claude** | `agent.js`, `codex.js`, `main.js`, `chat.js`, `app.js`, preview | فحص الإصدار، `auto`، usage/modelUsage (SDK)، effort/usage (Codex)، fallbackModel، structured outputs (SDK) |
| **Codex** | `openai-compatible.js`, `adapters/*` | vision اختياري، strict schemas، usage موحّد (المحوّل)، محوّل Responses، structured outputs (المحوّل) |

> `codex.js` محجوز لـ Claude (حدّ موثّق في `CLAUDE.md`)؛ فبنود مسار Codex الأصلي ينفّذها Claude، وكودكس ينفّذ مسار المحوّلات المتوافقة مع OpenAI.

## المحاور المشتركة (عابرة المحرّكات — أساس أولاً)

هذان يخدمان SDK + Codex + المحوّلات، فيُبنى **عقدهما الداخلي مرة واحدة** ويغذّيه كل محرّك:

- **عقد usage موحّد:** `{input, output, cached, reasoning, source: actual|estimate}`. SDK يعطي الحقيقي + `modelUsage`؛ Codex يلتقطه من app-server؛ المحوّل يقدّر. عرض واحد في `chat.js`.
- **عقد effort موحّد capability-aware:** SDK يمرّره؛ Codex والمحوّل يُسقطانه اليوم. لا قائمة عمياء — كل نموذج يعلن مستوياته.

## الموجات

### الموجة 1 — أساس usage الموحّد
- **Claude:** توسيع عرض `usage`/`modelUsage` من رسالة `result` (البنية موجودة، `chat.js:752` يعرض التكلفة). عقد usage داخلي.
- **Codex (Claude ينفّذ `codex.js`):** التقاط usage/rate بدل تجاهلها (`codex.js:437`).
- **Codex-الوكيل:** توسيع parser الـ usage في المحوّل ليقرأ `cached_tokens`.
- **قبول:** الرموز تظهر بالعرض بوسم `actual|estimate`؛ لا كسر لأي محرّك؛ eval أخضر.

### الموجة 2 — effort موحّد
- **Claude:** effort capability-aware في Codex (`codex.js` — تثبيت اسم الحقل من schema app-server، لا تخمين).
- **Codex-الوكيل:** effort اختياري في المحوّل عبر capability flag.
- **قبول:** لا effort غير صالح للنموذج؛ لا خفض صامت غير مرئي.

### الموجة 3 — النماذج والإصدار
- **Claude:** توسيع `preflight` بفحص إصدار Claude Code وتوافق النماذج (aliases، إرشاد تحديث لا تحديث تلقائي؛ الحاجز الحالي 2.1.175 < 2.1.197 لـ Sonnet 5).
- **Codex-الوكيل:** محوّل OpenAI Responses متخصّص جديد (`adapters/openai-responses.js`، `store:false`، allowlist نماذج).
- **قبول:** alias يحلّ للأحدث دون hardcoding؛ محوّل Responses لا يكسر مصنع Chat Completions.

### الموجة 4 — الأذونات الذكية
- **Claude:** `permissionMode:'auto'` (SDK): إضافة `'auto'` إلى `PERMISSION_MODES` (`main.js:214`) + خيار واجهة + معالجة `permission_denied` مرئياً + **`PreToolUse` حارساً حاسماً** (auto قد يتجاوز `canUseTool`؛ `run_in_terminal` وأدوات الكتابة خارج التمرير التلقائي).
- **قبول:** fail-safe (يحجب عند الشك)؛ خاصّ بمسار SDK؛ الحارس المحلي لا يُعطَّل.

### لاحقاً (مؤجّل بوعي)
- **Claude:** `fallbackModel` (تحقّق مفرد/مصفوفة أولاً)، structured outputs في SDK، checkpointing.
- **Codex-الوكيل:** strict schemas، vision، structured outputs، Batch (خدمة خلفية مستقلة).
- **مؤجّل بعيداً:** Dynamic Workflows، MCP OAuth، Realtime/الصوت (سطح منتج مستقل)، background mode.

## ترتيب البدء المعتمد
الموجة 1 أولاً (أرخص عائد، أدنى مخاطرة، محور مشترك، لا حساسية أمنية) — إثبات النمط قبل الأذونات الحسّاسة.

## التقدّم (محدّث 2026-07-13)

- **الموجة 1 (usage موحّد):** ✅ SDK (عرض `formatUsage` يقرأ العقدين) + المحوّلات (`usage.js` موحّد Chat/Responses، كودكس). ⏸️ usage الـ Codex الأصلي مؤجّل (بنية إشعار app-server غير موثّقة).
- **الموجة 2 (effort):** ✅ Codex (`codex.js` `model_reasoning_effort`، `max→xhigh`). ⏸️ effort للمحوّل مؤجّل (يحتاج تمرير `main.js`).
- **الموجة 3 (النماذج/الإصدار):** ✅ فحص إصدار CLI في `preflight` (`outdated`/`recommended` + banner `note`) + محوّل OpenAI Responses (`openai-responses.js`، allowlist، `store:false`، كودكس).
- **دفعة كودكس الإضافية:** ✅ strict schemas (بوابة `capabilities.strictTools`) + Structured Outputs (`text.format` + تحقّق محلي + fallback).
- **الموجة 4 (`auto`):** ✅ منفّذة ومُصلحة (الخيار ب). المنطق النقي في **`electron/autogate.js`** (`AUTO_SAFE_TOOLS` + `autoNeedsPrompt` + `nonSdkPerm`) يستهلكه `agent.js`/`main.js`. `preToolUse:'ask'` لكل أداة غير آمنة (fail-safe: المجهول يُسأل) + منتقي + تنبيه أمني. راجعها `muraji-amn` (whitelist) ثم **كودكس (٣ ثغرات عولجت):** إزالة أدوات المعاينة غير القرائية، `autoGated` يتجاوز `alwaysAllowed`، حصر auto بـ SDK. سياسة canUseTool مستخرجة نقيّةً (`decideAutoApproval`) فيثبتها الاختبار على **أصل الثغرة** لا المنطق المجاور. **fixture تكاملي `test:autogate` 40/40** (alwaysAllowed في auto ⇒ prompt، browser_navigate يُسمح فقط بـ browserControl، run_in_terminal لا يعفيه browserControl). بانتظار اعتماد كودكس النهائي؛ التحقّق الحيّ (SDK فعلي يوجّه ask→canUseTool) اختياري.
- **الجولة المنسّقة (vision + effort للمحوّل):** ✅ مكتملة. `main.js` يمرّر `input.images` (للمزوّد المعلن vision عبر `capabilities` في `list()`) + `input.effort` (Claude)؛ `openai-compatible.js` (content array + image_url) و`openai-responses.js` (`input_image` + `reasoning.effort` per-model) يستهلكانها (Codex). Chat لا يخترع `reasoning_effort`. اختبار `test:adapters`. **درس:** الفجوة كانت دلالية (عقد `list()` capabilities) لا نصّية — أكملها Claude لمّا تعذّر تمرير البند لكودكس.
- **مؤجّل:** Batch، Realtime، Dynamic Workflows، MCP OAuth، Sonnet 5 (CLI 2.1.197+).
- **توثيق مُنجَز (2026-07-14):** كل ما سبق موثّق في `CLAUDE.md` (effort Codex في `codex.js`،
  preflight `outdated`/`CLAUDE_MIN_RECOMMENDED`، محوّل `openai-responses`، strict/Structured
  Outputs، `usage.js` الموحّد). لا توثيق معلّق في هذه الخارطة.
