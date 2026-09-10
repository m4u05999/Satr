### لوحة موصّلات Codex ‏(/موصلات + OAuth — الدفعة C3، 2026-07-27)

- **المسبار أولاً**: `scripts/codex-mcp-panel-probe.js` (سلك خام) على codex-cli ‏0.144.3.
  الطرق كلها من الـschema المولّد (v2/): `mcpServerStatus/list` و`config/mcpServer/reload`
  و`mcpServer/oauth/login`، وإشعارا `mcpServer/startupStatus/updated` و
  `mcpServer/oauthLogin/completed`. أرقام التشغيل الفعلي: `5` خوادم، زمن السرد `4835ms`،
  وإجمالي `10` إشعارات إقلاع.
- **حدّ upstream 1 — لا حقل حالة في السرد**: مفاتيح `McpServerStatus` المرصودة هي
  `authStatus,name,resourceTemplates,resources,serverInfo,tools` و`has_status_field:false`.
  فحالة الاتصال **لا تأتي من السرد إطلاقاً**، بل من إشعارات
  `mcpServer/startupStatus/updated` وحدها (`McpServerStartupState`:
  `starting|ready|failed|cancelled`، و`McpServerStartupFailureReason`:
  `reauthenticationRequired`).
- **حدّ upstream 2 — الإشعارات لا تصل قبل بدء خيط**: صفر إشعار خلال `20` ثانية بعد
  `initialize`، ثم **10 إشعارات فوراً** بعد `thread/start` (خمسة `starting`، ثم
  `chrome-devtools/supabase/context7` → `failed` بنص خطأ، و`codex_apps/openaiDeveloperDocs`
  → `ready`). لذلك `codex.mcpStatus` يبدأ خيطاً عابراً **للقراءة فقط**
  (`sandbox:'read-only'`) وينتظر `9000ms` ثم يسرد ويغلق العملية.
- **حدّ upstream 3 — `tools` يعود null دائماً**: جُرّب `detail` الافتراضي و`full` و
  `toolsAndAuthOnly` وبعد بدء خيط ⇒ `tools_ever_array:false`. لذلك لا تعرض اللوحة عدد
  أدوات لـCodex (بخلاف مسار sdk)؛ `resources` يعمل (رُصد `26` لـ`codex_apps`، ويصير `0`
  تحت `toolsAndAuthOnly`).
- **اشتقاق الحالة**: `ready→connected` · `starting→pending` · `failed→failed` ·
  `cancelled→failed` · `failed` مع `reauthenticationRequired`‏→`needs-auth` ·
  و`authStatus==='notLoggedIn'` يفرض `needs-auth` دائماً. غياب أي إشعار ⇒ `pending`.
- **الإجراءات**: `config/mcpServer/reload` (params **null** إلزاماً في الـschema) هو
  الفعل الوحيد المعلن — نجح في `13ms` بردّ `{}`. التفعيل/التعطيل **غير مدعومين لـCodex
  عمداً** لأنهما يستلزمان الكتابة في `~/.codex/config.toml` و«سطر» لا يلمسه؛ يردّ
  `satr:mcpAction` بـ`unsupported` ولا تعرض اللوحة زرّاً يوهم بقدرة غير موجودة.
- **OAuth بلا تسريب رابط**: `mcpServer/oauth/login {name}` يعيد `authorizationUrl`.
  **الرابط لا يعبر IPC ولا يُبثّ إطلاقاً**: يبقى في `pendingMcpOauth` داخل `codex.js`
  (سقف عمر `5` دقائق)، و`satr:mcpOauthStart` يعيد `{ok,id,name}` فقط. الواجهة تعرض
  `confirm` عربياً صريحاً، ثم `satr:mcpOauthOpen {id}` يقرأ الرابط عبر `codex.mcpOauthUrl`
  (منقّى بـ`safeOauthUrl`: HTTPS أو HTTP loopback فقط، بلا `username/password`، بلا فراغ
  أو محارف تحكم/Bidi، وسقف `2048`) ثم `shell.openExternal` وينتظر
  `mcpServer/oauthLogin/completed`. رابط upstream غير آمن يُسقَط إلى `null` fail-closed.
  فشل الفتح يبقي الطلب معلّقاً لإعادة المحاولة، و`satr:mcpOauthCancel` يُسقطه.
  **لا يُخزَّن أي token في «سطر»** — المصادقة كلها داخل Codex.
- **حجب الأسرار**: نص خطأ الخادم يمرّ بـ`sanitizeMcpError` (إزالة محارف التحكم/Bidi،
  سقف `300` محرف، وحجب كامل إن طابق `memory.hasSecret` المشترك). و`serverInfo` مقصور
  على `version` فلا يعبر `websiteUrl` أو غيره. خادم `satr_preview` الداخلي **مستثنى من
  العرض** (تفصيل تنفيذي لا موصّل مستخدم).
- **حدّ لم يُتحقَّق منه حيّاً**: لا يوجد على جهاز التطوير خادم يعلن `notLoggedIn` أو
  `oAuth` (‏`distinct_auth_status` المرصودة: `bearerToken` و`unsupported`)، فدورة OAuth
  الحيّة **لم تُنفَّذ فعلياً**؛ غطّاها الاختبار القطعي بـfixture يحاكي العقد المعلن.
- **إعادة تحقّق (2026-09-03، ‏`0.153.0`)**: الحدود الثلاثة **صامدة** — لا حقل حالة في السرد،
  الإشعارات العشرة تصل بعد `thread/start` فقط، و`tools_ever_array:false` في الأوضاع الأربعة؛
  `reload` أعاد `{}` في `17ms`. الفرق الوحيد بيئي: الخوادم الخمسة كلها بلغت `ready` هذه المرة
  (‏`distinct_failure_reason: []`) بينما سقطت ثلاثة في 0.144 — لا يمسّ الاشتقاق.
- **IPC والواجهة**: `satr:mcpStatus` صار يقبل `{cwd, engine}` (النص المجرّد يبقى مقبولاً)،
  و`satr:mcpAction` أضيف له `engine`. الجديد: `satr:mcpOauthStart/Open/Cancel` بمعرّف
  بنمط `^cxoauth_[0-9]{1,9}_[a-z0-9]{1,8}$`. `/موصلات` صار `engines:['sdk','codex']`،
  و`mcpEl.open(cwd, engine)`. **لا نوع حدث جديد في `satr:event`** ومسار sdk بلا تغيير.
- **التحقق**: `npm run test:codex-mcp-panel` (قطعي، بلا شبكة) يغطي اشتقاق الحالات الأربع،
  استثناء `satr_preview`، إلزام الخيط العابر `read-only`، `reload` بـ`params:null` وفشله
  بلا تسريب، حجب الأسرار ونص upstream الخام، قائمة حقول الصف المغلقة، تحقق الرابط
  fail-closed (‏12 حالة)، ودورة OAuth كاملة (نجاح/رفض/إلغاء/رابط غير آمن/بلا رابط) مع
  **فحص صريح لعدم تسرّب الرابط من قناة البدء**، وثبات مسار sdk في `main.js`. زمنه `12.4s`
  وهو داخل `test:full`. المسبار الحيّ `npm run test:codex-mcp-panel-probe` خارجها عمداً.

