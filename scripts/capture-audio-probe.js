'use strict';
/**
 * مسبار م4 + م5 — الصوت في التقاط البرومو (الميكروفون وصوت النظام).
 *
 * السؤالان:
 *   م4: هل يمكن تسجيل صوت المستخدم (ميكروفون) مع لقطة المنتج؟ وأين البوابة فعلاً؟
 *       وكم ينحرف الصوت عن الصورة على 60 ثانية؟ وهل يبقى مساراً مستقلاً قابلاً للكتم؟
 *   م5: هل يعمل `audio:'loopback'` على ويندوز؟ وهل يلتقط النافذة وحدها أم النظام كله؟
 *
 * المنهج: نوافذ Electron حقيقية — نافذة «منتج» تومض أبيض وتُطلق نغمة في اللحظة نفسها،
 * ونافذة «مسجّلة» تبني MediaStream وتسجّل بـMediaRecorder، ثم يُحلَّل الملف الناتج
 * بـffmpeg (لمعة الإطار مقابل ظرف الصوت) لقياس الانحراف والإشارة الفعلية.
 *
 * لا يعدّل هذا المسبار أي ملف إنتاج. يستورد `promocapture.mediaSourceWindowKey` فقط
 * (دالة نقية) لمطابقة معرّف النافذة بالطريقة الإنتاجية نفسها.
 *
 * التشغيل:  npx electron scripts/capture-audio-probe.js [--quick] [--only=1,2,...]
 * الخرج:    dist/capture-audio-probe/  (‏results.json + المقاطع للمعاينة البشرية)
 */

const { app, BrowserWindow, desktopCapturer, session } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const promocapture = require('../electron/promocapture'); // قراءة فقط — دالة نقية

const OUT_DIR = path.join(__dirname, '..', 'dist', 'capture-audio-probe');
const PAGE = path.join(__dirname, 'fixtures', 'audio-probe-page.html');
const QUICK = process.argv.includes('--quick');
const ONLY = (() => {
  const arg = process.argv.find((a) => a.startsWith('--only='));
  return arg ? new Set(arg.slice(7).split(',').map((s) => s.trim())) : null;
})();

const HARD_TIMEOUT_MS = QUICK ? 8 * 60 * 1000 : 30 * 60 * 1000;
const LOOPBACK_REPS = QUICK ? 3 : 20;
const DRIFT_MS = QUICK ? 20000 : 60000;
const MARKER_EVERY_MS = 10000;
const PRODUCT_W = 960;
const PRODUCT_H = 540;

const results = { meta: {}, stages: {} };
const log = [];

function note(line) {
  const text = '[' + new Date().toISOString().slice(11, 23) + '] ' + line;
  log.push(text);
  try { process.stdout.write(text + '\n'); } catch {}
}

function persist() {
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, 'results.json'), JSON.stringify(results, null, 2), 'utf8');
    fs.writeFileSync(path.join(OUT_DIR, 'probe.log'), log.join('\n') + '\n', 'utf8');
  } catch (e) { try { process.stderr.write('persist failed: ' + e.message + '\n'); } catch {} }
}

// حارس التعليق: خطأ في العملية الرئيسية قد يعلّقها بحوار بدل أن ينهيها (درس مثبّت)
process.on('uncaughtException', (err) => {
  note('FATAL uncaughtException: ' + (err && err.stack || err));
  results.fatal = String(err && err.message || err);
  persist();
  try { app.exit(1); } catch { process.exit(1); }
});
process.on('unhandledRejection', (err) => {
  note('FATAL unhandledRejection: ' + (err && err.stack || err));
  results.fatal = String(err && err.message || err);
  persist();
  try { app.exit(1); } catch { process.exit(1); }
});
setTimeout(() => {
  note('FATAL hard timeout reached — writing partial results');
  results.fatal = 'hard_timeout';
  persist();
  try { app.exit(2); } catch { process.exit(2); }
}, HARD_TIMEOUT_MS).unref();

app.on('window-all-closed', () => {}); // لا نغلق: نافذة offscreen ثانية بعد الإتلاف تفشل ERR_FAILED

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- تشغيل عمليات خارجية (ffmpeg/ffprobe/powershell) ----------

function run(cmd, args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true });
    const out = []; let err = '';
    let settled = false;
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => { err += d.toString('utf8'); if (err.length > 4e6) err = err.slice(-2e6); });
    const finish = (code, error) => {
      if (settled) return; settled = true;
      clearTimeout(timer);
      resolve({ code, out: Buffer.concat(out), err, error: error ? String(error.message || error) : '' });
    };
    child.on('error', (e) => finish(-1, e));
    child.on('close', (code) => finish(code));
  });
}

// ---------- تحليل الوسائط ----------

async function probeStreams(file) {
  const r = await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]);
  try {
    const j = JSON.parse(r.out.toString('utf8'));
    return {
      ok: true,
      format: { duration: Number(j.format && j.format.duration) || 0, size: Number(j.format && j.format.size) || 0,
                name: (j.format && j.format.format_name) || '' },
      streams: (j.streams || []).map((s) => ({
        type: s.codec_type, codec: s.codec_name, start_time: Number(s.start_time) || 0,
        duration: Number(s.duration) || 0, sample_rate: s.sample_rate ? Number(s.sample_rate) : undefined,
        channels: s.channels, width: s.width, height: s.height, avg_frame_rate: s.avg_frame_rate,
      })),
    };
  } catch (e) { return { ok: false, error: r.err.slice(-400) }; }
}

const AUDIO_RATE = 8000;

// فكّ الصوت إلى PCM أحادي 8kHz — الزمن = العيّنة/المعدل (لا نثق بأي byteRate).
// `aresample=async=1:first_pts=0` يملأ الفجوات الزمنية بالصمت بدل ضغطها، كي لا ينهار
// الخط الزمني إن جاء المسار مبتوراً (درس مقاس في المرحلة 7).
async function decodeAudio(file) {
  const r = await run('ffmpeg', ['-v', 'error', '-i', file, '-vn',
    '-af', 'aresample=async=1:first_pts=0', '-ac', '1', '-ar', String(AUDIO_RATE), '-f', 's16le', '-']);
  const buf = r.out;
  const n = Math.floor(buf.length / 2);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i += 1) pcm[i] = buf.readInt16LE(i * 2);
  return { pcm, seconds: n / AUDIO_RATE, err: r.err.slice(-300) };
}

// لمعة كل إطار + طابعه الزمني الحقيقي — **من مجرى واحد مقترن سلفاً**.
//
// درس مثبّت (‏2026-08-21): النسخة الأولى قرأت اللمعة من الإطارات الخام على stdout
// والطوابع من سطور showinfo على stderr ثم زاوجتهما **بالفهرس**. حين اختلف العددان
// (‏1938 إطاراً خاماً مقابل 1545 طابعاً) انهار التزاوج، وسقطت الإطارات الزائدة على
// احتياطي `i/30` الذي يفترض 30fps بينما الملف يسلّم ‏23.96fps فعلياً — فخرجت ومضات
// كل 10ث بتباعد ~12ث (نسبة 30/23.96 = 1.252 تطابق 1938/1545 = 1.254).
//
// العلاج: `signalstats` يحسب متوسط اللمعة، و`metadata=print` يطبع القيمة **مع** طابعها
// الزمني في سطرين متلاصقين لكل إطار. مصدر واحد ⇒ لا تزاوج بالفهرس ⇒ لا انزياح ممكن.
async function decodeLuma(file) {
  const r = await run('ffmpeg', ['-v', 'error', '-i', file, '-an',
    '-vf', 'scale=8:8,format=gray,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-',
    '-f', 'null', '-']);
  const text = r.out.toString('utf8');
  const frames = [];
  const re = /pts_time:([0-9.]+)[^\n]*\n[^\n]*YAVG=([0-9.]+)/g;
  let m;
  while ((m = re.exec(text))) frames.push({ t: Number(m[1]), y: Number(m[2]) });
  return { frames, parsedTimes: frames.length, rawFrames: frames.length };
}

function rmsOf(pcm) {
  let sum = 0;
  for (let i = 0; i < pcm.length; i += 1) sum += pcm[i] * pcm[i];
  return pcm.length ? Math.sqrt(sum / pcm.length) / 32768 : 0;
}

function nonZeroCount(pcm) {
  let c = 0;
  for (let i = 0; i < pcm.length; i += 1) if (pcm[i] !== 0) c += 1;
  return c;
}

// طاقة تردد محدد داخل نافذة (Goertzel) — لتمييز مصدر النغمة في اختبار النطاق
function goertzel(pcm, from, to, freq, rate = AUDIO_RATE) {
  const n = Math.max(1, to - from);
  const k = Math.round((n * freq) / rate);
  const w = (2 * Math.PI * k) / n;
  const cw = Math.cos(w), coeff = 2 * cw;
  let s0 = 0, s1 = 0, s2 = 0;
  for (let i = from; i < to && i < pcm.length; i += 1) {
    s0 = (pcm[i] / 32768) + coeff * s1 - s2;
    s2 = s1; s1 = s0;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2) / n;
}

// ظرف RMS بنوافذ قصيرة + كشف بدايات النغمات
function envelope(pcm, hopMs = 5) {
  const hop = Math.round((AUDIO_RATE * hopMs) / 1000);
  const env = [];
  for (let i = 0; i + hop <= pcm.length; i += hop) {
    env.push({ t: i / AUDIO_RATE, v: rmsOf(pcm.subarray(i, i + hop)) });
  }
  return env;
}

// ظرف طاقة نطاق ضيق حول تردد العلامة — يتجاهل الحامل المستمر وضجيج النطاقات الأخرى
function bandEnvelope(pcm, freq, hopMs = 5) {
  const hop = Math.round((AUDIO_RATE * hopMs) / 1000);
  const win = Math.max(hop, Math.round((AUDIO_RATE * 20) / 1000)); // نافذة 20ms لدقة التردد
  const env = [];
  for (let i = 0; i + win <= pcm.length; i += hop) {
    env.push({ t: i / AUDIO_RATE, v: goertzel(pcm, i, i + win, freq) });
  }
  return env;
}

function onsets(series, key, threshold, refractoryS) {
  const hits = [];
  let last = -Infinity, armed = true;
  for (const p of series) {
    const v = p[key];
    if (v >= threshold && armed && p.t - last > refractoryS) { hits.push(p.t); last = p.t; armed = false; }
    if (v < threshold * 0.5) armed = true;
  }
  return hits;
}

function stats(values) {
  if (!values.length) return { n: 0 };
  const s = [...values].sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const p = (q) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
  return { n: values.length, min: +s[0].toFixed(1), max: +s[s.length - 1].toFixed(1),
           mean: +mean.toFixed(1), median: +p(0.5).toFixed(1), p95: +p(0.95).toFixed(1) };
}

// ميل الانحراف عبر العلامات (ms لكل ثانية) — يفرّق الثابت عن المتراكم
function slopePerSecond(points) {
  const n = points.length;
  if (n < 2) return null;
  const mx = points.reduce((a, p) => a + p.x, 0) / n;
  const my = points.reduce((a, p) => a + p.y, 0) / n;
  let num = 0, den = 0;
  for (const p of points) { num += (p.x - mx) * (p.y - my); den += (p.x - mx) * (p.x - mx); }
  return den ? +(num / den).toFixed(3) : null;
}

// ---------- نوافذ المسبار ----------

const windows = new Map();
const pendingDownloads = new Map();

function attachDownloads(ses) {
  if (ses.__probeDownloads) return;
  ses.__probeDownloads = true;
  ses.on('will-download', (event, item) => {
    const name = item.getFilename();
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(name)) { item.cancel(); return; }
    const target = path.join(OUT_DIR, name);
    item.setSavePath(target);
    item.once('done', (e, state) => {
      const waiter = pendingDownloads.get(name);
      if (waiter) { pendingDownloads.delete(name); waiter({ state, path: target, bytes: item.getReceivedBytes() }); }
    });
  });
}

function awaitDownload(name, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pendingDownloads.delete(name); resolve({ state: 'timeout' }); }, timeoutMs);
    pendingDownloads.set(name, (r) => { clearTimeout(timer); resolve(r); });
  });
}

const winOpts = new Map();
const crashes = [];

async function mkWin(key, opts = {}) {
  const existing = windows.get(key);
  if (existing && !existing.isDestroyed()) return existing;
  if (existing) {
    // النافذة ماتت (انهيار renderer غالباً) — نعيد بناءها بالخيارات نفسها ونسجّل الحادث
    note('  window "' + key + '" was destroyed — recreating');
    windows.delete(key);
    opts = { ...(winOpts.get(key) || {}), ...opts };
  }
  winOpts.set(key, opts);
  const win = new BrowserWindow({
    width: opts.width || 480, height: opts.height || 320,
    x: opts.x, y: opts.y,
    show: opts.show !== false,
    frame: false, resizable: false, autoHideMenuBar: true, backgroundColor: '#000000',
    useContentSize: true,
    webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false,
      ...(opts.partition ? { partition: opts.partition } : {}),
    },
  });
  attachDownloads(win.webContents.session);
  win.webContents.on('render-process-gone', (event, details) => {
    const item = { window: key, reason: details && details.reason, exitCode: details && details.exitCode };
    crashes.push(item);
    note('  RENDERER GONE [' + key + ']: ' + JSON.stringify(item));
  });
  await win.loadFile(PAGE, { search: 'role=' + (opts.role || key) });
  await delay(250);
  windows.set(key, win);
  return win;
}

const js = (win, code, gesture = false) => win.webContents.executeJavaScript(code, gesture);

// النافذتان الدائمتان — تُعاد تهيئتهما تلقائياً إن انهار renderer
const recorderWin = () => mkWin('recorder', { role: 'recorder', show: true, width: 420, height: 260, x: 40, y: 40 });
const productWin = () => mkWin('product', { role: 'product', show: true, width: PRODUCT_W, height: PRODUCT_H, x: 520, y: 40 });

// مطابقة نافذة المنتج بمعرّف مصدر desktopCapturer — بالطريقة الإنتاجية نفسها
async function sourceForWindow(win) {
  const key = promocapture.mediaSourceWindowKey(win.getMediaSourceId());
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const sources = await desktopCapturer.getSources({
      types: ['window'], thumbnailSize: { width: 1, height: 1 }, fetchWindowIcons: false,
    });
    const found = sources.find((s) => promocapture.mediaSourceWindowKey(s.id) === key);
    if (found) return { source: found, enumerated: true, id: found.id };
    await delay(250);
  }
  return { source: null, enumerated: false, id: win.getMediaSourceId() };
}

// نمط منح loopback الذي أثبتت المرحلة 2 نجاحه فعلياً (لا نفترضه — نضبطه من القياس).
// الافتراضي = ما رصدته المرحلة 2 حياً: mainFrame ينجح، ومصدر النافذة يردّ AbortError.
// تشغيل المراحل 5/6/9 بلا المرحلة 2 كان يسقط على الافتراضي القديم الخاطئ.
let loopbackMode = { useFrame: true, screen: false, audio: 'loopback' };

function installLoopbackHandler(ses, product, audio = 'loopback') {
  ses.setDisplayMediaRequestHandler(async (request, cb) => {
    let video = null;
    if (loopbackMode.useFrame) {
      video = product.webContents.mainFrame;
    } else {
      const list = await desktopCapturer.getSources({
        types: loopbackMode.screen ? ['screen'] : ['window'],
        thumbnailSize: { width: 1, height: 1 }, fetchWindowIcons: false,
      });
      video = loopbackMode.screen ? list[0]
        : list.find((s) => promocapture.mediaSourceWindowKey(s.id)
            === promocapture.mediaSourceWindowKey(product.getMediaSourceId()));
    }
    try { cb(video ? (audio ? { video, audio } : { video }) : {}); }
    catch (e) { note('  loopback cb threw: ' + String(e.message || e).slice(0, 80)); }
  }, { useSystemPicker: false });
}

// ---------- تنفيذ تسجيل كامل ----------

let recSeq = 0;

async function doRecord(recWin, spec) {
  recSeq += 1;
  const filename = spec.filename || ('rec-' + String(recSeq).padStart(2, '0'));
  const payload = JSON.stringify({ ...spec, filename });
  const out = await js(recWin, '__probe.record(' + payload + ')', true);
  if (out && out.ok && out.filename) {
    const saved = await awaitDownload(out.filename);
    out.saved = saved;
    if (out.filename2) out.saved2 = await awaitDownload(out.filename2);
  }
  return out;
}

// ---------- المراحل ----------

const stages = [];
const stage = (id, title, fn) => stages.push({ id, title, fn });

// ---- المرحلة 0: البيئة ----
stage('0', 'البيئة والأجهزة', async () => {
  const rec = await recorderWin();
  const devices = await js(rec, '__probe.devices()');
  // أسماء مداخل الصوت: حاسمة للصدق — «3 أجهزة» لا تعني ميكروفوناً فيزيائياً متصلاً
  const inputs = await js(rec, '__probe.audioInputs()');
  const ff = await run('ffmpeg', ['-version'], 15000);
  return {
    electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node,
    platform: process.platform, release: os.release(), arch: process.arch,
    ffmpeg: (ff.out.toString('utf8').split('\n')[0] || '').slice(0, 60),
    devices, audioInputs: inputs,
    quick: QUICK,
  };
});

// ---- المرحلة 1: بوابة الميكروفون (مصفوفة المعالجَين) ----
stage('1', 'م4 — أين بوابة الميكروفون فعلاً؟', async () => {
  const cells = [
    { req: 'none', chk: 'none' },
    { req: 'deny', chk: 'none' },
    { req: 'none', chk: 'deny' },
    { req: 'deny', chk: 'deny' },
    { req: 'allow', chk: 'allow' },
    { req: 'allow', chk: 'deny' },
  ];
  const rows = [];
  for (let i = 0; i < cells.length; i += 1) {
    const cell = cells[i];
    // جلسة مستقلة في الذاكرة لكل خلية: قرارات Chromium تُخزَّن لكل أصل/جلسة
    const part = 'capture-audio-probe-gate-' + i;
    const ses = session.fromPartition(part);
    const seen = { request: [], check: [] };
    if (cell.req !== 'none') {
      ses.setPermissionRequestHandler((wc, permission, cb) => {
        seen.request.push(permission);
        cb(cell.req === 'allow');
      });
    } else ses.setPermissionRequestHandler(null);
    if (cell.chk !== 'none') {
      ses.setPermissionCheckHandler((wc, permission) => {
        seen.check.push(permission);
        return cell.chk === 'allow';
      });
    } else ses.setPermissionCheckHandler(null);

    const win = await mkWin('gate' + i, { role: 'gate', partition: part, show: false, width: 200, height: 120 });
    const res = await js(win, '__probe.micGate()', true);
    rows.push({
      requestHandler: cell.req, checkHandler: cell.chk,
      granted: !!res.ok, errorName: res.name || '', ms: res.ms,
      requestFired: seen.request.slice(0, 4), checkFired: seen.check.slice(0, 6),
      trackHasLabel: res.tracks ? !!(res.tracks[0] && res.tracks[0].hasLabel) : null,
    });
    note('  gate[req=' + cell.req + ',chk=' + cell.chk + '] granted=' + !!res.ok + ' err=' + (res.name || '-')
      + ' reqFired=' + JSON.stringify(seen.request) + ' chkFired=' + JSON.stringify(seen.check.slice(0, 3)));
  }
  const defaultCell = rows[0];
  return {
    rows,
    verdict: {
      defaultGrantsSilently: defaultCell.granted && defaultCell.requestFired.length === 0,
      requestHandlerIsAuthoritative: rows[1].granted === false,
      checkHandlerAloneBlocks: rows[2].granted === false,
    },
  };
});

// ---- المرحلة 2: هل يفير معالج getDisplayMedia في المسار الإنتاجي؟ ----
stage('2', 'م5 — أي مسار يستدعي setDisplayMediaRequestHandler؟', async () => {
  const rec = await recorderWin();
  const product = await mkWin('product', { role: 'product', show: true, width: PRODUCT_W, height: PRODUCT_H, x: 520, y: 40 });
  const src = await sourceForWindow(product);
  results.meta.productSource = { enumerated: src.enumerated, idShape: /^window:/.test(src.id) ? 'window:*' : 'other' };

  const ses = rec.webContents.session;
  const fired = [];

  // (أ) المسار الإنتاجي الحالي: getUserMedia بقيود chromeMediaSource — هل يستدعي المعالج أصلاً؟
  ses.setDisplayMediaRequestHandler((request, cb) => {
    fired.push({ path: 'legacy', videoRequested: request.videoRequested === true,
                 audioRequested: request.audioRequested === true });
    cb(src.source ? { video: src.source } : {});
  }, { useSystemPicker: false });
  const legacy = await doRecord(rec, {
    id: 'legacy-video-only', filename: 'p2-legacy-video', durationMs: 1500,
    video: { sourceId: src.id, width: PRODUCT_W, height: PRODUCT_H, fps: 30 },
    audioSources: [], mix: 'tracks', bitrate: 3000000,
  });
  const handlerFiredForLegacy = fired.length;
  note('  legacy getUserMedia ok=' + legacy.ok + ' handlerFired=' + handlerFiredForLegacy);

  // (ب) المسار الحديث: أي شكل من ردود المعالج ينجح فعلاً على ويندوز؟
  // ملاحظة مقاسة: desktopCapturer لا يُدرج نافذة العملية نفسها (‏enumerated=false أعلاه)،
  // لذا نجرّب mainFrame أولاً — وهو المخرج الذي يسلكه الإنتاج أصلاً.
  const variants = [
    { key: 'mainFrame', audio: null, useFrame: true },
    { key: 'mainFrame+loopback', audio: 'loopback', useFrame: true },
    { key: 'mainFrame+loopbackWithMute', audio: 'loopbackWithMute', useFrame: true },
    { key: 'window-source+loopback', audio: 'loopback', useFrame: false },
    { key: 'screen-source+loopback', audio: 'loopback', useFrame: false, screen: true },
  ];
  const displayVariants = [];
  for (const v of variants) {
    let handlerSeen = null;
    let handedSourceId = '';
    ses.setDisplayMediaRequestHandler(async (request, cb) => {
      handlerSeen = { videoRequested: request.videoRequested === true, audioRequested: request.audioRequested === true };
      fired.push({ path: v.key, ...handlerSeen });
      let video = null;
      if (v.useFrame) {
        video = product.webContents.mainFrame;
        handedSourceId = 'mainFrame';
      } else {
        // مصدر طازج وقت النداء — المصادر القديمة قد تبطل
        const list = await desktopCapturer.getSources({
          types: v.screen ? ['screen'] : ['window'],
          thumbnailSize: { width: 1, height: 1 }, fetchWindowIcons: false,
        });
        video = v.screen ? list[0]
          : list.find((s) => promocapture.mediaSourceWindowKey(s.id) === promocapture.mediaSourceWindowKey(product.getMediaSourceId()));
        handedSourceId = video ? (v.screen ? 'screen:*' : 'window:*') : 'none';
      }
      // cb يرمي متزامناً إن لم يُقدَّم فيديو مطلوب — نلتقطه كي لا يُسقط المسبار كله
      try { cb(video ? (v.audio ? { video, audio: v.audio } : { video }) : {}); }
      catch (e) { note('  handler cb threw [' + v.key + ']: ' + String(e.message || e).slice(0, 80)); }
    }, { useSystemPicker: false });

    const out = await doRecord(rec, {
      id: 'display-' + v.key, filename: 'p2-' + v.key.replace(/[^a-z0-9]+/gi, '-'), durationMs: 1500,
      display: true, audioSources: [], mix: 'tracks', bitrate: 3000000,
    });
    let streams = null;
    if (out.ok && out.saved && out.saved.path) streams = await probeStreams(out.saved.path);
    displayVariants.push({
      variant: v.key, handedSourceId, handlerSeen,
      ok: out.ok, bytes: out.bytes || 0, errorName: out.errorName, error: out.error,
      trackCounts: out.trackCounts,
      fileStreams: streams ? streams.streams.map((s) => s.type + ':' + s.codec) : null,
    });
    note('  display[' + v.key + '] ok=' + out.ok + ' audioTracks='
      + (out.trackCounts ? out.trackCounts.audio : '-') + ' err=' + (out.errorName || out.error || '-'));
    await delay(300);
  }
  ses.setDisplayMediaRequestHandler(null);

  const working = displayVariants.filter((v) => v.ok);
  const withAudio = displayVariants.filter((v) => v.ok && v.trackCounts && v.trackCounts.audio > 0);
  const chosen = withAudio[0] || working[0] || null;
  if (chosen) {
    const v = variants.find((x) => x.key === chosen.variant);
    loopbackMode = { useFrame: !!v.useFrame, screen: !!v.screen, audio: v.audio || null };
    note('  loopback mode chosen: ' + chosen.variant);
  }
  return {
    legacyGetUserMedia: { ok: legacy.ok, bytes: legacy.bytes || 0, error: legacy.error, trackCounts: legacy.trackCounts },
    handlerFiredForLegacy,
    displayVariants,
    requests: fired,
    verdict: {
      productionGateIsDeadCodeForCurrentPath: handlerFiredForLegacy === 0,
      workingDisplayVariants: working.map((v) => v.variant),
      variantsYieldingAudioTrack: withAudio.map((v) => v.variant),
    },
  };
});

// ---- المرحلة 3: وجود صوت الميكروفون فعلياً ----
stage('3', 'م4 — مسار الميكروفون: موجود؟ وفيه صوت؟', async () => {
  const rec = await recorderWin();
  const product = await productWin();

  // نقيس ثلاث حالات كي نفرّق «بيئة صامتة» عن «معالجة Chromium ابتلعت النغمة»:
  //   default+silence : القيود الافتراضية بلا مصدر صوت   ⇒ خط الأساس
  //   raw+silence     : بلا AEC/NS/AGC وبلا مصدر         ⇒ هل المعالجة كانت السبب؟
  //   raw+tone        : بلا معالجة ونغمة 1000Hz بالسماعات ⇒ هل يلتقط الميكروفون شيئاً أصلاً؟
  const cases = [
    { key: 'default+silence', raw: false, tone: false },
    { key: 'raw+silence', raw: true, tone: false },
    { key: 'raw+tone', raw: true, tone: true },
  ];
  const rows = [];
  for (const c of cases) {
    if (c.tone) { await js(product, '__probe.toneStart(1000, 0.6)', true); await delay(500); }
    const out = await doRecord(rec, {
      id: 'mic-' + c.key, filename: 'p3-mic-' + c.key.replace(/[^a-z0-9]+/gi, '-'), durationMs: 4000,
      audioSources: [{ kind: 'mic', raw: c.raw }], mix: 'tracks',
    });
    if (c.tone) await js(product, '__probe.toneStop()');
    const file = out.ok && out.saved ? out.saved.path : null;
    const streams = file ? await probeStreams(file) : null;
    const audio = file ? await decodeAudio(file) : null;
    const half = audio ? Math.floor(audio.pcm.length / 2) : 0;
    const analysis = audio ? {
      seconds: +audio.seconds.toFixed(2),
      rms: +rmsOf(audio.pcm).toFixed(6),
      peakAbs: +(audio.pcm.reduce((a, v) => Math.max(a, Math.abs(v)), 0) / 32768).toFixed(6),
      nonZeroSamples: nonZeroCount(audio.pcm),
      totalSamples: audio.pcm.length,
      nonZeroRatio: audio.pcm.length ? +(nonZeroCount(audio.pcm) / audio.pcm.length).toFixed(4) : 0,
      tone1000: +goertzel(audio.pcm, Math.max(0, half - AUDIO_RATE), half, 1000).toFixed(6),
      noise1700: +goertzel(audio.pcm, Math.max(0, half - AUDIO_RATE), half, 1700).toFixed(6),
    } : null;
    rows.push({
      case: c.key,
      settings: out.trackLabels && out.trackLabels[0] ? out.trackLabels[0].settings : null,
      trackExists: !!(streams && streams.streams.some((s) => s.type === 'audio')),
      bytes: out.bytes || 0, mime: out.mime, error: out.error, errorName: out.errorName,
      analysis,
      hasSignal: !!(analysis && analysis.rms > 0.0005),
      hearsTone: !!(analysis && analysis.tone1000 > 0.001 && analysis.tone1000 > analysis.noise1700 * 6),
    });
    note('  mic[' + c.key + '] track=' + rows[rows.length - 1].trackExists
      + ' rms=' + (analysis ? analysis.rms : '-') + ' peak=' + (analysis ? analysis.peakAbs : '-')
      + ' tone=' + (analysis ? analysis.tone1000 : '-') + ' err=' + (out.errorName || '-'));
    await delay(300);
  }
  const anySignal = rows.some((r) => r.hasSignal);
  return {
    cases: rows,
    verdict: {
      trackExists: rows.every((r) => r.trackExists),
      hasSignal: anySignal,
      rawConstraintsAccepted: !!(rows[1].settings && rows[1].settings.echoCancellation === false),
      hearsSpeakerTone: rows.some((r) => r.hearsTone),
      // لا إشارة في الحالات الثلاث ⇒ الجهاز بلا مصدر صوت، لا عجز في المسار
      silentEnvironment: !anySignal,
    },
  };
});

// ---- المرحلة 4: الفصل — مسارات منفصلة أم مخبوزة ----
stage('4', 'م4/م5 — مسار منفصل قابل للكتم أم مخبوز؟', async () => {
  const rec = await recorderWin();
  const product = await productWin();
  const src = await sourceForWindow(product);

  // (أ) مساران صوتيان في مجرى واحد → كم مساراً في الملف؟
  // نغمتان مختلفتان (‏800/2200) كي نكشف: هل أُسقط الثاني أم مُزج مع الأول؟
  const twoTracks = await doRecord(rec, {
    id: 'two-audio-tracks', filename: 'p4-two-tracks', durationMs: 3000,
    video: { sourceId: src.id, width: PRODUCT_W, height: PRODUCT_H, fps: 30 },
    audioSources: [{ kind: 'tone', freq: 800, gain: 0.4 }, { kind: 'tone', freq: 2200, gain: 0.4 }],
    mix: 'tracks', bitrate: 3000000,
  });
  const twoStreams = twoTracks.saved && twoTracks.saved.path ? await probeStreams(twoTracks.saved.path) : null;
  // من نجا في الملف؟ الأول وحده ⇒ إسقاط · الاثنان ⇒ مزج قسري
  let survivors = null;
  if (twoTracks.saved && twoTracks.saved.path) {
    const audio = await decodeAudio(twoTracks.saved.path);
    const from = Math.floor(audio.pcm.length * 0.3), to = Math.floor(audio.pcm.length * 0.9);
    survivors = {
      first800: +goertzel(audio.pcm, from, to, 800).toFixed(6),
      second2200: +goertzel(audio.pcm, from, to, 2200).toFixed(6),
      noise1500: +goertzel(audio.pcm, from, to, 1500).toFixed(6),
    };
    note('  two-tracks survivors: 800=' + survivors.first800 + ' 2200=' + survivors.second2200
      + ' floor=' + survivors.noise1500);
  }

  // (ب) مسجّلان متوازيان: فيديو+صوت في ملف، والصوت وحده في ملف ثانٍ
  const parallel = await doRecord(rec, {
    id: 'parallel-recorders', filename: 'p4-parallel', durationMs: 3000,
    video: { sourceId: src.id, width: PRODUCT_W, height: PRODUCT_H, fps: 30 },
    audioSources: [{ kind: 'mic' }], mix: 'tracks', bitrate: 3000000, alsoAudioOnly: true,
  });
  const mainStreams = parallel.saved && parallel.saved.path ? await probeStreams(parallel.saved.path) : null;
  const sideStreams = parallel.saved2 && parallel.saved2.path ? await probeStreams(parallel.saved2.path) : null;

  const audioInFile = twoStreams ? twoStreams.streams.filter((s) => s.type === 'audio').length : null;
  const bothSurvive = !!(survivors && survivors.first800 > survivors.noise1500 * 4
    && survivors.second2200 > survivors.noise1500 * 4);
  const sideOk = !!(sideStreams && sideStreams.streams.some((s) => s.type === 'audio') && (parallel.bytes2 || 0) > 0);

  return {
    twoAudioTracksInOneStream: {
      streamTrackCounts: twoTracks.trackCounts, ok: twoTracks.ok, error: twoTracks.error,
      audioStreamsInFile: audioInFile,
      videoStreamsInFile: twoStreams ? twoStreams.streams.filter((s) => s.type === 'video').length : null,
      survivors,
    },
    parallelRecorders: {
      ok: parallel.ok, mainBytes: parallel.bytes || 0, sideBytes: parallel.bytes2 || 0,
      mainStreams: mainStreams ? mainStreams.streams.map((s) => s.type) : null,
      sideStreams: sideStreams ? sideStreams.streams.map((s) => s.type) : null,
      sideDuration: sideStreams ? sideStreams.format.duration : null,
    },
    verdict: {
      // مساران في MediaStream ⇒ كم مساراً في mp4؟
      tracksIn: twoTracks.trackCounts ? twoTracks.trackCounts.audio : null,
      audioStreamsOut: audioInFile,
      collapsedToOne: audioInFile === 1 && !!(twoTracks.trackCounts && twoTracks.trackCounts.audio > 1),
      // إن انهارا إلى واحد: هل مُزجا (كلاهما مسموع) أم أُسقط الثاني؟
      collapseIsMix: bothSurvive,
      collapseIsDrop: !!(survivors && survivors.first800 > survivors.noise1500 * 4 && !bothSurvive),
      // البديل المثبت: مسجّل ثانٍ يعطي ملف صوت مستقل قابل للكتم لاحقاً
      parallelSidecarWorks: sideOk,
      muteAfterTheFactPossible: sideOk,
    },
  };
});

// ---- المرحلة 5: هل يعمل loopback أصلاً؟ (تكرار) ----
stage('5', 'م5 — هل يعمل صوت النظام؟ (' + LOOPBACK_REPS + ' تسجيلات)', async () => {
  const rec = await recorderWin();
  const product = await productWin();
  const src = await sourceForWindow(product);
  const ses = rec.webContents.session;

  const requests = [];
  installLoopbackHandler(ses, product);

  // نغمة مستمرة من نافذة المنتج عبر السماعات
  const toneState = await js(product, '__probe.toneStart(1000, 0.5)', true);
  await delay(400);

  const runs = [];
  for (let i = 0; i < LOOPBACK_REPS; i += 1) {
    const out = await doRecord(rec, {
      id: 'loopback-' + i, filename: 'p5-loopback-' + String(i).padStart(2, '0'), durationMs: 8000,
      display: true, audioSources: [], mix: 'tracks', bitrate: 3000000,
    });
    let analysis = null;
    if (out.ok && out.saved && out.saved.path) {
      const audio = await decodeAudio(out.saved.path);
      const half = Math.floor(audio.pcm.length / 2);
      analysis = {
        seconds: +audio.seconds.toFixed(2),
        rms: +rmsOf(audio.pcm).toFixed(6),
        nonZeroRatio: audio.pcm.length ? +(nonZeroCount(audio.pcm) / audio.pcm.length).toFixed(4) : 0,
        tone1000: +goertzel(audio.pcm, Math.floor(half - AUDIO_RATE), half, 1000).toFixed(6),
      };
    }
    const pass = !!(analysis && analysis.rms > 0.0005 && analysis.tone1000 > 0.001);
    runs.push({ i, ok: out.ok, bytes: out.bytes || 0, error: out.error, errorName: out.errorName,
                trackCounts: out.trackCounts, analysis, pass });
    note('  loopback[' + i + '] ok=' + out.ok + ' pass=' + pass + ' rms=' + (analysis ? analysis.rms : '-')
      + ' tone=' + (analysis ? analysis.tone1000 : '-') + ' err=' + (out.errorName || out.error || '-'));
    if (!out.ok && i === 0) break; // لا فائدة من 20 تكراراً لمسار ساقط أصلاً
  }
  await js(product, '__probe.toneStop()');
  ses.setDisplayMediaRequestHandler(null);

  const passed = runs.filter((r) => r.pass).length;
  return {
    reps: runs.length, passed, threshold: LOOPBACK_REPS === 20 ? 19 : LOOPBACK_REPS,
    toneState, requests: requests.slice(0, 3),
    rmsStats: stats(runs.filter((r) => r.analysis).map((r) => r.analysis.rms * 1000)),
    runs,
    verdict: { works: passed >= (LOOPBACK_REPS === 20 ? 19 : Math.max(1, LOOPBACK_REPS - 1)) },
  };
});

// ---- المرحلة 6: نطاق loopback — النافذة أم النظام؟ ----
stage('6', 'م5 — هل يتسرّب صوت خارج نافذة المنتج؟', async () => {
  const rec = await recorderWin();
  const product = await productWin();
  const src = await sourceForWindow(product);
  const ses = rec.webContents.session;
  installLoopbackHandler(ses, product);

  // نافذة «غريبة» مستقلة تماماً عن نافذة المنتج المُلتقَطة
  const outsider = await mkWin('outsider', { role: 'outsider', show: true, width: 320, height: 200, x: 40, y: 360 });

  // عملية خارجية حقيقية: WAV مولَّد بـffmpeg يشغّله SoundPlayer في PowerShell
  const wav = path.join(OUT_DIR, 'p6-outsider-3500hz.wav');
  await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=3500:duration=9', '-ac', '2', wav]);
  const psCode = "$p=New-Object System.Media.SoundPlayer '" + wav.replace(/'/g, "''") + "';$p.PlaySync()";
  const external = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCode], 30000);

  await js(product, '__probe.toneStart(1000, 0.5)', true);
  await js(outsider, '__probe.toneStart(2500, 0.5)', true);
  await delay(600);

  const out = await doRecord(rec, {
    id: 'loopback-scope', filename: 'p6-scope', durationMs: 7000,
    display: true, audioSources: [], mix: 'tracks', bitrate: 3000000,
  });
  await js(product, '__probe.toneStop()');
  await js(outsider, '__probe.toneStop()');
  ses.setDisplayMediaRequestHandler(null);
  await external;

  let tones = null;
  if (out.ok && out.saved && out.saved.path) {
    const audio = await decodeAudio(out.saved.path);
    const from = Math.floor(audio.pcm.length * 0.3), to = Math.floor(audio.pcm.length * 0.8);
    tones = {
      product1000: +goertzel(audio.pcm, from, to, 1000).toFixed(6),
      outsiderWindow2500: +goertzel(audio.pcm, from, to, 2500).toFixed(6),
      outsiderProcess3500: +goertzel(audio.pcm, from, to, 3500).toFixed(6),
      noiseFloor1700: +goertzel(audio.pcm, from, to, 1700).toFixed(6),
      rms: +rmsOf(audio.pcm).toFixed(6),
    };
  }
  const leakWindow = !!(tones && tones.outsiderWindow2500 > tones.noiseFloor1700 * 4);
  const leakProcess = !!(tones && tones.outsiderProcess3500 > tones.noiseFloor1700 * 4);
  return {
    recorded: { ok: out.ok, bytes: out.bytes || 0, error: out.error },
    tones,
    verdict: {
      capturesOtherWindowInSameApp: leakWindow,
      capturesOtherProcess: leakProcess,
      systemWide: leakWindow || leakProcess,
    },
  };
});

// ---- المرحلة 7: انحراف صوت/صورة على 60 ثانية ----
async function driftRun(kind) {
  const rec = await recorderWin();
  const product = await productWin();
  const src = await sourceForWindow(product);
  const ses = rec.webContents.session;
  if (kind === 'loopback') installLoopbackHandler(ses, product);
  // الهجين: مصدر شاشة لمسار الصوت وحده (فيديو getDisplayMedia يُرمى في الصفحة)
  if (kind === 'hybrid') {
    ses.setDisplayMediaRequestHandler(async (request, cb) => {
      const list = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
      try { cb(list[0] ? { video: list[0], audio: 'loopback' } : {}); } catch (e) {}
    }, { useSystemPicker: false });
  }
  const speakerTone = kind === 'loopback' || kind === 'hybrid';

  const markerCount = Math.floor(DRIFT_MS / MARKER_EVERY_MS);
  const base = Date.now() + 3000;
  const times = [];
  for (let k = 0; k < markerCount; k += 1) times.push(base + k * MARKER_EVERY_MS);

  // حامل مستمر خافت: بلا إشارة بين العلامات يخرج المسار مبتوراً وينهار الخط الزمني.
  // في مسار loopback يأتي الحامل من سماعات نافذة المنتج نفسها.
  if (speakerTone) { await js(product, '__probe.toneStart(300, 0.05)', true); await delay(300); }

  // الومضة دائماً من نافذة المنتج (هي المُلتقَطة بصرياً)
  const flashSpec = { times, flash: true, tone: speakerTone, freq: 1000, toneMs: 120, gain: 0.7, flashMs: 200 };
  const flashPromise = js(product, '__probe.scheduleMarkers(' + JSON.stringify(flashSpec) + ')', true);

  const spec = {
    id: 'drift-' + kind, filename: 'p7-drift-' + kind, durationMs: DRIFT_MS + 5000,
    video: kind === 'loopback' ? null : { sourceId: src.id, width: PRODUCT_W, height: PRODUCT_H, fps: 30 },
    display: kind === 'loopback',
    audioSources: kind === 'loopback' ? []
      : kind === 'hybrid' ? [{ kind: 'displayLoopback' }]
      : [kind === 'mic' ? { kind: 'mic', raw: true }
                        : { kind: 'synthetic', carrierFreq: 300, carrierGain: 0.05 }],
    mix: 'tracks', bitrate: 4000000,
    // في مسار المسار المُخلَّق نُطلق النغمة داخل المسجّل نفسه على اللحظات ذاتها
    markers: kind === 'synthetic' ? { times, flash: false, tone: true, freq: 1000, toneMs: 120, gain: 0.7 } : null,
  };
  const out = await doRecord(rec, spec);
  const flashFired = await flashPromise;
  if (speakerTone) { await js(product, '__probe.toneStop()'); ses.setDisplayMediaRequestHandler(null); }

  const res = { kind, recorded: { ok: out.ok, bytes: out.bytes || 0, error: out.error, errorName: out.errorName,
                                  trackCounts: out.trackCounts },
                flashFired, toneFired: out.fired || null };
  if (!out.ok || !out.saved || !out.saved.path) return res;

  await analyzeDriftFile(res, out.saved.path, flashFired, out.fired || null, markerCount);
  return res;
}

// تحليل ملف انحراف — مفصول عن التسجيل كي يُعاد على الملفات المحفوظة بلا إعادة تسجيل
async function analyzeDriftFile(res, file, flashFired, firedTones, markerCount) {
  const out = { fired: firedTones };
  res.streams = await probeStreams(file);
  const audio = await decodeAudio(file);
  const luma = await decodeLuma(file);
  res.decoded = { audioSeconds: +audio.seconds.toFixed(2), frames: luma.rawFrames, parsedTimes: luma.parsedTimes };

  // كشف العلامة في نطاق 1000Hz وحده — فيتجاهل الحامل 300Hz ولا يخدعه ضجيج عريض
  const env = bandEnvelope(audio.pcm, 1000);
  const peak = env.reduce((a, p) => Math.max(a, p.v), 0);
  const audioHits = onsets(env, 'v', peak * 0.35, 2.0);
  // فحص سلامة الخط الزمني: مسار أقصر بكثير من الفيديو ⇒ القياس باطل لا صفر انحراف
  const videoDurationS = (res.streams && res.streams.streams.find((s) => s.type === 'video') || {}).duration || 0;
  res.timelineIntact = videoDurationS > 0 ? (audio.seconds / videoDurationS) > 0.8 : null;

  const lumaPeak = luma.frames.reduce((a, f) => Math.max(a, f.y), 0);
  const lumaBase = luma.frames.length
    ? luma.frames.map((f) => f.y).sort((a, b) => a - b)[Math.floor(luma.frames.length * 0.5)] : 0;
  const lumaThreshold = lumaBase + Math.max(30, (lumaPeak - lumaBase) * 0.5);
  const videoHits = onsets(luma.frames.map((f) => ({ t: f.t, v: f.y })), 'v', lumaThreshold, 2.0);

  res.detection = { audioHits: audioHits.map((t) => +t.toFixed(3)), videoHits: videoHits.map((t) => +t.toFixed(3)),
                    audioPeak: +peak.toFixed(6), lumaBase: +lumaBase.toFixed(1), lumaPeak: +lumaPeak.toFixed(1),
                    lumaThreshold: +lumaThreshold.toFixed(1),
                    audioSeconds: +audio.seconds.toFixed(2), videoSeconds: +videoDurationS.toFixed(2) };

  // التزاوج بأقرب جار لا بالفهرس (درس مثبّت): قائمتا الكشف قد تحملان علامة زائفة
  // (ومضة بدء الصفحة مثلاً) أو تُسقطا علامة عند الحافة، فالتزاوج بالفهرس يقرن عندها
  // علامة صوت بومضة أخرى تماماً ويولّد انحرافاً بالثواني — وهو مستحيل فيزيائياً.
  const PAIR_WINDOW_MS = 2000;
  const usedVideo = new Set();
  const matched = [];
  for (const at of audioHits) {
    let best = -1, bestDist = Infinity;
    for (let j = 0; j < videoHits.length; j += 1) {
      if (usedVideo.has(j)) continue;
      const d = Math.abs(videoHits[j] - at) * 1000;
      if (d < bestDist) { bestDist = d; best = j; }
    }
    if (best >= 0 && bestDist <= PAIR_WINDOW_MS) { usedVideo.add(best); matched.push({ at, vt: videoHits[best] }); }
  }
  // محاذاة سجلّ الإطلاق: العلامات المرصودة قد تكون ذيل المُطلَقة (بدء التسجيل يتأخر)
  const firedShift = Math.max(0, (flashFired ? flashFired.length : 0) - matched.length);
  const pairs = matched.map((pair, k) => {
    // انحراف موجب = الصوت متأخر عن الصورة
    const offset = (pair.vt - pair.at) * 1000;
    // تصحيح تشويش لحظة الإطلاق بين النافذتين (يلغى تلقائياً حين يكون المصدر واحداً)
    const idx = k + firedShift;
    const fSkew = flashFired && flashFired[idx] ? flashFired[idx].skewMs : 0;
    const tSkew = out.fired && out.fired[idx] ? out.fired[idx].skewMs : fSkew;
    return { k, atSeconds: +pair.vt.toFixed(2), rawOffsetMs: +offset.toFixed(1),
             triggerSkewMs: +(fSkew - tSkew).toFixed(1), offsetMs: +(offset - (fSkew - tSkew)).toFixed(1) };
  });
  res.pairing = { audioHits: audioHits.length, videoHits: videoHits.length, matched: pairs.length,
                  unmatchedVideo: videoHits.length - pairs.length, firedShift, windowMs: PAIR_WINDOW_MS };
  const offsets = pairs.map((p) => p.offsetMs);
  const first = offsets.length ? offsets[0] : null;
  const relative = offsets.map((v) => v - first);
  res.markers = pairs;
  res.offsetStats = stats(offsets);
  res.absOffsetStats = stats(offsets.map((v) => Math.abs(v)));
  res.relativeDriftStats = stats(relative.map((v) => Math.abs(v)));
  res.driftSlopeMsPerSecond = slopePerSecond(pairs.map((p) => ({ x: p.atSeconds, y: p.offsetMs })));
  res.constantOffsetMs = first;
  // دقة العيّنة الزمنية للفيديو: لا يمكن قياس عتبة 80ms بمعدل إطارات أخشن منها.
  // (‏م9 سجّل 1080p بـ~1.1fps فعلياً ⇒ تكميم ~900ms يبتلع العتبة كلها)
  const ivs = [];
  for (let i = 1; i < luma.frames.length; i += 1) ivs.push((luma.frames[i].t - luma.frames[i - 1].t) * 1000);
  ivs.sort((a, b) => a - b);
  const frameIntervalMs = ivs.length ? +ivs[Math.floor(ivs.length / 2)].toFixed(1) : null;
  const span = pairs.length >= 2 ? pairs[pairs.length - 1].atSeconds - pairs[0].atSeconds : 0;
  res.resolution = { frameIntervalMs, effectiveFps: frameIntervalMs ? +(1000 / frameIntervalMs).toFixed(2) : null,
                     quantizationMs: frameIntervalMs == null ? null : +(frameIntervalMs / 2).toFixed(1),
                     spanSeconds: +span.toFixed(1), sufficientForThreshold: frameIntervalMs != null && frameIntervalMs <= 100 };
  res.verdict = {
    timelineIntact: res.timelineIntact,
    markersDetected: pairs.length, expected: markerCount,
    // قياس صالح إن سلِم الخط الزمني، ورُصدت ≥4 علامات تمتد ≥30ث (تكفي لميل الانحراف)،
    // وكان تكميم الفيديو أدقّ من العتبة المقيسة — وإلا فالرقم لا يعني شيئاً
    measurementValid: res.timelineIntact === true && pairs.length >= 4 && span >= 30
      && res.resolution.sufficientForThreshold === true,
    p95AbsOffsetMs: res.absOffsetStats.p95 == null ? null : res.absOffsetStats.p95,
    p95RelativeDriftMs: res.relativeDriftStats.p95 == null ? null : res.relativeDriftStats.p95,
    passesRelative: res.relativeDriftStats.p95 != null && res.relativeDriftStats.p95 < 80,
    accumulating: res.driftSlopeMsPerSecond != null && Math.abs(res.driftSlopeMsPerSecond) > 0.5,
  };
  return res;
}

stage('7', 'م4 — انحراف الصوت/الصورة (مسار صوتي مستقل، ' + (DRIFT_MS / 1000) + 'ث)', async () => driftRun('synthetic'));

// ---- المرحلة H: هل يجتمع «فيديو النافذة وحدها» مع «صوت النظام»؟ ----
// السؤال الحاسم للميزة: getDisplayMedia هو المنفذ الوحيد لـloopback، لكن مصدر النافذة
// معه يعطي AbortError (‏م2)، و`mainFrame` يعطي معدل إطارات منهاراً (‏م9). فهل ينفع
// المسار الهجين: فيديو النافذة من getUserMedia + مسار صوت loopback وحده من
// getDisplayMedia (بإسقاط مسار الفيديو الخاص به)؟
stage('HD', 'م4/م5 — انحراف المسار الهجين على ' + (DRIFT_MS / 1000) + 'ث (التكوين القابل للشحن)',
  async () => driftRun('hybrid'));

stage('H', 'م4/م5 — هجين: فيديو النافذة + صوت النظام في ملف واحد', async () => {
  const rec = await recorderWin();
  const product = await productWin();
  const src = await sourceForWindow(product);
  const ses = rec.webContents.session;
  await js(product, '__probe.toneStart(1000, 0.6)', true);
  await delay(400);

  // معالج getDisplayMedia يسلّم مصدر شاشة (الوحيد الذي يقبل loopback بلا AbortError)
  ses.setDisplayMediaRequestHandler(async (request, cb) => {
    const list = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
    try { cb(list[0] ? { video: list[0], audio: 'loopback' } : {}); }
    catch (e) { note('  hybrid handler cb threw: ' + String(e.message || e).slice(0, 80)); }
  }, { useSystemPicker: false });

  const variants = [
    // (أ) المرجع: المسار الإنتاجي الحالي — فيديو النافذة بلا صوت
    { key: 'window-video-only', video: true, audio: [] },
    // (ب) الهجين المقترح: فيديو النافذة + صوت النظام
    { key: 'hybrid-window-video+loopback-audio', video: true, audio: [{ kind: 'displayLoopback' }] },
    // (ج) المقارن: getDisplayMedia كاملاً بمصدر شاشة (فيديو الشاشة كلها + صوتها)
    { key: 'screen-display-full', video: false, audio: [], display: true },
  ];
  const rows = [];
  for (const v of variants) {
    const out = await doRecord(rec, {
      id: 'hybrid-' + v.key, filename: 'pH-' + v.key.replace(/[^a-z0-9]+/gi, '-'), durationMs: 8000,
      video: v.video ? { sourceId: src.id, width: PRODUCT_W, height: PRODUCT_H, fps: 30 } : null,
      display: !!v.display, audioSources: v.audio, mix: 'tracks', bitrate: 4000000,
    });
    const row = { variant: v.key, ok: out.ok, bytes: out.bytes || 0, errorName: out.errorName,
                  error: String(out.error || '').slice(0, 200), trackCounts: out.trackCounts, mime: out.mime || '' };
    if (out.ok && out.saved && out.saved.path) {
      const file = out.saved.path;
      const streams = await probeStreams(file);
      const vs = streams.streams.find((s) => s.type === 'video');
      const as = streams.streams.find((s) => s.type === 'audio');
      const luma = await decodeLuma(file);
      const dur = (vs && vs.duration) || 0;
      row.video = vs ? { w: vs.width, h: vs.height, codec: vs.codec, durationS: +dur.toFixed(2) } : null;
      row.audioStream = as ? { codec: as.codec, channels: as.channels, durationS: +(as.duration || 0).toFixed(2) } : null;
      row.measuredFrames = luma.frames.length;
      row.measuredFps = dur > 0 ? +(luma.frames.length / dur).toFixed(2) : null;
      if (as) {
        const audio = await decodeAudio(file);
        const n = audio.pcm.length;
        row.audio = { seconds: +audio.seconds.toFixed(2), rms: +rmsOf(audio.pcm).toFixed(6),
                      tone1000: +goertzel(audio.pcm, 0, n, 1000).toFixed(6),
                      noise1700: +goertzel(audio.pcm, 0, n, 1700).toFixed(6) };
      }
    }
    rows.push(row);
    note('  hybrid[' + v.key + '] ok=' + row.ok + ' fps=' + (row.measuredFps || '-')
      + ' size=' + (row.video ? row.video.w + 'x' + row.video.h : '-')
      + ' tone=' + (row.audio ? row.audio.tone1000 : '-') + ' err=' + (row.errorName || '-'));
    await delay(400);
  }
  ses.setDisplayMediaRequestHandler(null);
  await js(product, '__probe.toneStop()');

  const ref = rows.find((r) => r.variant === 'window-video-only');
  const hyb = rows.find((r) => r.variant === 'hybrid-window-video+loopback-audio');
  const full = rows.find((r) => r.variant === 'screen-display-full');
  const hybHasAudio = !!(hyb && hyb.audio && hyb.audio.tone1000 > (hyb.audio.noise1700 || 0) * 20);
  return {
    rows,
    verdict: {
      hybridWorks: !!(hyb && hyb.ok && hybHasAudio && hyb.measuredFps != null && hyb.measuredFps >= 20),
      hybridKeepsWindowOnly: !!(hyb && hyb.video && hyb.video.w === PRODUCT_W && hyb.video.h === PRODUCT_H),
      hybridFps: hyb ? hyb.measuredFps : null,
      referenceFps: ref ? ref.measuredFps : null,
      fullScreenFps: full ? full.measuredFps : null,
      fullScreenIsWholeScreen: !!(full && full.video && full.video.w > PRODUCT_W),
    },
  };
});

// ---- المرحلة R: إعادة تحليل ملفات الانحراف المحفوظة بلا إعادة تسجيل ----
// تقرأ سجلّ الإطلاق من results.json المحفوظ وتعيد الكشف بالكاشف المصحَّح، فيصير
// الفرق بين رقمين قبل/بعد عائداً إلى الكاشف وحده — الملف والتسجيل هما هما.
stage('R', 'إعادة تحليل ملفات الانحراف المحفوظة (الكاشف المصحَّح)', async () => {
  const saved = results.stages || {};
  const targets = [
    { key: 'synthetic', file: 'p7-drift-synthetic.mp4', from: saved['7'] && saved['7'].data },
    { key: 'loopback', file: 'p7-drift-loopback.mp4', from: saved['9'] && saved['9'].data && saved['9'].data.drift },
  ];
  const outs = {};
  for (const t of targets) {
    const file = path.join(OUT_DIR, t.file);
    if (!fs.existsSync(file)) { outs[t.key] = { skipped: 'file_missing' }; continue; }
    const prior = t.from || {};
    const res = { kind: t.key, reanalyzed: true, sourceFile: t.file,
                  flashFired: prior.flashFired || null, toneFired: prior.toneFired || null };
    await analyzeDriftFile(res, file, prior.flashFired || null, prior.toneFired || null,
      (prior.verdict && prior.verdict.expected) || 6);
    outs[t.key] = res;
    note('  reanalyze[' + t.key + '] matched=' + (res.pairing ? res.pairing.matched : '-')
      + ' fps=' + (res.resolution ? res.resolution.effectiveFps : '-')
      + ' valid=' + (res.verdict ? res.verdict.measurementValid : '-')
      + ' p95rel=' + (res.verdict ? res.verdict.p95RelativeDriftMs : '-')
      + ' const=' + (res.constantOffsetMs != null ? res.constantOffsetMs : '-'));
  }
  return outs;
});

// ---- المرحلة 8: اقتران صوتي (هل يسمع الميكروفون السماعات؟) ثم انحراف الميكروفون ----
stage('8', 'م4 — اقتران الميكروفون الصوتي وانحرافه', async () => {
  const rec = await recorderWin();
  const product = await productWin();
  await js(product, '__probe.toneStart(1000, 0.6)', true);
  await delay(500);
  // raw إلزامي هنا: إلغاء الصدى مصمَّم أصلاً لحذف صوت السماعة من الميكروفون،
  // فقياس الاقتران بقيود افتراضية يقيس AEC لا الميكروفون.
  const probeRec = await doRecord(rec, {
    id: 'mic-coupling', filename: 'p8-coupling', durationMs: 4000,
    audioSources: [{ kind: 'mic', raw: true }], mix: 'tracks',
  });
  await js(product, '__probe.toneStop()');
  let coupling = null;
  if (probeRec.ok && probeRec.saved && probeRec.saved.path) {
    const audio = await decodeAudio(probeRec.saved.path);
    const from = Math.floor(audio.pcm.length * 0.3), to = Math.floor(audio.pcm.length * 0.9);
    coupling = {
      tone1000: +goertzel(audio.pcm, from, to, 1000).toFixed(6),
      noise1700: +goertzel(audio.pcm, from, to, 1700).toFixed(6),
      rms: +rmsOf(audio.pcm).toFixed(6),
    };
  }
  const coupled = !!(coupling && coupling.tone1000 > coupling.noise1700 * 6 && coupling.tone1000 > 0.001);
  const result = { coupling, acousticallyCoupled: coupled };
  if (coupled) {
    result.drift = await driftRun('mic');
  } else {
    result.driftSkipped = 'لا اقتران صوتي مرصود بين سماعة الجهاز وميكروفونه — انحراف الميكروفون الحقيقي غير قابل للقياس هنا';
  }
  return result;
});

// ---- المرحلة 9: انحراف loopback + التعايش مع الميكروفون ----
stage('9', 'م5 — انحراف صوت النظام والتعايش مع الميكروفون', async () => {
  const drift = await driftRun('loopback');

  // هل يمكن أن يجتمع صوت النظام والميكروفون؟ وهل يتضاعف صوت المنتج؟
  const rec = await recorderWin();
  const product = await productWin();
  const src = await sourceForWindow(product);
  const ses = rec.webContents.session;
  installLoopbackHandler(ses, product);
  await js(product, '__probe.toneStart(1000, 0.5)', true);
  await delay(400);
  const both = await doRecord(rec, {
    id: 'loopback-plus-mic', filename: 'p9-both', durationMs: 5000,
    display: true, audioSources: [{ kind: 'mic' }], mix: 'tracks', bitrate: 3000000, alsoAudioOnly: true,
  });
  await js(product, '__probe.toneStop()');
  ses.setDisplayMediaRequestHandler(null);
  const bothStreams = both.saved && both.saved.path ? await probeStreams(both.saved.path) : null;

  return {
    drift,
    coexistence: {
      ok: both.ok, error: both.error, streamTrackCounts: both.trackCounts,
      audioStreamsInFile: bothStreams ? bothStreams.streams.filter((s) => s.type === 'audio').length : null,
      sideFileBytes: both.bytes2 || 0,
    },
  };
});

// ---- المرحلة 10: هل صوت النظام متاح عبر المسار القديم (‏getUserMedia) أصلاً؟ ----
// السؤال الأمني: بوابة promocapture تحرس getDisplayMedia وحده. فإن أعطى المسارُ القديم
// صوتَ النظام، فالبوابة ليست حماية بل حارس على باب لا يمرّ منه أحد.
stage('10', 'م5 — صوت النظام عبر المسار القديم: هل يتجاوز البوابة؟', async () => {
  const rec = await recorderWin();
  const product = await productWin();
  const src = await sourceForWindow(product);
  const ses = rec.webContents.session;

  // معالج يرفض كل طلب getDisplayMedia — كي نثبت أن ما ينجح هنا لم يمرّ به
  let displayHandlerFired = 0;
  ses.setDisplayMediaRequestHandler((request, cb) => { displayHandlerFired += 1; cb({}); },
    { useSystemPicker: false });

  await js(product, '__probe.toneStart(1000, 0.5)', true);
  await delay(400);
  const out = await doRecord(rec, {
    id: 'legacy-desktop-audio', filename: 'p10-legacy-audio', durationMs: 5000,
    video: { sourceId: src.id, width: PRODUCT_W, height: PRODUCT_H, fps: 30 },
    audioSources: [{ kind: 'desktopLegacy' }], mix: 'tracks', bitrate: 3000000,
  });
  await js(product, '__probe.toneStop()');
  ses.setDisplayMediaRequestHandler(null);

  let analysis = null;
  if (out.ok && out.saved && out.saved.path) {
    const audio = await decodeAudio(out.saved.path);
    const from = Math.floor(audio.pcm.length * 0.3), to = Math.floor(audio.pcm.length * 0.9);
    analysis = {
      seconds: +audio.seconds.toFixed(2), rms: +rmsOf(audio.pcm).toFixed(6),
      tone1000: +goertzel(audio.pcm, from, to, 1000).toFixed(6),
      noise1700: +goertzel(audio.pcm, from, to, 1700).toFixed(6),
    };
  }
  const gotSystemAudio = !!(analysis && analysis.tone1000 > 0.001 && analysis.tone1000 > analysis.noise1700 * 6);
  note('  legacy-desktop-audio ok=' + out.ok + ' audioTracks='
    + (out.trackCounts ? out.trackCounts.audio : '-') + ' tone=' + (analysis ? analysis.tone1000 : '-')
    + ' displayHandlerFired=' + displayHandlerFired + ' err=' + (out.errorName || out.error || '-'));

  return {
    recorded: { ok: out.ok, bytes: out.bytes || 0, error: out.error, errorName: out.errorName,
                trackCounts: out.trackCounts, notes: out.notes },
    displayHandlerFired, analysis,
    verdict: {
      legacyAudioConstraintAccepted: !!(out.trackCounts && out.trackCounts.audio > 0),
      capturesSystemAudio: gotSystemAudio,
      // نجاح هنا مع displayHandlerFired=0 ⇒ البوابة لا تحرس هذا المسار إطلاقاً
      bypassesDisplayGate: gotSystemAudio && displayHandlerFired === 0,
    },
  };
});

// ---------- المشغّل ----------

app.whenReady().then(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // دمج النتائج السابقة بدل دهسها: تشغيل ‏--only كان يمحو أدلة مراحل لم تُعَد
  // (ضاعت بيانات المرحلة 2 هكذا مرة). الأدلة المحفوظة لا تُفقد بتشغيل جزئي.
  try {
    const prev = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'results.json'), 'utf8'));
    if (prev && prev.stages) { results.stages = prev.stages; results.meta = { ...prev.meta, ...results.meta }; }
    note('merged ' + Object.keys(results.stages).length + ' saved stage(s) from results.json');
  } catch {}
  note('probe start — quick=' + QUICK + ' out=' + path.relative(process.cwd(), OUT_DIR));
  for (const s of stages) {
    if (ONLY && !ONLY.has(s.id)) { note('stage ' + s.id + ' skipped (--only)'); continue; }
    note('stage ' + s.id + ': ' + s.title);
    const t0 = Date.now();
    try {
      results.stages[s.id] = { title: s.title, ok: true, ms: 0, data: await s.fn() };
    } catch (err) {
      note('  FAIL stage ' + s.id + ': ' + (err && err.stack || err));
      results.stages[s.id] = { title: s.title, ok: false, error: String(err && err.message || err).slice(0, 400) };
    }
    results.stages[s.id].ms = Date.now() - t0;
    note('  stage ' + s.id + ' done in ' + results.stages[s.id].ms + 'ms');
    persist();
  }
  results.meta.finishedAt = new Date().toISOString();
  persist();
  note('probe done — results in dist/capture-audio-probe/results.json');
  for (const win of windows.values()) { try { win.destroy(); } catch {} }
  app.exit(0);
});
