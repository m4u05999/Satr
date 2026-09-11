'use strict';

// عقد أدوات التوصيلات واحد؛ الرموز لا تدخل أدوات المحرك أو نتائجه.
const { randomUUID } = require('crypto');

const NAMES = Object.freeze(['list_project_connections', 'use_project_connection']);
const SERVICES = Object.freeze(['github', 'netlify', 'supabase']);
const ACTIONS = Object.freeze(['inspect', 'list_issues', 'read_file', 'create_issue', 'list_deploys', 'trigger_build', 'list_tables']);
const PARAM_LIMITS = Object.freeze({ path: 1024, title: 256, body: 8000, ref: 256, state: 32, branch: 256 });
const DEFINITIONS = Object.freeze([
  { name: NAMES[0], description: 'List this project’s service connections, allowed resources and tested engine access. No credentials.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: NAMES[1], description: 'Use an allowed project resource. GitHub: inspect/list_issues/read_file/create_issue; Netlify: inspect/list_deploys/trigger_build; Supabase: inspect/list_tables. Mutations always ask the user. No tokens or arbitrary URLs.',
    inputSchema: { type: 'object', properties: {
      service: { type: 'string', enum: SERVICES }, resource: { type: 'string', minLength: 1, maxLength: 256 },
      action: { type: 'string', enum: ACTIONS },
      params: { type: 'object', properties: Object.fromEntries(Object.entries(PARAM_LIMITS)
        .map(([key, maxLength]) => [key, { type: 'string', maxLength }])), additionalProperties: false },
    }, required: ['service', 'resource', 'action'], additionalProperties: false } },
]);

function isActive(ctx, callCtx) {
  try {
    return !!ctx && typeof ctx.isActive === 'function' && ctx.isActive() === true
      && !(callCtx && (callCtx.aborted || callCtx.signal && callCtx.signal.aborted));
  } catch { return false; }
}

// حقول strict الاختيارية تصل null؛ تُطبّع فقط هذه القيم، وتبقى التنقية في النواة.
function requestArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const out = { ...args };
  if (out.params === null) delete out.params;
  else if (out.params && typeof out.params === 'object' && !Array.isArray(out.params)) {
    out.params = Object.fromEntries(Object.entries(out.params).filter(([, value]) => value !== null));
  }
  return out;
}

async function run(name, cwd, args, ctx, callCtx) {
  if (!NAMES.includes(name)) return { ok: false, content: 'أداة توصيل غير معروفة.' };
  if (!isActive(ctx, callCtx)) return { ok: false, content: 'انتهى الدور أو لا يدعم المحرك هذا المسار.' };
  try {
    // تحميل كسول: جرد الأدوات وحده لا يفتح مخزن الحسابات.
    const manager = ctx.manager || require('./connections').getManager();
    const active = () => isActive(ctx, callCtx);
    const result = name === NAMES[0]
      ? await manager.list(cwd, ctx.engine)
      : await manager.execute(cwd, requestArgs(args), {
        engine: ctx.engine, isActive: active,
        requestPermission: (input) => active() && typeof ctx.requestPermission === 'function'
          ? ctx.requestPermission(input, callCtx) : Promise.resolve(false),
      });
    if (!active()) {
      // لا تعرض نتيجة دور انتهى؛ احتفظ فقط بشهادة أثر الكتابة كي لا يُعاد.
      if (result && result.externalOutcome === 'succeeded' && result.retryable === false) {
        return { ok: false, content: JSON.stringify({ ok: false, error: 'inactive', externalOutcome: 'succeeded', retryable: false }) };
      }
      return { ok: false, content: 'أُلغي استخدام التوصيلة لانتهاء الدور.' };
    }
    return { ok: !!result && result.ok === true, content: JSON.stringify(result || { ok: false, error: 'service_failed' }) };
  } catch {
    // لا تُمرّر رسالة النقل الخام: قد تحمل ترويسة أو رمزاً.
    return { ok: false, content: 'تعذّر استخدام التوصيلة. راجع حالتها في /موصلات.' };
  }
}

function mcpTools(cwd, ctx) {
  return DEFINITIONS.map((definition) => ({
    ...definition,
    // الإذن في execute بعد فحص المورد؛ بوابة المتصفح العامة ليست سلطة التوصيلات.
    access: 'read',
    handler: async (args, callCtx) => {
      const context = typeof ctx === 'function' ? ctx() : ctx;
      const result = await run(definition.name, cwd, args, context, callCtx);
      return { content: [{ type: 'text', text: result.content }], isError: !result.ok };
    },
  }));
}

function sdkShape(z, name) {
  if (name === NAMES[0]) return {};
  return {
    service: z.enum(SERVICES), resource: z.string().min(1).max(256), action: z.enum(ACTIONS),
    params: z.object(Object.fromEntries(Object.entries(PARAM_LIMITS)
      .map(([key, limit]) => [key, z.string().max(limit).optional()]))).strict().optional(),
  };
}

// بوابة صريحة مستقلة عن bypass و«دائماً». كل إذن مرتبط بنداء ودور حيين.
function createPermissionGate({ emit, isActive: active }) {
  const pending = new Map();
  let closed = false;
  const alive = () => !closed && isActive({ isActive: active });
  const settle = (id, allow) => {
    const entry = pending.get(id);
    if (!entry) return false;
    pending.delete(id);
    if (entry.signal && entry.abort) entry.signal.removeEventListener('abort', entry.abort);
    entry.resolve(allow === true && alive());
    return true;
  };
  return {
    requestPermission(input, callCtx) {
      if (!alive() || !isActive({ isActive: active }, callCtx)) return Promise.resolve(false);
      const id = 'connection_' + randomUUID();
      return new Promise((resolve) => {
        const entry = { resolve, signal: callCtx && callCtx.signal };
        pending.set(id, entry);
        if (entry.signal && typeof entry.signal.addEventListener === 'function') {
          entry.abort = () => settle(id, false);
          entry.signal.addEventListener('abort', entry.abort, { once: true });
        }
        if (callCtx && callCtx.abortedPromise) callCtx.abortedPromise.then(() => settle(id, false));
        try {
          emit({ type: 'permission_request', id, tool: NAMES[1], input,
            detail: input.action === 'trigger_build'
              ? 'تشغيل بناء في موقع Netlify المحدد قد ينشر الموقع. إذا لم يحدد فرع فقد ينشر فرع الإنتاج. الموافقة لهذا النداء وحده.'
              : 'إنشاء قضية في مستودع GitHub المحدد بالنص المعروض. الموافقة لهذا النداء وحده.',
            turnEligible: false, alwaysEligible: false });
        } catch { settle(id, false); }
      });
    },
    resolvePermission(id, allow) { return settle(id, allow); },
    stop() {
      closed = true;
      for (const id of pending.keys()) settle(id, false);
    },
  };
}

module.exports = { NAMES, DEFINITIONS, run, mcpTools, sdkShape, createPermissionGate };
