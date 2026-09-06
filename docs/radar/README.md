# رادار سطر — الأعداد

نسخة Markdown من صفحة «رادار سطر» (claude.ai) كي يقرأها Claude Code والوكلاء من داخل المستودع. **الرادار يقترح ولا ينفّذ**: ما يُقبل من بنوده يُسجَّل في `docs/OBSERVATIONS.md` بقرار المالك، وهذا المجلد سجلّ الاقتراحات لا القرارات.

| العدد | التاريخ | الملف | الملخّص |
|---|---|---|---|
| 005 | 2026-09-06 | [`005.md`](005.md) | 2026-09-06 · window 1–3d · 15 items + 5 F11 · all fronts |
| 004 | 2026-09-05 | [`004.md`](004.md) | 2026-09-05 · window 1d · 7 items · daily fronts F1/F2/F5/F8 |
| 003 | 2026-09-04 | [`003.md`](003.md) | 2026-09-04 · F11 tech scouting · 6 axes · 24 evaluated · 11 open / 8 watch / 5 grave |
| 002 | 2026-09-04 | [`002.md`](002.md) | 2026-09-04 · window 1d · 7 items · daily fronts F1/F2/F5/F8 |
| 001 | 2026-09-03 | [`001.md`](001.md) | 2026-09-03 · window 60–90d · 29 items |

## كيف تُقرأ

- الجبهات الدفاعية F1–F10 تسأل «هل يمسّ سطر؟» وتُدرَّج: **مباشر** (يلزم قراراً أو كوداً) · **يستحق OBS** (يُسجَّل ولا يُنفَّذ) · **للعلم**. ومنذ العدد ٠٠٦ يحمل كل بند وسم عدسة: يخدم سطر / يهدد سطر / يطوّر سطر.
- الجبهة الهجومية F11 (الأحد) تبدأ من رغبة معلنة لكل محور، وكل مرشّح يمرّ بخمسة أسئلة (المحور، الأثر على المستخدم العربي، الرخصة، الصيانة، كلفة الدمج) ويخرج بنتيجة: **افتح OBS** · **راقب حتى ينضج** · **مقبرة**.
- `state.json` هو الحالة الآلية: `baseline` (المثبّت في سطر — يقرؤه الرادار من `package.json`) و`baseline.engines_on_owner_machine` (إصدارات المحرّكات على جهاز المالك — **يكتبها المالك** بـ`npm run radar:baseline -- --write`) و`latest_seen` (لقطة السجلّات وقت العدد) و`open_threads` و`tech_watch` (الرغبات، المراقبة، **المقبرة**، `npm_blocklist`). قبل اقتراح مكتبة أو تقنية راجع المقبرة كي لا يُعاد ما رُفض بسبب مكتوب — و`npm run test:radar-graveyard` يعضّ.

## الحالة الحالية (من state.json)

**مفتوح للـOBS (F11):**
- E: prefix stability for prompt caching (budget block + repo_map out of system prompt)
- E: tool-result clearing before summarization (keep/buffer params à la OpenCode)
- E: Arabic token-tax metric in usage.js/langmetric.js
- E: bashOutputMaxChars / taskOutputMaxChars on the Claude Code path
- E: /skill-doctor measurement for the seven satr-* skills (pairs with OBS-114)
- E: mdream vs turndown A/B measured through usage.js (20 pages, 10 Arabic) + U+200F/U+202B preservation test — replace or reject with a number
- A: chrome-devtools-mcp over Electron CDP
- A: @mozilla/readability + turndown injected in preview; agent-browser optional
- B: bidi-js vendored + CodeMirror 6 bidi model + terminal-wg CSI handlers
- B: harfbuzzjs limited experiment (adds ~510KB dep — justify or bury)
- C: measure electron-updater blockmap differential; electronLanguages ar/en-US
- C: @microsoft/winappcli MSIX channel — GATED on a node-pty/ConPTY-inside-MSIX spike first
- D: agentskills.io validator in load_skill + license/metadata fields on satr-* skills
- D: npx skills import + marketplace.json reader + skill-creator evals.json; hurmoz contribution
- F: study pi / OpenCode compaction / Cline diff-edit eval — patterns only, no deps

**قيد المراقبة:** headroom-ai · NVIDIA/SkillEvaluator · text-shaper · Kitesurf · Blitz/Parley · Playwright MCP · agent-browser (Vercel) · Velopack · Electrobun / Bun.Terminal · deferred tool schemas (tool search) · speculative decoding (llama-server) · small-model routing · mini-swe-agent bash-only fallback · @anthropic-ai/sandbox-runtime (Windows alpha) · Microsoft MXC · WezTerm bidi model / Ghostty #11079 · coder/ghostty-web · ICU4X npm · @mapbox/mapbox-gl-rtl-text · @devsamhan/arabic-bidi / bidi-shaper / kashida · hurmoz / ArabAgentSkills / openai skills · OpenRouter endpoint · humain-m3 open weights

**المقبرة:** Lightpanda (AGPL-3.0; no Windows binary; no rendering/shaping) · Tauri 2 + Node sidecar (weeks of rewrite; sidecar ~50MB; node-pty outside bundle; solves neither SmartScreen nor signing) · V8 snapshots (electron-link/mksnapshot) (size increased 227->238MB; last commit 2024-11) · electron-delta (UNLICENSED; last publish 2022-08; requires signing function) · mem0 / Letta as dependency (numbers vs 'send whole conversation'; file memory proven; memory.js exists) · LiteLLM / Portkey (Python/server-side; not embeddable in Node) · rustybuzz-wasm (dead since 2021) · fontkit / opentype.js (for shaping) (5.6MB+9 deps (2024) / feature engine not HarfBuzz-grade) · unicode-bidirectional (2017, immutable+lodash deps) · Servo / Stylo (for Satr) (MPL; Stylo is CSS only; Servo bidi limited) · WebDriver BiDi (Electron doesn't expose it; CDP available directly) · Windows Sandbox CLI (wsb exec) (no process I/O) · raw AppContainer (RunInSandbox) (C++ tooling; no gain over MXC) · Roo Code (archived 2026-05-15) · Skilldex (third skill registry after two already evaluated, and stale: skilldex@0.1.1 last published 2026-02-21, solo author)

**أنجزه المالك منذ ٠٠١:** MSIX package for Microsoft Store · winget manifests + PR microsoft/winget-pkgs#429004 · Certum facts verified (OBS-096) · DeepSeek v4-flash/v4-pro migration · NIM/Groq catalog split + allam-2-7b · OBS-097 RTL issues channel · OBS-098 ar-terminal · edit_file hardening landed (OBS-108) · SDK upgraded 0.3.176 -> 0.3.261; user_message_uuids batching read at agent.js:2223 · OBS-114 satr-guide bundle cap with written justification; 4KiB cap on SKILL.md · OBS-117/118/121/122 Windows gate work (PR #42) · OBS-133/134/135 sessions-panel grouping fix — buildProjectCwdMap, orphan-joins-project guard (PR #71, 2026-09-06)

