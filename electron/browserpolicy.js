/** سياسة أفعال المتصفح الحساسة وحارس التسريب وميزانية المهمة — منطق نقي بلا Electron. */

'use strict';

const memory = require('./memory');

const DEFAULT_ACTION_LIMIT = 40;
const DEFAULT_ACTION_EXTENSION = 20;
const LARGE_PAYLOAD_CHARS = 1024;

const IMPACTING_TOOLS = new Set([
  'open_preview', 'browser_navigate', 'browser_back', 'browser_forward',
  'browser_click', 'browser_type', 'browser_select_option', 'browser_press_key',
  'browser_evaluate', 'browser_fill_form', 'browser_transfer_field', 'browser_request_secret',
]);

const DANGEROUS_ENGLISH = new RegExp(
  '\\b(?:send|submit|pay|purchase|buy|delete|remove|publish|deploy|confirm|subscribe|save|apply|authorize|grant|revoke|transfer)\\b',
  'i',
);
const DANGEROUS_ARABIC = /(?:أرسل|ارسل|ادفع|احذف|انشر|أكّد|اكد|فعّل|فعل|امنح|اعتمد|احفظ)/;

function bareToolName(name) {
  return String(name || '').replace(/^mcp__satr-terminal__/, '');
}

function textLooksDangerous(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return !!text && (DANGEROUS_ENGLISH.test(text) || DANGEROUS_ARABIC.test(text));
}

function isSensitiveAction(tool, input, pageContext) {
  const bare = bareToolName(tool);
  const data = input && typeof input === 'object' ? input : {};
  const context = pageContext && typeof pageContext === 'object' ? pageContext : {};
  if (bare === 'browser_evaluate' || bare === 'browser_transfer_field' || bare === 'browser_request_secret') return true;
  if (context.crossOriginPost === true || context.isSubmit === true) return true;
  if (bare === 'browser_press_key' && String(data.key) === 'Enter' && context.inForm === true) return true;
  return textLooksDangerous(context.elementText) || textLooksDangerous(context.ariaLabel);
}

function requiresExplicitApproval(tool) {
  return bareToolName(tool) === 'browser_fill_form';
}

function hasLeakRisk(value) {
  const text = typeof value === 'string' ? value : '';
  if (!text) return false;
  return text.length > LARGE_PAYLOAD_CHARS || memory.hasSecret(text);
}

function leakValueForTool(tool, input) {
  const bare = bareToolName(tool);
  const data = input && typeof input === 'object' ? input : {};
  if (bare === 'open_preview' || bare === 'browser_navigate') return typeof data.url === 'string' ? data.url : '';
  if (bare === 'browser_evaluate') return typeof data.expression === 'string' ? data.expression : '';
  return '';
}

function hasVisibleSecret(tool, input) {
  const bare = bareToolName(tool);
  const data = input && typeof input === 'object' ? input : {};
  if (bare === 'browser_type') return memory.hasSecret(data.text);
  if (bare === 'browser_fill_form') {
    return Array.isArray(data.fields) && data.fields.some((field) => memory.hasSecret(field && field.value));
  }
  if (bare === 'browser_handoff' || bare === 'browser_handoff_step' || bare === 'browser_request_secret') {
    return memory.hasSecret(data.reason) || memory.hasSecret(data.resume_hint);
  }
  return false;
}

function redactedExcerpt(value) {
  const text = String(value || '').replace(/[\u0000-\u001F\u007F]+/g, ' ').trim();
  if (!text) return '';
  if (memory.hasSecret(text)) {
    try {
      const url = new URL(text);
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin + url.pathname + '?[حمولة محجوبة]';
    } catch {}
    return '[محتوى سري محجوب]';
  }
  return text.slice(0, 180) + (text.length > 180 ? '…' : '');
}

function safePermissionInput(tool, input) {
  const data = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const bare = bareToolName(tool);
  if (bare === 'browser_evaluate' && hasLeakRisk(data.expression)) {
    return { expression: redactedExcerpt(data.expression) };
  }
  if ((bare === 'open_preview' || bare === 'browser_navigate') && hasLeakRisk(data.url)) {
    return { url: redactedExcerpt(data.url) };
  }
  return data;
}

function isImpactingAction(tool) {
  return IMPACTING_TOOLS.has(bareToolName(tool));
}

function createActionBudget(limit) {
  const initial = Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_ACTION_LIMIT;
  let cap = initial;
  let used = 0;
  return {
    check(tool) {
      const impacting = isImpactingAction(tool);
      return { impacting, allowed: !impacting || used < cap, used, limit: cap, remaining: Math.max(0, cap - used) };
    },
    consume(tool) {
      const status = this.check(tool);
      if (!status.impacting) return status;
      if (!status.allowed) return status;
      used += 1;
      return { impacting: true, allowed: true, used, limit: cap, remaining: Math.max(0, cap - used) };
    },
    extend(amount) {
      const extra = Number.isInteger(amount) && amount > 0 ? amount : DEFAULT_ACTION_EXTENSION;
      cap += extra;
      return { used, limit: cap, remaining: Math.max(0, cap - used), extendedBy: extra };
    },
    snapshot() { return { used, limit: cap, remaining: Math.max(0, cap - used) }; },
  };
}

function permissionDetail(tool, input, pageContext, budgetStatus) {
  const reasons = [];
  if (isSensitiveAction(tool, input, pageContext)) reasons.push('فعل حساس أو غير قابل للعكس — يلزم تأكيد هذه المرة فقط.');
  if (requiresExplicitApproval(tool)) reasons.push('تعبئة جماعية مرئية — راجع كل حقل وقيمته قبل السماح، ولن يُرسل النموذج.');
  const leakValue = leakValueForTool(tool, input);
  if (hasLeakRisk(leakValue)) reasons.push('رُصد خطر تسريب في الحمولة: ' + redactedExcerpt(leakValue));
  if (budgetStatus && budgetStatus.impacting && !budgetStatus.allowed) {
    reasons.push('بلغ الوكيل ميزانية أفعال المتصفح (' + budgetStatus.used + '/' + budgetStatus.limit + '). الموافقة تمددها ' + DEFAULT_ACTION_EXTENSION + ' فعلاً.');
  }
  return reasons.join('\n');
}

module.exports = {
  DEFAULT_ACTION_LIMIT,
  DEFAULT_ACTION_EXTENSION,
  LARGE_PAYLOAD_CHARS,
  bareToolName,
  isSensitiveAction,
  requiresExplicitApproval,
  hasLeakRisk,
  leakValueForTool,
  hasVisibleSecret,
  redactedExcerpt,
  safePermissionInput,
  isImpactingAction,
  createActionBudget,
  permissionDetail,
};
