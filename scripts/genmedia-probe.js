#!/usr/bin/env node
/**
 * مسبار حيّ لمزوّدي التوليد (الجولة 8 — البند الأول من docs/GENERATION-PLAN.md).
 *
 * «المسبار أولاً»: لا يُجمَّد عقد سلك في electron/genmedia.js قبل استدعاء حيّ يثبته.
 * يستدعي بأصغر كلفة ممكنة: صورة واحدة لكل مزوّد، وفيديو واحد قصير بأرخص نموذج
 * على fal لتوثيق دورة queue/polling الفعلية.
 *
 * 🔒 لا يطبع أي مفتاح: كل سطر خرج يمر بـ redact() الذي يستبدل قيم المفاتيح المعروفة،
 * ولا يطبع محتوى المحتوى المولَّد — البنية والأطوال ورموز الحالة فقط. الروابط المؤقتة
 * من fal قد تحمل توقيعاً فتُطبع بالمضيف والمسار بلا query.
 *
 * مفتاح غائب ⇒ «SKIPPED: no key» صريح، والمزوّد يُعلَّم unproven ولا يُبنى له عقد سلك.
 *
 * التشغيل: node scripts/genmedia-probe.js
 *          [--only gemini|openai|fal|discover|audio|audio-duration|music-quality|music-candidates|refs|gptimage|video2] [--no-video]
 * الأصول المولَّدة تُحفظ في dist/genmedia-probe/ للمعاينة البشرية (لا تدخل Git).
 *
 * === الجولة 9 ===
 * أُضيفت خمس مراحل، أولاها **مجانية عمداً**:
 *   • `discover` — POST بجسم فارغ `{}` لكل مرشّح: 404 ⇒ غير مستضاف على fal · 422 ⇒
 *     مستضاف (رفض تحقّق المدخل) · 200 ⇒ مستضاف ويقبل الفارغ. لا يُنفَّذ توليد فلا كلفة،
 *     وبذلك لا ندفع ثمن نموذج غير موجود ولا نبني على اسم من توثيق منشور.
 *   • `audio`    — أرخص نموذج صوت مستضاف يثبته الاكتشاف (نوع kind:'audio' الجديد).
 *   • `refs`     — image-to-image فعلي: المرجع يُمرَّر **data: URI** (بلا رفع لأي خدمة).
 *   • `gptimage` — استضافة fal لـGPT Image وسعره (قرار المالك v2.1)، ومعه بدائل النص العربي.
 *   • `video2`   — نموذج/نموذجان إضافيان للفيديو إن اتسعت الكلفة الصغرى.
 */

'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const OUT_DIR = path.join(__dirname, '..', 'dist', 'genmedia-probe');
const PROMPT = 'a single small red circle centered on a plain white background, minimal flat vector';
const VIDEO_PROMPT = 'a small red circle slowly pulsing on a plain white background';

// ---------- حجب المفاتيح من كل خرج ----------
const SECRETS = [];
function registerSecret(value) {
  const v = String(value || '').trim();
  if (v.length >= 8) SECRETS.push(v);
}
function redact(text) {
  let out = String(text);
  for (const s of SECRETS) {
    while (out.includes(s)) out = out.split(s).join('«REDACTED»');
  }
  // احتياط: أنماط مفاتيح شائعة قد تعود من رسالة خطأ المزوّد
  out = out.replace(/\bsk-[A-Za-z0-9_-]{12,}/g, 'sk-«REDACTED»');
  out = out.replace(/\bAIza[A-Za-z0-9_-]{20,}/g, 'AIza«REDACTED»');
  return out;
}
function say(...parts) {
  console.log(redact(parts.join(' ')));
}

// ---------- المفاتيح: بيئة النظام أولاً ثم مخزن سطر (أفضل جهد خارج Electron) ----------
function fromStore(name) {
  try {
    const os = require('os');
    const file = path.join(os.homedir(), '.satr', 'keys.json');
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'))[name];
    if (typeof entry === 'string') return entry.trim();
    if (entry && typeof entry === 'object' && entry.enc === false && typeof entry.v === 'string') {
      return entry.v.trim(); // المشفّر يحتاج Electron safeStorage — خارج نطاق المسبار
    }
  } catch (e) { /* لا مخزن — البيئة وحدها */ }
  return '';
}
function resolveKey(names) {
  for (const n of names) {
    const v = (process.env[n] || '').trim() || fromStore(n);
    if (v) { registerSecret(v); return { key: v, source: process.env[n] ? 'env:' + n : 'store:' + n }; }
  }
  return { key: '', source: '' };
}

// ---------- HTTP عبر https المدمجة (صفر اعتماديات — نمط gemini.js) ----------
function request(method, url, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const h = Object.assign({}, headers);
    if (payload) { h['content-type'] = 'application/json'; h['content-length'] = String(payload.length); }
    const req = https.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || 443,
      path: u.pathname + u.search, method, headers: h,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const ct = String(res.headers['content-type'] || '');
        let json = null;
        if (ct.includes('json')) { try { json = JSON.parse(buf.toString('utf8')); } catch (e) { /* ليس JSON صالحاً */ } }
        resolve({ status: res.statusCode, headers: res.headers, buffer: buf, json, contentType: ct });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs || 120000, () => { req.destroy(new Error('timeout after ' + (timeoutMs || 120000) + 'ms')); });
    if (payload) req.write(payload);
    req.end();
  });
}

// ---------- وصف بنية JSON بلا قيم (إلا القيم الآمنة الصريحة) ----------
const SAFE_VALUE_KEYS = new Set([
  'status', 'mimeType', 'mime_type', 'content_type', 'finishReason', 'finish_reason',
  'type', 'object', 'model', 'queue_position', 'file_name', 'width', 'height',
  'num_frames', 'fps', 'duration', 'seed', 'has_nsfw_concepts', 'code',
]);
function describe(value, depth) {
  const d = depth || 0;
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (!value.length) return 'array(0)';
    if (d >= 3) return 'array(' + value.length + ')';
    return 'array(' + value.length + ')[' + describe(value[0], d + 1) + ']';
  }
  const t = typeof value;
  if (t === 'string') return 'string(len=' + value.length + ')';
  if (t === 'number' || t === 'boolean') return t + '(' + value + ')';
  if (t !== 'object') return t;
  if (d >= 4) return 'object';
  const parts = [];
  for (const k of Object.keys(value)) {
    const v = value[k];
    if (SAFE_VALUE_KEYS.has(k) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) {
      parts.push(k + '=' + (typeof v === 'string' ? JSON.stringify(v.slice(0, 80)) : v));
    } else {
      parts.push(k + ':' + describe(v, d + 1));
    }
  }
  return '{ ' + parts.join(', ') + ' }';
}
// رابط بلا query (توقيعات fal المؤقتة قد تحمل رموزاً)
function safeUrl(u) {
  try { const x = new URL(String(u)); return x.origin + x.pathname; } catch (e) { return '<bad url>'; }
}

function saveAsset(name, buf) {
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const p = path.join(OUT_DIR, name);
    fs.writeFileSync(p, buf);
    return p;
  } catch (e) { return null; }
}
function magic(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50) return 'PNG';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'JPEG';
  if (buf.length >= 12 && buf.slice(4, 8).toString('latin1') === 'ftyp') return 'MP4(ftyp)';
  if (buf.length >= 12 && buf.slice(0, 4).toString('latin1') === 'RIFF') {
    return buf.slice(8, 12).toString('latin1') === 'WAVE' ? 'RIFF/WAVE' : 'RIFF/WEBP';
  }
  if (buf.length >= 3 && buf.slice(0, 3).toString('latin1') === 'ID3') return 'MP3/ID3';
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'MP3/frame';
  return 'unknown';
}

const results = [];
function record(provider, kind, ok, note) {
  results.push({ provider, kind, ok, note: note || '' });
}

// ============================ 1) Gemini — صورة مباشرة ============================
const GEMINI_MODELS = ['gemini-2.5-flash-image', 'gemini-2.5-flash-image-preview'];

async function probeGemini() {
  say('');
  say('=== PROVIDER: gemini (direct, image) ===');
  const { key, source } = resolveKey(['GEMINI_API_KEY', 'GOOGLE_API_KEY']);
  if (!key) { say('SKIPPED: no key (GEMINI_API_KEY)'); record('gemini', 'image', false, 'SKIPPED no key'); return; }
  say('key source:', source, '| key length:', key.length);

  for (const model of GEMINI_MODELS) {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent';
    const t0 = Date.now();
    let res;
    try {
      res = await request('POST', url, { 'x-goog-api-key': key }, {
        contents: [{ parts: [{ text: PROMPT }] }],
      }, 180000);
    } catch (e) {
      say('model', model, '-> TRANSPORT ERROR:', e.message);
      continue;
    }
    const ms = Date.now() - t0;
    say('model:', model, '| POST', new URL(url).pathname, '| status:', res.status, '| ms:', ms);
    if (res.status !== 200) {
      const err = (res.json && res.json.error) || {};
      say('  non-200 body shape:', describe(res.json), '| error.status:', String(err.status || err.code || ''));
      // رسالة المزوّد تُطبع بعد redact — تشخيص لازم للتمييز بين خطأ عقد وخطأ حساب
      say('  error.message:', JSON.stringify(String(err.message || '')));
      continue;
    }
    say('  response shape:', describe(res.json));
    const parts = (((res.json.candidates || [])[0] || {}).content || {}).parts || [];
    say('  candidates[0].content.parts:', 'array(' + parts.length + ')',
      '| part kinds:', parts.map((p) => Object.keys(p).join('+')).join(','));
    const inline = parts.find((p) => p.inlineData || p.inline_data);
    if (!inline) { say('  NO inlineData part — treating as failure'); continue; }
    const data = inline.inlineData || inline.inline_data;
    const b64 = data.data || '';
    const buf = Buffer.from(b64, 'base64');
    const saved = saveAsset('gemini-image.png', buf);
    say('  inlineData.mimeType:', JSON.stringify(data.mimeType || data.mime_type || ''),
      '| base64 length:', b64.length, '| decoded bytes:', buf.length, '| magic:', magic(buf));
    if (res.json.usageMetadata) say('  usageMetadata:', describe(res.json.usageMetadata));
    say('  saved:', saved ? path.relative(path.join(__dirname, '..'), saved) : '<save failed>');
    say('  WIRE OK: POST /v1beta/models/<model>:generateContent, header x-goog-api-key,'
      + ' body {contents:[{parts:[{text}]}]}, out candidates[0].content.parts[].inlineData{mimeType,data:b64}');
    record('gemini', 'image', true, model);
    return;
  }
  record('gemini', 'image', false, 'all models failed');
}

// ============================ 2) OpenAI — صورة مباشرة ============================
const OPENAI_ATTEMPTS = [
  { model: 'gpt-image-1-mini', quality: 'low', size: '1024x1024' },
  { model: 'gpt-image-1', quality: 'low', size: '1024x1024' },
];

async function probeOpenai() {
  say('');
  say('=== PROVIDER: openai (direct, image) ===');
  const { key, source } = resolveKey(['OPENAI_API_KEY']);
  if (!key) { say('SKIPPED: no key (OPENAI_API_KEY)'); record('openai', 'image', false, 'SKIPPED no key'); return; }
  say('key source:', source, '| key length:', key.length);

  for (const attempt of OPENAI_ATTEMPTS) {
    const url = 'https://api.openai.com/v1/images/generations';
    const t0 = Date.now();
    let res;
    try {
      res = await request('POST', url, { authorization: 'Bearer ' + key }, {
        model: attempt.model, prompt: PROMPT, n: 1, size: attempt.size, quality: attempt.quality,
      }, 240000);
    } catch (e) {
      say('model', attempt.model, '-> TRANSPORT ERROR:', e.message);
      continue;
    }
    const ms = Date.now() - t0;
    say('model:', attempt.model, 'quality:', attempt.quality, 'size:', attempt.size,
      '| POST /v1/images/generations | status:', res.status, '| ms:', ms);
    if (res.status !== 200) {
      const err = res.json && res.json.error ? res.json.error : {};
      say('  non-200 body shape:', describe(res.json), '| error.code:', JSON.stringify(String(err.code || '')),
        '| error.type:', JSON.stringify(String(err.type || '')));
      say('  error.message:', JSON.stringify(String(err.message || '')));
      continue;
    }
    say('  response shape:', describe(res.json));
    const item = (res.json.data || [])[0] || {};
    const b64 = item.b64_json || '';
    if (!b64) { say('  NO b64_json — treating as failure'); continue; }
    const buf = Buffer.from(b64, 'base64');
    const saved = saveAsset('openai-image.png', buf);
    say('  data[0] keys:', Object.keys(item).join(','), '| b64_json length:', b64.length,
      '| decoded bytes:', buf.length, '| magic:', magic(buf));
    if (res.json.usage) say('  usage:', describe(res.json.usage));
    say('  saved:', saved ? path.relative(path.join(__dirname, '..'), saved) : '<save failed>');
    say('  WIRE OK: POST https://api.openai.com/v1/images/generations, header Authorization: Bearer,'
      + ' body {model,prompt,n,size,quality}, out data[0].b64_json (base64, no url by default)');
    record('openai', 'image', true, attempt.model + '/' + attempt.quality);
    return;
  }
  record('openai', 'image', false, 'all models failed');
}

// ============================ 3) fal — صورة ثم فيديو عبر queue ============================
const FAL_IMAGE_MODELS = ['fal-ai/flux/schnell'];
// أرخص أولاً — الفشل (404) مجاني، وأول نجاح يوقف المحاولة فلا تتكرر الكلفة
const FAL_VIDEO_MODELS = [
  'fal-ai/ltx-video',
  'fal-ai/ltxv-13b-098-distilled',
  'fal-ai/wan/v2.2-5b/text-to-video',
];

/**
 * 💰 الرصيد الحيّ — الطريقة الوحيدة الصادقة لإثبات السعر: fal **لا يعيد كلفة في استجابة
 * التوليد**، فنقيس فرق الرصيد قبل/بعد. مرصود حياً 2026-08-01: `GET
 * https://rest.alpha.fal.ai/billing/user_balance` بترويسة `Authorization: Key <FAL_KEY>`
 * ⇒ 200 ونص جسمه **رقم عشري عارٍ** (لا JSON). التسوية غير فورية أحياناً فننتظر قليلاً.
 */
async function falBalance(key) {
  try {
    const res = await request('GET', 'https://rest.alpha.fal.ai/billing/user_balance',
      { authorization: 'Key ' + key }, null, 30000);
    const n = Number(String(res.buffer.toString('utf8')).trim());
    return Number.isFinite(n) ? n : null;
  } catch (e) { return null; }
}
/**
 * ⚠️ **تسوية الرصيد ليست فورية** (مرصود حياً): بقي الرصيد ثابتاً ست ثوانٍ بعد اكتمال
 * التوليد ثم تحرّك. لذلك نستقصي حتى يتغيّر أو تنفد المهلة، ونُبلّغ صراحةً حين لا يتحرّك
 * (`unsettled`) بدل تسجيل صفر كاذب.
 */
const SETTLE_BUDGET_MS = 150000;
const SETTLE_STEP_MS = 10000;
async function measuredCost(key, before, label) {
  if (before == null) return null;
  const started = Date.now();
  let after = before;
  while (Date.now() - started < SETTLE_BUDGET_MS) {
    await new Promise((r) => setTimeout(r, SETTLE_STEP_MS));
    const now = await falBalance(key);
    if (now == null) break;
    after = now;
    if (after !== before) break;
  }
  const delta = Math.round((before - after) * 1e6) / 1e6;
  const settled = after !== before;
  say('  💰 measured cost (' + label + '): balance', before, '->', after,
    '| delta USD:', delta, '| settled:', settled, '| waited ms:', Date.now() - started);
  return settled ? delta : null;
}

async function falSubmit(key, model, input) {
  const url = 'https://queue.fal.run/' + model;
  const t0 = Date.now();
  const res = await request('POST', url, { authorization: 'Key ' + key }, input, 120000);
  return { res, ms: Date.now() - t0, url };
}

async function falPoll(key, statusUrl, responseUrl, budgetMs, label) {
  const started = Date.now();
  let polls = 0;
  const seenStatuses = [];
  while (Date.now() - started < budgetMs) {
    await new Promise((r) => setTimeout(r, 3000));
    polls += 1;
    const st = await request('GET', statusUrl, { authorization: 'Key ' + key }, null, 60000);
    const status = st.json && st.json.status ? String(st.json.status) : '<none>';
    if (!seenStatuses.includes(status)) seenStatuses.push(status);
    if (polls === 1) say('  ' + label + ' first status poll -> HTTP', st.status, '| shape:', describe(st.json));
    if (status === 'COMPLETED') {
      const out = await request('GET', responseUrl, { authorization: 'Key ' + key }, null, 60000);
      say('  ' + label + ' polls:', polls, '| elapsed ms:', Date.now() - started,
        '| statuses seen:', seenStatuses.join('->'));
      say('  ' + label + ' response HTTP:', out.status, '| shape:', describe(out.json));
      return { ok: out.status === 200, out, polls, elapsed: Date.now() - started };
    }
    if (status === 'FAILED' || status === 'ERROR') {
      say('  ' + label + ' terminal failure status:', status, '| shape:', describe(st.json));
      return { ok: false, out: st, polls, elapsed: Date.now() - started };
    }
  }
  say('  ' + label + ' BUDGET EXHAUSTED after', polls, 'polls /', budgetMs, 'ms');
  return { ok: false, out: null, polls, elapsed: Date.now() - started };
}

async function falDownload(url, name) {
  const res = await request('GET', url, {}, null, 120000);
  say('  asset GET', safeUrl(url), '-> HTTP', res.status, '| content-type:', JSON.stringify(res.contentType),
    '| bytes:', res.buffer.length, '| magic:', magic(res.buffer));
  if (res.status === 200 && res.buffer.length) {
    const saved = saveAsset(name, res.buffer);
    say('  saved:', saved ? path.relative(path.join(__dirname, '..'), saved) : '<save failed>');
    return true;
  }
  return false;
}

async function probeFal(doVideo, imageSize) {
  say('');
  say('=== PROVIDER: fal (aggregator, image + video via queue) ===');
  const { key, source } = resolveKey(['FAL_KEY']);
  if (!key) {
    say('SKIPPED: no key (FAL_KEY)');
    record('fal', 'image', false, 'SKIPPED no key');
    record('fal', 'video', false, 'SKIPPED no key');
    return;
  }
  say('key source:', source, '| key length:', key.length);

  // ---- صورة ----
  let imageOk = false;
  for (const model of FAL_IMAGE_MODELS) {
    const bal0 = await falBalance(key);
    let sub;
    try { sub = await falSubmit(key, model, { prompt: PROMPT, image_size: imageSize, num_images: 1 }); }
    catch (e) { say('image model', model, '-> TRANSPORT ERROR:', e.message); continue; }
    say('image model:', model, '| image_size:', imageSize,
      '| POST https://queue.fal.run/<model> | status:', sub.res.status, '| ms:', sub.ms);
    if (sub.res.status !== 200) { say('  non-200 shape:', describe(sub.res.json)); continue; }
    say('  submit shape:', describe(sub.res.json));
    const q = sub.res.json || {};
    say('  request_id length:', String(q.request_id || '').length,
      '| status_url:', safeUrl(q.status_url), '| response_url:', safeUrl(q.response_url));
    const done = await falPoll(key, q.status_url, q.response_url, 240000, 'image');
    if (!done.ok) { record('fal', 'image', false, model + ' poll failed'); continue; }
    const body = done.out.json || {};
    const img = (body.images || [])[0] || {};
    say('  images[0] keys:', Object.keys(img).join(','), '| url host+path:', safeUrl(img.url));
    if (img.url) imageOk = await falDownload(img.url, 'fal-image' + path.extname(safeUrl(img.url) || '.png'));
    say('  WIRE OK: POST https://queue.fal.run/<model> (Authorization: Key <FAL_KEY>) ->'
      + ' {request_id,status_url,response_url}; GET status_url until status=COMPLETED;'
      + ' GET response_url -> {images:[{url,content_type,...}]}; asset fetched by URL (no auth header needed)');
    const cost = await measuredCost(key, bal0, model);
    record('fal', 'image', imageOk, model + (cost == null ? '' : ' | measured $' + cost));
    break;
  }
  if (!imageOk && !results.some((r) => r.provider === 'fal' && r.kind === 'image')) {
    record('fal', 'image', false, 'all image models failed');
  }

  // ---- فيديو ----
  if (!doVideo) { say('video: SKIPPED by --no-video flag'); record('fal', 'video', false, 'SKIPPED by flag'); return; }
  for (const model of FAL_VIDEO_MODELS) {
    const bal0 = await falBalance(key);
    let sub;
    try { sub = await falSubmit(key, model, { prompt: VIDEO_PROMPT }); }
    catch (e) { say('video model', model, '-> TRANSPORT ERROR:', e.message); continue; }
    say('video model:', model, '| POST https://queue.fal.run/<model> | status:', sub.res.status, '| ms:', sub.ms);
    if (sub.res.status !== 200) {
      const detail = sub.res.json && sub.res.json.detail;
      say('  non-200 shape:', describe(sub.res.json), '| detail type:', Array.isArray(detail) ? 'array' : typeof detail);
      continue;
    }
    say('  submit shape:', describe(sub.res.json));
    const q = sub.res.json || {};
    const done = await falPoll(key, q.status_url, q.response_url, 600000, 'video');
    if (!done.ok) { record('fal', 'video', false, model + ' poll failed'); continue; }
    const body = done.out.json || {};
    say('  output top keys:', Object.keys(body).join(','));
    const video = body.video || (body.videos || [])[0] || {};
    say('  video keys:', Object.keys(video).join(','), '| url host+path:', safeUrl(video.url));
    let ok = false;
    if (video.url) ok = await falDownload(video.url, 'fal-video' + (path.extname(safeUrl(video.url)) || '.mp4'));
    say('  WIRE OK (video): same queue cycle as image; output {video:{url,content_type,file_size?}}');
    const cost = await measuredCost(key, bal0, model);
    record('fal', 'video', ok, model + (cost == null ? '' : ' | measured $' + cost));
    return;
  }
  record('fal', 'video', false, 'all video models failed');
}

// ============================ 4) اكتشاف مجاني: أي مرشّح مستضاف على fal؟ ============================
/**
 * POST بجسم فارغ `{}` على `queue.fal.run/<model>`.
 *
 * ⚠️ **مرصود حياً 2026-08-01 (تصحيح فرضية سابقة)**: بوابة الطابور **لا تتحقّق من المدخل
 * عند التقديم**؛ أعادت `200 IN_QUEUE` لكل معرّف موجود ولو بجسم فارغ، والتحقق يقع وقت
 * التنفيذ. لذلك الإشارة الوحيدة الموثوقة هنا هي:
 *   404 ⇒ لا نموذج بهذا المعرّف على fal
 *   200 ⇒ المعرّف موجود (ولا يعني أنه سيُنفَّذ بنجاح ولا أن الحساب مخوَّل له)
 * الطلب يُلغى فوراً بـ`PUT cancel_url`، ووظيفة الجسم الفارغ تنتهي بخطأ تحقّق وقت التنفيذ
 * فلا استدلال ⇒ لا كلفة. النتيجة تُخزَّن في `discovery.json` كي لا تتكرر الإدراجات.
 */
const DISCOVERY = {
  audio: [
    'fal-ai/cassetteai/sound-effects-generator',
    'fal-ai/ace-step',
    'fal-ai/stable-audio',
    'fal-ai/stable-audio-25/text-to-audio',
    'fal-ai/elevenlabs/sound-effects',
    'fal-ai/lyria2',
    'fal-ai/minimax-music',
    'fal-ai/diffrhythm',
  ],
  refs: [
    'fal-ai/flux/dev/image-to-image',
    'fal-ai/flux-kontext/dev',
    'fal-ai/flux-pro/kontext',
    'fal-ai/nano-banana/edit',
    'fal-ai/gemini-25-flash-image/edit',
    'fal-ai/qwen-image-edit',
  ],
  gptimage: [
    // مرصود 2026-08-01: نسختا `/byok` تلزمان مفتاح OpenAI الخاص بالمستخدم — الأولى ردّت
    // 422 `{detail:[{type:"missing"}]}` عند جلب الخرج والثانية 404؛ لذلك النسخة **بلا BYOK**
    // مقدَّمة هنا لأنها الوحيدة التي أنتجت أصلاً فعلياً.
    'fal-ai/gpt-image-1/text-to-image',
    'fal-ai/gpt-image-1/text-to-image/byok',
    'fal-ai/gpt-image-1-mini/text-to-image/byok',
    'fal-ai/gpt-image-1-mini',
    'fal-ai/gpt-image-2',
    'fal-ai/nano-banana',
    'fal-ai/nano-banana-pro',
    'fal-ai/gemini-25-flash-image',
  ],
  video2: [
    'fal-ai/ltxv-13b-098-distilled',
    'fal-ai/wan/v2.2-5b/text-to-video',
    'fal-ai/kling-video/v1/standard/text-to-video',
    'fal-ai/minimax/hailuo-02/standard/text-to-video',
  ],
};

const DISCOVERY_CACHE = path.join(OUT_DIR, 'discovery.json');
let discovered = {}; // model id -> http status

function loadDiscovery() {
  try { discovered = JSON.parse(fs.readFileSync(DISCOVERY_CACHE, 'utf8')) || {}; } catch (e) { discovered = {}; }
}
function saveDiscovery() {
  try { fs.mkdirSync(OUT_DIR, { recursive: true }); fs.writeFileSync(DISCOVERY_CACHE, JSON.stringify(discovered, null, 2)); }
  catch (e) { /* أفضل جهد */ }
}

async function probeDiscover(groups, force) {
  say('');
  say('=== DISCOVERY (empty-body POST; 404 vs 200 only — cancelled immediately) ===');
  const { key } = resolveKey(['FAL_KEY']);
  if (!key) { say('SKIPPED: no key (FAL_KEY)'); return; }
  loadDiscovery();
  for (const group of groups) {
    say('-- group:', group);
    for (const model of DISCOVERY[group]) {
      if (!force && typeof discovered[model] === 'number') {
        say('  ', model, '-> cached HTTP', discovered[model],
          '|', discovered[model] === 404 ? 'NOT HOSTED' : 'HOSTED (id exists)');
        continue;
      }
      let res;
      try { res = await request('POST', 'https://queue.fal.run/' + model, { authorization: 'Key ' + key }, {}, 60000); }
      catch (e) { say('  ', model, '-> TRANSPORT ERROR:', e.message); continue; }
      discovered[model] = res.status;
      say('  ', model, '-> HTTP', res.status, '|',
        res.status === 404 ? 'NOT HOSTED' : (res.status === 200 ? 'HOSTED (id exists)' : 'status ' + res.status));
      if (res.status !== 404 && res.status !== 200) {
        const d = res.json && (res.json.detail || res.json.error || res.json.message);
        say('     body shape:', describe(res.json), '| detail:', JSON.stringify(String(
          typeof d === 'string' ? d : JSON.stringify(d || '')).slice(0, 200)));
      }
      if (res.status === 200 && res.json && res.json.cancel_url) {
        let cancel = null;
        try { cancel = await request('PUT', res.json.cancel_url, { authorization: 'Key ' + key }, null, 30000); } catch (e) { /* أفضل جهد */ }
        say('     cancel -> HTTP', cancel ? cancel.status : '<error>');
      }
    }
  }
  saveDiscovery();
}

function hostedOf(group) {
  return DISCOVERY[group].filter((m) => discovered[m] === 200);
}

// ============================ 5) fal — الصوت (نوع kind:'audio' الجديد) ============================
const AUDIO_PROMPT = 'a short soft synth pad chord, calm ambient, one bar';
// مدخلات كل نموذج تختلف — نجرّب الشكل الشائع ثم نقرأ رسالة 422 لتصحيحه إن لزم
const AUDIO_INPUT = {
  'fal-ai/cassetteai/sound-effects-generator': { prompt: AUDIO_PROMPT, duration: 5 },
  'fal-ai/ace-step': { prompt: AUDIO_PROMPT, duration: 10 },
  'fal-ai/stable-audio': { prompt: AUDIO_PROMPT, seconds_total: 10 },
  'fal-ai/stable-audio-25/text-to-audio': { prompt: AUDIO_PROMPT, seconds_total: 10 },
  'fal-ai/elevenlabs/sound-effects': { text: AUDIO_PROMPT, duration_seconds: 5 },
  'fal-ai/lyria2': { prompt: AUDIO_PROMPT },
  'fal-ai/minimax-music': { prompt: AUDIO_PROMPT },
  'fal-ai/diffrhythm': { lyrics: '[00:00.00]la la la' },
};

async function probeFalAudio() {
  say('');
  say('=== PROVIDER: fal (audio via queue) ===');
  const { key } = resolveKey(['FAL_KEY']);
  if (!key) { say('SKIPPED: no key (FAL_KEY)'); record('fal', 'audio', false, 'SKIPPED no key'); return; }

  const hosted = hostedOf('audio');
  say('hosted audio candidates:', hosted.length ? hosted.join(', ') : '<none discovered>');
  for (const model of hosted) {
    const input = AUDIO_INPUT[model] || { prompt: AUDIO_PROMPT };
    say('audio model:', model, '| input keys:', Object.keys(input).join(','));
    const bal0 = await falBalance(key);
    let sub;
    try { sub = await falSubmit(key, model, input); }
    catch (e) { say('  TRANSPORT ERROR:', e.message); continue; }
    say('  POST status:', sub.res.status, '| ms:', sub.ms);
    if (sub.res.status !== 200) {
      say('  non-200 shape:', describe(sub.res.json));
      const d = sub.res.json && sub.res.json.detail;
      say('  detail:', JSON.stringify(String(typeof d === 'string' ? d : JSON.stringify(d || '')).slice(0, 300)));
      continue;
    }
    say('  submit shape:', describe(sub.res.json));
    const q = sub.res.json || {};
    const done = await falPoll(key, q.status_url, q.response_url, 300000, 'audio');
    if (!done.ok) { record('fal', 'audio', false, model + ' poll failed'); continue; }
    const body = done.out.json || {};
    say('  output top keys:', Object.keys(body).join(','));
    const a = body.audio || body.audio_file || (body.audios || [])[0] || {};
    say('  audio object keys:', Object.keys(a).join(','), '| url host+path:', safeUrl(a.url));
    let ok = false;
    if (a.url) ok = await falDownload(a.url, 'fal-audio' + (path.extname(safeUrl(a.url)) || '.mp3'));
    const cost = await measuredCost(key, bal0, model);
    say('  WIRE OK (audio): same queue cycle as image; output field observed above');
    record('fal', 'audio', ok, model + (cost == null ? '' : ' | measured $' + cost));
    return;
  }
  record('fal', 'audio', false, 'all audio models failed');
}

// ============ 5-ب) fal — مدد ace-step الأطول (ج10: موسيقى الإعلان ≥62ث) ============
/**
 * ج9 جمّدت `duration:10` وحدها لأنها الوحيدة المقيسة. إعلان «سطر» يحتاج ≥62ث، فهذا
 * السيناريو يثبت مدداً أطول **بالقياس لا بالافتراض**: لكل مدة يقيس السعر بفرق الرصيد
 * (نمط `measuredCost` مع كشف `unsettled`)، و**يقرأ طول الصوت الفعلي من ترويسة WAV**
 * (‏RIFF/‏fmt/‏data) بدل تصديق ما طُلب — فقد يقصّ المزوّد أو يمدّد بلا إعلان.
 *
 * التشغيل: node scripts/genmedia-probe.js --only audio-duration [--durations 30,63,120]
 */
const MUSIC_PROMPT = 'upbeat energetic synth-pop electro instrumental, 124 bpm, driving arpeggio, '
  + 'rising energy, bright analog synths, punchy drums, no vocals';
const DEFAULT_DURATIONS = [30, 63, 120];

/** طول WAV الفعلي بالثواني من عدد إطارات PCM؛ لا نثق بـbyteRate إن خالف fmt. */
function wavSeconds(buf) {
  try {
    if (buf.length < 44 || buf.slice(0, 4).toString('latin1') !== 'RIFF'
      || buf.slice(8, 12).toString('latin1') !== 'WAVE') return null;
    let pos = 12;
    let headerByteRate = 0;
    let channels = 0;
    let sampleRate = 0;
    let bits = 0;
    while (pos + 8 <= buf.length) {
      const id = buf.slice(pos, pos + 4).toString('latin1');
      const size = buf.readUInt32LE(pos + 4);
      if (id === 'fmt ') {
        channels = buf.readUInt16LE(pos + 10);
        sampleRate = buf.readUInt32LE(pos + 12);
        headerByteRate = buf.readUInt32LE(pos + 16);
        bits = buf.readUInt16LE(pos + 22);
      } else if (id === 'data') {
        const pcmByteRate = sampleRate * channels * (bits / 8);
        if (!pcmByteRate) return null;
        return {
          seconds: Math.round((size / pcmByteRate) * 100) / 100,
          sampleRate,
          channels,
          bits,
          dataBytes: size,
          headerByteRate,
          pcmByteRate,
        };
      }
      pos += 8 + size + (size % 2);
    }
    return null;
  } catch (e) { return null; }
}

async function probeAceStepDurations(durations) {
  say('');
  say('=== fal/ace-step: duration scaling (ج10 — promo music ≥62s) ===');
  const { key } = resolveKey(['FAL_KEY']);
  if (!key) { say('SKIPPED: no key (FAL_KEY)'); record('fal', 'audio-duration', false, 'SKIPPED no key'); return; }
  const model = 'fal-ai/ace-step';
  say('model:', model, '| prompt length:', MUSIC_PROMPT.length, '| durations:', durations.join(','));

  for (const duration of durations) {
    say('');
    say('-- duration requested:', duration, 's');
    const bal0 = await falBalance(key);
    let sub;
    try { sub = await falSubmit(key, model, { prompt: MUSIC_PROMPT, duration }); }
    catch (e) { say('  TRANSPORT ERROR:', e.message); record('fal', 'audio-duration', false, duration + 's transport'); continue; }
    say('  POST status:', sub.res.status, '| ms:', sub.ms);
    if (sub.res.status !== 200) {
      const d = sub.res.json && sub.res.json.detail;
      say('  non-200 shape:', describe(sub.res.json), '| detail:',
        JSON.stringify(String(typeof d === 'string' ? d : JSON.stringify(d || '')).slice(0, 300)));
      record('fal', 'audio-duration', false, duration + 's submit ' + sub.res.status);
      continue;
    }
    const q = sub.res.json || {};
    const done = await falPoll(key, q.status_url, q.response_url, 600000, 'dur' + duration);
    if (!done.ok) { record('fal', 'audio-duration', false, duration + 's poll failed'); continue; }
    const body = done.out.json || {};
    const a = body.audio || {};
    say('  audio keys:', Object.keys(a).join(','), '| content_type:', JSON.stringify(String(a.content_type || '')));
    if (!a.url) { record('fal', 'audio-duration', false, duration + 's no url'); continue; }
    const asset = await request('GET', a.url, {}, null, 180000);
    const meta = wavSeconds(asset.buffer);
    say('  asset HTTP:', asset.status, '| bytes:', asset.buffer.length, '| magic:', magic(asset.buffer));
    say('  ⏱ actual WAV seconds:', meta ? meta.seconds : '<unreadable>',
      '| sampleRate:', meta ? meta.sampleRate : '-', '| channels:', meta ? meta.channels : '-',
      '| bits:', meta ? meta.bits : '-');
    const saved = saveAsset('fal-music-' + duration + 's.wav', asset.buffer);
    say('  saved:', saved ? path.relative(path.join(__dirname, '..'), saved) : '<save failed>');
    const cost = await measuredCost(key, bal0, model + '@' + duration + 's');
    const okDur = !!(meta && meta.seconds >= duration - 1.5);
    say('  duration honoured:', okDur, '(requested', duration + 's, got', meta ? meta.seconds + 's)' : '?)');
    record('fal', 'audio-duration', okDur,
      duration + 's -> ' + (meta ? meta.seconds : '?') + 's' + (cost == null ? ' | cost unsettled' : ' | measured $' + cost));
  }
}

// ============ 5-ج) fal — جولة جودة موسيقى الإعلان (قرار محمد 2026-08-02) ============
/**
 * يجسّ النماذج الأعلى بالأولوية المتفق عليها، ويقف عند أول نموذج ينتج مقطعاً واحداً ≥62ث.
 * السعر مجهول قبل أول توليدة لكل نموذج، لذلك يُسمح بمسبار واحد فقط ثم يصبح فرق الرصيد
 * المقيس هو حارس بقية الجولة. أي تسوية معلّقة توقف الإنفاق بدلاً من افتراض كلفة صفرية.
 *
 * التشغيل: node scripts/genmedia-probe.js --only music-quality [--cap-usd 2]
 */
const QUALITY_CAP_USD = 2;
const QUALITY_DIR = path.join(OUT_DIR, 'quality-round');
const CINEMATIC_PROMPT = 'Instrumental cinematic technology-advertising score, no vocals. Begin very quiet and intimate '
  + 'with sparse felt piano and a soft string bed, then add warm cellos, wider strings, restrained cinematic percussion '
  + 'and subtle brass layer by layer. Maintain an elegant premium tone, a clear continuous upward energy arc, and reach '
  + 'the strongest emotional climax in the final ten seconds with a clean resolved ending. No singing, no speech, no choir.';

function falAudioAsset(body) {
  const asset = body.audio || body.audio_file || (body.audios || [])[0] || null;
  if (typeof asset === 'string') return { url: asset };
  return asset && typeof asset === 'object' ? asset : {};
}

function qualityExtension(asset, response) {
  const declared = String(asset.content_type || asset.contentType || response.contentType || '').toLowerCase();
  const pathname = safeUrl(asset.url || '');
  if (declared.includes('wav') || /\.wav$/i.test(pathname)) return '.wav';
  if (declared.includes('mpeg') || declared.includes('mp3') || /\.mp3$/i.test(pathname)) return '.mp3';
  return magic(response.buffer).startsWith('RIFF/WAVE') ? '.wav' : '.mp3';
}

function ffmpegPath() {
  const candidates = [
    process.env.FFMPEG_PATH,
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || 'ffmpeg';
}

function analysisWav(rawPath) {
  const raw = fs.readFileSync(rawPath);
  const direct = wavSeconds(raw);
  if (direct && direct.bits === 16) return { path: rawPath, meta: direct, converted: false };
  const wavPath = rawPath.replace(/\.[^.]+$/, '') + '-pcm16.wav';
  const converted = spawnSync(ffmpegPath(), [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', rawPath,
    '-acodec', 'pcm_s16le', '-ar', '48000', wavPath,
  ], { encoding: 'utf8' });
  if (converted.status !== 0) {
    say('  ffmpeg conversion failed | status:', converted.status, '| stderr:',
      JSON.stringify(String(converted.stderr || '').slice(0, 300)));
    return { path: '', meta: null, converted: true };
  }
  return { path: wavPath, meta: wavSeconds(fs.readFileSync(wavPath)), converted: true };
}

function validFalReferenceUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return parsed.protocol === 'https:' && (parsed.hostname === 'fal.media' || parsed.hostname.endsWith('.fal.media'))
      && !parsed.search && !parsed.hash ? parsed.toString() : '';
  } catch (error) {
    return '';
  }
}

function qualityProbeSpecs(miniMaxReferenceUrl) {
  const referenceUrl = validFalReferenceUrl(miniMaxReferenceUrl);
  return [
    {
      model: 'fal-ai/lyria2',
      input: { prompt: CINEMATIC_PROMPT, negative_prompt: 'vocals, singing, speech, choir, distortion, clipping' },
      durationField: '<none>',
    },
    {
      model: 'fal-ai/minimax-music',
      input: referenceUrl ? { prompt: '## ' + CINEMATIC_PROMPT + ' ##', reference_audio_url: referenceUrl } : null,
      durationField: '<none>',
    },
    {
      model: 'fal-ai/stable-audio-25/text-to-audio',
      input: { prompt: CINEMATIC_PROMPT, seconds_total: 65 },
      durationField: 'seconds_total=65',
    },
  ];
}

async function probeMusicQuality(capUsd, originalRoundStart, startModel, miniMaxReferenceUrl) {
  say('');
  say('=== fal: cinematic music quality round (ج10 تكميلي) ===');
  const { key } = resolveKey(['FAL_KEY']);
  if (!key) {
    say('SKIPPED: no key (FAL_KEY)');
    record('fal', 'music-quality', false, 'SKIPPED no key');
    return;
  }
  fs.mkdirSync(QUALITY_DIR, { recursive: true });
  const currentStart = await falBalance(key);
  if (currentStart == null) {
    say('STOPPED: balance unavailable; cannot enforce cap');
    record('fal', 'music-quality', false, 'balance unavailable');
    return;
  }
  const roundStart = Number.isFinite(originalRoundStart) ? originalRoundStart : currentStart;
  if (roundStart < currentStart) throw new Error('--round-start cannot be below current balance');
  const specs = qualityProbeSpecs(miniMaxReferenceUrl);
  const startIndex = startModel ? specs.findIndex((spec) => spec.model === startModel) : 0;
  if (startIndex < 0) throw new Error('unknown --quality-start model: ' + startModel);
  say('round cap USD:', capUsd, '| original balance:', roundStart, '| resume balance:', currentStart,
    '| start model:', specs[startIndex].model);
  let latestBalance = currentStart;

  for (const spec of specs.slice(startIndex)) {
    const spentBefore = Math.round((roundStart - latestBalance) * 1e6) / 1e6;
    const remaining = Math.round((capUsd - spentBefore) * 1e6) / 1e6;
    say('');
    say('-- cap guard:', spec.model, '| spent:', spentBefore, '| remaining:', remaining);
    if (remaining <= 0) {
      say('STOPPED: round cap exhausted before generation');
      break;
    }
    if (!spec.input) {
      say('UNPROVEN:', spec.model, '| missing local MiniMax reference audio');
      record('fal', 'music-quality', false, spec.model + ' missing reference');
      continue;
    }
    say('model:', spec.model, '| input keys:', Object.keys(spec.input).join(','),
      '| duration input:', spec.durationField);
    const balanceBefore = await falBalance(key);
    if (balanceBefore == null) {
      say('STOPPED: pre-generation balance unavailable');
      break;
    }
    latestBalance = balanceBefore;
    let sub;
    try {
      sub = await falSubmit(key, spec.model, spec.input);
    } catch (error) {
      say('  TRANSPORT ERROR:', error.message);
      record('fal', 'music-quality', false, spec.model + ' transport');
      continue;
    }
    say('  POST status:', sub.res.status, '| ms:', sub.ms);
    if (sub.res.status !== 200) {
      const detail = sub.res.json && sub.res.json.detail;
      say('  non-200 shape:', describe(sub.res.json), '| detail:',
        JSON.stringify(String(typeof detail === 'string' ? detail : JSON.stringify(detail || '')).slice(0, 500)));
      record('fal', 'music-quality', false, spec.model + ' submit ' + sub.res.status);
      continue;
    }
    const queue = sub.res.json || {};
    const done = await falPoll(key, queue.status_url, queue.response_url, 900000, 'music-quality');
    if (!done.ok) {
      record('fal', 'music-quality', false, spec.model + ' poll failed');
      const failedCost = await measuredCost(key, balanceBefore, spec.model + ' failed');
      if (failedCost == null) {
        say('STOPPED: failed generation cost unsettled');
        break;
      }
      latestBalance = await falBalance(key) || latestBalance;
      continue;
    }
    const body = done.out.json || {};
    const asset = falAudioAsset(body);
    say('  output top keys:', Object.keys(body).join(','));
    say('  audio keys:', Object.keys(asset).join(','), '| url host+path:', safeUrl(asset.url));
    if (!asset.url) {
      record('fal', 'music-quality', false, spec.model + ' no audio url');
      const missingCost = await measuredCost(key, balanceBefore, spec.model + ' no-audio');
      if (missingCost == null) {
        say('STOPPED: no-audio generation cost unsettled');
        break;
      }
      latestBalance = await falBalance(key) || latestBalance;
      continue;
    }
    const response = await request('GET', asset.url, {}, null, 240000);
    const extension = qualityExtension(asset, response);
    const rawPath = path.join(QUALITY_DIR, spec.model.split('/').join('-') + '-probe' + extension);
    fs.writeFileSync(rawPath, response.buffer);
    say('  asset HTTP:', response.status, '| content-type:', JSON.stringify(response.contentType),
      '| bytes:', response.buffer.length, '| magic:', magic(response.buffer), '| format:', extension.slice(1));
    say('  raw saved:', path.relative(path.join(__dirname, '..'), rawPath));
    const analyzed = analysisWav(rawPath);
    const meta = analyzed.meta;
    say('  analysis source:', analyzed.path ? path.relative(path.join(__dirname, '..'), analyzed.path) : '<conversion failed>',
      '| converted to PCM16:', analyzed.converted);
    say('  ⏱ actual file seconds:', meta ? meta.seconds : '<unreadable>',
      '| sampleRate:', meta ? meta.sampleRate : '-', '| channels:', meta ? meta.channels : '-',
      '| bits:', meta ? meta.bits : '-');
    const cost = await measuredCost(key, balanceBefore, spec.model);
    if (cost == null) {
      record('fal', 'music-quality', false, spec.model + ' cost unsettled');
      say('STOPPED: generation cost unsettled; cannot enforce remaining cap');
      break;
    }
    latestBalance = await falBalance(key) || latestBalance;
    const singleClip = !!(meta && meta.seconds >= 62);
    record('fal', 'music-quality', !!meta,
      spec.model + ' | actual ' + (meta ? meta.seconds : '?') + 's | format ' + extension.slice(1)
      + ' | measured $' + cost + ' | single-clip>=62 ' + singleClip);
    if (singleClip) {
      say('SUFFICIENT: first proven single-clip model reached ≥62s; stopping priority probe');
      break;
    }
  }

  const roundEnd = await falBalance(key);
  const roundSpent = roundEnd == null ? null : Math.round((roundStart - roundEnd) * 1e6) / 1e6;
  say('');
  say('quality round probe balance:', roundStart, '->', roundEnd == null ? '<unavailable>' : roundEnd,
    '| spent USD:', roundSpent == null ? '<unsettled>' : roundSpent, '| cap USD:', capUsd);
}

const CANDIDATE_PROMPTS = [
  'Instrumental cinematic technology-advertising score, no vocals. Open with almost-silent felt piano and a distant '
    + 'warm string harmonic. Build patiently: intimate cello, then violins, restrained low percussion and subtle brass. '
    + 'Each layer should raise emotional intensity without becoming bombastic. Make the final ten seconds the clear, '
    + 'powerful premium-tech climax, then land on one clean resolved final chord. No choir, speech, singing or distortion.',
  'Premium cinematic instrumental for a major technology brand, no vocals. A hushed solitary piano motif begins the piece; '
    + 'soft violas and cellos answer it, wider strings enter gradually, then elegant cinematic drums and restrained horns. '
    + 'Keep a continuous upward arc and generous dynamic range. Reserve the loudest, most moving statement for the final '
    + 'ten seconds and finish decisively. Organic orchestra, clean master, no choir, speech, singing or clipping.',
];

const CANDIDATE_MODEL_PROFILES = {
  'fal-ai/stable-audio-25/text-to-audio': {
    probeFile: 'fal-ai-stable-audio-25-text-to-audio-probe.wav',
    filePrefix: 'cine-stable25',
  },
};

async function generateMusicCandidates(capUsd, roundStart, count, modelId) {
  say('');
  say('=== fal: cinematic candidates through electron/genmedia.generate ===');
  const { key } = resolveKey(['FAL_KEY']);
  if (!key) {
    say('SKIPPED: no key (FAL_KEY)');
    record('fal', 'music-candidates', false, 'SKIPPED no key');
    return;
  }
  if (!Number.isFinite(roundStart) || roundStart <= 0) {
    throw new Error('--round-start is required from the printed probe balance');
  }
  const genmedia = require('../electron/genmedia');
  const profile = CANDIDATE_MODEL_PROFILES[modelId];
  if (!profile) throw new Error('unsupported --candidate-model: ' + modelId);
  const model = genmedia.listCatalog().models.find((item) => item.id === modelId);
  if (!model || !model.proven) throw new Error(modelId + ' is not frozen as proven');
  const projectDir = path.join(OUT_DIR, 'quality-project');
  const candidateDir = path.join(__dirname, '..', 'promo', 'footage', 'music-candidates', 'quality-round');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(candidateDir, { recursive: true });

  const probeSource = path.join(QUALITY_DIR, profile.probeFile);
  if (fs.existsSync(probeSource)) {
    const probeTarget = path.join(candidateDir, profile.filePrefix + '-probe.wav');
    fs.copyFileSync(probeSource, probeTarget);
    say('reused paid probe as candidate:', path.relative(path.join(__dirname, '..'), probeTarget));
  } else {
    say('probe candidate missing:', path.relative(path.join(__dirname, '..'), probeSource));
  }

  for (let index = 0; index < count; index += 1) {
    const currentBalance = await falBalance(key);
    if (currentBalance == null) {
      say('STOPPED: balance unavailable before candidate', index + 1);
      break;
    }
    const spent = Math.round((roundStart - currentBalance) * 1e6) / 1e6;
    const remaining = Math.round((capUsd - spent) * 1e6) / 1e6;
    say('');
    say('-- candidate cap guard:', index + 1, '| balance:', currentBalance,
      '| round spent:', spent, '| remaining:', remaining, '| estimated next:', model.unit_cost_usd);
    if (remaining < model.unit_cost_usd) {
      say('STOPPED: next measured model price does not fit remaining cap');
      break;
    }
    const before = currentBalance;
    const result = await genmedia.generate({
      cwd: projectDir,
      kind: 'audio',
      prompt: CANDIDATE_PROMPTS[index],
      model: model.id,
      count: 1,
      budget_usd: remaining,
    }, {
      env: {},
      getKey: (name) => name === 'FAL_KEY' ? key : '',
    });
    say('  generate result:', JSON.stringify({
      ok: result.ok,
      error_code: result.error_code || '',
      model: result.model || '',
      files: result.files || [],
      cost_usd_estimate: result.cost_usd_estimate,
      catalog_date: result.catalog_date,
    }));
    const cost = await measuredCost(key, before, model.id + '/candidate-' + (index + 1));
    if (cost == null) {
      say('STOPPED: candidate cost unsettled; cannot enforce remaining cap');
      break;
    }
    if (!result.ok || !Array.isArray(result.files) || !result.files[0]) {
      record('fal', 'music-candidates', false, 'candidate ' + (index + 1) + ' failed | measured $' + cost);
      continue;
    }
    const source = path.join(projectDir, result.files[0]);
    const extension = path.extname(source).toLowerCase() || '.wav';
    const target = path.join(candidateDir, profile.filePrefix + '-' + (index + 1) + extension);
    fs.copyFileSync(source, target);
    const analyzed = analysisWav(target);
    say('  candidate saved:', path.relative(path.join(__dirname, '..'), target));
    say('  ⏱ candidate actual file seconds:', analyzed.meta ? analyzed.meta.seconds : '<unreadable>',
      '| sampleRate:', analyzed.meta ? analyzed.meta.sampleRate : '-',
      '| channels:', analyzed.meta ? analyzed.meta.channels : '-',
      '| bits:', analyzed.meta ? analyzed.meta.bits : '-');
    record('fal', 'music-candidates', !!analyzed.meta,
      path.basename(target) + ' | actual ' + (analyzed.meta ? analyzed.meta.seconds : '?')
      + 's | measured $' + cost);
  }

  const roundEnd = await falBalance(key);
  const totalSpent = roundEnd == null ? null : Math.round((roundStart - roundEnd) * 1e6) / 1e6;
  say('');
  say('quality round total balance:', roundStart, '->', roundEnd == null ? '<unavailable>' : roundEnd,
    '| total spent USD:', totalSpent == null ? '<unsettled>' : totalSpent, '| cap USD:', capUsd);
}

// ============================ 6) fal — refs فعلية (image-to-image بـdata: URI) ============================
const REFS_PROMPT = 'change the circle color to solid blue, keep everything else identical';

function dataUriFor(file) {
  const buf = fs.readFileSync(file);
  const ext = path.extname(file).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : (ext === '.webp' ? 'image/webp' : 'image/jpeg');
  return { uri: 'data:' + mime + ';base64,' + buf.toString('base64'), bytes: buf.length, mime };
}

async function probeFalRefs() {
  say('');
  say('=== PROVIDER: fal (refs / image-to-image) ===');
  const { key } = resolveKey(['FAL_KEY']);
  if (!key) { say('SKIPPED: no key (FAL_KEY)'); record('fal', 'refs', false, 'SKIPPED no key'); return; }

  // المرجع: أصل الصورة الذي أنتجه المسبار نفسه (لا رفع لأي خدمة — data: URI محلي)
  let refFile = '';
  for (const name of ['fal-image.jpg', 'fal-image.jpeg', 'fal-image.png', 'gemini-image.png']) {
    const p = path.join(OUT_DIR, name);
    if (fs.existsSync(p)) { refFile = p; break; }
  }
  if (!refFile) { say('SKIPPED: no local reference asset in dist/genmedia-probe (run image probe first)'); record('fal', 'refs', false, 'no local ref'); return; }
  const ref = dataUriFor(refFile);
  say('reference:', path.basename(refFile), '| bytes:', ref.bytes, '| mime:', ref.mime,
    '| data URI length:', ref.uri.length);

  const hosted = hostedOf('refs');
  say('hosted refs candidates:', hosted.length ? hosted.join(', ') : '<none discovered>');
  for (const model of hosted) {
    const input = { prompt: REFS_PROMPT, image_url: ref.uri };
    if (model.includes('flux/dev/image-to-image')) input.strength = 0.6;
    say('refs model:', model, '| input keys:', Object.keys(input).join(','));
    const bal0 = await falBalance(key);
    let sub;
    try { sub = await falSubmit(key, model, input); }
    catch (e) { say('  TRANSPORT ERROR:', e.message); continue; }
    say('  POST status:', sub.res.status, '| ms:', sub.ms);
    if (sub.res.status !== 200) {
      const d = sub.res.json && sub.res.json.detail;
      say('  non-200 shape:', describe(sub.res.json), '| detail:',
        JSON.stringify(String(typeof d === 'string' ? d : JSON.stringify(d || '')).slice(0, 300)));
      continue;
    }
    const q = sub.res.json || {};
    const done = await falPoll(key, q.status_url, q.response_url, 300000, 'refs');
    if (!done.ok) { record('fal', 'refs', false, model + ' poll failed'); continue; }
    const body = done.out.json || {};
    say('  output top keys:', Object.keys(body).join(','));
    const img = (body.images || [])[0] || body.image || {};
    say('  images[0] keys:', Object.keys(img).join(','), '| url host+path:', safeUrl(img.url));
    let ok = false;
    if (img.url) ok = await falDownload(img.url, 'fal-refs-' + model.split('/').join('-') + (path.extname(safeUrl(img.url)) || '.jpg'));
    const cost = await measuredCost(key, bal0, model);
    say('  WIRE OK (refs): input {prompt, image_url:"data:<mime>;base64,..."} — no upload endpoint needed');
    record('fal', 'refs', ok, model + (cost == null ? '' : ' | measured $' + cost));
    return;
  }
  record('fal', 'refs', false, 'all refs models failed');
}

// ============================ 7) fal — GPT Image واستضافته (قرار المالك v2.1) ============================
const ARABIC_PROMPT = 'a clean poster with the Arabic word «سطر» written large and correctly in the center, white background, minimal';

async function probeFalGptImage(allCandidates) {
  say('');
  say('=== PROVIDER: fal (GPT Image hosting + Arabic-text alternatives) ===');
  const { key } = resolveKey(['FAL_KEY']);
  if (!key) { say('SKIPPED: no key (FAL_KEY)'); record('fal', 'gptimage', false, 'SKIPPED no key'); return; }

  const hosted = hostedOf('gptimage');
  say('hosted gptimage-group candidates:', hosted.length ? hosted.join(', ') : '<none discovered>');
  const gpt = hosted.filter((m) => m.includes('gpt-image'));
  const alt = hosted.filter((m) => !m.includes('gpt-image'));
  say('GPT Image hosted on fal:', gpt.length ? gpt.join(', ') : '<NONE>');
  say('Arabic-capable alternatives hosted:', alt.length ? alt.join(', ') : '<none>');

  // نولّد فعلياً بأول مرشّح GPT Image؛ فإن غاب فبأول بديل (لتقرير القائد)
  const order = gpt.concat(alt);
  for (const model of order) {
    const input = { prompt: ARABIC_PROMPT };
    if (model.includes('gpt-image')) { input.image_size = '1024x1024'; input.quality = 'low'; input.num_images = 1; }
    say('generating with:', model, '| input keys:', Object.keys(input).join(','));
    const bal0 = await falBalance(key);
    let sub;
    try { sub = await falSubmit(key, model, input); }
    catch (e) { say('  TRANSPORT ERROR:', e.message); continue; }
    say('  POST status:', sub.res.status, '| ms:', sub.ms);
    if (sub.res.status !== 200) {
      const d = sub.res.json && sub.res.json.detail;
      say('  non-200 shape:', describe(sub.res.json), '| detail:',
        JSON.stringify(String(typeof d === 'string' ? d : JSON.stringify(d || '')).slice(0, 300)));
      continue;
    }
    const q = sub.res.json || {};
    const done = await falPoll(key, q.status_url, q.response_url, 300000, 'gptimage');
    if (!done.ok) { record('fal', 'gptimage', false, model + ' poll failed'); continue; }
    const body = done.out.json || {};
    say('  output top keys:', Object.keys(body).join(','));
    const img = (body.images || [])[0] || {};
    say('  images[0] keys:', Object.keys(img).join(','), '| url host+path:', safeUrl(img.url));
    let ok = false;
    if (img.url) ok = await falDownload(img.url, 'fal-arabic-' + model.split('/').join('-') + (path.extname(safeUrl(img.url)) || '.jpg'));
    const cost = await measuredCost(key, bal0, model);
    record('fal', 'gptimage', ok, model + (cost == null ? '' : ' | measured $' + cost));
    if (!allCandidates) return; // الافتراضي: أول نجاح يكفي — والمقارنة العربية بـ--all-candidates
  }
  record('fal', 'gptimage', false, 'no candidate generated');
}

// ============================ 8) fal — نماذج فيديو إضافية ============================
/**
 * حارس كلفة صريح: نماذج الفيديو المميّزة (Kling/Hailuo) أغلى بمرتبة من LTX/WAN، والعقد
 * يطلب «نموذجاً أو اثنين إضافيين **إن اتسعت الكلفة الصغرى**». فلا تُولَّد إلا بعلم صريح،
 * ويُطبع سبب التخطي كي لا يُقرأ غيابها نقصاً في التغطية.
 */
const PREMIUM_VIDEO = new Set([
  'fal-ai/kling-video/v1/standard/text-to-video',
  'fal-ai/minimax/hailuo-02/standard/text-to-video',
]);

async function probeFalVideoExtra(includePremium) {
  say('');
  say('=== PROVIDER: fal (extra video models) ===');
  const { key } = resolveKey(['FAL_KEY']);
  if (!key) { say('SKIPPED: no key (FAL_KEY)'); record('fal', 'video2', false, 'SKIPPED no key'); return; }
  const hosted = hostedOf('video2');
  say('hosted extra-video candidates:', hosted.length ? hosted.join(', ') : '<none discovered>');
  let proven = 0;
  for (const model of hosted) {
    if (PREMIUM_VIDEO.has(model) && !includePremium) {
      say('SKIPPED (cost guard):', model, '— premium tier; run with --include-premium-video to prove it');
      continue;
    }
    if (proven >= 2) { say('stopping after 2 proven extra video models (cost guard)'); break; }
    say('video model:', model);
    const bal0 = await falBalance(key);
    let sub;
    try { sub = await falSubmit(key, model, { prompt: VIDEO_PROMPT }); }
    catch (e) { say('  TRANSPORT ERROR:', e.message); continue; }
    say('  POST status:', sub.res.status, '| ms:', sub.ms);
    if (sub.res.status !== 200) {
      const d = sub.res.json && sub.res.json.detail;
      say('  non-200 shape:', describe(sub.res.json), '| detail:',
        JSON.stringify(String(typeof d === 'string' ? d : JSON.stringify(d || '')).slice(0, 300)));
      continue;
    }
    const q = sub.res.json || {};
    const done = await falPoll(key, q.status_url, q.response_url, 900000, 'video2');
    if (!done.ok) { record('fal', 'video2', false, model + ' poll failed'); continue; }
    const body = done.out.json || {};
    say('  output top keys:', Object.keys(body).join(','));
    const v = body.video || (body.videos || [])[0] || {};
    say('  video keys:', Object.keys(v).join(','), '| url host+path:', safeUrl(v.url));
    let ok = false;
    if (v.url) ok = await falDownload(v.url, 'fal-video-' + model.split('/').join('-') + '.mp4');
    const cost = await measuredCost(key, bal0, model);
    record('fal', 'video2', ok, model + (cost == null ? '' : ' | measured $' + cost));
    if (ok) proven += 1;
  }
  if (!proven) record('fal', 'video2', false, 'no extra video model proven');
}

// ============================ التشغيل ============================
async function main() {
  const args = process.argv.slice(2);
  const onlyIdx = args.indexOf('--only');
  const only = onlyIdx >= 0 ? args[onlyIdx + 1] : '';
  const doVideo = !args.includes('--no-video');
  const sizeIdx = args.indexOf('--image-size');
  const imageSize = sizeIdx >= 0 ? args[sizeIdx + 1] : 'square';
  const capIdx = args.indexOf('--cap-usd');
  const capUsd = capIdx >= 0 ? Number(args[capIdx + 1]) : QUALITY_CAP_USD;
  const roundStartIdx = args.indexOf('--round-start');
  const roundStart = roundStartIdx >= 0 ? Number(args[roundStartIdx + 1]) : NaN;
  const qualityStartIdx = args.indexOf('--quality-start');
  const qualityStart = qualityStartIdx >= 0 ? String(args[qualityStartIdx + 1] || '') : '';
  const miniMaxReferenceIdx = args.indexOf('--minimax-reference-url');
  const miniMaxReferenceUrl = miniMaxReferenceIdx >= 0 ? String(args[miniMaxReferenceIdx + 1] || '') : '';
  const candidateCountIdx = args.indexOf('--candidate-count');
  const candidateCount = candidateCountIdx >= 0 ? Number(args[candidateCountIdx + 1]) : 2;
  const candidateModelIdx = args.indexOf('--candidate-model');
  const candidateModel = candidateModelIdx >= 0
    ? String(args[candidateModelIdx + 1] || '')
    : 'fal-ai/stable-audio-25/text-to-audio';

  say('genmedia-probe: live wire probe for generation providers');
  say('node:', process.version, '| platform:', process.platform, '| date:', new Date().toISOString());
  say('scope:', only ? 'only=' + only : 'all providers', '| video:', doVideo ? 'yes' : 'no',
    '| fal image_size:', imageSize);

  if (!only || only === 'gemini') await probeGemini();
  if (!only || only === 'openai') await probeOpenai();
  if (!only || only === 'fal') await probeFal(doVideo, imageSize);

  // --- الجولة 9 ---
  const wantAudio = !only || only === 'audio';
  const wantRefs = !only || only === 'refs';
  const wantGpt = !only || only === 'gptimage';
  const wantVid2 = !only || only === 'video2';
  const groups = [];
  if (wantAudio) groups.push('audio');
  if (wantRefs) groups.push('refs');
  if (wantGpt) groups.push('gptimage');
  if (wantVid2) groups.push('video2');
  const force = args.includes('--rediscover');
  if (only === 'music-candidates') {
    if (!Number.isFinite(capUsd) || capUsd <= 0 || capUsd > QUALITY_CAP_USD) {
      throw new Error('--cap-usd must be >0 and <=' + QUALITY_CAP_USD);
    }
    if (!Number.isInteger(candidateCount) || candidateCount < 1 || candidateCount > CANDIDATE_PROMPTS.length) {
      throw new Error('--candidate-count must be 1..' + CANDIDATE_PROMPTS.length);
    }
    await generateMusicCandidates(capUsd, roundStart, candidateCount, candidateModel);
  } else if (only === 'music-quality') {
    if (!Number.isFinite(capUsd) || capUsd <= 0 || capUsd > QUALITY_CAP_USD) {
      throw new Error('--cap-usd must be >0 and <=' + QUALITY_CAP_USD);
    }
    await probeMusicQuality(capUsd, roundStart, qualityStart, miniMaxReferenceUrl);
  } else if (only === 'audio-duration') {
    const di = args.indexOf('--durations');
    const list = di >= 0 && args[di + 1]
      ? args[di + 1].split(',').map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0)
      : DEFAULT_DURATIONS;
    await probeAceStepDurations(list);
  } else if (only === 'discover') { await probeDiscover(Object.keys(DISCOVERY), force); }
  else if (groups.length) {
    await probeDiscover(groups, force);
    if (wantAudio) await probeFalAudio();
    if (wantRefs) await probeFalRefs();
    if (wantGpt) await probeFalGptImage(args.includes('--all-candidates'));
    if (wantVid2) await probeFalVideoExtra(args.includes('--include-premium-video'));
  }

  say('');
  say('=== SUMMARY ===');
  for (const r of results) {
    say((r.ok ? 'PROVEN  ' : 'UNPROVEN') + '  ' + r.provider + '/' + r.kind + '  ' + r.note);
  }
  const proven = results.filter((r) => r.ok).length;
  say('proven contracts:', proven, '/', results.length);
  say('genmedia-probe: done');
}

main().catch((e) => { say('FATAL:', e && e.message ? e.message : String(e)); process.exit(1); });
