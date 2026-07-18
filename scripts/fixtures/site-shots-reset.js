'use strict';
// يعمل قبل وحدات ES (السكربت الكلاسيكي يسبق المؤجل): تصفير تفضيلات محفوظة
// كي لا تتسرب حالة لقطة سابقة إلى التالية عبر localStorage في النافذة المعادة
localStorage.removeItem('satr_ledger_collapsed');
localStorage.removeItem('satr_term_height');
