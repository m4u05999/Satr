### تكافؤ /ضغط و/سياق لمحرك Codex (الدفعة C2، 2026-07-26)

- **المسبار أولاً**: `scripts/codex-compact-probe.js` (سلك خام — يشغّل `codex app-server`
  بنفسه) على codex-cli ‏0.144.3 والنموذج `gpt-5.6-sol`. شُغّل جولتين متطابقتين بنيوياً؛
  أرقام الجولة الثانية: `thread/compact/start` أعاد **كائناً فارغاً `{}`**، واكتمل خلال
  `7018ms` (الجولة الأولى `7736ms`) بـ`8` إشعارات، وإجمالي `353` إشعاراً للمسبار كله.
- **إشارة الاكتمال (حدّ upstream مثبّت)**: إشعار `thread/compacted` **لم يصل قط** — وهو
  موسوم `Deprecated` في الـschema (`ContextCompactedNotification`). الواصل فعلاً هو
  `item/completed` بعنصر `type:'contextCompaction'`، **وحمولته `{id, type}` فقط**.
  لذلك **لا تتوفّر أرقام رموز قبل/بعد للضغط في Codex**، ولا يخترعها «سطر»: يبثّ
  `system/compact_boundary` بـ`compact_metadata:{trigger:'manual'}` بلا `pre_tokens`/
  `post_tokens`، والبطاقة القائمة في `chat.js` تعرض الأرقام فقط إن كان `pre_tokens`
  رقماً ⇒ تظهر «🗜 ضُغطت المحادثة» صادقة بلا أي تغيير في المكوّن.
- **الضغط يجري كدور حقيقي**: الإشعارات داخل نافذته كانت `turn/started` و`item/started`
  و`item/completed` و`thread/tokenUsage/updated` و`account/rateLimits/updated` و
  `thread/status/changed` و`turn/completed`. لذلك `finishTurn` القائم يغلق التشغيل
  طبيعياً ويبقى `session_id` هو `threadId` نفسه.
- **الاستمرارية مثبّتة**: بعد الضغط بقي الخيط قابلاً للإكمال (`turn_status_after_compact`
  = `completed`) واسترجع النموذج رمزاً زُرع قبل الضغط (`memo_recalled:true`, `14` محرفاً).
- **حدّ upstream ثانٍ**: `thread/compact/start` أثناء دور جارٍ **قُبِل بلا خطأ**
  (`during_active_turn.accepted:true`). «سطر» لا يستغل ذلك: `compactConversation()` في
  `app.js` يحجب الأمر أثناء `busy` كما كان لبقية المحركات.
- **حدّ upstream ثالث (نافذة السياق)**: `model/list` **لا يعلن نافذة سياق إطلاقاً** —
  تحقق حيّ: `7` نماذج وصفر حقل `contextWindow`/`maxTokens` (والـschema يؤكد: تعريف
  `Model` بلا أي حقل كهذا). المصدر الوحيد هو `modelContextWindow` داخل إشعار
  `thread/tokenUsage/updated` الحيّ (القيمة المرصودة `258400`).
- **`last` لا `total`**: `ThreadTokenUsage` يحمل الاثنين؛ `total` **تراكمي عبر الخيط**
  فيكبر أبداً ولا يعكس الإشغال (رُصد `14337` ثم `31474`)، بينما `last` يصف آخر طلب
  (`17137`). لذلك لوحة `/سياق` تُبنى من `last`. ملاحظة مرصودة: لقطة الضغط نفسها أعادت
  `last.totalTokens=5656` بـ`inputTokens=0` و`outputTokens=0` — يسجّلها «سطر» كما أعلنها
  upstream بلا تأويل. ولم يتقلّص إدخال الدور التالي في هذا القياس
  (`last_input_shrank_after_compact:false`) لأن الخيط كان صغيراً (~14k من 258k).
- **المحرك**: `electron/codex.js` يعترض `prompt.trim() === '/compact'` في تسلسل الإقلاع
  ويستدعي `thread/compact/start {threadId}` بدل `turn/start` (نمط `kimi.js`: الأمر المائل
  يُعالَج داخل المحرك) — بلا مهارات ولا ذاكرة ولا صور ولا مدخل نصّي. ويحتفظ بخريطة
  `contextSnapshots` (آخر لقطة لكل خيط، سقف `100`) في ذاكرة العملية — **لا مخزن قرص
  جديد ولا اعتمادية**. ويصدّر `contextUsage(cwd, sessionId)` و`COMPACT_COMMAND`.
- **التدهور الرشيق**: فشل `thread/compact/start` (إصدار لا يعلن الطريقة) يعطي رسالة
  عربية ثابتة «إصدار Codex المثبّت لا يدعم ضغط المحادثة من سطر» بلا نص خطأ upstream
  خام، ثم يُغلق الدور بنتيجة عادية. واكتمال الدور **بلا** عنصر `contextCompaction` لا
  يُظهر بطاقة ضغط بل تحذيراً «لم يؤكّد Codex اكتمال ضغط المحادثة».
- **IPC**: **لا قناة جديدة** — `satr:contextUsage` القائم أُضيف له فرع `engine === 'codex'`
  يوجّه إلى `codex.contextUsage`. غياب اللقطة (إقلاع جديد أو جلسة بلا دور بعد) يعيد
  `{ok:false}` برسالة عربية هادئة. الفئات المعروضة: الإدخال والإخراج، ومعهما «منها
  مخبّأ» و«منه تفكير» بأسماء تُظهر أنهما مجموعتان فرعيتان فلا يُقرأ الشريط جمعاً مضاعفاً.
- **الواجهة**: `/سياق` و`/ضغط` أُضيف لهما `'codex'` في `engines`، و`compactConversation()`
  يقبل codex. **لا نوع حدث جديد في `satr:event`** ولا تغيير في أي مكوّن.
- **إعادة تحقّق (2026-08-27، ‏`0.149.1`)**: **صامد** — `thread/compact/start` يعيد `{}`،
  والإشارة تبقى `item/completed:contextCompaction` بحمولة `{id,type}` فقط (فلا أرقام
  رموز)، و`modelContextWindow` ما زال `258400`، والضغط أثناء دور جارٍ ما زال مقبولاً،
  واسترجاع الرمز المزروع نجح.
- **إعادة تحقّق (2026-09-03، ‏`0.153.0`)**: **صامد** حرفياً في البنود الخمسة (‏`{}` · حمولة
  `{id,type}` · `258400` · مقبول أثناء دور · استرجاع الرمز `14` محرفاً)، الضغط في `7695ms`.
- **التحقق**: `npm run test:codex-compact` (قطعي، بلا شبكة — fixture عبر `CODEX_BIN=node`)
  يغطي: استدعاء `thread/compact/start` مرة واحدة بحقل `threadId` وحده و**بلا** `turn/start`،
  وتحويل `contextCompaction` إلى `compact_boundary` مع بقاء `session_id` وغياب
  `pre_tokens`/`post_tokens`، والتدهور الرشيق مع **فحص صريح لعدم تسرّب نص خطأ upstream**،
  والاكتمال الصامت بلا بطاقة كاذبة، وتطبيع `/سياق` من `last` لا `total`، ورسالة الغياب،
  وعزل اللقطات بين الخيوط، وثبات مجموعة أنواع `satr:event`. وهو داخل `test:full`.
  المسبار الحيّ `npm run test:codex-compact-probe` خارجها عمداً (يستهلك ثلاثة أدوار).

