### مكوّنات الواجهة (تفكيك Web Components — اكتمل ت-0…ت-13)

> الخطة والسجل الكامل بالدروس المثبّتة في `docs/COMPONENTS-PLAN.md` — اقرأه قبل أي
> عمل على الواجهة. صفر اعتماديات وبنّائين: Web Components أصلية + وحدات ES.

- **المعمارية**: `src/ui/app.js` قشرة إقلاع وتوجيه (وحدة ES تعمل أولاً — ترتيب الوسوم)
  تملك حالة التطبيق ومجرى `satr:event` ومنسّق الأسطح؛ المكوّنات ذاتية التسجيل في
  `src/ui/components/`؛
  المشتركات وحدات في `src/ui/lib/`. العقد: أحداث `CustomEvent` للخارج + methods عامة +
  الحالة تُمرَّر لحظة الفتح (المكوّنات لا تقرأ حالة القشرة).
- **الأنماط**: Shadow DOM ⇒ `adoptedStyleSheets` حصراً (وسم `<style>` داخل Shadow
  **محجوب بـ CSP**)؛ light DOM ⇒ base.css. Tokens تعبر الحدود بالوراثة من `:root`.
- **بـ Shadow DOM** (عزل حقيقي): لوحات agents/skills/mcp/context/sessions/git/files +
  file-viewer + gate + perm-dialog + preview-panel (م-1 — بعد اكتمال التفكيك).
- **بلا Shadow (light DOM بغلاف `display:contents`)**: terminal-panel (xterm يقيس
  المستند) + composer وtopbar (الترميز داخل الوسم في index.html — القشرة تربط عناصرهما)
  + **chat** (البث يعيد بناء innerHTML؛ يبني `<main>` بداخله ويعيد كتلة
  `newAssistantBlock(label)` بعقدها للقشرة، ويعتمد diffSheet على المستند). `composer`
  يملك المسودات لكل cwd واستعادة النص/الصور؛ `chat` يملك البحث وقلم الرسالة وحالة
  الإيقاف وزر الإعادة؛ `topbar` يعرض ملخّص تغييرات الجلسة ودليل الاختصارات؛ و`app.js`
  يبقى مالك حالة النموذج/الجهد/الأذونات/السياق وآخر دور وخريطة `file_edit`.
- **دروس مثبّتة**: retargeting نقرات Shadow على مستمع المضيف ⇒ `composedPath()[0]`؛
  نداء مبكر لمكوّن ⇒ `customElements.whenDefined`؛ grep لكل id/صنف قبل حذف CSS.

