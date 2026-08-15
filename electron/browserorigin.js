/** تصنيف أدوات متصفح «سطر» وثقة النطاقات — منطق نقي بلا Electron. */

'use strict';

const LOCAL_ORIGINS = Object.freeze([
  'http://localhost', 'https://localhost',
  'http://127.0.0.1', 'https://127.0.0.1',
]);

const READ_TOOLS = new Set([
  'read_page', 'browser_snapshot', 'browser_console', 'browser_network', 'screenshot',
  'browser_screenshot_element', 'browser_wait_for', 'browser_scroll', 'browser_hover',
  'browser_set_viewport', 'browser_perf',
]);
const NAVIGATE_TOOLS = new Set([
  'open_preview', 'close_preview', 'browser_navigate', 'browser_back', 'browser_forward',
]);
const ACT_TOOLS = new Set([
  'browser_click', 'browser_type', 'browser_select_option', 'browser_press_key', 'browser_evaluate',
  'browser_fill_form', 'browser_transfer_field', 'browser_request_secret',
]);
const HANDOFF_TOOLS = new Set(['browser_handoff', 'browser_handoff_step']);

function bareToolName(name) {
  return String(name || '').replace(/^mcp__satr-terminal__/, '');
}

function originOf(url) {
  if (typeof url !== 'string' || url.length > 4096) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function isLocalOrigin(origin) {
  if (!origin) return false;
  try {
    const host = new URL(origin).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1';
  } catch {
    return false;
  }
}

function isTrusted(url, trustedSet) {
  const origin = originOf(url);
  if (!origin) return false;
  if (isLocalOrigin(origin)) return true;
  return trustedSet instanceof Set && trustedSet.has(origin);
}

function trust(url, trustedSet) {
  const origin = originOf(url);
  if (!origin || !(trustedSet instanceof Set)) return null;
  trustedSet.add(origin);
  return origin;
}

function classifyBrowserTool(name) {
  const bare = bareToolName(name);
  if (READ_TOOLS.has(bare)) return 'read';
  if (NAVIGATE_TOOLS.has(bare)) return 'navigate';
  if (ACT_TOOLS.has(bare)) return 'act';
  if (HANDOFF_TOOLS.has(bare)) return 'handoff';
  return null;
}

function targetForTool(name, input, currentUrl, navigationTarget) {
  const bare = bareToolName(name);
  if (bare === 'open_preview' || bare === 'browser_navigate') return input && input.url;
  if (bare === 'browser_back' || bare === 'browser_forward') return navigationTarget || currentUrl || null;
  return currentUrl || null;
}

function actionLabel(name) {
  const labels = {
    open_preview: 'فتح المعاينة', close_preview: 'إغلاق المعاينة', browser_navigate: 'التنقّل', browser_back: 'الرجوع',
    browser_forward: 'التقدّم', browser_click: 'النقر', browser_type: 'الكتابة',
    browser_select_option: 'اختيار عنصر', browser_press_key: 'ضغط مفتاح',
    browser_evaluate: 'تنفيذ JavaScript تشخيصي', browser_fill_form: 'تعبئة نموذج',
    browser_transfer_field: 'نقل قيمة سرية بين حقلين', browser_request_secret: 'طلب إدخال سر في حقل',
    browser_handoff_step: 'تسليم خطوة للمستخدم',
  };
  const bare = bareToolName(name);
  return labels[bare] || bare || 'فعل متصفح';
}

function trustPrompt(name, target) {
  const origin = originOf(target);
  return 'الوكيل يريد ' + actionLabel(name) + ' على نطاق جديد: ' + (origin || 'نطاق غير معروف')
    + ' — هل تثق به لهذه الجلسة؟\n' + String(target || '');
}

function canAutoControl(name, target, trustedSet) {
  const browserClass = classifyBrowserTool(name);
  if (browserClass === 'read' || browserClass === 'handoff') return true;
  if (browserClass === 'navigate' || browserClass === 'act') return isTrusted(target, trustedSet);
  return false;
}

module.exports = {
  LOCAL_ORIGINS, originOf, isTrusted, trust, classifyBrowserTool, targetForTool, actionLabel, trustPrompt, canAutoControl,
};
