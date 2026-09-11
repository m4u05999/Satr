/**
 * توصيلات الخدمات الأساسية — طلبات ثابتة من العملية الرئيسية بلا SDK إضافي.
 * الرموز لا تُحفظ هنا. ملكية المشروع والموافقة على الأثر مسؤولية connections.js.
 * حدود النقل وإعادة التوجيه وهوية المورد تُفحص ثانيةً هنا قبل إرجاع أي بيانات.
 */
'use strict';

const { scrubSecrets } = require('./secretscrub');

const BODY_LIMIT = 2 * 1024 * 1024;
const FILE_LIMIT = 64 * 1024;
const TEXT_LIMIT = 32000;
const PAGE_SIZE = 100;
const PAGE_LIMIT = 3;
const REQUEST_TIMEOUT = 15000;
const ORIGINS = Object.freeze({
  github: 'https://api.github.com',
  netlify: 'https://api.netlify.com',
  supabase: 'https://api.supabase.com',
});
const MESSAGES = Object.freeze({
  auth_expired: 'انتهت المصادقة أو لم يعد الرمز صالحاً. أعد ربط الحساب.',
  forbidden: 'الخدمة لا تسمح بهذا الإجراء أو بهذه الصلاحية.',
  not_found: 'المورد غير متاح للحساب المتصل.',
  network: 'تعذر الاتصال بالخدمة. حاول لاحقاً.',
  invalid_response: 'رد الخدمة غير صالح للاستخدام الآمن.',
  bad_input: 'مدخلات التوصيلة غير صالحة.',
});
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const PROJECT_REF = /^[a-z]{20}$/;
const REPOSITORY = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9_.-]{1,100}$/i;
const TABLES_QUERY = "SELECT table_schema, table_name FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_schema, table_name LIMIT 101";

class ServiceError extends Error {
  constructor(code) {
    super(MESSAGES[code] || MESSAGES.invalid_response);
    this.code = Object.hasOwn(MESSAGES, code) ? code : 'invalid_response';
  }
}
function fail(code) { throw new ServiceError(code); }
function record(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function tokenValue(token) {
  if (typeof token !== 'string' || token.length < 8 || token.length > 4096 || /[^\x21-\x7e]/.test(token)) fail('bad_input');
  return token;
}
function resourceValue(service, value) {
  if (typeof value !== 'string') fail('bad_input');
  const valid = service === 'github' ? REPOSITORY.test(value) && !['.', '..'].includes(value.split('/')[1])
    : service === 'netlify' ? UUID.test(value) : service === 'supabase' && PROJECT_REF.test(value);
  if (!valid) fail('bad_input');
  return value;
}
function safeText(value, token, limit = 500) {
  if (typeof value !== 'string') return '';
  // الحجب قبل القص حتى لا تبقى مقدمة سر قطعها سقف العرض.
  const exact = value.split(token).join('[secret]');
  return scrubSecrets(exact)
    .replace(/\b(?:github_pat_|sbp_|nfp_)[A-Za-z0-9_]{16,}\b/g, '[secret]')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .slice(0, limit);
}
function safeUrl(value, token) {
  if (typeof value !== 'string' || value.length > 2048 || safeText(value, token, 2048) !== value) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return '';
    url.search = '';
    url.hash = '';
    return url.href;
  } catch { return ''; }
}
function objectParams(params, allowed) {
  if (!record(params) || Object.keys(params).some((key) => !allowed.includes(key))) fail('bad_input');
  return params;
}
function branchValue(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._/-]{0,199}$/i.test(value)
    || value.includes('..') || value.endsWith('/') || value.includes('//')) fail('bad_input');
  return value;
}
function filePath(value) {
  if (typeof value !== 'string' || value.length > 512 || !/^[\p{L}\p{M}\p{N}_.@() -]+(?:\/[\p{L}\p{M}\p{N}_.@() -]+)*$/u.test(value)
    || value.split('/').some((part) => part === '.' || part === '..' || !part.trim())) fail('bad_input');
  return value;
}
function requiredString(value, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(value)) fail('bad_input');
  return value;
}
function validResponseResource(service, value) {
  try { return resourceValue(service, value); } catch { fail('invalid_response'); }
}
function compareResource(service, expected, actual) {
  validResponseResource(service, actual);
  if (expected.toLowerCase() !== actual.toLowerCase()) fail('invalid_response');
}
function requireRecord(value) { if (!record(value)) fail('invalid_response'); return value; }
function requireArray(value) { if (!Array.isArray(value)) fail('invalid_response'); return value; }

function createServices({ fetchImpl = globalThis.fetch, requestTimeoutMs = REQUEST_TIMEOUT } = {}) {
  if (typeof fetchImpl !== 'function') fail('bad_input');
  const timeoutMs = Number.isInteger(requestTimeoutMs) && requestTimeoutMs >= 10 && requestTimeoutMs <= REQUEST_TIMEOUT
    ? requestTimeoutMs : REQUEST_TIMEOUT;

  async function request(service, token, pathname, { method = 'GET', body, control } = {}) {
    tokenValue(token);
    // يتحقق المالك قبل كل طلب، خاصةً بعد انتظار قراءة سبقت فعلاً مؤثراً.
    if (control && typeof control.assertActive === 'function') control.assertActive();
    const url = ORIGINS[service] + pathname;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let reader;
    let response;
    try {
      const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json', 'User-Agent': 'satr' };
      if (service === 'github') {
        headers.Accept = 'application/vnd.github+json';
        headers['X-GitHub-Api-Version'] = '2026-03-10';
      }
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      response = await fetchImpl(url, {
        method, headers, redirect: 'error', signal: controller.signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response || response.redirected || (response.url && response.url !== url)) fail('invalid_response');
      if (response.status === 401) fail('auth_expired');
      if (response.status === 403) fail('forbidden');
      if (response.status === 404) fail('not_found');
      if (response.status >= 500 || response.status === 429 || response.status === 408) fail('network');
      if (response.status < 200 || response.status >= 300) fail('invalid_response');
      if (!response.headers || !/^(?:application\/json|application\/[^;]+\+json)(?:;|$)/i.test(response.headers.get('content-type') || '')) fail('invalid_response');
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > BODY_LIMIT)) fail('invalid_response');
      if (!response.body || typeof response.body.getReader !== 'function') fail('invalid_response');
      reader = response.body.getReader();
      const chunks = [];
      let bytes = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (!(chunk.value instanceof Uint8Array)) fail('invalid_response');
        bytes += chunk.value.byteLength;
        if (bytes > BODY_LIMIT) fail('invalid_response');
        chunks.push(Buffer.from(chunk.value));
      }
      let data;
      try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { fail('invalid_response'); }
      return { data, hasNext: /;\s*rel=["']?next\b/i.test(response.headers.get('link') || '') };
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      fail('network');
    } finally {
      clearTimeout(timer);
      controller.abort();
      try {
        if (reader) await reader.cancel();
        else if (response && response.body) await response.body.cancel();
      } catch {}
    }
  }

  // لا نتبع عنوان Link القادم من الشبكة؛ رقم الصفحة فقط يولّد محلياً.
  async function paged(service, token, pathname, projectRow, control) {
    const resources = [];
    let truncated = false;
    for (let page = 1; page <= PAGE_LIMIT; page += 1) {
      const sep = pathname.includes('?') ? '&' : '?';
      const result = await request(service, token, pathname + sep + 'per_page=' + PAGE_SIZE + '&page=' + page, { control });
      const rows = requireArray(result.data);
      if (rows.length > PAGE_SIZE) fail('invalid_response');
      for (const row of rows) resources.push(projectRow(requireRecord(row)));
      const more = result.hasNext || rows.length === PAGE_SIZE;
      if (!more) break;
      if (page === PAGE_LIMIT) truncated = true;
    }
    return { resources, truncated };
  }

  async function githubInspect(token, resourceId, control) {
    resourceValue('github', resourceId);
    const data = requireRecord((await request('github', token, '/repos/' + resourceId, { control })).data);
    compareResource('github', resourceId, data.full_name);
    if (!Number.isSafeInteger(data.id) || data.id <= 0) fail('invalid_response');
    return {
      id: safeText(resourceId, token), repositoryId: data.id, label: safeText(data.full_name, token),
      description: safeText(data.description, token, 1000), private: data.private === true,
      defaultBranch: safeText(data.default_branch, token, 200),
      url: safeUrl('https://github.com/' + resourceId, token),
    };
  }
  const github = {
    id: 'github', label: 'GitHub', loginUrl: 'https://github.com/settings/personal-access-tokens/new',
    actions: { inspect: { write: false }, list_issues: { write: false }, read_file: { write: false }, create_issue: { write: true } },
    async authenticate(token) {
      const data = requireRecord((await request('github', token, '/user')).data);
      if (!Number.isSafeInteger(data.id) || data.id <= 0 || typeof data.login !== 'string' || !data.login) fail('invalid_response');
      return { id: safeText(String(data.id), token, 100), label: safeText(data.login, token, 200) };
    },
    listResources(token) {
      return paged('github', token, '/user/repos', (row) => ({
        id: safeText(validResponseResource('github', row.full_name), token), label: safeText(row.full_name, token),
      }));
    },
    inspect: githubInspect,
    async run(token, resourceId, action, params = {}, control = {}) {
      tokenValue(token);
      if (typeof action !== 'string') fail('bad_input');
      resourceValue('github', resourceId);
      if (!Object.hasOwn(github.actions, action)) fail('bad_input');
      if (action === 'inspect') {
        objectParams(params, []);
        return githubInspect(token, resourceId, control);
      }
      if (action === 'list_issues') {
        objectParams(params, ['state']);
        const state = params.state === undefined ? 'open' : params.state;
        if (!['open', 'closed', 'all'].includes(state)) fail('bad_input');
        await githubInspect(token, resourceId, control);
        const page = await paged('github', token, '/repos/' + resourceId + '/issues?state=' + state, (row) => {
          if (!Number.isSafeInteger(row.number) || row.number <= 0
            || row.repository_url !== ORIGINS.github + '/repos/' + resourceId) fail('invalid_response');
          return {
            number: row.number, title: safeText(row.title, token, 500), body: safeText(row.body, token, 2000),
            state: safeText(row.state, token, 30), isPullRequest: record(row.pull_request),
            url: safeUrl('https://github.com/' + resourceId + '/issues/' + row.number, token),
          };
        }, control);
        return { issues: page.resources, truncated: page.truncated };
      }
      if (action === 'create_issue') {
        objectParams(params, ['title', 'body']);
        const title = requiredString(params.title, 256);
        const body = params.body === undefined ? '' : params.body;
        if (typeof body !== 'string' || body.length > 10000 || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(body)) fail('bad_input');
        if (title.includes(token) || body.includes(token)) fail('bad_input');
        await githubInspect(token, resourceId, control);
        const row = requireRecord((await request('github', token, '/repos/' + resourceId + '/issues', { method: 'POST', body: { title, body }, control })).data);
        if (!Number.isSafeInteger(row.number) || row.number <= 0
          || row.repository_url !== ORIGINS.github + '/repos/' + resourceId) fail('invalid_response');
        return { number: row.number, title: safeText(row.title, token, 500), url: safeUrl('https://github.com/' + resourceId + '/issues/' + row.number, token) };
      }
      objectParams(params, ['path', 'ref']);
      const path = filePath(params.path);
      const ref = params.ref === undefined ? '' : branchValue(params.ref);
      await githubInspect(token, resourceId, control);
      const endpoint = '/repos/' + resourceId + '/contents/' + path.split('/').map(encodeURIComponent).join('/')
        + (ref ? '?ref=' + encodeURIComponent(ref) : '');
      const data = requireRecord((await request('github', token, endpoint, { control })).data);
      if (data.type !== 'file' || data.path !== path || data.encoding !== 'base64'
        || typeof data.content !== 'string' || !Number.isSafeInteger(data.size) || data.size < 0 || data.size > FILE_LIMIT) fail('invalid_response');
      const encoded = data.content.replace(/\n/g, '');
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) fail('invalid_response');
      const buffer = Buffer.from(encoded, 'base64');
      if (buffer.length !== data.size || buffer.length > FILE_LIMIT) fail('invalid_response');
      let content;
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { fail('invalid_response'); }
      if (content.includes('\0')) fail('invalid_response');
      const clean = safeText(content, token, FILE_LIMIT);
      return { path: safeText(path, token, 512), ref: safeText(ref, token, 200), content: clean.slice(0, TEXT_LIMIT), truncated: clean.length > TEXT_LIMIT };
    },
  };

  async function netlifyInspect(token, resourceId, control) {
    resourceValue('netlify', resourceId);
    const data = requireRecord((await request('netlify', token, '/api/v1/sites/' + resourceId, { control })).data);
    compareResource('netlify', resourceId, data.id);
    // لا تمرر password أو session_id أو build_settings أو كائن الموقع الخام.
    return { id: safeText(resourceId, token), label: safeText(data.name, token), state: safeText(data.state, token, 80), url: safeUrl(data.ssl_url || data.url, token) };
  }
  const netlify = {
    id: 'netlify', label: 'Netlify', loginUrl: 'https://app.netlify.com/user/applications',
    actions: { inspect: { write: false }, list_deploys: { write: false }, trigger_build: { write: true } },
    async authenticate(token) {
      const data = requireRecord((await request('netlify', token, '/api/v1/user')).data);
      if (typeof data.id !== 'string' || !data.id || data.id.length > 100) fail('invalid_response');
      return { id: safeText(data.id, token, 100), label: safeText(data.full_name || data.email, token, 200) };
    },
    listResources(token) {
      return paged('netlify', token, '/api/v1/sites', (row) => ({
        id: safeText(validResponseResource('netlify', row.id), token), label: safeText(row.name, token),
      }));
    },
    inspect: netlifyInspect,
    async run(token, resourceId, action, params = {}, control = {}) {
      tokenValue(token);
      if (typeof action !== 'string') fail('bad_input');
      resourceValue('netlify', resourceId);
      if (!Object.hasOwn(netlify.actions, action)) fail('bad_input');
      objectParams(params, action === 'trigger_build' ? ['branch'] : []);
      const branch = action === 'trigger_build' && params.branch !== undefined ? branchValue(params.branch) : '';
      const site = await netlifyInspect(token, resourceId, control);
      if (action === 'inspect') return site;
      if (action === 'list_deploys') {
        const page = await paged('netlify', token, '/api/v1/sites/' + resourceId + '/deploys', (row) => {
          compareResource('netlify', resourceId, row.site_id);
          if (typeof row.id !== 'string' || !row.id) fail('invalid_response');
          return {
            id: safeText(row.id, token, 100), siteId: safeText(resourceId, token), state: safeText(row.state, token, 80),
            branch: safeText(row.branch, token, 200), createdAt: safeText(row.created_at, token, 40),
            url: safeUrl(row.deploy_ssl_url || row.ssl_url, token),
          };
        }, control);
        return { deploys: page.resources, truncated: page.truncated };
      }
      const endpoint = '/api/v1/sites/' + resourceId + '/builds' + (branch ? '?branch=' + encodeURIComponent(branch) : '');
      const data = requireRecord((await request('netlify', token, endpoint, { method: 'POST', control })).data);
      if (typeof data.id !== 'string' || !data.id) fail('invalid_response');
      return { id: safeText(data.id, token, 100), siteId: safeText(resourceId, token), deployId: safeText(data.deploy_id, token, 100), done: data.done === true, createdAt: safeText(data.created_at, token, 40) };
    },
  };

  async function supabaseInspect(token, resourceId, control) {
    resourceValue('supabase', resourceId);
    const data = requireRecord((await request('supabase', token, '/v1/projects/' + resourceId, { control })).data);
    compareResource('supabase', resourceId, data.ref || data.id);
    return { id: safeText(resourceId, token), label: safeText(data.name, token), region: safeText(data.region, token, 80), status: safeText(data.status, token, 80) };
  }
  const supabase = {
    id: 'supabase', label: 'Supabase', loginUrl: 'https://supabase.com/dashboard/account/tokens',
    actions: { inspect: { write: false }, list_tables: { write: false } },
    async authenticate(token) {
      const data = requireRecord((await request('supabase', token, '/v1/profile')).data);
      if (typeof data.gotrue_id !== 'string' || !UUID.test(data.gotrue_id)) fail('invalid_response');
      return { id: safeText(data.gotrue_id, token, 100), label: safeText(data.username || data.primary_email, token, 200) };
    },
    async listResources(token) {
      const data = requireArray((await request('supabase', token, '/v1/projects')).data);
      const resources = data.slice(0, PAGE_SIZE * PAGE_LIMIT).map((row) => {
        requireRecord(row);
        return { id: safeText(validResponseResource('supabase', row.ref || row.id), token), label: safeText(row.name, token) };
      });
      return { resources, truncated: data.length > resources.length };
    },
    inspect: supabaseInspect,
    async run(token, resourceId, action, params = {}, control = {}) {
      tokenValue(token);
      if (typeof action !== 'string') fail('bad_input');
      resourceValue('supabase', resourceId);
      if (!Object.hasOwn(supabase.actions, action)) fail('bad_input');
      objectParams(params, []);
      const project = await supabaseInspect(token, resourceId, control);
      if (action === 'inspect') return project;
      const data = requireArray((await request('supabase', token, '/v1/projects/' + resourceId + '/database/query/read-only', {
        method: 'POST', body: { query: TABLES_QUERY }, control,
      })).data);
      if (data.length > 101) fail('invalid_response');
      return {
        tables: data.slice(0, 100).map((row) => {
          requireRecord(row);
          if (typeof row.table_schema !== 'string' || typeof row.table_name !== 'string') fail('invalid_response');
          return { schema: safeText(row.table_schema, token, 200), name: safeText(row.table_name, token, 200) };
        }),
        truncated: data.length > 100,
      };
    },
  };
  for (const service of [github, netlify, supabase]) {
    for (const action of Object.values(service.actions)) Object.freeze(action);
    Object.freeze(service.actions);
    Object.freeze(service);
  }
  return Object.freeze({ github, netlify, supabase });
}

module.exports = { createServices, ServiceError, resourceValue };
