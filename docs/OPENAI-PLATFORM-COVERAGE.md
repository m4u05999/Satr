# منظومة OpenAI وتغطية «سطر» لها

> **نوع الوثيقة:** تقرير بحثي لاتخاذ القرار، بلا تنفيذ.  
> **تاريخ المسح:** 13 يوليو 2026.  
> **النطاق:** نماذج OpenAI الحديثة وواجهات المنصة، ثم مطابقتها مع `electron/codex.js` و`electron/adapters/openai-compatible.js`.

## الخلاصة التنفيذية

1. المسار الأقوى في «سطر» هو **Codex الأصلي**: يدعم GPT‑5.6/5.5، الصور، جلسات مستمرة، أدوات الملفات والأوامر، وMCP للمعاينة. لكنه لا يمرر اختيار `reasoning effort`، ولا يعرض usage/cost/rate limits، ولا يتيح Structured Outputs أو Batch أو Realtime كقدرات تطبيقية.
2. `openai-compatible.js` ليس موصلاً إلى OpenAI حالياً؛ هو مصنع Chat Completions لمزوّدي DeepSeek/Qwen/MiniMax وغيرهم. يدعم بث النص وحلقة function calling محلية، لكنه نصي فقط، بلا strict schemas أو Structured Outputs أو reasoning effort أو Responses API.
3. أعلى عائد بأقل جهد: **تمرير effort إلى Codex، التقاط usage، ثم إضافة vision وstrict-tools كقدرات اختيارية للمحوّلات**. هذه تحسينات محدودة لا تستدعي إعادة بناء.
4. أعلى فجوة استراتيجية: لا يوجد مسار API مباشر إلى OpenAI Responses. إن أُريدت نماذج mini/nano وStructured Outputs وBatch والأدوات المستضافة، فالأصح إنشاء محوّل OpenAI متخصص بـResponses، لا تشويه المصنع العام المتوافق مع Chat Completions.
5. Realtime ليس «نموذجاً آخر في المنتقي»؛ هو سطح منتج صوتي جديد يحتاج WebRTC/WebSocket، جلسة وأحداث صوت، أذونات ميكروفون، ومشغلاً صوتياً. يؤجل إلى مرحلة معمارية مستقلة.

## 1. المنهج والحدود

- جرى فحص `CLAUDE.md`، و`electron/codex.js`، و`electron/codexmcp.js`، و`electron/adapters/openai-compatible.js`، و`electron/adapters/index.js`، و`electron/tools.js`، و`electron/main.js`، ومنتقي النماذج في `src/ui/app.js`.
- الحقائق الخارجية مأخوذة من صفحات OpenAI الرسمية فقط. أُضيف خادم `openaiDeveloperDocs` الرسمي إلى إعداد Codex، لكنه يحتاج إعادة تشغيل ليصبح أداة قابلة للاستدعاء؛ لذلك استُخدم في هذه الجلسة fallback الويب الرسمي المسموح.
- الأسعار أدناه بالدولار لكل مليون token: **input / cached input / output**، ولا تشمل رسوم الأدوات المستضافة أو الزيادة الإقليمية.
- تسعير API لا يساوي بالضرورة تكلفة مسار Codex داخل «سطر»، لأن هذا المسار يسجل عبر اشتراك ChatGPT وCodex CLI، لا عبر مفتاح OpenAI API مباشر.
- حالة «مدعوم» تعني أن «سطر» يمرر القدرة ويعرض نتيجتها فعلياً، لا أن النموذج أو Codex CLI يستطيعانها نظرياً.

## 2. خريطة نماذج OpenAI الحديثة

### 2.1 عائلة GPT‑5.6 — الاختيار الافتراضي في 2026

توصي صفحة النماذج الحالية بـSol للعمل المعقد، وTerra للتوازن، وLuna للحجم الكبير الحساس للكلفة. الثلاثة تقبل النص والصورة وتخرج النص، وتدعم reasoning وfunction calling وStructured Outputs والأدوات المستضافة عبر Responses. [صفحة النماذج الرسمية](https://developers.openai.com/api/docs/models)

| النموذج | السياق / أقصى خرج | السعر API | effort | القدرات | متى يُختار |
|---|---:|---:|---|---|---|
| `gpt-5.6-sol` (`gpt-5.6`) | 1.05M / 128K | 5 / 0.5 / 30 | none→max | reasoning، vision، functions، structured، tools كاملة | أعقد البرمجة، المراجعة، البحث والمهام المهنية عالية القيمة |
| `gpt-5.6-terra` | 1.05M / 128K | 2.5 / 0.25 / 15 | none→max | قدرات Sol نفسها | الافتراضي العملي المتوازن؛ جودة قوية بنصف سعر Sol |
| `gpt-5.6-luna` | 1.05M / 128K | 1 / 0.1 / 6 | none→max | قدرات Sol نفسها | أعمال كثيفة، مهام واضحة، subagents، وحساسية أعلى للكلفة |

ملاحظتان ماليتان: ما فوق 272K input يُسعّر للطلب كله بضعفي input و1.5× output، وكتابة cache في GPT‑5.6 تكلف 1.25× input العادي. [Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol) · [Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra) · [Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna)

### 2.2 GPT‑5.5 وGPT‑5.4 — خط 2025/بداية 2026

| النموذج | السياق / الخرج | السعر | القدرات والاستخدام |
|---|---:|---:|---|
| `gpt-5.5` | 1.05M / 128K | 5 / 0.5 / 30 | frontier سابق، vision/functions/structured؛ لا سبب لتفضيله على Sol بالسعر نفسه إلا ثبات سلوكي قائم |
| `gpt-5.5-pro` | 1.05M / 128K | 30 / — / 180 | Responses فقط، بلا streaming، للمهام النادرة شديدة الصعوبة؛ يحتاج background mode غالباً |
| `gpt-5.4` | 1.05M / 128K | 2.5 / 0.25 / 15 | قيمة جيدة للعمل المهني، لكن Terra أحدث بالسعر نفسه |
| `gpt-5.4-pro` | 1.05M / 128K | 30 / — / 180 | Responses فقط؛ مهام عميقة بطيئة، خلفه 5.5 Pro |
| `gpt-5.4-mini` | 400K / 128K | 0.75 / 0.075 / 4.5 | أقوى mini رخيص للبرمجة وcomputer use وsubagents |
| `gpt-5.4-nano` | 400K / 128K | 0.20 / 0.02 / 1.25 | تصنيف، استخراج، ترتيب، تلخيص وsubagents بسيطة؛ لا computer use/tool search |

المصدر: [GPT‑5.5](https://developers.openai.com/api/docs/models/gpt-5.5) · [GPT‑5.5 Pro](https://developers.openai.com/api/docs/models/gpt-5.5-pro) · [GPT‑5.4](https://developers.openai.com/api/docs/models/gpt-5.4) · [GPT‑5.4 mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini) · [GPT‑5.4 nano](https://developers.openai.com/api/docs/models/gpt-5.4-nano)

### 2.3 خط GPT‑5 الأول وCodex المتخصص

| النموذج | السياق / الخرج | السعر | التقييم الحالي |
|---|---:|---:|---|
| `gpt-5` | 400K / 128K | 1.25 / 0.125 / 10 | جيل 2025 السابق؛ reasoning+vision+functions+structured، لكن OpenAI توصي بـ5.6 |
| `gpt-5-mini` | 400K / 128K | 0.25 / 0.025 / 2 | ما زال رخيصاً جداً؛ Terra أحدث لمعظم الأعمال العامة |
| `gpt-5-nano` | 400K / 128K | 0.05 / 0.005 / 0.40 | الأرخص للتصنيف والتلخيص؛ Luna أحدث لكن أغلى بكثير |
| `gpt-5.3-codex` | 400K / 128K | 1.75 / 0.175 / 14 | نموذج agentic coding متخصص، effort حتى xhigh؛ أقدم من خط Codex الحالي الظاهر في «سطر» |

المصدر: [GPT‑5](https://developers.openai.com/api/docs/models/gpt-5) · [GPT‑5 mini](https://developers.openai.com/api/docs/models/gpt-5-mini) · [GPT‑5 nano](https://developers.openai.com/api/docs/models/gpt-5-nano) · [GPT‑5.3‑Codex](https://developers.openai.com/api/docs/models/gpt-5.3-codex)

**قرار مقترح:** لا تُعد النماذج القديمة إلى منتقي Codex؛ قرار المشروع «حديثة فقط» منسجم مع السوق. إذا أضيف OpenAI API مباشر، فـ5.4 mini/nano مفيدان كـtiers منخفضة الكلفة لا كبدائل Codex تفاعلية.

### 2.4 سلسلة o للاستدلال

| النموذج | السياق / الخرج | السعر | الرؤية والأدوات | الحالة/الاختيار |
|---|---:|---:|---|---|
| `o3-pro` | 200K / 100K | 20 / — / 80 | vision، functions، structured؛ Responses فقط، بلا streaming | أعلى compute في السلسلة القديمة؛ لا يُضاف لواجهة تفاعلية جديدة |
| `o3` | 200K / 100K | 2 / 0.5 / 8 | vision، functions، structured، streaming | قوي للرياضيات/العلوم/التحليل، لكنه «succeeded by GPT‑5» رسمياً |
| `o4-mini` | 200K / 100K | 1.1 / 0.275 / 4.4 | vision، functions، structured، streaming | deprecated ومخلوف بـGPT‑5 mini |
| `o3-mini` | 200K / 100K | 1.1 / 0.55 / 4.4 | نص فقط، functions وstructured | deprecated؛ لا اختيار جديد |
| `o1` / `o1-mini` | 200K/128K | مرتفع/قديم | قدرات متفاوتة | deprecated؛ للتوافق التاريخي فقط |

المصدر: [o3 Pro](https://developers.openai.com/api/docs/models/o3-pro) · [o3](https://developers.openai.com/api/docs/models/o3) · [o4-mini](https://developers.openai.com/api/docs/models/o4-mini) · [فهرس النماذج وحالات deprecation](https://developers.openai.com/api/docs/models/all)

**الخلاصة:** GPT‑5.x دمج reasoning في الخط العام؛ سلسلة o لم تعد استثماراً مناسباً لواجهة «سطر» الجديدة، إلا إن وُجد عميل API قائم يحتاج o3 تحديداً.

### 2.5 Realtime

Realtime أسرة صوتية متعددة الوسائط تدعم function calling، لكنها لا تدعم Structured Outputs. النقل يكون WebRTC للعميل الذي يلتقط الصوت، WebSocket لمسار خادمي، وSIP للهاتف. [دليل Realtime الرسمي](https://developers.openai.com/api/docs/guides/realtime)

| النموذج | السياق / الخرج | سعر النص | سعر الصوت | الاختيار |
|---|---:|---:|---:|---|
| `gpt-realtime-2.1` | 128K / 32K | 4 / 0.4 / 24 | 32 / 0.4 / 64 | أفضل voice reasoning وأدوات؛ ضوضاء/مقاطعة وأرقام أفضل |
| `gpt-realtime-2.1-mini` | 128K / 32K | 0.6 / 0.06 / 2.4 | 10 / 0.3 / 20 | الافتراضي التجريبي المنطقي للصوت منخفض الكلفة |
| `gpt-realtime-2` | 128K / 32K | 4 / 0.4 / 24 | 32 / 0.4 / 64 | مخلوف بـ2.1 بالسعر نفسه |
| `gpt-realtime-mini` | 32K / 4K | 0.6 / 0.06 / 2.4 | راجع الصفحة | جيل أصغر وأقصر سياق؛ 2.1 mini أولى |

المصدر: [Realtime 2.1](https://developers.openai.com/api/docs/models/gpt-realtime-2.1) · [Realtime 2.1 mini](https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini) · [Realtime 2](https://developers.openai.com/api/docs/models/gpt-realtime-2) · [Realtime mini](https://developers.openai.com/api/docs/models/gpt-realtime-mini)

## 3. ميزات المنصة الحديثة

| الميزة | الوضع الرسمي | الدلالة لـ«سطر» |
|---|---|---|
| **Responses API** | موصى بها لكل مشروع جديد؛ agentic loop، items typed، state عبر `previous_response_id`/Conversations، أدوات مستضافة، reasoning summaries، وكفاءة cache أفضل | الأساس الصحيح لأي موصل OpenAI API جديد |
| **Chat Completions** | ما زالت مدعومة؛ messages وchoices، والحالة تُدار محلياً | مناسبة للمصنع متعدد المزوّدين لأنها القاسم المشترك، لا لفتح كامل OpenAI |
| **Function calling** | أدوات مخصصة بـJSON Schema؛ strict موصى به دائماً | «سطر» يملك الحلقة والتنفيذ الآمن، لكنه يحتاج schemas strict اختيارية |
| **Structured Outputs** | function schemas للأدوات، أو `text.format` في Responses/`response_format` في Chat لإخراج JSON مطابق | مفيدة لخطط المهام، نتائج المراجعة، الذاكرة والحوكمة؛ غائبة حالياً |
| **Reasoning effort** | قيم تعتمد على النموذج: none/minimal/low/medium/high/xhigh/max؛ الأقل أسرع وأرخص | يجب أن يكون capability-driven لا قائمة واحدة عمياء |
| **Prompt caching** | آلي من 1024 token، ويظهر `cached_tokens` في usage؛ ثبات المقدمة يزيد hits | سياق skills/repo map/system ثابت نسبياً ومؤهل، لكن «سطر» لا يعرض cached usage |
| **Vision** | URL أو Base64 data URL أو file ID، وصور متعددة؛ الصور تُحاسب tokens | Codex جاهز؛ المحوّلات تحتاج content arrays بدلاً من string |
| **Realtime** | جلسات audio/text/image، function tools، WebRTC/WebSocket/SIP وأحداث جلسة مستقلة | مرحلة منتج مستقلة، لا تعديل صغير للمحوّل الحالي |
| **Batch** | JSONL async، خصم 50%، سقف 24 ساعة، ويدعم Responses وChat وغيرها | مناسب للتقييمات، التلخيص الجماعي، والفهرسة؛ ليس للمحادثة الحية |

المصادر: [الانتقال إلى Responses](https://developers.openai.com/api/docs/guides/migrate-to-responses) · [Function calling](https://developers.openai.com/api/docs/guides/function-calling) · [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs) · [Reasoning](https://developers.openai.com/api/docs/guides/reasoning) · [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) · [Vision](https://developers.openai.com/api/docs/guides/images-vision) · [Batch](https://developers.openai.com/api/docs/guides/batch)

### Responses مقابل Chat Completions: القرار المعماري

OpenAI تقول إن Chat Completions ستبقى مدعومة، لكن Responses هي primitive الجديدة والمفضلة. Responses تضيف loop وكائنات Items وأدوات مستضافة وحالة reasoning/tool أفضل؛ وتذكر OpenAI تحسناً داخلياً 3% في SWE-bench وكفاءة cache أفضل 40–80% مقارنة بـChat في اختبارات داخلية. هذه أرقام إرشادية من المزود وليست ضماناً لأحمال «سطر». [المصدر](https://developers.openai.com/api/docs/guides/migrate-to-responses)

لذلك:

- أبقِ `openai-compatible.js` على Chat Completions كي لا تكسر DeepSeek/Qwen/MiniMax.
- أنشئ لاحقاً مسار OpenAI متخصصاً بـResponses ويطبّع Items إلى عقد أحداث «سطر» نفسها.
- لا تجعل `Responses` خياراً عاماً في config للمصنع قبل وجود parser منفصل لأحداثه وأدواته وحالته.

## 4. جرد «سطر» الحالي

### 4.1 المساران

**Codex الأصلي (`electron/codex.js`):**

- يشغّل `codex app-server` ويتكلم JSON-RPC v2، مع thread start/resume وturn start.
- المنتقي يعرض `gpt-5.6-sol/terra/luna` و`gpt-5.5` فقط؛ وهذا مطابق لقرار «نماذج حديثة فقط».
- يمرر النص والصور المنقاة Base64 كـdata URL.
- يطبّع بث النص، أوامر shell، file changes، plan updates وreasoning summary.
- يحقن MCP محلياً للمعاينة، ويبني أذونات عربية حول الأفعال المتغيرة للصفحة.
- لا يمرر `effort`، ولا يقرأ token usage/rate limits، و`total_cost_usd` دائماً null.

**المحوّل المتوافق (`electron/adapters/openai-compatible.js`):**

- `POST /chat/completions` عبر `https/http` المدمجين، وSSE `choices[].delta`.
- مسجل حالياً لـDeepSeek وQwen وMiniMax؛ لا تسجيل `api.openai.com` ولا `OPENAI_API_KEY`.
- يدير آخر 40 رسالة محلياً وعلى القرص، ويشغّل حتى 8 جولات أدوات.
- يدعم function calls متدفقة وأذونات الكتابة/التنفيذ، ثم يطبّع الأحداث للواجهة.
- التعريفات JSON Schema لكنها بلا `strict:true` وبلا `additionalProperties:false`؛ لذا الالتزام best-effort.
- لا صور أو صوت، ولا reasoning parameters، ولا structured response، ولا Batch/Realtime.

### 4.2 مصفوفة الميزات

الرموز: **مدعوم** = يعمل end-to-end، **جزئي** = قدرة موجودة لكن غير مكشوفة/مكتملة، **غائب** = لا مسار حالي.

| النموذج/الميزة | Codex الأصلي | OpenAI-compatible | الملاحظة |
|---|---|---|---|
| GPT‑5.6 Sol/Terra/Luna | **مدعوم** | **غائب** | ظاهر في منتقي Codex؛ لا موصل OpenAI API |
| GPT‑5.5 | **مدعوم** | **غائب** | ظاهر في Codex |
| GPT‑5.4/mini/nano وGPT‑5 mini/nano | **غائب** | **غائب** | غير معروضة؛ المصنع مسجل لمزوّدين آخرين |
| سلسلة o | **غائب** | **غائب** | لا داعي لإضافتها افتراضياً؛ أغلبها قديم/deprecated |
| Realtime models | **غائب** | **غائب** | تحتاج سطحاً صوتياً جديداً |
| Streaming نصي | **مدعوم** | **مدعوم** | JSON-RPC مقابل SSE |
| Responses API | **جزئي/غير مباشر** | **غائب** | Codex يخفي API خلف app-server؛ «سطر» لا يملك Responses contract |
| Chat Completions | **غير منطبق** | **مدعوم** | المصنع مبني عليه بالكامل |
| Function calling | **مدعوم** | **جزئي** | Codex native+MCP؛ المحوّل best-effort بلا strict |
| Structured Outputs | **غائب** | **غائب** | لا `text.format` ولا `response_format` |
| Reasoning effort | **غائب** | **غائب** | الواجهة تملك effort لكنه يمر إلى SDK فقط |
| Reasoning summaries | **جزئي** | **غائب** | Codex يعرض item reasoning حتى 600 حرف، بلا تحكم summary |
| Prompt caching | **مبهم** | **جزئي نظرياً** | قد يديره Codex/المزوّد؛ لا OpenAI endpoint ولا cached_tokens telemetry |
| Vision/input images | **مدعوم** | **غائب** | 6 صور، أنواع/حجم/Base64 منقاة في main.js |
| Audio | **غائب** | **غائب** | لا capture/playback أو audio event contract |
| أدوات محلية | **مدعوم** | **مدعوم** | أمان وتنقية وأذونات عربية جيدة |
| أدوات OpenAI المستضافة | **جزئي** | **غائب** | Codex يملك أدواته ومـCP؛ لا تحكم Responses hosted tools |
| Conversation state | **مدعوم** | **مدعوم يدوياً** | Codex threads؛ المحوّل transcript محلي محدود |
| Usage tokens | **غائب** | **جزئي** | Codex يهمله؛ المحوّل يجمع prompt/completion أو يقدّر |
| Cached-token usage | **غائب** | **غائب** | parser لا يقرأ token details |
| Batch | **غائب** | **غائب** | لا ملفات JSONL ولا lifecycle |
| Background mode/webhooks | **غائب** | **غائب** | مطلوب لـPro والمهام الطويلة |

### 4.3 مصفوفة ملاءمة النماذج لمساري «سطر»

| الفئة | Codex | محوّل API مستقبلي | القرار |
|---|---|---|---|
| GPT‑5.6 Sol/Terra/Luna | ممتاز | ممتاز | يبقى Codex للمطور التفاعلي؛ API للمهام المنظمة/الخلفية |
| GPT‑5.5 | قائم | لا أولوية | احتفاظ للتوافق، لا افتراضي جديد |
| 5.4 mini/nano | غير ضروري | عالي القيمة | تصنيف/تلخيص/subagents منخفضة الكلفة |
| GPT‑5 nano القديم | غير ضروري | قيمة قصوى للسعر | فقط إن أثبتت evals أن الجودة تكفي |
| o3/o3-pro | ضعيف استراتيجياً | توافق اختياري | لا تُعرض افتراضياً |
| Realtime 2.1 | غير مناسب | محرك مستقل | مشروع صوت منفصل |

## 5. الفجوات مرتبة بالأولوية

### P0 — عائد عالٍ وجهد صغير

1. **تمرير reasoning effort إلى Codex.** الواجهة و`main.js` يملكان قيماً منقاة، لكن فرع Codex يسقطها. يلزم أولاً تثبيت اسم الحقل في schema لإصدار app-server المستخدم، ثم تمريره في `turn/start` أو موضعه الرسمي. لا تخمين للحقل.
2. **التقاط usage/rate limits في Codex.** `onNotification` يتجاهلهما صراحةً؛ طبّع input/output/cached/reasoning إن أتاحها app-server، واترك cost null إذا لم توجد أسعار موثوقة لمسار الاشتراك.
3. **إظهار capability metadata في المنتقي.** لا تعرض effort غير صالح للنموذج؛ GPT‑5.6 يقبل none→max، و5.5 none→xhigh. تجنب «خفض صامت» غير مرئي.
4. **قراءة cached token details في المحوّل.** توسعة parser للـusage لا تغير العقد؛ تعرض وفورات cache بدل جمع prompt/completion فقط.

### P1 — عائد عالٍ وجهد متوسط

5. **Vision للمحوّل العام كقدرة اختيارية.** استخدم content arrays و`image_url` فقط عندما `config.capabilities.vision` صريح؛ الصور تمر حصراً من `sanitizeImages` في `main.js`.
6. **Strict function schemas ببوابة capability.** أضف `strict:true` و`additionalProperties:false` وrequired كامل/nullable لأدوات OpenAI التي تدعمه. لا تفرضه على كل مزوّد متوافق، لأن التوافق الاسمي لا يضمن subset JSON Schema نفسه.
7. **usage موحد.** عقد داخلي واحد لـinput/output/cached/reasoning/audio/image tokens مع `source: actual|estimate`، ويُطبّع من Codex وChat وResponses لاحقاً.

### P2 — توسعة استراتيجية

8. **محوّل OpenAI Responses متخصص.** `https` وSSE المدمجان يكفيان، فلا dependency جديدة. يحتاج parser typed events، function_call/output، state policy (`previous_response_id` أو transcript محلي)، `store:false` افتراضياً للخصوصية، وتعطيل الأدوات المستضافة غير المصرح بها.
9. **Structured Outputs للاستخدامات الداخلية.** ابدأ بمخرجات ذات قيمة واضحة: نتيجة reviewer، خطة task ledger، وmemory candidate. schema يُعرّف في النواة، يتحقق محلياً بعد الاستجابة، ويسقط إلى مسار نصي آمن عند الرفض.
10. **OpenAI provider registry.** مفتاح `OPENAI_API_KEY` من `keys.js` دون إعادته للواجهة، host/path ثابتان في الكود، ونماذج allowlist حديثة. لا تسمح للمستخدم بإدخال host عشوائي مع المفتاح.
11. **Batch كخدمة خلفية منفصلة.** مناسب لـevals أو تلخيص دفعي، وليس داخل `start(input,cwd,emit)` التفاعلي؛ يحتاج سجل jobs واستئنافاً وتنزيلاً آمناً للنتائج.

### P3 — تغيير معماري مستقل

12. **Realtime/الصوت.** يحتاج عقد IPC جديداً للصوت، `getUserMedia`/WebRTC أو WebSocket خادمي، ephemeral credentials، مشغل audio، interruption/VAD، أذونات واضحة، ومؤشرات تسجيل عربية. لا يوضع في `openai-compatible.js`.
13. **Background mode/webhooks.** مطلوب عملياً لـPro والمهام الممتدة؛ يحتاج lifecycle خارج `currentRun`، تخزين job IDs، واستئناف بعد إعادة التشغيل.
14. **Hosted tools العامة.** web/file/code/computer عبر Responses توسع سطح الثقة والبيانات الخارجة؛ لا تفعلها بمجرد إضافتها إلى `tools`. لكل أداة سياسة وبيان بيانات وإذن ومخرجات مطبّعة.

## 6. توصيات تنفيذية تحترم قيود «سطر»

### الأمان

- كل model/effort/tool/schema/provider يدخل عبر allowlist أو regex صارم في `main.js`، لا من renderer مباشرة إلى API أو spawn.
- مفتاح OpenAI يبقى في `keys.js`/البيئة داخل العملية الرئيسية؛ لا preload API يعيد قيمته.
- `store:false` افتراضي في Responses/Chat المباشر، مع توثيق صريح قبل أي state مخزنة لدى المزود.
- مدخلات الصور تستخدم التنقية الحالية؛ الصوت يحتاج حدود مدة/حجم/codec ومؤشر تسجيل مرئي قبل أي إرسال.
- function calls تُنفذ عبر `tools.js` فقط، مع تحقق محلي حتى مع strict schemas؛ schema ليست حاجز أمان.
- hosted tools وMCP البعيد لا ترث موافقة أدوات القراءة المحلية تلقائياً؛ المحتوى البعيد غير موثوق.

### صفر اعتماديات

- `https`, `http`, SSE parser الحالي، وWebSocket المدمج في Electron/Chromium تكفي مبدئياً.
- لا تضف OpenAI SDK لمجرد Responses؛ القيمة هنا صغيرة مقابل حجم dependency، وعقد «سطر» يحتاج parser خاصاً على أي حال.
- لـRealtime في renderer استخدم WebRTC الأصلي؛ أنشئ ephemeral token في main عبر IPC محدد، ولا تكشف API key.

### العربية وتجربة الاستخدام

- أوصاف النماذج بالعربية: «الأقوى/متوازن/الأسرع»، مع tooltip يوضح الكلفة والسياق وvision.
- لا تعرض أسماء `none|low|…` وحدها؛ ترجم الأثر: السرعة، الكلفة، وملاءمة المهمة، مع إبقاء القيمة التقنية LTR.
- رسائل رفض schema/rate limit/context بالعربية، مع تفاصيل API التقنية في كتلة `dir=auto`/LTR.
- Realtime يحتاج اختبار العربية واللهجات والمقاطعة والضوضاء عملياً قبل اختيار 2.1 أو mini؛ لا تكفي جودة الإنجليزية.

## 7. خطة قرار مقترحة

### المرحلة A — صقل Codex القائم

- effort capability-aware.
- usage/rate/cached telemetry.
- اختبارات schema للأحداث الحالية وعدم كسر أذونات app-server/MCP.

### المرحلة B — صقل المصنع المتوافق

- capability flags لا افتراضات عامة.
- vision اختياري وstrict tools اختياري.
- usage موحد وتفاصيل cache.

### المرحلة C — OpenAI Responses مباشر

- adapter منفصل، `store:false`، models allowlist: 5.6 tiers + 5.4 mini/nano عند الحاجة.
- functions أولاً، ثم Structured Outputs، ثم أدوات مستضافة محددة واحدةً واحدة.
- eval مقارنة مع Codex وChat: جودة عربية، أدوات، latency، tokens، cache، ورفض الأذونات.

### المرحلة D — Batch ثم Realtime

- Batch أولاً لأنه مستقل وأقل خطراً ومفيد للتقييمات.
- Realtime بعد مواصفة UX/خصوصية/أذونات صوت مستقلة.

## 8. القرار المختصر

- **للمستخدم التفاعلي الذي يبرمج:** أبقِ Codex/GPT‑5.6 هو المسار الأساسي.
- **للمهمات المنظمة الرخيصة أو المخرجات JSON:** أضف مستقبلاً OpenAI Responses بـ5.4 mini/nano أو 5.6 Luna.
- **لأعلى جودة API:** 5.6 Sol؛ **لأفضل توازن:** Terra؛ **للحجم والكلفة:** Luna.
- **لا تستثمر في سلسلة o** كواجهة جديدة؛ هي توافق تاريخي بعد GPT‑5.
- **لا تخلط Realtime بالمحادثة النصية:** هو محرك وسطح منتج مستقل.
- **أول دفعة تنفيذ لاحقة:** effort + usage في Codex، ثم capability flags/vision/strict في المحوّل؛ لا تبدأ بـRealtime.

## المصادر الرسمية الأساسية

- [OpenAI Models](https://developers.openai.com/api/docs/models)
- [All models and deprecations](https://developers.openai.com/api/docs/models/all)
- [Migrate to Responses](https://developers.openai.com/api/docs/guides/migrate-to-responses)
- [Function calling](https://developers.openai.com/api/docs/guides/function-calling)
- [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Reasoning models](https://developers.openai.com/api/docs/guides/reasoning)
- [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [Images and vision](https://developers.openai.com/api/docs/guides/images-vision)
- [Realtime and audio](https://developers.openai.com/api/docs/guides/realtime)
- [Batch API](https://developers.openai.com/api/docs/guides/batch)
