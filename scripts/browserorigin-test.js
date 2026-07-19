/** اختبار نقي لثقة نطاقات متصفح «سطر» وتصنيف أدواته. */
'use strict';

const assert = require('assert');
const browserorigin = require('../electron/browserorigin');

let passed = 0;
function ok(value, name) { assert.ok(value, name); passed += 1; console.log('✓ ' + name); }

const trusted = new Set();
ok(browserorigin.originOf('HTTPS://Example.COM:443/a?q=1') === 'https://example.com', 'originOf يطبّع المخطط والمضيف والمنفذ الافتراضي');
ok(browserorigin.originOf('file:///tmp/a') === null && browserorigin.originOf('javascript:alert(1)') === null, 'originOf يرفض غير http/https');
ok(browserorigin.isTrusted('http://localhost:5173/x', trusted), 'localhost موثوق على أي منفذ');
ok(browserorigin.isTrusted('https://127.0.0.1:8443/', trusted), '127.0.0.1 موثوق على أي منفذ');
ok(!browserorigin.isTrusted('https://example.com/a', trusted), 'النطاق الخارجي الجديد غير موثوق');
ok(browserorigin.trust('https://example.com/a', trusted) === 'https://example.com', 'فعل المستخدم يبذر origin مطبّعاً');
ok(browserorigin.isTrusted('https://example.com/other', trusted), 'الثقة تشمل بقية مسارات النطاق نفسه');
ok(!browserorigin.isTrusted('https://sub.example.com/', trusted), 'الثقة لا تتسرّب إلى نطاق فرعي');

ok(browserorigin.classifyBrowserTool('read_page') === 'read', 'read_page قراءة');
ok(browserorigin.classifyBrowserTool('mcp__satr-terminal__screenshot') === 'read', 'screenshot المؤهلة قراءة');
ok(browserorigin.classifyBrowserTool('browser_navigate') === 'navigate', 'browser_navigate تنقّل');
ok(browserorigin.classifyBrowserTool('browser_back') === 'navigate', 'browser_back تنقّل');
ok(browserorigin.classifyBrowserTool('browser_click') === 'act', 'browser_click فعل');
ok(browserorigin.classifyBrowserTool('browser_evaluate') === 'act', 'browser_evaluate فعل قوي');
ok(browserorigin.classifyBrowserTool('browser_fill_form') === 'act', 'browser_fill_form فعل');
ok(browserorigin.classifyBrowserTool('browser_transfer_field') === 'act', 'browser_transfer_field فعل');
ok(browserorigin.classifyBrowserTool('browser_request_secret') === 'act', 'browser_request_secret فعل');
ok(browserorigin.classifyBrowserTool('browser_handoff') === 'handoff', 'browser_handoff منح قيادة آمن مستقل');
ok(browserorigin.classifyBrowserTool('browser_handoff_step') === 'handoff', 'browser_handoff_step تسليم مرحلي آمن');
ok(browserorigin.classifyBrowserTool('run_in_background') === null, 'الأداة غير المتصفحية لا تُصنّف');
ok(browserorigin.targetForTool('browser_navigate', { url: 'https://new.test/x' }, 'https://old.test') === 'https://new.test/x', 'هدف التنقّل من input');
ok(browserorigin.targetForTool('browser_click', { ref: 'e1' }, 'https://page.test/x') === 'https://page.test/x', 'هدف الفعل هو الصفحة الحالية');
ok(browserorigin.canAutoControl('read_page', 'https://evil.test', new Set()), 'القراءة حرة تحت تحكم المتصفح');
ok(!browserorigin.canAutoControl('browser_click', 'https://evil.test', new Set()), 'الفعل على نطاق غير موثوق يُبوّب');
ok(browserorigin.canAutoControl('browser_click', 'http://localhost:5173', new Set()), 'الفعل على localhost يمر تلقائياً');
ok(/نطاق جديد/.test(browserorigin.trustPrompt('browser_click', 'https://new.test/x')), 'رسالة التحويل تعرض النطاق الجديد');

console.log('\nنجح ' + passed + ' تحقّقاً.');
