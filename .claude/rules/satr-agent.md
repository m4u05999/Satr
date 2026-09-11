---
paths:
  - "electron/adapters/**"
  - "electron/tools.js"
  - "electron/context.js"
  - "electron/repomap.js"
  - "electron/memory.js"
  - "electron/keys.js"
  - "electron/features.js"
  - "electron/skills.js"
  - "electron/skillwriter.js"
  - "src/ui/components/skills-panel.js"
  - "src/ui/components/memory-panel.js"
  - "src/ui/components/context-panel.js"
---

# satr-agent — اقرأ قبل أن تلمس

هذه الملفات لها سجلّ معماري مفصّل (دفعات، قرارات، دروس مقيسة) نُقل من `CLAUDE.md` إلى
`docs/internals/`. **قبل تعديلها اقرأ ما يخصّ تغييرك من القائمة، ووثّق دفعتك الجديدة في الملف المعني:**

- `docs/internals/08-adapters-providers.md` — طبقة المحوّلات والمزوّدين (Adapters/Providers — المرحلة 5)
- `docs/internals/15-keys-vault.md` — مخزن الأسرار ومركز المفاتيح (keys.js — المرحلة 5ب)
- `docs/internals/18-features-community-enterprise.md` — طبقة القدرات ونموذج Community + Enterprise (features.js — المرحلة 5ج)
- `docs/internals/19-phase5-ipcs.md` — IPCs المرحلة 5 (قراءة/كتابة، مُنقّاة في main.js)
- `docs/internals/21-skills-panel.md` — لوحة المهارات (Skills)
- `docs/internals/24-project-memory.md` — ذاكرة المشروع المحلية الصريحة (الأولوية 4)
- `docs/internals/25-repo-map.md` — خريطة المستودع المقتصدة للمزوّدات العمياء (الأولوية 5 — الدفعة الأولى)
