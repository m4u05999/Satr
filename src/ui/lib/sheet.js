// مساعد بناء ورقة أنماط منشأة (Constructable Stylesheet) لمكوّنات الواجهة.
// القرار المثبّت (docs/COMPONENTS-PLAN.md §1 — تحقق حيّ): أنماط المكوّنات تمر عبر
// adoptedStyleSheets حصراً — وسم <style> داخل Shadow DOM محجوب بـ CSP (style-src 'self')،
// بينما CSSStyleSheet المبنية في JS لا تُعد inline فتعمل بلا هاشات جديدة.
export function sheet(cssText) {
  const s = new CSSStyleSheet();
  s.replaceSync(cssText);
  return s;
}
