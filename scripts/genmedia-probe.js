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
 * التشغيل: node scripts/genmedia-probe.js [--only gemini|openai|fal] [--no-video]
 * الأصول المولَّدة تُحفظ في dist/genmedia-probe/ للمعاينة البشرية (لا تدخل Git).
 */

'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

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
  if (buf.length >= 12 && buf.slice(0, 4).toString('latin1') === 'RIFF') return 'RIFF/WEBP';
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
    record('fal', 'image', imageOk, model);
    break;
  }
  if (!imageOk && !results.some((r) => r.provider === 'fal' && r.kind === 'image')) {
    record('fal', 'image', false, 'all image models failed');
  }

  // ---- فيديو ----
  if (!doVideo) { say('video: SKIPPED by --no-video flag'); record('fal', 'video', false, 'SKIPPED by flag'); return; }
  for (const model of FAL_VIDEO_MODELS) {
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
    record('fal', 'video', ok, model);
    return;
  }
  record('fal', 'video', false, 'all video models failed');
}

// ============================ التشغيل ============================
async function main() {
  const args = process.argv.slice(2);
  const onlyIdx = args.indexOf('--only');
  const only = onlyIdx >= 0 ? args[onlyIdx + 1] : '';
  const doVideo = !args.includes('--no-video');
  const sizeIdx = args.indexOf('--image-size');
  const imageSize = sizeIdx >= 0 ? args[sizeIdx + 1] : 'square';

  say('genmedia-probe: live wire probe for generation providers');
  say('node:', process.version, '| platform:', process.platform, '| date:', new Date().toISOString());
  say('scope:', only ? 'only=' + only : 'all providers', '| video:', doVideo ? 'yes' : 'no',
    '| fal image_size:', imageSize);

  if (!only || only === 'gemini') await probeGemini();
  if (!only || only === 'openai') await probeOpenai();
  if (!only || only === 'fal') await probeFal(doVideo, imageSize);

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
