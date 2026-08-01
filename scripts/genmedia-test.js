#!/usr/bin/env node
/**
 * اختبار قطعي لنواة التوليد `electron/genmedia.js` — بلا شبكة خارجية.
 *
 * يشغّل خادم HTTP محلياً على 127.0.0.1 يحاكي عقد fal المجمَّد من المسبار الحيّ
 * (queue: POST ⇒ status 202/200 ⇒ response ⇒ جلب الأصل)، ويحقنه عبر `ctx.baseUrls`
 * و`ctx.extraAssetHosts` — المسارات الإنتاجية (التوجيه، السقف، التنقية، الكتابة،
 * السجل، حارس النطاق) هي نفسها بلا تعديل.
 *
 * التغطية المطلوبة (برومبت الجولة 8): التوجيه الأرخص حسب المفاتيح والسقوط الصريح ·
 * over_budget قبل أي نداء · schema سطر السجل v1 وحدوده وذرية الكتابة وسقف الدوران ·
 * تفريغ البرومبت الملتقط بالسر · رفض refs الخارجة عن cwd والمطلقة · عدم تسريب مفتاح
 * في أي نتيجة/سجل/خطأ · الكتالوج موسوم estimate بتاريخ.
 *
 * التشغيل: node scripts/genmedia-test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const genmedia = require('../electron/genmedia');

// ============================ عدّاد الفحوص ============================
let passed = 0;
let total = 0;
const failures = [];
function check(name, fn) {
  total += 1;
  const index = total;
  return Promise.resolve().then(fn).then(() => {
    passed += 1;
    console.log('[' + index + '] ok — ' + name);
  }, (e) => {
    failures.push(name + ': ' + (e && e.message ? e.message : String(e)));
    console.log('[' + index + '] FAIL — ' + name + ' :: ' + (e && e.message ? e.message : e));
  });
}

// ============================ مفتاح وهمي مميّز لفحص التسريب ============================
const FAKE_KEY = 'fal-TESTKEY-b7d41f9c2ae84cf1-DO-NOT-LEAK';
const TEST_ENV = { FAL_KEY: FAKE_KEY };

// ============================ الخادم المزيّف ============================
const IMAGE_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const VIDEO_BYTES = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42', 'latin1'), Buffer.alloc(16)]);

let server = null;
let origin = '';
const seen = { submits: [], authHeaders: [], assetAuth: [] };
let statusHits = 0;

function startServer() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, origin || 'http://127.0.0.1');
      const p = url.pathname;

      // 1) تقديم الطلب للطابور
      if (req.method === 'POST' && p.startsWith('/model/')) {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          const modelId = p.slice('/model/'.length);
          seen.submits.push({ modelId, body: JSON.parse(body || '{}') });
          seen.authHeaders.push(String(req.headers.authorization || ''));
          if (modelId.includes('always-fails')) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ detail: 'simulated provider outage' }));
            return;
          }
          const kind = modelId.includes('video') ? 'video' : 'image';
          statusHits = 0;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            status: 'IN_QUEUE', request_id: 'req-0001', queue_position: 0, logs: null, metrics: {},
            status_url: origin + '/requests/req-0001/status',
            response_url: origin + '/requests/req-0001?kind=' + kind,
          }));
        });
        return;
      }

      // 2) الحالة: 202 ما دام غير مكتمل ثم 200 عند الاكتمال (كما رصد المسبار حرفياً)
      if (req.method === 'GET' && p === '/requests/req-0001/status') {
        statusHits += 1;
        // يحاكي التسلسل المرصود حياً: IN_QUEUE (202) -> IN_PROGRESS (202) -> COMPLETED (200)
        if (statusHits < 3) {
          res.writeHead(202, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: statusHits === 1 ? 'IN_QUEUE' : 'IN_PROGRESS', request_id: 'req-0001' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'COMPLETED', request_id: 'req-0001' }));
        return;
      }

      // 3) الخرج النهائي
      if (req.method === 'GET' && p === '/requests/req-0001') {
        const kind = url.searchParams.get('kind');
        res.writeHead(200, { 'content-type': 'application/json' });
        if (kind === 'video') {
          res.end(JSON.stringify({
            video: { url: origin + '/assets/clip.mp4', content_type: 'video/mp4', file_name: 'clip.mp4', file_size: VIDEO_BYTES.length },
            seed: 7,
          }));
        } else {
          res.end(JSON.stringify({
            images: [{ url: origin + '/assets/one.jpg', width: 1024, height: 1024, content_type: 'image/jpeg' }],
            timings: { inference: 0.1 }, seed: 7, has_nsfw_concepts: [false], prompt: 'x',
          }));
        }
        return;
      }

      // 4) الأصول
      if (req.method === 'GET' && p.startsWith('/assets/')) {
        seen.assetAuth.push(String(req.headers.authorization || ''));
        if (p.endsWith('.mp4')) { res.writeHead(200, { 'content-type': 'video/mp4' }); res.end(VIDEO_BYTES); return; }
        if (p.endsWith('.exe')) { res.writeHead(200, { 'content-type': 'application/x-msdownload' }); res.end(Buffer.alloc(8)); return; }
        res.writeHead(200, { 'content-type': 'image/jpeg' }); res.end(IMAGE_BYTES); return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    server.listen(0, '127.0.0.1', () => {
      origin = 'http://127.0.0.1:' + server.address().port;
      resolve();
    });
  });
}

// ============================ سياق الحقن ============================
// نماذج اختبار: كلها على سائق fal، بأسعار مختلفة لإثبات «الأرخص أولاً» والسقوط
const TEST_MODELS = [
  {
    id: 'test/always-fails-cheap', provider: 'fal', kind: 'image', label: 'cheap (fails)',
    unit: 'image', unit_cost_usd: 0.001, max_count: 4, supports_refs: false, proven: true, wire: {},
  },
  {
    id: 'test/works-mid', provider: 'fal', kind: 'image', label: 'mid (works)',
    unit: 'image', unit_cost_usd: 0.005, max_count: 4, supports_refs: false, proven: true, wire: { image_size: 'square_hd' },
  },
  {
    id: 'test/works-video', provider: 'fal', kind: 'video', label: 'video (works)',
    unit: 'video', unit_cost_usd: 0.04, max_count: 1, supports_refs: false, proven: true, wire: {},
  },
];

function ctxFor(extra) {
  return Object.assign({
    env: TEST_ENV,
    getKey: () => '',
    models: TEST_MODELS,
    baseUrls: { fal: origin + '/model' },
    extraAssetHosts: ['127.0.0.1'],
    sleep: () => Promise.resolve(), // لا انتظار حقيقي في الاختبار
    now: () => 1754000000000,
    random: () => 'aabbccdd',
  }, extra || {});
}

let TMP = '';
function freshCwd(label) {
  const dir = path.join(TMP, label);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function readEntries(cwd) {
  const file = genmedia.logFileFor(cwd);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// ============================ الفحوص ============================
async function main() {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'genmedia-test-'));
  await startServer();

  // ---------- الكتالوج ----------
  await check('الكتالوج موسوم estimate وبتاريخ، ويعلن المزوّدين الأربعة', () => {
    const cat = genmedia.listCatalog();
    assert.strictEqual(cat.estimate, true, 'الكتالوج غير موسوم estimate');
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(cat.catalog_date), 'catalog_date ليس تاريخاً');
    assert.strictEqual(cat.catalog_date, genmedia.CATALOG_DATE);
    for (const m of cat.models) {
      assert.strictEqual(m.estimate, true, 'نموذج بلا وسم estimate: ' + m.id);
      assert.strictEqual(m.catalog_date, cat.catalog_date, 'نموذج بلا تاريخ: ' + m.id);
      assert.strictEqual(typeof m.unit_cost_usd, 'number');
    }
    const names = cat.providers.map((p) => p.name).sort();
    assert.deepStrictEqual(names, ['fal', 'gemini', 'managed', 'openai']);
  });

  await check('خانة managed معرَّفة ومعطَّلة وبلا مفتاح ولا سائق', () => {
    const managed = genmedia.providerByName('managed');
    assert.strictEqual(managed.enabled, false, 'managed مفعّلة!');
    assert.strictEqual(managed.proven, false);
    assert.strictEqual(managed.keyName, '');
    assert.strictEqual(managed.managed, true);
  });

  await check('المزوّدان المباشران معلَّمان unproven بسبب مرصود ولا يدخلان التوجيه', () => {
    for (const name of ['openai', 'gemini']) {
      const p = genmedia.providerByName(name);
      assert.strictEqual(p.proven, false, name + ' معلَّم مثبتاً بلا مسبار ناجح');
      assert.strictEqual(p.enabled, false, name + ' مفعّل بلا مسبار ناجح');
      assert.ok(p.unproven && p.unproven.code, name + ' بلا سبب مرصود');
    }
    // بالكتالوج الحقيقي (بلا حقن) لا يظهر أي نموذج غير مثبت في المرشّحين
    const cands = genmedia.candidatesFor('image', { env: { FAL_KEY: FAKE_KEY, OPENAI_API_KEY: 'x', GEMINI_API_KEY: 'y' }, getKey: () => '' });
    assert.ok(cands.every((m) => m.proven), 'مرشّح غير مثبت دخل التوجيه');
    assert.ok(cands.every((m) => m.provider === 'fal'), 'مزوّد غير fal دخل التوجيه');
  });

  await check('اختيار نموذج غير مثبت صراحةً يعيد provider_unproven fail-closed', async () => {
    const cwd = freshCwd('unproven');
    const res = await genmedia.generate(
      { cwd, kind: 'image', prompt: 'دائرة حمراء', model: 'gpt-image-1-mini' },
      { env: { OPENAI_API_KEY: 'sk-whatever', FAL_KEY: FAKE_KEY }, getKey: () => '' },
    );
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error_code, 'provider_unproven');
    assert.ok(seen.submits.length === 0 || !seen.submits.some((s) => s.modelId.includes('gpt-image')),
      'أُرسل طلب شبكة لمزوّد غير مثبت');
  });

  // ---------- التقدير والتوجيه ----------
  await check('التوجيه يختار الأرخص أولاً حين لا نموذج صريح', () => {
    const plan = genmedia.estimate({ kind: 'image', prompt: 'x', count: 2 }, ctxFor());
    assert.strictEqual(plan.ok, true);
    assert.strictEqual(plan.model, 'test/always-fails-cheap', 'لم يُختر الأرخص');
    assert.strictEqual(plan.cost_usd_estimate, 0.002, 'كلفة خاطئة: ' + plan.cost_usd_estimate);
    assert.strictEqual(plan.estimate, true);
    assert.deepStrictEqual(plan.alternatives, ['test/works-mid']);
  });

  await check('غياب المفتاح ⇒ لا مرشّح ⇒ no_provider بلا شبكة', async () => {
    const cwd = freshCwd('nokey');
    const before = seen.submits.length;
    const res = await genmedia.generate({ cwd, kind: 'image', prompt: 'x' }, ctxFor({ env: {} }));
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error_code, 'no_provider');
    assert.strictEqual(seen.submits.length, before, 'جرى نداء شبكة بلا مفتاح');
  });

  // ---------- السقف الصلب ----------
  await check('over_budget يُرفض قبل أي استدعاء شبكة', async () => {
    const cwd = freshCwd('budget');
    const before = seen.submits.length;
    const res = await genmedia.generate(
      { cwd, kind: 'image', prompt: 'x', model: 'test/works-mid', count: 4, budget_usd: 0.001 },
      ctxFor(),
    );
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error_code, 'over_budget');
    assert.strictEqual(res.cost_usd_estimate, 0.02);
    assert.strictEqual(res.budget_usd, 0.001);
    assert.strictEqual(seen.submits.length, before, 'جرى نداء شبكة رغم تجاوز السقف!');
  });

  await check('السقوط لا يتجاوز السقف: الأرخص يفشل والأغلى فوق الميزانية ⇒ لا نداء للأغلى', async () => {
    const cwd = freshCwd('budget-fallback');
    const before = seen.submits.length;
    // الأرخص 0.001 (يفشل) والتالي 0.005 — الميزانية 0.002 تسمح بالأول فقط
    const res = await genmedia.generate({ cwd, kind: 'image', prompt: 'x', budget_usd: 0.002 }, ctxFor());
    assert.strictEqual(res.ok, false);
    const calls = seen.submits.slice(before).map((s) => s.modelId);
    assert.deepStrictEqual(calls, ['test/always-fails-cheap'], 'نُودي نموذج فوق الميزانية: ' + calls.join(','));
    assert.ok(res.fallbacks.some((f) => f.error_code === 'over_budget'), 'لم يُذكر تجاوز السقف في السقوط');
  });

  // ---------- المسار الناجح + السقوط الصريح ----------
  await check('السقوط الصريح: يفشل الأرخص فينجح التالي، والنتيجة تذكر السقوط', async () => {
    const cwd = freshCwd('fallback');
    const before = seen.submits.length;
    const res = await genmedia.generate({ cwd, kind: 'image', prompt: 'دائرة حمراء على خلفية بيضاء' }, ctxFor());
    assert.strictEqual(res.ok, true, 'فشل التوليد: ' + res.error_code);
    assert.strictEqual(res.model, 'test/works-mid');
    assert.strictEqual(res.provider, 'fal');
    const calls = seen.submits.slice(before).map((s) => s.modelId);
    assert.deepStrictEqual(calls, ['test/always-fails-cheap', 'test/works-mid'], 'ترتيب المحاولات: ' + calls.join(','));
    assert.strictEqual(res.fallbacks.length, 1, 'لم يُسجَّل السقوط');
    assert.strictEqual(res.fallbacks[0].model, 'test/always-fails-cheap');
    assert.ok(res.fallbacks[0].error_code, 'سقوط بلا رمز خطأ');
    assert.strictEqual(res.cost_usd_estimate, 0.005, 'الكلفة لا تعكس النموذج المنفَّذ فعلاً');
  });

  await check('الأصل يُكتب تحت generations/ باسم منقّى ومسار نسبي فقط', async () => {
    const cwd = freshCwd('assets');
    const res = await genmedia.generate({ cwd, kind: 'image', prompt: 'x', model: 'test/works-mid' }, ctxFor());
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.files.length, 1);
    const rel = res.files[0];
    assert.ok(rel.startsWith('generations/'), 'المسار ليس تحت generations/: ' + rel);
    assert.ok(!path.isAbsolute(rel), 'مسار مطلق تسرّب إلى النتيجة');
    assert.ok(/^generations\/gen-image-\d+-[a-z0-9]+-1\.jpg$/.test(rel), 'اسم غير منقّى: ' + rel);
    assert.ok(fs.existsSync(path.join(cwd, rel)), 'الملف غير موجود على القرص');
    assert.strictEqual(fs.readFileSync(path.join(cwd, rel)).length, IMAGE_BYTES.length);
  });

  await check('الفيديو يمر بدورة queue نفسها ويُكتب mp4', async () => {
    const cwd = freshCwd('video');
    const res = await genmedia.generate({ cwd, kind: 'video', prompt: 'دائرة نابضة', model: 'test/works-video' }, ctxFor());
    assert.strictEqual(res.ok, true, 'فشل الفيديو: ' + res.error_code);
    assert.strictEqual(res.kind, 'video');
    assert.ok(res.files[0].endsWith('.mp4'), 'امتداد الفيديو خاطئ: ' + res.files[0]);
  });

  await check('استقصاء الحالة يحترم 202 ثم 200 (لا يُعد 202 اكتمالاً)', () => {
    // statusHits تصفَّر عند كل submit؛ آخر تشغيل ناجح احتاج 3 نداءات (202,202,200)
    assert.ok(statusHits >= 3, 'لم يُستقصَ حتى COMPLETED — عدد النداءات: ' + statusHits);
  });

  // ---------- المراجع ----------
  await check('refs: مطلق ومتجاوز cwd و`..` كلها مرفوضة قبل الشبكة', async () => {
    const cwd = freshCwd('refs-bad');
    const before = seen.submits.length;
    const cases = [
      [['C:\\Windows\\win.ini'], 'refs_outside'],
      [['/etc/passwd'], 'refs_outside'],
      [['../outside.png'], 'refs_outside'],
      [['sub/../../escape.png'], 'refs_outside'],
    ];
    for (const [refs, expected] of cases) {
      const res = await genmedia.generate({ cwd, kind: 'image', prompt: 'x', model: 'test/works-mid', refs }, ctxFor());
      assert.strictEqual(res.ok, false, 'قُبل مرجع خارجي: ' + refs[0]);
      assert.strictEqual(res.error_code, expected, refs[0] + ' -> ' + res.error_code);
    }
    assert.strictEqual(seen.submits.length, before, 'جرى نداء شبكة رغم مرجع غير صالح');
  });

  await check('refs: تجاوز السقف 6 مرفوض، والمرجع الصالح يُرفض بـrefs_unsupported لعدم ثبوت مساره', async () => {
    const cwd = freshCwd('refs-cap');
    const many = Array.from({ length: 7 }, (_, i) => 'a' + i + '.png');
    const over = await genmedia.generate({ cwd, kind: 'image', prompt: 'x', model: 'test/works-mid', refs: many }, ctxFor());
    assert.strictEqual(over.error_code, 'refs_invalid', 'سقف المراجع لم يُطبَّق');
    assert.strictEqual(genmedia.MAX_REFS, 6);

    fs.writeFileSync(path.join(cwd, 'ref.png'), IMAGE_BYTES);
    const res = await genmedia.generate({ cwd, kind: 'image', prompt: 'x', model: 'test/works-mid', refs: ['ref.png'] }, ctxFor());
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error_code, 'refs_unsupported', 'مرجع مُرِّر لنموذج بلا مسار مراجع مثبت');
  });

  // ---------- حارس نطاق الأصول ----------
  await check('حارس نطاق الأصول: fal.media فقط عبر https، وأي نطاق آخر مرفوض', () => {
    const fal = genmedia.providerByName('fal');
    const ok = ['https://v3b.fal.media/files/b/x/y.jpg', 'https://fal.media/a.png'];
    const bad = [
      'http://v3b.fal.media/files/x.jpg',      // بلا https
      'https://evil.example.com/x.jpg',        // نطاق آخر
      'https://falamedia.com/x.jpg',           // تشابه اسمي
      'https://fal.media.evil.com/x.jpg',      // لاحقة مخادعة
      'file:///C:/Windows/win.ini',            // بروتوكول محلي
      'not a url',
    ];
    for (const u of ok) assert.strictEqual(genmedia.isAllowedAssetUrl(u, fal, {}), true, 'رُفض رابط صالح: ' + u);
    for (const u of bad) assert.strictEqual(genmedia.isAllowedAssetUrl(u, fal, {}), false, 'قُبل رابط خطر: ' + u);
  });

  await check('نوع أصل غير مدعوم يُرفض ولا يُكتب على القرص', async () => {
    const cwd = freshCwd('badtype');
    const ctx = ctxFor();
    // خادم يعيد رابط .exe في الخرج
    const patched = Object.assign({}, ctx, {
      request: async (method, url, headers, body, timeout) => {
        const real = require('http');
        void real;
        if (method === 'GET' && url.includes('/requests/req-0001?')) {
          return {
            status: 200, headers: {}, contentType: 'application/json', buffer: Buffer.alloc(0),
            json: { images: [{ url: origin + '/assets/bad.exe', content_type: 'application/x-msdownload' }] },
          };
        }
        return defaultCtxRequest(method, url, headers, body, timeout);
      },
    });
    const res = await genmedia.generate({ cwd, kind: 'image', prompt: 'x', model: 'test/works-mid' }, patched);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error_code, 'asset_type_rejected');
    const dir = path.join(cwd, 'generations');
    const written = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    assert.strictEqual(written.length, 0, 'كُتب ملف رغم رفض النوع: ' + written.join(','));
  });

  // ---------- السجل ----------
  await check('سطر السجل يطابق schema v1 بحقوله وترتيبه وبلا مسار مطلق', async () => {
    const cwd = freshCwd('log-schema');
    const res = await genmedia.generate({ cwd, kind: 'image', prompt: 'وصف عربي للاختبار', model: 'test/works-mid' }, ctxFor());
    assert.strictEqual(res.ok, true);
    const entries = readEntries(cwd);
    assert.strictEqual(entries.length, 1, 'عدد أسطر السجل: ' + entries.length);
    const e = entries[0];
    assert.deepStrictEqual(Object.keys(e), [
      'id', 'at', 'kind', 'provider', 'model', 'prompt', 'refs', 'files',
      'cost_usd_estimate', 'catalog_date', 'status',
    ], 'حقول السطر: ' + Object.keys(e).join(','));
    assert.ok(/^gen_\d+_[a-z0-9]+$/.test(e.id), 'صيغة المعرّف: ' + e.id);
    assert.ok(!Number.isNaN(Date.parse(e.at)), 'at ليس تاريخاً');
    assert.strictEqual(e.kind, 'image');
    assert.strictEqual(e.status, 'completed');
    assert.strictEqual(e.catalog_date, genmedia.CATALOG_DATE);
    assert.strictEqual(typeof e.cost_usd_estimate, 'number');
    assert.deepStrictEqual(e.refs, []);
    for (const f of e.files) assert.ok(!path.isAbsolute(f) && f.startsWith('generations/'), 'مسار سجل غير نسبي: ' + f);
    assert.ok(!JSON.stringify(e).includes(cwd), 'مسار مطلق داخل السطر');
  });

  await check('الفشل يُسجَّل بحالة failed ورمز خطأ', async () => {
    const cwd = freshCwd('log-fail');
    const res = await genmedia.generate({ cwd, kind: 'image', prompt: 'x', model: 'test/always-fails-cheap' }, ctxFor());
    assert.strictEqual(res.ok, false);
    const entries = readEntries(cwd);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].status, 'failed');
    assert.ok(entries[0].error_code, 'سطر فاشل بلا error_code');
    assert.deepStrictEqual(entries[0].files, []);
  });

  await check('البرومبت في السجل ≤2000 نقطة بعد التنقية (تحكم/Bidi مُزال)', async () => {
    const cwd = freshCwd('log-prompt');
    const long = 'ب'.repeat(2600) + '\u0000\u202Eعكس' + '\n\n\t';
    const res = await genmedia.generate({ cwd, kind: 'image', prompt: long, model: 'test/works-mid' }, ctxFor());
    assert.strictEqual(res.ok, true);
    const e = readEntries(cwd)[0];
    assert.strictEqual(Array.from(e.prompt).length, genmedia.MAX_PROMPT_LOG, 'طول البرومبت: ' + Array.from(e.prompt).length);
    assert.ok(!/[\u0000-\u001f\u202a-\u202e\u2066-\u2069]/.test(e.prompt), 'محرف تحكم/Bidi بقي في السجل');
  });

  await check('برومبت يلتقطه hasSecret يُخزَّن فارغاً بعلامة prompt_redacted', async () => {
    const cwd = freshCwd('log-secret');
    const secret = 'ولّد صورة ثم استعمل api_key=AbCdEf0123456789XyZ للرفع';
    const res = await genmedia.generate({ cwd, kind: 'image', prompt: secret, model: 'test/works-mid' }, ctxFor());
    assert.strictEqual(res.ok, true);
    const e = readEntries(cwd)[0];
    assert.strictEqual(e.prompt, '', 'البرومبت الحسّاس خُزِّن!');
    assert.strictEqual(e.prompt_redacted, true, 'لا علامة على التفريغ');
    const raw = fs.readFileSync(genmedia.logFileFor(cwd), 'utf8');
    assert.ok(!raw.includes('AbCdEf0123456789XyZ'), 'السر تسرّب إلى ملف السجل');
  });

  await check('قصّ الأقدم عند تجاوز 4MiB مع بقاء الأحدث وسلامة JSONL', () => {
    const cwd = freshCwd('log-rotate');
    const file = genmedia.logFileFor(cwd);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const filler = JSON.stringify({ id: 'gen_1_old', at: '2020-01-01T00:00:00.000Z', pad: 'x'.repeat(4000) });
    const lines = [];
    for (let i = 0; i < 1200; i += 1) lines.push(filler);
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
    assert.ok(fs.statSync(file).size > genmedia.LOG_MAX_BYTES, 'ملف التحضير أصغر من السقف');

    // إلحاق سطر جديد يفعّل القصّ
    const res = genmedia.generate({ cwd, kind: 'image', prompt: 'newest', model: 'test/works-mid' }, ctxFor());
    return res.then((r) => {
      assert.strictEqual(r.ok, true);
      const size = fs.statSync(file).size;
      assert.ok(size <= genmedia.LOG_MAX_BYTES, 'السجل تجاوز السقف بعد القصّ: ' + size);
      const after = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      for (const l of after) JSON.parse(l); // سلامة كل سطر
      const last = JSON.parse(after[after.length - 1]);
      assert.strictEqual(last.status, 'completed', 'الأحدث لم يبقَ في الذيل');
      assert.ok(after.length < 1200, 'لم يُقصّ شيء');
    });
  });

  await check('readLog يعيد الأحدث أولاً ويتخطى السطر التالف', () => {
    const cwd = freshCwd('log-read');
    const file = genmedia.logFileFor(cwd);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file,
      JSON.stringify({ id: 'gen_1_a', status: 'completed' }) + '\n'
      + '{ this is not json\n'
      + JSON.stringify({ id: 'gen_2_b', status: 'failed' }) + '\n', 'utf8');
    const items = genmedia.readLog(cwd, 200);
    assert.strictEqual(items.length, 2, 'عدد المقروء: ' + items.length);
    assert.strictEqual(items[0].id, 'gen_2_b', 'الترتيب ليس الأحدث أولاً');
  });

  // ---------- عدم تسريب المفتاح ----------
  await check('المفتاح يصل ترويسة الاعتماد ولا يتسرّب إلى نتيجة أو سجل أو رسالة خطأ', async () => {
    const cwd = freshCwd('leak');
    seen.authHeaders.length = 0;
    seen.assetAuth.length = 0;

    const okRes = await genmedia.generate({ cwd, kind: 'image', prompt: 'x', model: 'test/works-mid' }, ctxFor());
    const failRes = await genmedia.generate({ cwd, kind: 'image', prompt: 'y', model: 'test/always-fails-cheap' }, ctxFor());
    const budgetRes = await genmedia.generate({ cwd, kind: 'image', prompt: 'z', model: 'test/works-mid', budget_usd: 0 }, ctxFor());

    // وصل فعلاً بالصيغة الصحيحة
    assert.ok(seen.authHeaders.some((h) => h === 'Key ' + FAKE_KEY), 'المفتاح لم يصل ترويسة Authorization');
    // ولم يُرسل مع جلب الأصل (كما رصد المسبار: الأصل بلا اعتماد)
    assert.ok(seen.assetAuth.every((h) => !h), 'أُرسل اعتماد مع جلب الأصل');

    const blobs = [JSON.stringify(okRes), JSON.stringify(failRes), JSON.stringify(budgetRes),
      JSON.stringify(genmedia.listCatalog()), fs.readFileSync(genmedia.logFileFor(cwd), 'utf8')];
    for (const blob of blobs) {
      assert.ok(!blob.includes(FAKE_KEY), 'المفتاح تسرّب!');
      assert.ok(!blob.includes('TESTKEY'), 'جزء من المفتاح تسرّب!');
    }
    // ولا في أسماء الملفات المكتوبة
    for (const f of fs.readdirSync(path.join(cwd, 'generations'))) {
      assert.ok(!f.includes('TESTKEY'), 'المفتاح في اسم ملف!');
    }
  });

  await check('رسائل الأخطاء عربية وبلا نص مزوّد خام', () => {
    for (const code of ['over_budget', 'no_provider', 'provider_error', 'asset_rejected', 'refs_outside']) {
      const msg = genmedia.messageFor({ error_code: code });
      assert.ok(msg && /[\u0600-\u06FF]/.test(msg), 'رسالة غير عربية للرمز: ' + code);
    }
    const unproven = genmedia.messageFor({ error_code: 'provider_unproven', provider: 'openai' });
    assert.ok(unproven.includes('platform.openai.com'), 'رسالة unproven بلا إرشاد');
  });

  // ---------- مدخلات فاسدة ----------
  await check('المدخلات الفاسدة مرفوضة fail-closed بلا شبكة', async () => {
    const cwd = freshCwd('bad-input');
    const before = seen.submits.length;
    const cases = [
      [{ cwd, kind: 'audio', prompt: 'x' }, 'unsupported_kind'],
      [{ cwd, kind: 'image', prompt: '   ' }, 'bad_input'],
      [{ cwd, kind: 'image', prompt: 'x', count: 0 }, 'bad_count'],
      [{ cwd, kind: 'image', prompt: 'x', count: 9 }, 'bad_count'],
      [{ cwd, kind: 'image', prompt: 'x', count: 1.5 }, 'bad_count'],
      [{ cwd, kind: 'image', prompt: 'x', model: 'no/such-model' }, 'unknown_model'],
      [{ cwd, kind: 'video', prompt: 'x', model: 'test/works-mid' }, 'kind_mismatch'],
      [{ cwd: 'relative/path', kind: 'image', prompt: 'x' }, 'bad_cwd'],
      [{ cwd: path.join(TMP, 'does-not-exist'), kind: 'image', prompt: 'x' }, 'bad_cwd'],
      [{ cwd, kind: 'image', prompt: 'x', model: 'test/works-mid', budget_usd: -1 }, 'bad_input'],
    ];
    for (const [req, expected] of cases) {
      const res = await genmedia.generate(req, ctxFor());
      assert.strictEqual(res.ok, false, 'قُبل مدخل فاسد: ' + JSON.stringify(req.kind || req.cwd));
      assert.strictEqual(res.error_code, expected, JSON.stringify(req) + ' -> ' + res.error_code);
    }
    assert.strictEqual(seen.submits.length, before, 'جرى نداء شبكة بمدخل فاسد');
  });

  await check('count فوق سقف النموذج يُرفض (فيديو max_count=1)', async () => {
    const cwd = freshCwd('count');
    const res = await genmedia.generate({ cwd, kind: 'video', prompt: 'x', model: 'test/works-video', count: 3 }, ctxFor());
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error_code, 'count_exceeded');
  });

  // ---------- الخاتمة ----------
  server.close();
  console.log('');
  if (failures.length) {
    console.log('genmedia-test: FAILED — ' + failures.length + ' فحصاً');
    for (const f of failures) console.log('  - ' + f);
    process.exitCode = 1;
  } else {
    console.log('genmedia-test: ok — ' + passed + '/' + total
      + ' (التوجيه والسقوط، السقف الصلب، schema السجل والقصّ، تفريغ السر، حصر المراجع، حارس النطاق، عدم تسريب المفتاح)');
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* أفضل جهد */ }
}

// نقل افتراضي للاختبار (يُستعمل داخل حالة نوع الأصل المرفوض)
function defaultCtxRequest(method, url, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const h = Object.assign({}, headers);
    if (payload) { h['content-type'] = 'application/json'; h['content-length'] = String(payload.length); }
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: h,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const ct = String(res.headers['content-type'] || '');
        let json = null;
        if (ct.includes('json')) { try { json = JSON.parse(buf.toString('utf8')); } catch (e) { /* ليس JSON */ } }
        resolve({ status: res.statusCode, headers: res.headers, buffer: buf, json, contentType: ct });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

main().catch((e) => {
  console.log('genmedia-test: FATAL — ' + (e && e.message ? e.message : e));
  if (server) try { server.close(); } catch (x) { /* تنظيف */ }
  process.exitCode = 1;
});
