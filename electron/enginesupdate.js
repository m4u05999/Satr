'use strict';

// كشف تأخّر إصدارات المحرّكات — بلا تحديث تلقائي (طلب مالك 2026-08-24).
//
// العطل المُعالَج: كان «سطر» يقيس حداثة Claude Code بعتبة **محفورة في الكود**
// (`CLAUDE_MIN_RECOMMENDED`)، فبقي `2.1.220` يُعدّ حديثاً وهو متأخر 21 إصداراً عن
// `2.1.241`؛ ولم يكن هناك فحص لـCodex ولا Kimi إطلاقاً. العتبة الثابتة تقيس «أقدم من
// حدّ ميزات قديم» لا «متأخر عن الحالي»، وتتقادم مع كل إصدار من «سطر».
//
// **لماذا لا تحديث تلقائي؟** عقود المحرّكات هنا مثبتة بمسابير حية (app-server لـCodex،
// وACP لـKimi، وSDK لكلود). إصدار جديد قد يكسر عقداً، فيستيقظ المستخدم على تطبيق
// معطَّل بلا سبب ظاهر — وأسوأ منه أن يقع التحديث أثناء دور جارٍ. لذلك: نكشف، ونُعلم،
// ونحدّث بضغطة صريحة في طرفية مرئية. نفس فلسفة محدّث «سطر» نفسه.
//
// صفر اعتماديات: https المدمجة. ولا تنفيذ هنا — هذه الوحدة **تقرأ وتقارن فقط**؛
// الأوامر ثابتة في هذا الملف ولا تأتي من renderer، وتشغيلها يقع في main عبر termjobs.

const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

// قناة التحديث تختلف عن قناة معرفة الإصدار:
//   npm    ⇒ يُثبَّت ويُحدَّث بـnpm.
//   script ⇒ Kimi على ويندوز مثبَّت مستقلاً؛ `kimi upgrade` يرفض صراحةً
//            («Detected install source: native (windows). Auto-update is not supported»)
//            ويوجّه إلى سكربت التثبيت. لكن **رقم إصداره يُقرأ من npm** — رسالة kimi
//            نفسها تقارن بـnpm (رصد حيّ: «0.27.0 -> 0.38.0»).
const ENGINES = Object.freeze([
  Object.freeze({
    id: 'claude', label: 'Claude Code', pkg: '@anthropic-ai/claude-code',
    channel: 'npm', command: 'npm i -g @anthropic-ai/claude-code@latest',
    // درس مسجَّل: المثبّت الأصلي (native) يكسر اكتشاف المسار في «سطر» — npm حصراً.
    note: 'حدّثه بـnpm لا بالمثبّت الأصلي — الأخير يكسر اكتشاف المسار في «سطر».',
  }),
  Object.freeze({
    id: 'codex', label: 'Codex', pkg: '@openai/codex',
    channel: 'npm', command: 'npm i -g @openai/codex@latest', note: '',
  }),
  Object.freeze({
    id: 'kimi', label: 'Kimi Code', pkg: '@moonshot-ai/kimi-code',
    channel: 'script', command: 'irm https://code.kimi.com/kimi-code/install.ps1 | iex',
    note: 'نسخة ويندوز مستقلة عن npm: «kimi upgrade» يرفض الترقية ويوجّه إلى سكربت التثبيت.',
  }),
]);

const ENGINE_IDS = Object.freeze(ENGINES.map((e) => e.id));
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // استعلام مرة يومياً — لا مع كل إقلاع
const FETCH_TIMEOUT_MS = 6000;
const MAX_BODY = 64 * 1024;
const SAFE_VERSION = /^\d{1,5}\.\d{1,5}\.\d{1,5}(?:-[A-Za-z0-9.]{1,32})?$/;

function cachePath() {
  return path.join(os.homedir(), '.satr', 'engine-versions.json');
}

function readCache() {
  try {
    const raw = fs.readFileSync(cachePath(), 'utf8');
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : {};
  } catch { return {}; }
}

function writeCache(value) {
  try {
    const file = cachePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value), 'utf8');
    fs.renameSync(tmp, file); // ذرّي أفضل جهد — فشل القرص لا يكسر الفحص
  } catch { /* الكاش راحة لا شرط */ }
}

// أصغر استعلام ممكن: نقطة `/latest` تعيد وثيقة النسخة وحدها لا كل التاريخ.
function fetchLatest(pkg, deps) {
  const get = (deps && deps.get) || https.get;
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let request;
    try {
      request = get('https://registry.npmjs.org/' + encodeURIComponent(pkg).replace(/%40/, '@') + '/latest',
        { headers: { accept: 'application/json' } }, (res) => {
          if (res.statusCode !== 200) { res.resume(); finish(null); return; }
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            if (body.length < MAX_BODY) body += chunk;
            else res.destroy();
          });
          res.on('end', () => {
            try {
              const value = JSON.parse(body);
              const version = value && typeof value.version === 'string' ? value.version.trim() : '';
              finish(SAFE_VERSION.test(version) ? version : null);
            } catch { finish(null); }
          });
        });
    } catch { finish(null); return; }
    request.on('error', () => finish(null));
    request.setTimeout(FETCH_TIMEOUT_MS, () => { try { request.destroy(); } catch {} finish(null); });
  });
}

// مقارنة semver مبسّطة: الأرقام الثلاثة فقط. اللاحقة (-beta) تُتجاهل عمداً — لا نريد
// أن نعلن تأخّراً بسبب نسخة تجريبية.
function parseVersion(text) {
  const m = /(\d{1,5})\.(\d{1,5})\.(\d{1,5})/.exec(String(text || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

// «متأخر بكم إصداراً» على مستوى patch وحده حين يتطابق major.minor — رقم إرشادي
// للعرض لا مقياس دقيق (قفزة minor تعيد null فيُعرض «متأخر» بلا عدد).
function patchGap(installed, latest) {
  const x = parseVersion(installed);
  const y = parseVersion(latest);
  if (!x || !y || x[0] !== y[0] || x[1] !== y[1]) return null;
  const gap = y[2] - x[2];
  return gap > 0 ? gap : null;
}

// `installed` خريطة {id: نسخة أو فارغ}. لا تُشغَّل هنا أوامر ولا تُقرأ ثنائيات —
// اكتشاف النسخ المثبَّتة مسؤولية main (المسبارات القائمة).
async function check(installed, options) {
  const settings = options && typeof options === 'object' ? options : {};
  const now = Number.isFinite(settings.now) ? settings.now : Date.now();
  const cache = settings.noCache ? {} : readCache();
  const next = Object.assign({}, cache);
  const source = installed && typeof installed === 'object' ? installed : {};
  let changed = false;

  const engines = await Promise.all(ENGINES.map(async (engine) => {
    const entry = cache[engine.id];
    let latest = entry && SAFE_VERSION.test(String(entry.latest || '')) ? entry.latest : null;
    const fresh = entry && Number.isFinite(entry.at) && (now - entry.at) < CACHE_TTL_MS;
    if (!fresh) {
      const fetched = await fetchLatest(engine.pkg, settings);
      if (fetched) { latest = fetched; next[engine.id] = { latest: fetched, at: now }; changed = true; }
    }
    const current = typeof source[engine.id] === 'string' ? source[engine.id].trim() : '';
    const cmp = current && latest ? compareVersions(current, latest) : null;
    return {
      id: engine.id, label: engine.label, channel: engine.channel,
      command: engine.command, note: engine.note,
      installed: current || '', latest: latest || '',
      // fail-open: تعذّر معرفة الأحدث لا يعني تأخّراً — لا ننبّه على شكّ
      behind: cmp === -1, gap: cmp === -1 ? patchGap(current, latest) : null,
    };
  }));

  if (changed && !settings.noCache) writeCache(next);
  return { engines, anyBehind: engines.some((e) => e.behind) };
}

// أمر التحديث يُشتق من المعرّف فقط — لا نص أمر يعبر من renderer إطلاقاً.
function commandFor(id) {
  const engine = ENGINES.find((e) => e.id === id);
  return engine ? engine.command : null;
}

module.exports = {
  ENGINES, ENGINE_IDS, CACHE_TTL_MS,
  parseVersion, compareVersions, patchGap, check, commandFor, fetchLatest,
};
