### الوكلاء الفرعيون (Subagents — المرحلة 14.2)

- **الاكتشاف**: `electron/agents.js` (نمط skills.js) يفحص `<cwd>/.claude/agents/*.md` و
  `~/.claude/agents/*.md` — كل وكيل ملف Markdown بمقدمة YAML (name/description/tools/model)
  وجسمه برومبت الوكيل؛ المشروع يفوز عند تكرار الاسم. IPC قراءة فقط `satr:listAgents(cwd)`.
  الـ SDK نفسه يحمّل الوكلاء من القرص (settingSources) — السرد للعرض فقط.
- **العرض المتداخل**: `forwardSubagentText: true` في agent.js يمرّر نصوص الوكيل كرسائل
  بـ `parent_tool_use_id`. الواجهة: أداة الإطلاق (Task/Agent) من الخيط الرئيسي تصير
  **بطاقة وكيل** (`agent-card`: رأس 🤖 بالحالة + وصف المهمة)، وكل ما يصل بـ
  parent_tool_use_id يتوجّه داخلها — أدوات متداخلة (قائمة ملتصقة بالآخر) وسجل نصي حي
  (renderMD). tool_result للإطلاق يعلّم البطاقة ✓/✗ عبر toolEls القائمة.
- **اللوحة**: أمر `/وكلاء` يفتح لوحة قراءة فقط (اسم/مصدر/وصف/نموذج/أدوات، وإرشاد إنشاء
  عند الخلو). وكيل نموذجي للمشروع: `.claude/agents/muraji-amn.md` (مراجع أمني عربي).

