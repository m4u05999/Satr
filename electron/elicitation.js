'use strict';

const { randomUUID } = require('crypto');
const memory = require('./memory');

const SAFE_ID = /^el_[a-f0-9]{32}$/;
const MAX_FIELDS = 20;
const MAX_FIELD_NAME = 160;
const MAX_FIELD_LABEL = 400;
const MAX_FIELD_VALUE = 2000;
const MAX_SERVER_NAME = 160;
const MAX_URL = 2048;
const MAX_ELICITATION_ID = 256;
const CONTROL_BIDI_RE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const CONTROL_BIDI_TEST_RE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const SECRET_FIELD_RE = /(?:^|[^a-z0-9])(?:password|passwd|pwd|passphrase|token|key|secret|credential)(?=$|[^a-z0-9])/i;
const SECRET_FIELD_COMPACT_RE = /password|passwd|pwd|passphrase|token|key|secret|credential/i;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SECRET_REJECTION_MESSAGE = 'رُفض طلب إدخال حساس من موصّل Claude. أكمل المصادقة عبر /mcp في Claude Code أو استخدم browser_handoff؛ لا ترسل كلمة مرور أو رمزاً أو مفتاحاً في المحادثة.';
const UNSUPPORTED_REJECTION_MESSAGE = 'تعذّر عرض طلب إدخال موصّل Claude بأمان، فرُفض الطلب. حدّث Claude Code أو أكمل إعداد الموصّل عبر /mcp.';

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return Array.from(value
    .replace(CONTROL_BIDI_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim())
    .slice(0, maxLength)
    .join('');
}

function safeUrl(value) {
  if (typeof value !== 'string' || CONTROL_BIDI_TEST_RE.test(value)) return '';
  const raw = value.trim();
  if (!raw || Array.from(raw).length > MAX_URL || /\s/.test(raw)) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.username || parsed.password) return '';
    const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) return '';
    const normalized = parsed.href;
    return Array.from(normalized).length <= MAX_URL ? normalized : '';
  } catch {
    return '';
  }
}

function fieldMetadataHasSecret(...values) {
  return values
    .filter((value) => typeof value === 'string')
    .some((raw) => {
      const withoutControls = raw.replace(CONTROL_BIDI_RE, '');
      const separated = withoutControls
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2');
      const compact = withoutControls.replace(/[^a-z0-9]/gi, '');
      return memory.hasSecret(raw)
        || memory.hasSecret(withoutControls)
        || SECRET_FIELD_RE.test(separated)
        || SECRET_FIELD_COMPACT_RE.test(compact);
    });
}

function sanitizeElicitationRequest(request) {
  if (!isPlainRecord(request)) return { ok: false, error: 'bad_request' };
  if (typeof request.serverName !== 'string') return { ok: false, error: 'bad_server' };
  if (memory.hasSecret(request.serverName)) return { ok: false, error: 'secret' };
  const server = cleanText(request.serverName, MAX_SERVER_NAME);
  if (!server) return { ok: false, error: 'bad_server' };
  const mode = request.mode == null || request.mode === 'form'
    ? 'form'
    : request.mode === 'url' ? 'url' : '';
  if (!mode) return { ok: false, error: 'bad_mode' };

  if (mode === 'url') {
    if (typeof request.elicitationId !== 'string'
      || !request.elicitationId
      || Array.from(request.elicitationId).length > MAX_ELICITATION_ID
      || CONTROL_BIDI_TEST_RE.test(request.elicitationId)) {
      return { ok: false, error: 'bad_elicitation_id' };
    }
    const url = safeUrl(request.url);
    if (!url) return { ok: false, error: 'bad_url' };
    return {
      ok: true,
      server,
      mode,
      fields: [],
      fieldMap: new Map(),
      url,
      urlKey: JSON.stringify([request.serverName, request.elicitationId]),
    };
  }

  if (fieldMetadataHasSecret(request.message, request.title, request.displayName, request.description)) {
    return { ok: false, error: 'secret' };
  }
  const schema = request.requestedSchema;
  if (!isPlainRecord(schema) || schema.type !== 'object' || !isPlainRecord(schema.properties)) {
    return { ok: false, error: 'bad_schema' };
  }
  const propertyNames = Object.keys(schema.properties);
  if (!propertyNames.length || propertyNames.length > MAX_FIELDS) {
    return { ok: false, error: 'bad_field_count' };
  }

  const fields = [];
  const fieldMap = new Map();
  for (const originalName of propertyNames) {
    const definition = schema.properties[originalName];
    if (!isPlainRecord(definition) || definition.type !== 'string') {
      return { ok: false, error: 'unsupported_field_type' };
    }
    if (definition.title != null && typeof definition.title !== 'string') {
      return { ok: false, error: 'bad_field_title' };
    }
    if (definition.description != null && typeof definition.description !== 'string') {
      return { ok: false, error: 'bad_field_description' };
    }
    if (fieldMetadataHasSecret(originalName, definition.title, definition.description)) {
      return { ok: false, error: 'secret' };
    }
    const name = cleanText(originalName, MAX_FIELD_NAME);
    if (!name || DANGEROUS_KEYS.has(name) || fieldMap.has(name)) {
      return { ok: false, error: 'bad_field_name' };
    }
    const title = cleanText(definition.title, 160);
    const description = cleanText(definition.description, 300);
    const label = cleanText([title, description].filter(Boolean).join(' — '), MAX_FIELD_LABEL);
    fields.push(label ? { name, label } : { name });
    fieldMap.set(name, originalName);
  }
  return { ok: true, server, mode, fields, fieldMap, url: '', urlKey: '' };
}

function sanitizeRendererContent(value) {
  if (!isPlainRecord(value)) return { ok: false, error: 'bad_content' };
  const entries = Object.entries(value);
  if (entries.length > MAX_FIELDS) return { ok: false, error: 'too_many_fields' };
  const content = Object.create(null);
  for (const [rawName, rawValue] of entries) {
    if (typeof rawValue !== 'string') return { ok: false, error: 'bad_value' };
    const name = cleanText(rawName, MAX_FIELD_NAME);
    if (!name || DANGEROUS_KEYS.has(name) || Object.prototype.hasOwnProperty.call(content, name)) {
      return { ok: false, error: 'bad_field_name' };
    }
    const text = cleanText(rawValue, MAX_FIELD_VALUE);
    if (memory.hasSecret(text)) return { ok: false, error: 'secret' };
    content[name] = text;
  }
  return { ok: true, content };
}

function createElicitationController(options) {
  const emit = options && typeof options.emit === 'function' ? options.emit : () => {};
  const pending = new Map();
  const urlStates = new Map();
  let closed = false;

  function emitSafeMessage(text) {
    try { emit({ type: 'stderr', text }); } catch { /* العرض لا يكسر رفض الطلب */ }
  }

  function settle(entry, result) {
    if (!entry || pending.get(entry.id) !== entry) return false;
    pending.delete(entry.id);
    if (entry.signal && entry.abortHandler) {
      try { entry.signal.removeEventListener('abort', entry.abortHandler); } catch { /* انتهت الإشارة */ }
    }
    const finalResult = result && result.action === 'accept'
      ? (result.content ? { action: 'accept', content: result.content } : { action: 'accept' })
      : { action: 'decline' };
    if (entry.urlKey) urlStates.set(entry.urlKey, { url: entry.url, result: finalResult });
    entry.resolve(finalResult);
    return true;
  }

  function waitForSharedResult(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.resolve({ action: 'decline' });
    return new Promise((resolve) => {
      let finished = false;
      const finish = (result) => {
        if (finished) return;
        finished = true;
        try { signal.removeEventListener('abort', onAbort); } catch { /* انتهت الإشارة */ }
        resolve(result);
      };
      const onAbort = () => finish({ action: 'decline' });
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(finish, () => finish({ action: 'decline' }));
    });
  }
  async function handle(request, callbackOptions) {
    if (closed) return { action: 'decline' };
    const prepared = sanitizeElicitationRequest(request);
    if (!prepared.ok) {
      emitSafeMessage(prepared.error === 'secret' ? SECRET_REJECTION_MESSAGE : UNSUPPORTED_REJECTION_MESSAGE);
      return { action: 'decline' };
    }
    const signal = callbackOptions && callbackOptions.signal;
    if (signal && signal.aborted) return { action: 'decline' };
    if (prepared.urlKey) {
      const existing = urlStates.get(prepared.urlKey);
      if (existing && existing.url !== prepared.url) {
        emitSafeMessage(UNSUPPORTED_REJECTION_MESSAGE);
        return { action: 'decline' };
      }
      if (existing && existing.result) return existing.result;
      if (existing && existing.promise) return waitForSharedResult(existing.promise, signal);
    }

    const id = 'el_' + randomUUID().replace(/-/g, '');
    let resolvePromise;
    const promise = new Promise((resolve) => { resolvePromise = resolve; });
    const entry = {
      id,
      server: prepared.server,
      mode: prepared.mode,
      fields: prepared.fields,
      fieldMap: prepared.fieldMap,
      url: prepared.url,
      urlKey: prepared.urlKey,
      signal,
      abortHandler: null,
      resolve: resolvePromise,
    };
    pending.set(id, entry);
    if (prepared.urlKey) urlStates.set(prepared.urlKey, { url: prepared.url, promise });
    if (signal) {
      entry.abortHandler = () => { settle(entry, { action: 'decline' }); };
      signal.addEventListener('abort', entry.abortHandler, { once: true });
    }
    const event = {
      type: 'elicitation_request',
      id,
      server: prepared.server,
      mode: prepared.mode,
      fields: prepared.fields.map((field) => ({ ...field })),
    };
    if (prepared.mode === 'url') event.url = prepared.url;
    try { emit(event); }
    catch { settle(entry, { action: 'decline' }); }
    return promise;
  }

  function resolve(id, action, content) {
    if (!SAFE_ID.test(String(id || '')) || (action !== 'accept' && action !== 'decline')) {
      return { ok: false, error: 'bad_reply' };
    }
    const entry = pending.get(id);
    if (!entry) return { ok: false, error: 'not_pending' };
    if (action === 'decline') {
      settle(entry, { action: 'decline' });
      return { ok: true };
    }
    if (entry.mode === 'url') {
      if (content !== undefined) return { ok: false, error: 'unexpected_content' };
      settle(entry, { action: 'accept' });
      return { ok: true };
    }

    const cleaned = sanitizeRendererContent(content);
    if (!cleaned.ok) {
      if (cleaned.error === 'secret') {
        emitSafeMessage(SECRET_REJECTION_MESSAGE);
        settle(entry, { action: 'decline' });
        return { ok: true, declined: true, error: 'secret' };
      }
      return { ok: false, error: cleaned.error };
    }
    const sdkContent = {};
    for (const [publicName, value] of Object.entries(cleaned.content)) {
      const originalName = entry.fieldMap.get(publicName);
      if (!originalName) return { ok: false, error: 'unknown_field' };
      sdkContent[originalName] = value;
    }
    settle(entry, { action: 'accept', content: sdkContent });
    return { ok: true };
  }

  function peek(id) {
    if (!SAFE_ID.test(String(id || ''))) return null;
    const entry = pending.get(id);
    return entry ? { mode: entry.mode, url: entry.url } : null;
  }

  function declineAll() {
    if (closed) return;
    closed = true;
    for (const entry of Array.from(pending.values())) settle(entry, { action: 'decline' });
    urlStates.clear();
  }

  return {
    handle,
    resolve,
    peek,
    declineAll,
    pendingCount: () => pending.size,
  };
}

module.exports = {
  SAFE_ID,
  MAX_FIELDS,
  MAX_FIELD_VALUE,
  SECRET_REJECTION_MESSAGE,
  UNSUPPORTED_REJECTION_MESSAGE,
  cleanText,
  safeUrl,
  sanitizeElicitationRequest,
  sanitizeRendererContent,
  createElicitationController,
};
