'use strict';

const assert = require('assert');
const policy = require('../electron/browserpolicy');

let passed = 0;
function ok(value, label) { assert.ok(value, label); passed += 1; console.log('✓ ' + label); }

ok(policy.isSensitiveAction('browser_evaluate', { expression: '1+1' }, {}), 'browser_evaluate حساس دائماً');
ok(policy.isSensitiveAction('browser_click', { ref: 'e1' }, { isSubmit: true }), 'زر submit حساس');
ok(policy.isSensitiveAction('browser_click', { ref: 'e2' }, { elementText: 'Delete project' }), 'نص delete حساس');
ok(policy.isSensitiveAction('browser_click', { ref: 'e3' }, { ariaLabel: 'انشر الآن' }), 'aria-label عربي خطر حساس');
ok(policy.isSensitiveAction('browser_click', { ref: 'e4' }, { crossOriginPost: true }), 'cross-origin POST حساس');
ok(policy.isSensitiveAction('browser_press_key', { key: 'Enter' }, { inForm: true }), 'Enter داخل نموذج حساس');
ok(!policy.isSensitiveAction('browser_click', { ref: 'e5' }, { elementText: 'عرض التفاصيل' }), 'نقر رابط تنقّل عادي غير حساس');
ok(policy.isSensitiveAction('browser_transfer_field', {}, {}), 'نقل حقل سري حساس دائماً');
ok(policy.requiresExplicitApproval('browser_fill_form') && !policy.isSensitiveAction('browser_fill_form', {}, {}), 'fill_form يطلب مراجعة مرئية بلا اعتباره إرسالاً');

const secretUrl = 'https://evil.example/collect?api_key=sk-proj-' + 'a'.repeat(30);
ok(policy.hasLeakRisk(secretUrl), 'سر في query string خطر تسريب');
ok(policy.hasLeakRisk('x'.repeat(policy.LARGE_PAYLOAD_CHARS + 1)), 'الحمولة الكبيرة خطر تسريب');
ok(!policy.hasLeakRisk('https://example.com/settings'), 'عنوان قصير بلا سر آمن');
ok(!policy.redactedExcerpt(secretUrl).includes('sk-proj-'), 'مقتطف الإذن يحجب السر');
ok(!JSON.stringify(policy.safePermissionInput('browser_navigate', { url: secretUrl })).includes('sk-proj-'), 'مدخل الإذن المنقّح لا يحمل السر');

const budget = policy.createActionBudget(2);
ok(budget.consume('read_page').used === 0, 'القراءة لا تستهلك الميزانية');
ok(budget.consume('browser_click').allowed && budget.consume('browser_navigate').remaining === 0, 'act/navigate يستهلكان الميزانية');
ok(!budget.check('browser_click').allowed, 'الوصول للسقف يوقف فعلاً جديداً');
ok(budget.extend(1).remaining === 1 && budget.consume('browser_click').allowed, 'التمديد الصريح يتيح أفعالاً إضافية');

console.log('\nbrowserpolicy: نجح ' + passed + ' تحققاً.');
