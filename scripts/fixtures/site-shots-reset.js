'use strict';
// يعمل قبل وحدات ES (السكربت الكلاسيكي يسبق المؤجل): تصفير تفضيلات محفوظة
// كي لا تتسرب حالة لقطة سابقة إلى التالية عبر localStorage في النافذة المعادة
localStorage.removeItem('satr_ledger_collapsed');
localStorage.removeItem('satr_term_height');
// تفضيلات تخطيط غرفة العمليات: لقطة «هيئة القضاة» تزرعها فلا تتسرب إلى لقطة الفريق
for (const key of Object.keys(localStorage)) {
  if (key.startsWith('satr_ops_layout:')) localStorage.removeItem(key);
}
