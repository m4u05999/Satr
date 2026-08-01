/**
 * نواة توليد الوسائط في «سطر» (م١ من docs/GENERATION-PLAN.md — الجولة 8، البند الأول).
 *
 * سجل مزوّدين بطبقتين (مباشر: openai/gemini · مجمّع: fal) + كتالوج أسعار تقديري مؤرخ
 * + توجيه أرخص-أولاً حسب المفاتيح المتوفرة مع سقوط صريح + تنزيل الأصول إلى
 * `<cwd>/generations/` + سجل JSONL في `<cwd>/.satr/generations.jsonl`.
 *
 * ⚠️ «المسبار أولاً» (المبدأ 5 في الخطة): لا يُجمَّد عقد سلك قبل استدعاء حيّ يثبته.
 * `scripts/genmedia-probe.js` شُغّل حياً 2026-08-01 والنتيجة:
 *   • fal  — PROVEN (صورة + فيديو عبر queue). عقده مجمَّد أدناه حرفياً كما رُصد.
 *   • openai — UNPROVEN: المفتاح صالح والمسار يُقبل، لكن الحساب ردّ 400
 *     `billing_hard_limit_reached` ("Billing hard limit has been reached.") فلم تُرصد
 *     بنية استجابة ناجحة قط.
 *   • gemini — UNPROVEN: المسار يُقبل، لكن الحساب ردّ 429 `RESOURCE_EXHAUSTED` مع
 *     `limit: 0` على `generate_content_free_tier_requests` (توليد الصور خارج الطبقة
 *     المجانية) فلم تُرصد بنية استجابة ناجحة قط.
 * لذلك المزوّدان المباشران **معرَّفان في السجل ومعطَّلان** ولا يملكان مسار سلك: التوجيه
 * لا يختارهما، واختيارهما صراحةً يعيد `provider_unproven` fail-closed. لا كود تخميني
 * يدّعي عقداً لم يُرصد. بعد إصلاح الحساب: أعد المسبار ⇒ جمِّد الشكل المرصود ⇒ فعّلهما.
 *
 * 🔒 المفاتيح: بيئة النظام أولاً ثم مخزن «سطر» (keys.get) — لا تدخل نتيجةً أو حدثاً أو
 * سجلاً أبداً، ولا تُطبع في رسالة خطأ. البرومبت في السجل ≤2000 نقطة بعد التنقية، وإن
 * التقطه memory.hasSecret يُخزَّن فارغاً بعلامة `prompt_redacted`.
 *
 * 💰 `budget_usd` سقف صلب: التقدير الذي يتجاوزه يُرفض بـ`over_budget` **قبل أي استدعاء
 * شبكة**، لا أثناءه.
 *
 * صفر اعتماديات: https المدمجة (نمط adapters/gemini.js) — القاعدة 5.
 */

'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const memory = require('./memory'); // hasSecret — حارس الأسرار المشترك
const inject = require('./inject'); // resolveInside — تحقّق المسارات النسبية داخل cwd

// ============================ الحدود والثوابت ============================

const SCHEMA_VERSION = 1;
const CATALOG_DATE = '2026-08-01'; // تاريخ الكتالوج — كل سعر تقديري منسوب إليه

const MAX_PROMPT_SEND = 4000;      // أقصى برومبت يُرسل للمزوّد (نقاط Unicode)
const MAX_PROMPT_LOG = 2000;       // أقصى برومبت يُخزَّن في السجل (نصّ العقد)
const MAX_REFS = 6;                // سقف المراجع (نصّ العقد)
const MAX_COUNT = 4;               // سقف العدد في الطلب الواحد (نصّ عقد الأداة)
const MAX_ASSET_BYTES = 64 * 1024 * 1024; // سقف حجم الأصل الواحد المنزَّل
const LOG_MAX_BYTES = 4 * 1024 * 1024;    // سقف ملف السجل (نصّ العقد) — يُقصّ الأقدم
const LOG_TRIM_TO = Math.floor(LOG_MAX_BYTES * 0.75);

const SUBMIT_TIMEOUT_MS = 120000;
const POLL_INTERVAL_MS = 3000;
const POLL_BUDGET_IMAGE_MS = 300000;
const POLL_BUDGET_VIDEO_MS = 900000;
const ASSET_TIMEOUT_MS = 180000;

const KINDS = new Set(['image', 'video']); // الصوت خارج ج8 صراحةً

// امتدادات الأصول المسموحة (تُشتق من content-type لا من رابط المزوّد)
const EXT_BY_TYPE = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/webp': '.webp',
  'video/mp4': '.mp4', 'video/webm': '.webm',
};

// ============================ كتالوج النماذج (تقديري ومؤرَّخ) ============================
/**
 * `unit_cost_usd` تقديري بتاريخ CATALOG_DATE — لا يُنسب إلى فاتورة المزوّد.
 * `proven` يعكس مسبارَ 2026-08-01 حصراً؛ غير المثبت لا يدخل التوجيه.
 */
const MODELS = [
  {
    id: 'fal-ai/flux/schnell',
    provider: 'fal',
    kind: 'image',
    label: 'FLUX schnell — صور سريعة رخيصة (fal)',
    unit: 'image',
    unit_cost_usd: 0.003,
    max_count: 4,
    supports_refs: false,
    proven: true,
    // مجمَّد من المسبار: image_size=square_hd أعاد 1024×1024 image/jpeg
    wire: { image_size: 'square_hd' },
  },
  {
    id: 'fal-ai/ltx-video',
    provider: 'fal',
    kind: 'video',
    label: 'LTX Video — فيديو قصير رخيص (fal)',
    unit: 'video',
    unit_cost_usd: 0.04,
    max_count: 1,
    supports_refs: false,
    proven: true,
    wire: {},
  },
  {
    id: 'gpt-image-1-mini',
    provider: 'openai',
    kind: 'image',
    label: 'GPT Image mini (OpenAI — غير مثبت)',
    unit: 'image',
    unit_cost_usd: 0.005,
    max_count: 4,
    supports_refs: false,
    proven: false,
    unproven_reason: 'billing_hard_limit_reached',
  },
  {
    id: 'gemini-2.5-flash-image',
    provider: 'gemini',
    kind: 'image',
    label: 'Nano Banana (Gemini — غير مثبت)',
    unit: 'image',
    unit_cost_usd: 0.039,
    max_count: 4,
    supports_refs: false,
    proven: false,
    unproven_reason: 'free_tier_quota_zero',
  },
];

// ============================ سجل المزوّدين ============================
const PROVIDERS = [
  {
    name: 'fal',
    tier: 'aggregator',
    label: 'fal.ai',
    keyName: 'FAL_KEY',
    enabled: true,
    proven: true,
    baseUrl: 'https://queue.fal.run',
    assetHosts: ['fal.media'], // الأصول تُجلب من هذا النطاق حصراً (أو نطاقاته الفرعية)
  },
  {
    name: 'openai',
    tier: 'direct',
    label: 'OpenAI (مباشر)',
    keyName: 'OPENAI_API_KEY',
    enabled: false,
    proven: false,
    unproven: {
      code: 'billing_hard_limit_reached',
      probed_at: '2026-08-01',
      note: 'المفتاح مقبول والمسار صحيح، لكن الحساب ردّ 400 قبل أي توليد. ارفع حد الإنفاق '
        + 'أو أضِف رصيداً في platform.openai.com ثم أعد تشغيل المسبار.',
    },
  },
  {
    name: 'gemini',
    tier: 'direct',
    label: 'Google Gemini (مباشر)',
    keyName: 'GEMINI_API_KEY',
    enabled: false,
    proven: false,
    unproven: {
      code: 'free_tier_quota_zero',
      probed_at: '2026-08-01',
      note: 'المسار صحيح، لكن حصة الطبقة المجانية لتوليد الصور صفر (429 RESOURCE_EXHAUSTED, '
        + 'limit: 0). فعّل الفوترة على مشروع المفتاح ثم أعد تشغيل المسبار.',
    },
  },
  {
    // خانة م٣ (رصيد سطر المُدار) — معرَّفة ومعطَّلة، بلا أي منطق في ج8.
    name: 'managed',
    tier: 'managed',
    label: 'رصيد «سطر» المُدار (لاحقاً)',
    keyName: '',
    enabled: false,
    proven: false,
    managed: true,
    unproven: { code: 'not_available_yet', probed_at: '', note: 'يُفتح في المرحلة ٣ من خطة التسييل.' },
  },
];

function providerByName(name) {
  return PROVIDERS.find((p) => p.name === name) || null;
}

/**
 * مصدر قائمة النماذج. `ctx.models` منفذ **داخلي للاختبار القطعي حصراً** (نظير `ctx.request`
 * و`ctx.baseUrls`): ctx يأتي من العملية الرئيسية أو الأدوات ولا يعبر من renderer إطلاقاً،
 * ويبقى السائق محصوراً في DRIVERS فلا يفتح الحقن مزوّداً جديداً. غيابه = الكتالوج الحقيقي.
 */
function modelsOf(ctx) {
  return (ctx && Array.isArray(ctx.models) && ctx.models.length) ? ctx.models : MODELS;
}

// ============================ المفاتيح ============================
// بيئة النظام أولاً ثم مخزن «سطر» — القيمة لا تغادر هذه الوحدة إلى نتيجة أو سجل.
function resolveKey(keyName, ctx) {
  if (!keyName) return '';
  const env = (ctx && ctx.env) || process.env;
  const fromEnv = String((env && env[keyName]) || '').trim();
  if (fromEnv) return fromEnv;
  if (ctx && typeof ctx.getKey === 'function') {
    try { return String(ctx.getKey(keyName) || '').trim(); } catch (e) { return ''; }
  }
  try {
    // lazy: keys.js يستورد electron — لا نحمّله إلا عند الحاجة كي تعمل الاختبارات بلا Electron
    return String(require('./keys').get(keyName) || '').trim();
  } catch (e) { return ''; }
}

function hasKey(provider, ctx) {
  return !!resolveKey(provider.keyName, ctx);
}

// ============================ التنقية ============================

// إزالة محارف التحكم C0/C1 وBidi ثم طيّ الفراغات
function cleanText(value) {
  let out = String(value == null ? '' : value);
  let result = '';
  for (const ch of out) {
    const cp = ch.codePointAt(0);
    const control = cp < 0x20 || (cp >= 0x7f && cp <= 0x9f);
    const bidi = cp === 0x061c || cp === 0x200e || cp === 0x200f
      || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069);
    result += (control || bidi) ? ' ' : ch;
  }
  return result.replace(/\s+/g, ' ').trim();
}

// قصّ بنقاط Unicode (لا وحدات UTF-16) كي لا ينكسر زوج بديل
function slicePoints(value, max) {
  const points = Array.from(String(value || ''));
  return points.length <= max ? points.join('') : points.slice(0, max).join('');
}

/**
 * برومبت السجل: منقّى ومقصوص ≤2000 نقطة. إن التقطه memory.hasSecret يُخزَّن فارغاً
 * بعلامة `prompt_redacted` (نصّ العقد: «يُخزَّن فارغاً بعلامة»).
 */
function logPrompt(rawPrompt) {
  const cleaned = cleanText(rawPrompt);
  if (memory.hasSecret(cleaned)) return { prompt: '', redacted: true };
  return { prompt: slicePoints(cleaned, MAX_PROMPT_LOG), redacted: false };
}

// اسم أصل منقّى بالبناء (لا يُشتق من البرومبت أو من رابط المزوّد إطلاقاً)
function assetName(kind, stamp, rand, index, ext) {
  return 'gen-' + kind + '-' + stamp + '-' + rand + '-' + index + ext;
}

function uniquePath(dir, name, exists) {
  const check = exists || fs.existsSync;
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; i <= 999; i += 1) {
    const candidate = path.join(dir, i === 1 ? name : stem + '-' + i + ext);
    if (!check(candidate)) return candidate;
  }
  return null;
}

/**
 * المراجع: مسارات نسبية داخل cwd حصراً (نفس حارس inject.resolveInside: لا مطلق، لا `..`،
 * ولا هروب symlink)، بسقف MAX_REFS. أي مرجع غير صالح يُفشل الطلب كاملاً fail-closed.
 */
function sanitizeRefs(refs, cwd) {
  if (refs == null) return { ok: true, refs: [] };
  if (!Array.isArray(refs)) return { ok: false, error_code: 'refs_invalid' };
  if (refs.length > MAX_REFS) return { ok: false, error_code: 'refs_invalid' };
  const out = [];
  for (const raw of refs) {
    if (typeof raw !== 'string' || !raw.trim()) return { ok: false, error_code: 'refs_invalid' };
    const rel = cleanText(raw).replace(/\\/g, '/');
    if (!rel) return { ok: false, error_code: 'refs_invalid' };
    const abs = inject.resolveInside(cwd, rel);
    if (!abs) return { ok: false, error_code: 'refs_outside' };
    let stat;
    try { stat = fs.statSync(abs); } catch (e) { return { ok: false, error_code: 'refs_missing' }; }
    if (!stat.isFile()) return { ok: false, error_code: 'refs_missing' };
    if (!out.includes(rel)) out.push(rel);
  }
  return { ok: true, refs: out };
}

function isDirectory(p) {
  try { return fs.statSync(p).isDirectory(); } catch (e) { return false; }
}

// ============================ الكتالوج والتقدير ============================

function modelPublic(m) {
  const out = {
    id: m.id, provider: m.provider, kind: m.kind, label: m.label,
    unit: m.unit, unit_cost_usd: m.unit_cost_usd, max_count: m.max_count,
    supports_refs: m.supports_refs, proven: m.proven,
    estimate: true, catalog_date: CATALOG_DATE,
  };
  if (!m.proven) out.unproven_reason = m.unproven_reason || '';
  return out;
}

function providerPublic(p) {
  const out = {
    name: p.name, tier: p.tier, label: p.label, keyName: p.keyName,
    enabled: p.enabled, proven: p.proven,
  };
  if (p.managed) out.managed = true;
  if (p.unproven) out.unproven = { code: p.unproven.code, probed_at: p.unproven.probed_at, note: p.unproven.note };
  return out;
}

/** كتالوج عام: نماذج ومزوّدون بأسعار تقديرية مؤرخة. لا مفاتيح ولا قيم. */
function listCatalog() {
  return {
    schema_version: SCHEMA_VERSION,
    catalog_date: CATALOG_DATE,
    estimate: true,
    kinds: Array.from(KINDS),
    providers: PROVIDERS.map(providerPublic),
    models: MODELS.map(modelPublic),
  };
}

function costFor(model, count) {
  const n = Math.max(1, Math.min(count || 1, model.max_count));
  return Math.round(model.unit_cost_usd * n * 1e6) / 1e6;
}

/** مرشّحو التوجيه: مثبت + مزوّده مفعّل + المفتاح مضبوط + يدعم النوع. الأرخص أولاً. */
function candidatesFor(kind, ctx) {
  return modelsOf(ctx)
    .filter((m) => m.kind === kind && m.proven)
    .filter((m) => {
      const p = providerByName(m.provider);
      return p && p.enabled && p.proven && hasKey(p, ctx);
    })
    .sort((a, b) => a.unit_cost_usd - b.unit_cost_usd);
}

/**
 * التقدير قبل أي شبكة. نموذج صريح ⇒ مزوّده (ولو غير مثبت — نعيد سبباً صريحاً)؛
 * غيابه ⇒ الأرخص المتاح للنوع.
 */
function estimate(req, ctx) {
  const r = req || {};
  const kind = String(r.kind || '');
  if (!KINDS.has(kind)) return { ok: false, error_code: 'unsupported_kind' };

  const prompt = cleanText(r.prompt);
  if (!prompt) return { ok: false, error_code: 'bad_input' };

  const rawCount = r.count == null ? 1 : r.count;
  if (typeof rawCount !== 'number' || !Number.isInteger(rawCount) || rawCount < 1 || rawCount > MAX_COUNT) {
    return { ok: false, error_code: 'bad_count' };
  }

  let chosen = null;
  let fallbackChain = [];
  if (r.model) {
    const wanted = String(r.model);
    const model = modelsOf(ctx).find((m) => m.id === wanted);
    if (!model) return { ok: false, error_code: 'unknown_model' };
    if (model.kind !== kind) return { ok: false, error_code: 'kind_mismatch' };
    const provider = providerByName(model.provider);
    if (!model.proven || !provider || !provider.enabled || !provider.proven) {
      return {
        ok: false, error_code: 'provider_unproven', provider: model.provider,
        reason: (provider && provider.unproven && provider.unproven.code) || model.unproven_reason || '',
      };
    }
    if (!hasKey(provider, ctx)) return { ok: false, error_code: 'no_key', provider: provider.name, key_name: provider.keyName };
    chosen = model;
  } else {
    fallbackChain = candidatesFor(kind, ctx);
    if (!fallbackChain.length) return { ok: false, error_code: 'no_provider', kind };
    chosen = fallbackChain[0];
  }

  if (rawCount > chosen.max_count) return { ok: false, error_code: 'count_exceeded', max_count: chosen.max_count };

  return {
    ok: true,
    kind,
    provider: chosen.provider,
    model: chosen.id,
    count: rawCount,
    cost_usd_estimate: costFor(chosen, rawCount),
    catalog_date: CATALOG_DATE,
    estimate: true,
    alternatives: fallbackChain.slice(1).map((m) => m.id),
  };
}

// ============================ نقل HTTP (https المدمجة) ============================
function defaultRequest(method, url, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { reject(new Error('bad_url')); return; }
    const mod = u.protocol === 'http:' ? http : https;
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const h = Object.assign({}, headers);
    if (payload) { h['content-type'] = 'application/json'; h['content-length'] = String(payload.length); }
    const req = mod.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search, method, headers: h,
    }, (res) => {
      const chunks = [];
      let total = 0;
      let aborted = false;
      res.on('data', (c) => {
        total += c.length;
        if (total > MAX_ASSET_BYTES) { aborted = true; res.destroy(); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        if (aborted) { reject(new Error('asset_too_large')); return; }
        const buf = Buffer.concat(chunks);
        const ct = String(res.headers['content-type'] || '');
        let json = null;
        if (ct.includes('json')) { try { json = JSON.parse(buf.toString('utf8')); } catch (e) { /* ليس JSON */ } }
        resolve({ status: res.statusCode, headers: res.headers, buffer: buf, json, contentType: ct });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs || SUBMIT_TIMEOUT_MS, () => { req.destroy(new Error('timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

function transportOf(ctx) {
  return (ctx && typeof ctx.request === 'function') ? ctx.request : defaultRequest;
}
function sleeper(ctx) {
  return (ctx && typeof ctx.sleep === 'function')
    ? ctx.sleep
    : ((ms) => new Promise((r) => setTimeout(r, ms)));
}
function baseUrlFor(provider, ctx) {
  const override = ctx && ctx.baseUrls && ctx.baseUrls[provider.name];
  return override || provider.baseUrl;
}

/**
 * 🔒 رابط الأصل: https ونطاق المزوّد المعلن حصراً. رابط من نطاق آخر (استجابة مزوّد
 * غريبة/مخترقة) يُرفض قبل أي جلب. `ctx.extraAssetHosts` منفذ اختبار محلي فقط.
 */
function isAllowedAssetUrl(rawUrl, provider, ctx) {
  let u;
  try { u = new URL(String(rawUrl)); } catch (e) { return false; }
  const extra = (ctx && Array.isArray(ctx.extraAssetHosts)) ? ctx.extraAssetHosts : [];
  if (extra.includes(u.hostname)) return u.protocol === 'http:' || u.protocol === 'https:';
  if (u.protocol !== 'https:') return false;
  return (provider.assetHosts || []).some((h) => u.hostname === h || u.hostname.endsWith('.' + h));
}

// ============================ سائق fal (مجمَّد من المسبار الحيّ) ============================
/**
 * العقد المرصود حرفياً 2026-08-01 (codex-cli غير معني — هذا سلك fal):
 *  1) POST {base}/{model}  header `Authorization: Key <FAL_KEY>`  body: مدخلات النموذج
 *     ⇒ 200 { status:'IN_QUEUE', request_id(36), response_url, status_url, cancel_url,
 *             logs:null, metrics:{}, queue_position:0 }
 *  2) GET status_url ⇒ **HTTP 202** ما دام IN_QUEUE/IN_PROGRESS، و**HTTP 200** عند COMPLETED.
 *     التسلسل المرصود: IN_QUEUE -> IN_PROGRESS -> COMPLETED.
 *  3) GET response_url ⇒ 200 وبنية الخرج:
 *     صورة: { images:[{url,width,height,content_type}], timings, seed, has_nsfw_concepts, prompt }
 *     فيديو: { video:{url,content_type,file_name,file_size}, seed }
 *  4) الأصل يُجلب بـGET عادي على url **بلا ترويسة اعتماد**.
 * ⚠️ status_url/response_url تُستعملان كما أعادهما المزوّد ولا تُبنيان محلياً: المسار
 *    المرصود يطوي `fal-ai/flux/schnell` إلى `fal-ai/flux/requests/<id>`.
 */
async function falGenerate(model, args, ctx, provider, key) {
  const request = transportOf(ctx);
  const sleep = sleeper(ctx);
  const base = baseUrlFor(provider, ctx);
  const auth = { authorization: 'Key ' + key };

  const input = Object.assign({}, model.wire, { prompt: args.prompt });
  if (model.kind === 'image') input.num_images = args.count;

  const submit = await request('POST', base + '/' + model.id, auth, input, SUBMIT_TIMEOUT_MS);
  if (submit.status !== 200 || !submit.json || !submit.json.status_url || !submit.json.response_url) {
    return { ok: false, error_code: 'provider_error', http_status: submit.status };
  }
  const statusUrl = String(submit.json.status_url);
  const responseUrl = String(submit.json.response_url);

  const budget = model.kind === 'video' ? POLL_BUDGET_VIDEO_MS : POLL_BUDGET_IMAGE_MS;
  const started = Date.now();
  let completed = false;
  while (Date.now() - started < budget) {
    await sleep(POLL_INTERVAL_MS);
    if (ctx && ctx.signal && ctx.signal.aborted) return { ok: false, error_code: 'aborted' };
    let st;
    try { st = await request('GET', statusUrl, auth, null, SUBMIT_TIMEOUT_MS); }
    catch (e) { return { ok: false, error_code: 'provider_error' }; }
    const status = st.json && st.json.status ? String(st.json.status) : '';
    if (status === 'COMPLETED') { completed = true; break; }
    if (status === 'FAILED' || status === 'ERROR') return { ok: false, error_code: 'provider_failed' };
  }
  if (!completed) return { ok: false, error_code: 'timeout' };

  let out;
  try { out = await request('GET', responseUrl, auth, null, SUBMIT_TIMEOUT_MS); }
  catch (e) { return { ok: false, error_code: 'provider_error' }; }
  if (out.status !== 200 || !out.json) return { ok: false, error_code: 'provider_error', http_status: out.status };

  const assets = [];
  if (model.kind === 'image') {
    for (const img of (Array.isArray(out.json.images) ? out.json.images : [])) {
      if (img && img.url) assets.push({ url: String(img.url), contentType: String(img.content_type || '') });
    }
  } else {
    const v = out.json.video || (Array.isArray(out.json.videos) ? out.json.videos[0] : null);
    if (v && v.url) assets.push({ url: String(v.url), contentType: String(v.content_type || '') });
  }
  if (!assets.length) return { ok: false, error_code: 'no_assets' };
  return { ok: true, assets };
}

const DRIVERS = { fal: falGenerate };

// ============================ كتابة الأصول ============================
async function downloadAssets(assets, opts) {
  const { cwd, kind, provider, ctx, stamp, rand } = opts;
  const request = transportOf(ctx);
  const dir = path.join(cwd, 'generations');
  try { fs.mkdirSync(dir, { recursive: true }); }
  catch (e) { return { ok: false, error_code: 'write_failed' }; }

  const files = [];
  for (let i = 0; i < assets.length; i += 1) {
    const asset = assets[i];
    if (!isAllowedAssetUrl(asset.url, provider, ctx)) return { ok: false, error_code: 'asset_rejected' };
    let res;
    try { res = await request('GET', asset.url, {}, null, ASSET_TIMEOUT_MS); }
    catch (e) {
      return { ok: false, error_code: e && e.message === 'asset_too_large' ? 'asset_too_large' : 'provider_error' };
    }
    if (res.status !== 200 || !res.buffer || !res.buffer.length) return { ok: false, error_code: 'provider_error' };
    if (res.buffer.length > MAX_ASSET_BYTES) return { ok: false, error_code: 'asset_too_large' };

    const type = String(res.contentType || asset.contentType || '').split(';')[0].trim().toLowerCase();
    const ext = EXT_BY_TYPE[type];
    if (!ext) return { ok: false, error_code: 'asset_type_rejected' };

    const target = uniquePath(dir, assetName(kind, stamp, rand, i + 1, ext));
    if (!target) return { ok: false, error_code: 'write_failed' };
    try { fs.writeFileSync(target, res.buffer); }
    catch (e) { return { ok: false, error_code: 'write_failed' }; }
    files.push(path.relative(cwd, target).replace(/\\/g, '/'));
  }
  return { ok: true, files };
}

// ============================ سجل JSONL ============================
function logFileFor(cwd) {
  return path.join(cwd, '.satr', 'generations.jsonl');
}

/** قصّ الأقدم حين يتجاوز السجل السقف — temp+rename، أفضل جهد. */
function rotate(file) {
  try {
    const stat = fs.statSync(file);
    if (stat.size <= LOG_MAX_BYTES) return;
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    let kept = lines;
    while (kept.length > 1 && Buffer.byteLength(kept.join('\n') + '\n', 'utf8') > LOG_TRIM_TO) {
      kept = kept.slice(1); // الأقدم أولاً
    }
    const temp = file + '.tmp-' + process.pid + '-' + Date.now();
    fs.writeFileSync(temp, kept.join('\n') + '\n', 'utf8');
    fs.renameSync(temp, file);
  } catch (e) { /* أفضل جهد — فشل القصّ لا يكسر التوليد */ }
}

/** إلحاق سطر واحد (O_APPEND ذرّي أفضل جهد). الفشل لا يكسر الدور. */
function appendLog(cwd, entry) {
  try {
    const file = logFileFor(cwd);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
    rotate(file);
    return true;
  } catch (e) { return false; }
}

/** قراءة أحدث N سطر منقّى (يستهلكها IPC عند كودكس). */
function readLog(cwd, limit) {
  const max = Math.max(1, Math.min(limit || 200, 1000));
  try {
    const lines = fs.readFileSync(logFileFor(cwd), 'utf8').split('\n').filter(Boolean);
    const out = [];
    for (const line of lines.slice(-max)) {
      try {
        const entry = JSON.parse(line);
        if (entry && typeof entry === 'object' && typeof entry.id === 'string') out.push(entry);
      } catch (e) { /* سطر تالف — يُتخطى */ }
    }
    return out.reverse(); // الأحدث أولاً
  } catch (e) { return []; }
}

function buildEntry(base, extra) {
  // ترتيب حقول v1 كما في العقد المجمَّد
  const entry = {
    id: base.id,
    at: base.at,
    kind: base.kind,
    provider: base.provider,
    model: base.model,
    prompt: base.prompt,
    refs: base.refs,
    files: extra.files || [],
    cost_usd_estimate: base.cost_usd_estimate,
    catalog_date: CATALOG_DATE,
    status: extra.status,
  };
  if (base.prompt_redacted) entry.prompt_redacted = true;
  if (extra.error_code) entry.error_code = extra.error_code;
  return entry;
}

// ============================ التوليد ============================
/**
 * `generate(req, ctx)` — req = {cwd, kind, prompt, model?, count?, refs?, budget_usd?}
 * ctx (اختياري، للحقن في الاختبار): {request, sleep, baseUrls, extraAssetHosts, env,
 * getKey, now, random, signal}
 */
async function generate(req, ctx) {
  const r = req || {};
  const context = ctx || {};
  const now = typeof context.now === 'function' ? context.now() : Date.now();
  const rand = typeof context.random === 'function'
    ? String(context.random()) : crypto.randomBytes(4).toString('hex');
  const id = 'gen_' + now + '_' + rand;
  const at = new Date(now).toISOString();

  const cwd = typeof r.cwd === 'string' ? r.cwd : '';
  if (!cwd || !path.isAbsolute(cwd) || !isDirectory(cwd)) {
    return { ok: false, id, error_code: 'bad_cwd', message: 'مجلد المشروع غير صالح.' };
  }

  // 1) التقدير أولاً — لا شبكة قبله
  const plan = estimate(r, context);
  if (!plan.ok) {
    return { ok: false, id, error_code: plan.error_code, provider: plan.provider || '', message: messageFor(plan) };
  }

  // 2) المراجع
  const refs = sanitizeRefs(r.refs, cwd);
  if (!refs.ok) {
    return { ok: false, id, error_code: refs.error_code, message: messageFor({ error_code: refs.error_code }) };
  }
  const model = modelsOf(context).find((m) => m.id === plan.model);
  if (refs.refs.length && !model.supports_refs) {
    return {
      ok: false, id, error_code: 'refs_unsupported',
      message: 'النموذج المختار (' + model.id + ') لا يملك مسار مراجع مثبتاً بالمسبار — أزِل المراجع أو انتظر ج9.',
    };
  }

  // 3) 💰 السقف الصلب — قبل أي استدعاء شبكة
  if (r.budget_usd != null) {
    const budget = Number(r.budget_usd);
    if (!Number.isFinite(budget) || budget < 0) {
      return { ok: false, id, error_code: 'bad_input', message: 'قيمة budget_usd غير صالحة.' };
    }
    if (plan.cost_usd_estimate > budget) {
      return {
        ok: false, id, error_code: 'over_budget',
        cost_usd_estimate: plan.cost_usd_estimate, budget_usd: budget, catalog_date: CATALOG_DATE,
        message: 'الكلفة التقديرية ' + plan.cost_usd_estimate + '$ تتجاوز السقف المطلوب '
          + budget + '$ — لم يُجرَ أي استدعاء.',
      };
    }
  }

  // 4) سلسلة المرشّحين (سقوط صريح): النموذج الصريح وحده، أو الأرخص فالأرخص
  const chain = r.model
    ? [model]
    : candidatesFor(plan.kind, context).filter((m) => plan.count <= m.max_count);
  const logged = logPrompt(r.prompt);
  const stamp = String(now);
  const fallbacks = [];

  for (const candidate of chain) {
    const provider = providerByName(candidate.provider);
    const driver = DRIVERS[candidate.provider];
    const key = resolveKey(provider.keyName, context);
    if (!driver || !key) { fallbacks.push({ provider: candidate.provider, model: candidate.id, error_code: 'no_key' }); continue; }

    const cost = costFor(candidate, plan.count);
    // السقف يُعاد فحصه لكل مرشّح — السقوط لأغلى لا يتجاوز الميزانية أبداً
    if (r.budget_usd != null && cost > Number(r.budget_usd)) {
      fallbacks.push({ provider: candidate.provider, model: candidate.id, error_code: 'over_budget' });
      continue;
    }

    let outcome;
    try {
      outcome = await driver(candidate, { prompt: slicePoints(cleanText(r.prompt), MAX_PROMPT_SEND), count: plan.count },
        context, provider, key);
    } catch (e) {
      outcome = { ok: false, error_code: 'provider_error' };
    }

    if (outcome.ok) {
      const saved = await downloadAssets(outcome.assets, {
        cwd, kind: plan.kind, provider, ctx: context, stamp, rand,
      });
      const base = {
        id, at, kind: plan.kind, provider: candidate.provider, model: candidate.id,
        prompt: logged.prompt, prompt_redacted: logged.redacted, refs: refs.refs,
        cost_usd_estimate: cost,
      };
      if (!saved.ok) {
        appendLog(cwd, buildEntry(base, { status: 'failed', error_code: saved.error_code }));
        return {
          ok: false, id, error_code: saved.error_code, provider: candidate.provider, model: candidate.id,
          fallbacks, message: messageFor({ error_code: saved.error_code }),
        };
      }
      appendLog(cwd, buildEntry(base, { status: 'completed', files: saved.files }));
      return {
        ok: true, id, kind: plan.kind, provider: candidate.provider, model: candidate.id,
        files: saved.files, count: saved.files.length,
        cost_usd_estimate: cost, catalog_date: CATALOG_DATE, estimate: true,
        refs: refs.refs, fallbacks,
      };
    }
    fallbacks.push({ provider: candidate.provider, model: candidate.id, error_code: outcome.error_code });
  }

  const lastCode = fallbacks.length ? fallbacks[fallbacks.length - 1].error_code : 'no_provider';
  appendLog(cwd, buildEntry({
    id, at, kind: plan.kind, provider: plan.provider, model: plan.model,
    prompt: logged.prompt, prompt_redacted: logged.redacted, refs: refs.refs,
    cost_usd_estimate: plan.cost_usd_estimate,
  }, { status: 'failed', error_code: lastCode }));

  return {
    ok: false, id, error_code: lastCode, kind: plan.kind, fallbacks,
    message: messageFor({ error_code: lastCode }),
  };
}

// ============================ الرسائل العربية (بلا نص مزوّد خام) ============================
const MESSAGES = {
  unsupported_kind: 'نوع التوليد غير مدعوم — المتاح: صورة أو فيديو (الصوت خارج هذه الجولة).',
  bad_input: 'طلب غير صالح — تحقّق من الوصف.',
  bad_count: 'العدد المطلوب خارج النطاق المسموح (1 إلى 4).',
  bad_cwd: 'مجلد المشروع غير صالح.',
  unknown_model: 'النموذج المطلوب غير موجود في الكتالوج.',
  kind_mismatch: 'النموذج المطلوب لا يولّد هذا النوع.',
  count_exceeded: 'العدد المطلوب يتجاوز سقف هذا النموذج.',
  no_provider: 'لا مزوّد متاح لهذا النوع — اضبط FAL_KEY من ⚙ ← «مفاتيح المزوّدين».',
  no_key: 'مفتاح المزوّد غير مضبوط — أضِفه من ⚙ ← «مفاتيح المزوّدين».',
  provider_unproven: 'هذا المزوّد غير مفعَّل في «سطر» بعد: لم يثبته مسبار حيّ (حساب المزوّد يرفض الطلب).',
  refs_invalid: 'المراجع غير صالحة — مسارات نسبية داخل المشروع بحد أقصى 6.',
  refs_outside: 'المراجع يجب أن تكون داخل مجلد المشروع حصراً.',
  refs_missing: 'ملف مرجعي غير موجود.',
  refs_unsupported: 'النموذج المختار لا يدعم المراجع.',
  provider_error: 'تعذّر إكمال التوليد لدى المزوّد.',
  provider_failed: 'أبلغ المزوّد بفشل التوليد.',
  timeout: 'انتهت مهلة انتظار المزوّد قبل اكتمال التوليد.',
  aborted: 'أُلغي التوليد.',
  no_assets: 'لم يُعِد المزوّد أي أصل.',
  asset_rejected: 'رابط الأصل من نطاق غير معتمد — رُفض قبل التنزيل.',
  asset_type_rejected: 'نوع الأصل المُعاد غير مدعوم.',
  asset_too_large: 'الأصل المُعاد يتجاوز الحجم المسموح.',
  write_failed: 'تعذّرت كتابة الأصل في مجلد المشروع.',
};

function messageFor(plan) {
  const code = plan && plan.error_code;
  const base = MESSAGES[code] || 'تعذّر التوليد.';
  if (code === 'provider_unproven' && plan && plan.provider) {
    const p = providerByName(plan.provider);
    if (p && p.unproven && p.unproven.note) return base + ' ' + p.unproven.note;
  }
  return base;
}

module.exports = {
  listCatalog,
  estimate,
  generate,
  readLog,
  // مُصدَّرات للاختبار القطعي وللقنوات (بلا أسرار)
  CATALOG_DATE,
  SCHEMA_VERSION,
  MAX_REFS,
  MAX_COUNT,
  MAX_PROMPT_LOG,
  LOG_MAX_BYTES,
  logFileFor,
  logPrompt,
  sanitizeRefs,
  isAllowedAssetUrl,
  providerByName,
  candidatesFor,
  messageFor,
};
