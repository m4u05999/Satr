/**
 * بوابة وضع «تلقائي ذكي» (auto) — الموجة 4. موديول نقي بلا تبعيات (نمط diff.js/inject.js)
 * ليكون قابلاً للاختبار مستقلاً عن electron/SDK. يستهلكه agent.js (preToolUse/canUseTool)
 * وmain.js (تنقية permissionMode).
 *
 * الفكرة: في auto يُصنّف مصنّف Anthropic الأدوات (خطوة 4 من تقييم أذونات SDK) قبل مربع
 * الإذن العربي (canUseTool، خطوة 6). فأي أداة ذات أثر (تنفيذ/كتابة/شبكة/تنقّل/متصفح كاتب/
 * إطلاق وكيل/مجهولة) تُجبَر على المربع عبر preToolUse:'ask' (خطوة 1، تسبق auto).
 * **fail-safe (مراجعتا muraji-amn + كودكس): قائمة بيضاء للآمن لا قائمة سوداء للخطر** —
 * ما ليس هنا يُسأل، فأداة جديدة/مجهولة (خادم MCP مستخدم) تفشل مغلقةً لا مفتوحةً.
 */

'use strict';

const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto']);

// الأدوات الآمنة في auto: أثرها قراءة محلية أو حالة داخلية غير تنفيذية وغير دائمة وبلا
// شبكة. سُمّيت AUTO_SAFE_TOOLS لا READ_ONLY (اقتراح كودكس): TodoWrite وpropose_memory
// تُغيّران حالة داخلية مرئية لكن بلا ملف/تنفيذ/شبكة. المستبعَد من أدوات المعاينة يُسأل:
// snapshot يكتب data-satr-ref في DOM، screenshot_element يعمل scrollIntoView، scroll
// يطلق lazy-load/شبكة، hover يطلق mouseover/JS — ليست قراءة بحتة (مراجعة كودكس الثانية).
const AUTO_SAFE_TOOLS = new Set([
  // أدوات SDK القرائية المحلية + سجل المهام الداخلي
  'Read', 'Glob', 'Grep', 'LS', 'TodoWrite',
  // معاينة الويب — القرائية البحتة فقط
  'mcp__satr-terminal__read_page',
  // قرائية محضة مُثبَتة بفحص حيّ: لا سمة ولا عنصر ولا تمرير بعد القياس (‏test:readability
  // يفحص DOM بعده). لولا ذلك لبقيت خارج القائمة مثل snapshot/scroll/hover.
  'mcp__satr-terminal__browser_readability',
  'mcp__satr-terminal__screenshot',
  'mcp__satr-terminal__browser_console',
  'mcp__satr-terminal__browser_network',
  'mcp__satr-terminal__browser_wait_for',
  'mcp__satr-terminal__get_background_output',
  'mcp__satr-terminal__list_background_tasks',
  // مهارات/تحقق/ذاكرة — قراءة أو اقتراح بلا كتابة قرص
  'mcp__satr-skills__load_skill',
  'mcp__satr-skills__read_skill_resource',
  'mcp__satr-verify__verification_config',
  'mcp__satr-memory__propose_memory',
]);

// هل تحتاج الأداة مربع الإذن العربي في هذا الوضع؟ true فقط في auto ولأداة غير آمنة.
// لا يعتمد على agent_id: ينطبق موحّداً على الخيط الرئيسي والوكلاء الفرعيين (يرثون auto).
function autoNeedsPrompt(toolName, permissionMode) {
  return permissionMode === 'auto' && !AUTO_SAFE_TOOLS.has(toolName);
}

// تنقية permissionMode للمحرّكات غير SDK: auto حصري لـ SDK (يعتمد على preToolUse hook)،
// فيسقط لـ default لـ Codex/المحوّلات (تجنّب سلوك مضلّل — الواجهة تصفه «SDK فقط»).
function nonSdkPerm(mode) {
  const m = PERMISSION_MODES.has(mode) ? mode : 'default';
  return m === 'auto' ? 'default' : m;
}

// سياسة الموافقة التلقائية في canUseTool — مستخرجة نقيّةً ليختبرها fixture (طلب كودكس:
// اختبار يستهدف أصل الثغرة، لا autoNeedsPrompt وحدها). تطابق ترتيب canUseTool حرفياً.
// تُرجع 'allow' (تُوافَق تلقائياً بلا مربع) أو 'prompt' (تذهب لمربع الإذن العربي).
// ctx: { permissionMode, alwaysAllowed:Set, browserControl:bool, readOnly:bool, browserTool:bool }
//   - readOnly: أداة قرائية معفاة دائماً (skill/verify-config/memory-propose) — يحسبها المستدعي.
//   - browserTool: ضمن أدوات المتصفح (BROWSER_AUTO_TOOLS) — يحسبها المستدعي.
// **الإصلاح الجوهري:** «موافقة دائمة» سابقة (alwaysAllowed) لا تعفي أداة غير آمنة في auto.
function decideAutoApproval(toolName, ctx) {
  ctx = ctx || {};
  const gated = autoNeedsPrompt(toolName, ctx.permissionMode);
  if (!gated && ctx.alwaysAllowed && ctx.alwaysAllowed.has(toolName)) return 'allow';
  if (ctx.readOnly) return 'allow';
  if (ctx.browserControl && ctx.browserTool) return 'allow';
  return 'prompt';
}

module.exports = { PERMISSION_MODES, AUTO_SAFE_TOOLS, autoNeedsPrompt, nonSdkPerm, decideAutoApproval };
