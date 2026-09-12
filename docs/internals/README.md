# سجلّ المعمارية التفصيلي — docs/internals

> هذا المجلد هو قسم «المعمارية» الذي كان يعيش داخل `CLAUDE.md` (‏4,145 سطراً، دفعةً دفعة).
> نُقل **حرفياً** في 2026-09 (خطة حمية الرموز — `docs/TOKEN-DIET-PLAN.md`) كي لا يُحمَّل كاملاً في
> كل جلسة. **القاعدة**: قبل تعديل نظام فرعي اقرأ ملفه هنا؛ وأي دفعة جديدة تُوثَّق في ملفها لا في
> `CLAUDE.md`. قواعد `.claude/rules/*.md` تحيل إلى هذه الملفات تلقائياً عند لمس مساراتها.

| # | الملف | العنوان الأصلي | الحجم |
|---|---|---|---|
| 00 | [`00-architecture-overview.md`](00-architecture-overview.md) | المعمارية | 41.3 ك.ب |
| 01 | [`01-data-flow.md`](01-data-flow.md) | تدفق البيانات | 13.4 ك.ب |
| 02 | [`02-claude-fork-rewind.md`](02-claude-fork-rewind.md) | تفريع واسترجاع Claude الأصلي (دفعة A — 2026-07-24) | 10.9 ك.ب |
| 03 | [`03-claude-models-account.md`](03-claude-models-account.md) | نماذج وحساب Claude الديناميكيان (دفعة B — 2026-07-25) | 10.7 ك.ب |
| 04 | [`04-claude-connectors.md`](04-claude-connectors.md) | إدخال موصّلات Claude (دفعة C — 2026-07-26) | 7.2 ك.ب |
| 05 | [`05-claude-sdk-background-tasks.md`](05-claude-sdk-background-tasks.md) | مهام Claude SDK الخلفية (دفعة D — 2026-07-26) — وبنود الجوال OBS-147/148 | 18.9 ك.ب |
| 06 | [`06-claude-sdk-polish.md`](06-claude-sdk-polish.md) | تلميع محرك Claude Agent SDK (دفعة E — 2026-07-27) | 12.9 ك.ب |
| 07 | [`07-session-continuity.md`](07-session-continuity.md) | استمرارية المحادثة والجلسة (2026-09-10) | 4.5 ك.ب |
| 08 | [`08-adapters-providers.md`](08-adapters-providers.md) | طبقة المحوّلات والمزوّدين (Adapters/Providers — المرحلة 5) | 12.3 ك.ب |
| 09 | [`09-codex-steer.md`](09-codex-steer.md) | التوجيه أثناء الدور لمحرك Codex (turn/steer — الدفعة C1، 2026-07-26) | 6.1 ك.ب |
| 10 | [`10-codex-compact-context.md`](10-codex-compact-context.md) | تكافؤ /ضغط و/سياق لمحرك Codex (الدفعة C2، 2026-07-26) | 6.8 ك.ب |
| 11 | [`11-codex-connectors-panel.md`](11-codex-connectors-panel.md) | لوحة موصّلات Codex ‏(/موصلات + OAuth — الدفعة C3، 2026-07-27) | 6.2 ك.ب |
| 12 | [`12-codex-account-usage.md`](12-codex-account-usage.md) | حساب Codex واستهلاكه ‏(⚙ + تسجيل دخول — الدفعة C4، 2026-07-27) | 7.5 ك.ب |
| 13 | [`13-send-liveness-timeouts.md`](13-send-liveness-timeouts.md) | موثوقية الإرسال — مهلات الإقلاع والإيقاف (إصلاح 2026-07-30) | 2.4 ك.ب |
| 14 | [`14-kimi-engine-acp.md`](14-kimi-engine-acp.md) | محرك Kimi Code الأصيل (ACP — 2.10.0) | 18.6 ك.ب |
| 15 | [`15-keys-vault.md`](15-keys-vault.md) | مخزن الأسرار ومركز المفاتيح (keys.js — المرحلة 5ب) | 1.4 ك.ب |
| 16 | [`16-testsprite-mcp.md`](16-testsprite-mcp.md) | تكامل TestSprite MCP (اختياري) | 8.0 ك.ب |
| 17 | [`17-testsprite-jobs.md`](17-testsprite-jobs.md) | نواة مدير جولة TestSprite (testspritejobs.js — العقد المجمَّد v1) | 5.2 ك.ب |
| 18 | [`18-features-community-enterprise.md`](18-features-community-enterprise.md) | طبقة القدرات ونموذج Community + Enterprise (features.js — المرحلة 5ج) | 1.3 ك.ب |
| 19 | [`19-phase5-ipcs.md`](19-phase5-ipcs.md) | IPCs المرحلة 5 (قراءة/كتابة، مُنقّاة في main.js) | 0.9 ك.ب |
| 20 | [`20-sessions-browser.md`](20-sessions-browser.md) | متصفح الجلسات (المرحلة 1) | 5.2 ك.ب |
| 21 | [`21-skills-panel.md`](21-skills-panel.md) | لوحة المهارات (Skills) | 16.7 ك.ب |
| 22 | [`22-task-ledger.md`](22-task-ledger.md) | سجل المهام الدائم (Task Ledger — الأولوية 2) | 2.6 ك.ب |
| 23 | [`23-verify-loop-checkpoint.md`](23-verify-loop-checkpoint.md) | حلقة التحقق وcheckpoint الدور (الأولوية 3) | 5.4 ك.ب |
| 24 | [`24-project-memory.md`](24-project-memory.md) | ذاكرة المشروع المحلية الصريحة (الأولوية 4) | 2.3 ك.ب |
| 25 | [`25-repo-map.md`](25-repo-map.md) | خريطة المستودع المقتصدة للمزوّدات العمياء (الأولوية 5 — الدفعة الأولى) | 5.0 ك.ب |
| 26 | [`26-research-orchestrator.md`](26-research-orchestrator.md) | منسّق باحثين للقراءة فقط (الأولوية 6 — الخطوة 1) | 2.4 ك.ب |
| 27 | [`27-executor-worktree.md`](27-executor-worktree.md) | عامل منفّذ محايد عن المحرك في worktree معزول (الأولوية 6 — الخطوة 2) | 3.1 ك.ب |
| 28 | [`28-parallel-executors.md`](28-parallel-executors.md) | عوامل منفّذة متوازية بملكية ملفات (الأولوية 6 — الخطوة 3) | 2.8 ك.ب |
| 29 | [`29-reviewer-merge.md`](29-reviewer-merge.md) | مراجع ثانٍ ودمج بموافقة صريحة (الأولوية 6 — الخطوة 4) | 14.0 ك.ب |
| 30 | [`30-integration-verify.md`](30-integration-verify.md) | التحقق التكاملي قبل الدمج (غرفة العمليات — المرحلة 5) | 4.9 ك.ب |
| 31 | [`31-review-my-changes.md`](31-review-my-changes.md) | «راجع تغييراتي الآن» — المراجعة العمياء من المحادثة (2026-08-25) | 4.3 ك.ب |
| 32 | [`32-decisions-evidence-log.md`](32-decisions-evidence-log.md) | سجل القرارات والأدلة (غرفة العمليات — المرحلة 6) | 4.9 ك.ب |
| 33 | [`33-ops-room-ui.md`](33-ops-room-ui.md) | واجهة غرفة العمليات (المرحلة 7) | 20.8 ك.ب |
| 34 | [`34-bounded-loop-mode.md`](34-bounded-loop-mode.md) | وضع الحلقة المحدودة (الجولة الخامسة — النواة) | 20.2 ك.ب |
| 35 | [`35-media-generation-core.md`](35-media-generation-core.md) | نواة توليد الوسائط BYOK (م١ — الجولة 8، البند الأول) | 6.8 ك.ب |
| 36 | [`36-media-generation-extension.md`](36-media-generation-extension.md) | توسعة نواة التوليد (الجولة 9 — الصوت وrefs وافتراضي الصور وحارس المنزل) | 9.5 ك.ب |
| 37 | [`37-audio-durations-ad-music.md`](37-audio-durations-ad-music.md) | مدد الصوت وموسيقى الإعلان المولَّدة (الجولة 10 — أولى دفعات م٢) | 5.5 ك.ب |
| 38 | [`38-ad-music-quality-round.md`](38-ad-music-quality-round.md) | جولة جودة موسيقى الإعلان بعد الرفض السمعي (الجولة 10 التكميلي) | 3.4 ك.ب |
| 39 | [`39-claude-code-parity-commands.md`](39-claude-code-parity-commands.md) | أوامر التكافؤ مع Claude Code (الدفعة الأخيرة قبل التجميد) | 2.4 ك.ب |
| 40 | [`40-subagents.md`](40-subagents.md) | الوكلاء الفرعيون (Subagents — المرحلة 14.2) | 1.4 ك.ب |
| 41 | [`41-msix-store-package.md`](41-msix-store-package.md) | حزمة Microsoft Store (‏MSIX — 2026-09-04) | 3.9 ك.ب |
| 42 | [`42-auto-update.md`](42-auto-update.md) | التحديث التلقائي (المرحلة 17) | 3.1 ك.ب |
| 43 | [`43-run-in-terminal-tool.md`](43-run-in-terminal-tool.md) | دمج الطرفية مع النموذج — أداة run_in_terminal (المرحلة 16) | 2.4 ك.ب |
| 44 | [`44-background-terminal-jobs.md`](44-background-terminal-jobs.md) | مهام الطرفية المعمّرة — run_in_background | 7.7 ك.ب |
| 45 | [`45-bg-term-done-feedback.md`](45-bg-term-done-feedback.md) | توصيل `bg_term_done` إلى النموذج (دفعة تغذية الأدوات الراجعة — 2026-08-24) | 4.4 ك.ب |
| 46 | [`46-envbrief.md`](46-envbrief.md) | وعي بيئة «سطر» الموحّد — envbrief | 3.7 ك.ب |
| 47 | [`47-generate-media-tool-gallery.md`](47-generate-media-tool-gallery.md) | أداة توليد الوسائط وقنوات المعرض — الجولة 8 | 1.9 ك.ب |
| 48 | [`48-generation-done-event-skill.md`](48-generation-done-event-skill.md) | حدث اكتمال التوليد ومهارة `satr-generate` — الجولة 9 | 2.4 ك.ب |
| 49 | [`49-slash-menu-sync.md`](49-slash-menu-sync.md) | مزامنة أوامر CLI في قائمة «/» (المرحلة 14.1) | 1.1 ك.ب |
| 50 | [`50-first-run-gate-icon.md`](50-first-run-gate-icon.md) | بوابة أول التشغيل + الأيقونة (المرحلة 6 — تلميع المنتج) | 3.7 ك.ب |
| 51 | [`51-project-files-panel-reader.md`](51-project-files-panel-reader.md) | لوحة ملفات المشروع + عارض القراءة (الدفعة 1.2 من ROADMAP) | 6.4 ك.ب |
| 52 | [`52-git-changes-panel.md`](52-git-changes-panel.md) | لوحة تغييرات git ± (الدفعة 4.7 — «فرق») | 5.0 ك.ب |
| 53 | [`53-chat-export.md`](53-chat-export.md) | تصدير المحادثة 📤 (الدفعة 4.8 — «مشاركة») | 1.5 ك.ب |
| 54 | [`54-mixed-direction-chat.md`](54-mixed-direction-chat.md) | اتجاه المحتوى المختلط في المحادثة (دفعة «RTL المختلط» — 2026-07-18) | 1.6 ك.ب |
| 55 | [`55-at-files-image-paste.md`](55-at-files-image-paste.md) | منصّة @ للملفات + لصق الصور (المرحلة 4) | 1.0 ك.ب |
| 56 | [`56-arabic-diff-viewer.md`](56-arabic-diff-viewer.md) | عارض الفرق (Diff) العربي (المرحلة 3) | 2.0 ك.ب |
| 57 | [`57-arabic-terminal.md`](57-arabic-terminal.md) | الطرفية العربية المدمجة (المرحلة 8 — مكتملة: 8.1–8.4) | 9.5 ك.ب |
| 58 | [`58-preview-panel.md`](58-preview-panel.md) | لوحة المعاينة المدمجة 🌐 (م-1 — الدفعة 5 «سطر يرى الويب») | 62.7 ك.ب |
| 59 | [`59-design-system.md`](59-design-system.md) | نظام التصميم (الدفعة 4.1) | 12.3 ك.ب |
| 60 | [`60-quick-ux-batch.md`](60-quick-ux-batch.md) | دفعة UX السريعة (بعد 4.1 — من مراجعة UX بموافقة المالك) | 1.6 ك.ب |
| 61 | [`61-daily-loop-polish.md`](61-daily-loop-polish.md) | دفعة تلميع الحلقة اليومية (2026-07-19) | 1.8 ك.ب |
| 62 | [`62-web-components.md`](62-web-components.md) | مكوّنات الواجهة (تفكيك Web Components — اكتمل ت-0…ت-13) | 2.3 ك.ب |
| 63 | [`63-generations-gallery-panel.md`](63-generations-gallery-panel.md) | لوحة معرض التوليدات 🖼 (الجولة 8 من «ولّد من سطر» — kimi-code) | 2.6 ك.ب |
| 64 | [`64-generation-cards-chat.md`](64-generation-cards-chat.md) | بطاقة التوليد في المحادثة وبطاقة الصوت (الجولة 9 §2/§4 — kimi-code) | 3.4 ك.ب |
| 65 | [`65-media-players-gallery.md`](65-media-players-gallery.md) | مشغّلا الوسائط في المعرض (الجولة 10 §3 — kimi-code) | 2.9 ك.ب |
| 66 | [`66-reply-readability.md`](66-reply-readability.md) | قرائية ردود الوكيل — سلّم العناوين وعارض Markdown وتوجيه شكل الرد (2026-09-11) | 8.4 ك.ب |
| 67 | [`67-project-connections.md`](67-project-connections.md) | توصيلات المشروع المجانية (OBS-145 — دفعة الرمز الشخصي، 2026-09-08) | 4.2 ك.ب |
| 68 | [`68-models-boot-and-preview-controls.md`](68-models-boot-and-preview-controls.md) | إقلاع النماذج وأسقف اللوحات · أزرار المعاينة وقصد المستخدم (2026-09-10) | 2.4 ك.ب |
| 69 | [`69-computer-use-desktop.md`](69-computer-use-desktop.md) | استعمال الحاسوب — سطح ويندوز: المعين والمراجع والحرّاس والأدوات الثماني (الخطوات ٠–٤، 2026-09-11) | 12.2 ك.ب |
| 70 | [`70-accessibility-names.md`](70-accessibility-names.md) | أسماء الوصول للأزرار الرمزية والحقول والحاويات (‏OBS-166/167/176 — 2026-09-12) | 6.2 ك.ب |
| 71 | [`71-boot-order-chat-guard.md`](71-boot-order-chat-guard.md) | ترتيب الإقلاع وحارس `<satr-chat>` — نداءات القشرة قبل ترقية المكوّن (‏OBS-172 — 2026-09-12) | 6.0 ك.ب |
