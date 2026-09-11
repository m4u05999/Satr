### أوامر التكافؤ مع Claude Code (الدفعة الأخيرة قبل التجميد)

ثلاثة أوامر أساسية تطابق ما يعتمده مستخدم Claude Code اليومي. **بعد هذه الدفعة تُجمَّد
الأوامر** (لا أوامر جديدة قبل الإصدار — المرحلة 6). كلها عبر محرك SDK فقط.

- **`/موصلات` (MCP)**: لوحة جانبية لحالة خوادم MCP. IPC `satr:mcpStatus(cwd)` →
  `{ok, servers:[{name, status, scope, serverInfo, error, tools}]}` عبر `query().mcpServerStatus()`
  في تشغيل عابر (`withControlQuery` في agent.js). الحالات: `connected`/`pending`/`needs-auth`/
  `failed`/`disabled`. الإجراءات عبر `satr:mcpAction {cwd, name, action}` حيث action ∈
  `{reconnect, enable, disable}` (تُنقّى بـ `SAFE_MCP_NAME` و `MCP_ACTIONS` في main.js) →
  `reconnectMcpServer`/`toggleMcpServer`. **حدّ معروف**: أفعال لوحة الحالة نفسها لا تبدأ
  مصادقة OAuth. إن أطلق الموصّل أثناء أداة طلب URL قياسياً، يعرض سطر حوار دفعة C ويفتحه
  بعد تأكيد صريح؛ وإلا يُصادَق على `needs-auth` من Claude Code بالأمر `/mcp` ثم «تحديث».
  «إعادة الاتصال» أفضل جهد، والإجراءات تحدّث اللوحة لتكشف الحالة الفعلية.
- **`/سياق` (context)**: لوحة تعرض امتلاء نافذة السياق. IPC `satr:contextUsage {cwd, sessionId}`
  → `{ok, usage}` عبر `query().getContextUsage()` (يستأنف الجلسة إن وُجد sessionId ليعكس رموز
  المحادثة الفعلية، وإلا السياق الأساس). `usage` فيه `totalTokens`/`maxTokens`/`percentage`/
  `model`/`categories[{name, tokens, isDeferred}]`. الواجهة تعرض النسبة وشريطاً وصفوف الفئات
  (عدا «الفراغ»، مع وسم «مؤجّل» لغير المحمّل). الأرقام والنموذج LTR.
- **`/ضغط` (compact)**: يرسل `/compact` كدور SDK عادي (لا IPC جديد) — النموذج يلخّص ويُصدر
  `system/compact_boundary`، والواجهة تعرض بطاقة بالرموز قبل/بعد. الجلسة تبقى نفسها فتكمل
  المحادثة. يتطلب جلسة قائمة (sessionId)؛ يُرفض أثناء انشغال دور آخر.

