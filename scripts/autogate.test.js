/**
 * اختبار بوابة auto (الموجة 4) — يثبت منطق البوابة المحلي الذي اشترطه كودكس قبل الاعتماد.
 * يغطّي autogate.js النقي. (إثبات أن SDK الحقيقي يوجّه ask→canUseTool اختبار حيّ منفصل.)
 * التشغيل: node scripts/autogate.test.js
 */
'use strict';

const assert = require('assert');
const { PERMISSION_MODES, AUTO_SAFE_TOOLS, autoNeedsPrompt, nonSdkPerm, decideAutoApproval } = require('../electron/autogate');

let passed = 0;
function check(label, cond) {
  assert.ok(cond, 'فشل: ' + label);
  passed++;
  console.log('✓ ' + label);
}

// 1) الأدوات الخطرة والمجهولة تُسأل في auto (fail-safe)
check('Bash تُسأل في auto', autoNeedsPrompt('Bash', 'auto') === true);
check('Write تُسأل في auto', autoNeedsPrompt('Write', 'auto') === true);
check('Edit تُسأل في auto', autoNeedsPrompt('Edit', 'auto') === true);
check('MultiEdit تُسأل في auto', autoNeedsPrompt('MultiEdit', 'auto') === true);
check('run_in_terminal تُسأل في auto', autoNeedsPrompt('mcp__satr-terminal__run_in_terminal', 'auto') === true);
check('run_in_background تُسأل في auto', autoNeedsPrompt('mcp__satr-terminal__run_in_background', 'auto') === true);
check('stop_background_task تُسأل في auto', autoNeedsPrompt('mcp__satr-terminal__stop_background_task', 'auto') === true);
check('verify_project تُسأل في auto', autoNeedsPrompt('mcp__satr-verify__verify_project', 'auto') === true);
check('أداة مجهولة (خادم MCP مستخدم) تُسأل — fail-safe', autoNeedsPrompt('mcp__someserver__do_thing', 'auto') === true);
check('WebFetch تُسأل في auto', autoNeedsPrompt('WebFetch', 'auto') === true);
check('WebSearch تُسأل في auto', autoNeedsPrompt('WebSearch', 'auto') === true);
check('Task (إطلاق وكيل) تُسأل في auto', autoNeedsPrompt('Task', 'auto') === true);

// 2) الأدوات الآمنة تمرّ دون سؤال في auto
check('Read تمرّ دون سؤال', autoNeedsPrompt('Read', 'auto') === false);
check('Glob تمرّ دون سؤال', autoNeedsPrompt('Glob', 'auto') === false);
check('Grep تمرّ دون سؤال', autoNeedsPrompt('Grep', 'auto') === false);
check('read_page (قرائية) تمرّ', autoNeedsPrompt('mcp__satr-terminal__read_page', 'auto') === false);
check('get_background_output (قرائية) تمرّ', autoNeedsPrompt('mcp__satr-terminal__get_background_output', 'auto') === false);
check('list_background_tasks (قرائية) تمرّ', autoNeedsPrompt('mcp__satr-terminal__list_background_tasks', 'auto') === false);
check('browser_console (قرائية) تمرّ', autoNeedsPrompt('mcp__satr-terminal__browser_console', 'auto') === false);

// 3) الإصلاح: أدوات المعاينة غير القرائية أُزيلت من الآمنة ⇒ تُسأل (مراجعة كودكس الثانية)
check('browser_snapshot (يكتب DOM) تُسأل', autoNeedsPrompt('mcp__satr-terminal__browser_snapshot', 'auto') === true);
check('browser_screenshot_element (scrollIntoView) تُسأل', autoNeedsPrompt('mcp__satr-terminal__browser_screenshot_element', 'auto') === true);
check('browser_scroll تُسأل', autoNeedsPrompt('mcp__satr-terminal__browser_scroll', 'auto') === true);
check('browser_hover تُسأل', autoNeedsPrompt('mcp__satr-terminal__browser_hover', 'auto') === true);
check('AUTO_SAFE_TOOLS لا تحوي snapshot', !AUTO_SAFE_TOOLS.has('mcp__satr-terminal__browser_snapshot'));
check('AUTO_SAFE_TOOLS لا تحوي scroll', !AUTO_SAFE_TOOLS.has('mcp__satr-terminal__browser_scroll'));

// 4) browser_navigate تُسأل في auto (السماح بها يتم عبر browserControl في canUseTool، خارج البوابة)
check('browser_navigate تُسأل في auto', autoNeedsPrompt('mcp__satr-terminal__browser_navigate', 'auto') === true);
check('open_preview تُسأل في auto', autoNeedsPrompt('mcp__satr-terminal__open_preview', 'auto') === true);

// 5) auto فقط — الأوضاع الأخرى لا تُفعّل البوابة (السلوك القائم بلا تغيير)
check('Bash في default لا تُبوَّب هنا', autoNeedsPrompt('Bash', 'default') === false);
check('Bash في acceptEdits لا تُبوَّب هنا', autoNeedsPrompt('Bash', 'acceptEdits') === false);
check('Bash في plan لا تُبوَّب هنا', autoNeedsPrompt('Bash', 'plan') === false);

// 6) سياسة canUseTool المستخرجة (decideAutoApproval) — تختبر **أصل الثغرتين** (طلب كودكس)
const perma = new Set(['Bash']); // «موافقة دائمة» سابقة لأداة خطرة
// الثغرة 2: alwaysAllowed لا يعفي أداة غير آمنة في auto ⇒ تبقى prompt (لا تلتفّ)
check('Bash + alwaysAllowed في auto ⇒ prompt', decideAutoApproval('Bash', { permissionMode: 'auto', alwaysAllowed: perma }) === 'prompt');
// نفسها في default: alwaysAllowed يعفي (السلوك القائم بلا تغيير)
check('Bash + alwaysAllowed في default ⇒ allow', decideAutoApproval('Bash', { permissionMode: 'default', alwaysAllowed: perma }) === 'allow');
// أداة آمنة + alwaysAllowed في auto ⇒ allow (القرائية لا تُبوَّب أصلاً)
check('Read + alwaysAllowed في auto ⇒ allow', decideAutoApproval('Read', { permissionMode: 'auto', alwaysAllowed: new Set(['Read']) }) === 'allow');
// الثغرة 4: browser_navigate تُسمح **فقط** مع browserControl الصريح
check('browser_navigate + browserControl ⇒ allow', decideAutoApproval('mcp__satr-terminal__browser_navigate', { permissionMode: 'auto', browserControl: true, browserTool: true }) === 'allow');
check('browser_navigate بلا browserControl ⇒ prompt', decideAutoApproval('mcp__satr-terminal__browser_navigate', { permissionMode: 'auto', browserControl: false, browserTool: true }) === 'prompt');
// القرائية المعفاة (skill/verify-config/memory) ⇒ allow حتى في auto
check('أداة قرائية معفاة (readOnly) ⇒ allow في auto', decideAutoApproval('mcp__satr-skills__load_skill', { permissionMode: 'auto', readOnly: true }) === 'allow');
// أداة خطرة بلا أي إعفاء في auto ⇒ prompt
check('Write بلا إعفاء في auto ⇒ prompt', decideAutoApproval('Write', { permissionMode: 'auto' }) === 'prompt');
// browserControl لا يعفي أداة **غير** متصفح (run_in_terminal مثلاً) ⇒ prompt
check('run_in_terminal مع browserControl ⇒ prompt', decideAutoApproval('mcp__satr-terminal__run_in_terminal', { permissionMode: 'auto', browserControl: true, browserTool: false }) === 'prompt');

// 7) nonSdkPerm: auto يسقط لـ default لغير SDK؛ الأوضاع الأخرى تُصان
check('nonSdkPerm(auto) = default', nonSdkPerm('auto') === 'default');
check('nonSdkPerm(acceptEdits) = acceptEdits', nonSdkPerm('acceptEdits') === 'acceptEdits');
check('nonSdkPerm(plan) = plan', nonSdkPerm('plan') === 'plan');
check('nonSdkPerm(bypassPermissions) محفوظ', nonSdkPerm('bypassPermissions') === 'bypassPermissions');
check('nonSdkPerm(قيمة فاسدة) = default', nonSdkPerm('garbage') === 'default');
check('PERMISSION_MODES يشمل auto', PERMISSION_MODES.has('auto') === true);

console.log('\nالنتيجة: ' + passed + '/' + passed + ' ناجحة.');
