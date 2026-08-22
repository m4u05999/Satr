'use strict';

/**
 * مسبار م3: هل يُخفي مسار الالتقاط المؤشر الأصلي عند طلب cursor:'never'؟
 *
 * الفرضية: Screen Studio يحتاج مؤشراً عالي الدقة مُضافاً بعد التسجيل، وهذا يستحيل
 * إن بقي المؤشر الأصلي مخبوزاً في البكسلات.
 *
 * ما يُقاس:
 *   • 20 تسجيلاً × ~3 ثوانٍ عبر getDisplayMedia({video:{cursor:'never'}}).
 *   • 5 تسجيلات مرجعية عبر getDisplayMedia({video:{cursor:'always'}}) لإثبات أن
 *     المؤشر يُلتقط فعلاً عندما نطلب ظهوره.
 *   • المؤشر يُحرَّك فوق checkerboard عالية التباين.
 *   • الفحص ليس بـ track.getSettings().cursor بل بالإطارات نفسها (فرق بكسلي
 *     مقارنةً بإطار مرجعي بدون مؤشر).
 *   • العتبة: لا مؤشر أصلي في 19/20 تسجيلاً على الأقل للمسار الجديد.
 *
 * ملاحظة تنفيذية: نوافذ العملية الأم لا تظهر دائماً في desktopCapturer، لذلك نفتح
 * نافذة الالتقاط في عملية Electron مساعدة منفصلة ونمرّر معرّفها/موضعها إلى المسبار.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { app, BrowserWindow, desktopCapturer, session, nativeImage } = require('electron');

const OUT_DIR = path.join(__dirname, '..', 'dist', 'cursor-hide-probe');
const REPORT_DIR = path.join('D:', 'sater', 'prompts-studio-bs', 'probes');
const WIN_W = 640;
const WIN_H = 480;
const DURATION_MS = 3000;
const FPS = 30;
const BITRATE = 6_000_000;
const HELPER_TITLE = 'Satr Cursor Hide Probe Helper';

// عزل بيانات المستخدم وكاش GPU كي لا يتصادم المسبار مع عمليات «سطر» الحية
app.setPath('userData', path.join(OUT_DIR, 'main-user-data'));
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function logErr(msg) {
  try { fs.appendFileSync(path.join(OUT_DIR, 'probe-err.log'), msg + '\n', 'utf8'); } catch {}
}

function sourceBaseId(id) {
  const m = /^window:([^:]+):\d+$/.exec(String(id || ''));
  return m ? 'window:' + m[1] : String(id);
}

function startCursorMover() {
  const psPath = path.join(__dirname, 'cursor-hide-probe-cursor.ps1');
  const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psPath], {
    windowsHide: true,
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  let alive = true;
  ps.on('exit', () => { alive = false; });
  ps.stderr.on('data', (chunk) => { logErr('cursor ps: ' + chunk.toString().trim()); });
  return {
    move(x, y) {
      if (alive) {
        try { ps.stdin.write(`${Math.round(x)} ${Math.round(y)}\n`); } catch {}
      }
    },
    stop() {
      if (alive) {
        try { ps.stdin.write('exit\n'); } catch {}
        try { ps.stdin.end(); } catch {}
      }
    },
  };
}

function startHelper() {
  return new Promise((resolve, reject) => {
    const helperPath = path.join(__dirname, 'cursor-hide-probe-helper.js');
    const helperUserData = path.join(OUT_DIR, 'helper-user-data');
    const child = spawn(process.execPath, [
      '--user-data-dir=' + helperUserData,
      '--disable-gpu-shader-disk-cache',
      helperPath,
    ], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let resolved = false;
    let sourceId = '';
    let bounds = null;
    let stdoutBuf = '';
    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (t.startsWith('MEDIA_SOURCE_ID:')) sourceId = t.slice('MEDIA_SOURCE_ID:'.length).trim();
        if (t.startsWith('BOUNDS:')) {
          const parts = t.slice('BOUNDS:'.length).split(',').map(Number);
          if (parts.length === 4) bounds = { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
        }
        if (sourceId && bounds && !resolved) {
          resolved = true;
          resolve({ child, sourceId, bounds });
        }
      }
    });
    child.stderr.on('data', (chunk) => { logErr('helper err: ' + chunk.toString().trim()); });
    child.on('exit', (code) => {
      if (!resolved) reject(new Error('helper exited early: ' + code));
    });
    setTimeout(() => {
      if (!resolved) {
        try { child.kill(); } catch {}
        reject(new Error('helper startup timeout'));
      }
    }, 15000);
  });
}

async function findHelperSource(sourceId) {
  const baseId = sourceBaseId(sourceId);
  for (let i = 0; i < 10; i++) {
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 1, height: 1 },
      fetchWindowIcons: false,
    });
    const source = sources.find((s) => s && (sourceBaseId(s.id) === baseId || s.name === HELPER_TITLE));
    if (source) return source;
    await sleep(200);
  }
  return null;
}

function installDisplayHandler(win, getSource) {
  const handler = (request, callback) => {
    let sameOwner = false;
    try {
      sameOwner = request && request.frame && request.frame.top && request.frame.top === win.webContents.mainFrame;
    } catch {}
    const valid = sameOwner && request.videoRequested === true && request.audioRequested !== true;
    if (!valid) return callback({});
    const source = getSource();
    callback(source ? { video: source } : {});
  };
  session.defaultSession.setDisplayMediaRequestHandler(handler, { useSystemPicker: false });
  return () => {
    try { session.defaultSession.setDisplayMediaRequestHandler(null); } catch {}
  };
}

async function recordInRenderer(win, method, sourceId, cursor, durationMs, sliceMs = 1000) {
  const expr = `(() => {
    const method = ${JSON.stringify(method)};
    const sourceId = ${JSON.stringify(sourceId)};
    const cursor = ${JSON.stringify(cursor)};
    const durationMs = ${durationMs};
    const sliceMs = ${sliceMs};
    const bitrate = ${BITRATE};
    return new Promise(async (resolve) => {
      try {
        let stream;
        if (method === 'getUserMedia') {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
              mandatory: {
                chromeMediaSource: 'desktop',
                chromeMediaSourceId: sourceId,
                minFrameRate: 30, maxFrameRate: 30,
              }
            }
          });
        } else {
          stream = await navigator.mediaDevices.getDisplayMedia({
            audio: false,
            video: { cursor: cursor || 'never', displaySurface: 'window' }
          });
        }
        const [track] = stream.getVideoTracks();
        const settings = track.getSettings();
        const candidates = ['video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm','video/mp4;codecs=avc1.42E01E','video/mp4;codecs=avc1','video/mp4'];
        let recorder = null;
        let mime = '';
        for (const candidate of candidates) {
          if (!MediaRecorder.isTypeSupported(candidate)) continue;
          try {
            recorder = new MediaRecorder(stream, { mimeType: candidate, videoBitsPerSecond: bitrate });
            mime = candidate;
            break;
          } catch {}
        }
        if (!recorder) {
          stream.getTracks().forEach(t => t.stop());
          return resolve({ error: 'no_recorder', settings: { cursor: settings.cursor, width: settings.width, height: settings.height, frameRate: settings.frameRate } });
        }
        const chunks = [];
        let recorderError = null;
        recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
        recorder.onerror = (e) => { recorderError = e.message || 'recorder_error'; };
        const startedAt = performance.now();
        recorder.start(sliceMs);
        setTimeout(() => {
          recorder.onstop = () => {
            const elapsedMs = performance.now() - startedAt;
            stream.getTracks().forEach(t => t.stop());
            if (recorderError) {
              return resolve({ error: recorderError, mime, settings: { cursor: settings.cursor, width: settings.width, height: settings.height, frameRate: settings.frameRate } });
            }
            const blob = new Blob(chunks, { type: recorder.mimeType });
            if (!blob.size) return resolve({ error: 'empty_blob', mime, settings });
            blob.arrayBuffer().then(ab => {
              const bytes = new Uint8Array(ab);
              let binary = '';
              const chunkSize = 65536;
              for (let i = 0; i < bytes.length; i += chunkSize) {
                binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
              }
              resolve({
                base64: btoa(binary),
                mimeType: recorder.mimeType,
                settings: { cursor: settings.cursor, width: settings.width, height: settings.height, frameRate: settings.frameRate },
                durationMs: elapsedMs,
                byteLength: bytes.length,
              });
            }).catch((err) => resolve({ error: 'blob_read:' + err.message, mime, settings }));
          };
          recorder.stop();
        }, durationMs);
      } catch (err) {
        resolve({ error: err.name + ':' + err.message });
      }
    });
  })()`;
  return win.webContents.executeJavaScript(expr, true);
}

async function extractFrame(videoPath, timeSec, outPngPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', videoPath,
      '-ss', String(timeSec),
      '-vframes', '1',
      '-pix_fmt', 'rgba',
      outPngPath,
    ], { windowsHide: true });
    let err = '';
    proc.stderr.on('data', (c) => { err += c.toString(); });
    proc.on('close', (code) => {
      if (code !== 0 || !fs.existsSync(outPngPath)) return reject(new Error(err || 'ffmpeg failed'));
      resolve(outPngPath);
    });
  });
}

async function captureReferenceFrame(rendererWin, helperSourceId, mover) {
  // نُبعد المؤشر تماماً عن نافذة المساعدة ثم نسجّل لقطة قصيرة بـ getDisplayMedia
  mover.move(50, 50);
  await sleep(300);
  const refVideoPath = path.join(OUT_DIR, 'ref-temp.webm');
  const refResult = await recordInRenderer(rendererWin, 'getDisplayMedia', helperSourceId, 'never', 600, 100);
  if (refResult.error) return { error: refResult.error, settings: refResult.settings };
  fs.writeFileSync(refVideoPath, Buffer.from(refResult.base64, 'base64'));
  const refPngPath = path.join(OUT_DIR, 'ref-temp.png');
  try {
    await extractFrame(refVideoPath, 0.25, refPngPath);
  } catch (error) {
    return { error: 'extract:' + error.message, settings: refResult.settings };
  }
  return { refPngPath, settings: refResult.settings };
}

function findComponents(diff, width, height) {
  const labels = new Int32Array(width * height);
  const areas = [];
  const boxes = [];
  let label = 0;
  const stack = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!diff[i] || labels[i]) continue;
      label++;
      let area = 0;
      let minX = x, maxX = x, minY = y, maxY = y;
      stack.length = 0;
      stack.push(i);
      labels[i] = label;
      while (stack.length) {
        const ci = stack.pop();
        area++;
        const cx = ci % width;
        const cy = Math.floor(ci / width);
        if (cx < minX) minX = cx; else if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy; else if (cy > maxY) maxY = cy;
        if (cx > 0) { const ni = ci - 1; if (diff[ni] && !labels[ni]) { labels[ni] = label; stack.push(ni); } }
        if (cx + 1 < width) { const ni = ci + 1; if (diff[ni] && !labels[ni]) { labels[ni] = label; stack.push(ni); } }
        if (cy > 0) { const ni = ci - width; if (diff[ni] && !labels[ni]) { labels[ni] = label; stack.push(ni); } }
        if (cy + 1 < height) { const ni = ci + width; if (diff[ni] && !labels[ni]) { labels[ni] = label; stack.push(ni); } }
      }
      areas.push(area);
      boxes.push({ minX, maxX, minY, maxY });
    }
  }
  return { labelCount: label, areas, boxes };
}

function cursorCandidates(frameImg, refImg) {
  const fSize = frameImg.getSize();
  const rSize = refImg.getSize();
  if (fSize.width !== rSize.width || fSize.height !== rSize.height) {
    refImg = refImg.resize({ width: fSize.width, height: fSize.height });
  }
  const frameBmp = frameImg.toBitmap();
  const refBmp = refImg.toBitmap();
  const w = fSize.width;
  const h = fSize.height;
  const len = w * h;
  const diff = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    const o = i * 4;
    const d = Math.abs(frameBmp[o] - refBmp[o]) + Math.abs(frameBmp[o + 1] - refBmp[o + 1]) + Math.abs(frameBmp[o + 2] - refBmp[o + 2]);
    diff[i] = d > 80 ? 1 : 0;
  }
  const comps = findComponents(diff, w, h);
  const candidates = [];
  for (let i = 0; i < comps.labelCount; i++) {
    const area = comps.areas[i];
    const b = comps.boxes[i];
    const bw = b.maxX - b.minX + 1;
    const bh = b.maxY - b.minY + 1;
    const compact = area / Math.max(1, bw * bh);
    const margin = Math.min(b.minX, b.minY, w - 1 - b.maxX, h - 1 - b.maxY);
    if (area >= 12 && area <= 900 && bw <= 64 && bh <= 64 && compact >= 0.12 && margin >= 4) {
      candidates.push({ area, box: b, compactness: compact });
    }
  }
  return candidates;
}

async function analyzeRecording(videoPath, refPngPath, recordingName, sampleTimes) {
  const refImg = nativeImage.createFromPath(refPngPath);
  if (refImg.isEmpty()) throw new Error('empty_reference');
  const results = [];
  for (let i = 0; i < sampleTimes.length; i++) {
    const t = sampleTimes[i];
    const framePath = path.join(OUT_DIR, `${recordingName}-frame-${i}.png`);
    try {
      await extractFrame(videoPath, t, framePath);
    } catch (error) {
      results.push({ time_sec: t, cursorDetected: true, candidates: 0, error: error.message });
      continue;
    }
    const frameImg = nativeImage.createFromPath(framePath);
    const cands = frameImg.isEmpty() ? [] : cursorCandidates(frameImg, refImg);
    results.push({ time_sec: t, cursorDetected: cands.length > 0, candidates: cands.length });
  }
  const cursorDetectedAny = results.some((r) => r.cursorDetected);
  return { cursorDetectedAny, frames: results };
}

async function runOneRecording(rendererWin, mover, method, cursor, index, helperSourceId, helperBounds, sharedRefPath) {
  const name = `${method}-${cursor}-${String(index).padStart(2, '0')}`;
  const videoPath = path.join(OUT_DIR, `${name}.webm`);

  // حركات المؤشر داخل نافذة المساعدة
  const positions = [
    { x: helperBounds.x + Math.round(helperBounds.width * 0.5), y: helperBounds.y + Math.round(helperBounds.height * 0.5) },
    { x: helperBounds.x + Math.round(helperBounds.width * 0.25), y: helperBounds.y + Math.round(helperBounds.height * 0.25) },
    { x: helperBounds.x + Math.round(helperBounds.width * 0.75), y: helperBounds.y + Math.round(helperBounds.height * 0.25) },
    { x: helperBounds.x + Math.round(helperBounds.width * 0.75), y: helperBounds.y + Math.round(helperBounds.height * 0.75) },
    { x: helperBounds.x + Math.round(helperBounds.width * 0.25), y: helperBounds.y + Math.round(helperBounds.height * 0.75) },
  ];
  mover.move(positions[0].x, positions[0].y);
  await sleep(80);

  const startedAt = Date.now();
  const recordPromise = recordInRenderer(rendererWin, method, helperSourceId, cursor, DURATION_MS);

  const moveInterval = setInterval(() => {
    const elapsed = Date.now() - startedAt;
    const idx = Math.min(positions.length - 1, Math.floor(elapsed / 600));
    const p = positions[idx];
    mover.move(p.x, p.y);
  }, 120);

  let recordResult;
  try {
    recordResult = await recordPromise;
  } finally {
    clearInterval(moveInterval);
  }

  if (recordResult.error) {
    return {
      name,
      method,
      cursor,
      error: recordResult.error,
      mime: recordResult.mime || '',
      settings: recordResult.settings || null,
      cursorDetectedAny: true,
      frames: [],
    };
  }

  fs.writeFileSync(videoPath, Buffer.from(recordResult.base64, 'base64'));

  if (!sharedRefPath) {
    return { name, method, cursor, error: 'no_reference', cursorDetectedAny: true, frames: [] };
  }

  const sampleTimes = [0.4, 0.9, 1.5, 2.1, 2.6];
  const analysis = await analyzeRecording(videoPath, sharedRefPath, name, sampleTimes);

  return {
    name,
    method,
    cursor,
    videoPath,
    mime: recordResult.mimeType,
    settings: recordResult.settings,
    durationMs: recordResult.durationMs,
    byteLength: recordResult.byteLength,
    cursorDetectedAny: analysis.cursorDetectedAny,
    frames: analysis.frames,
  };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const report = {
    probe: 'cursor-hide-probe',
    at: new Date().toISOString(),
    platform: process.platform,
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    findings: { cursorAlways: [], cursorNever: [] },
    summary: {},
  };

  await app.whenReady();

  let helper;
  try {
    helper = await startHelper();
    report.helperSourceId = helper.sourceId;
    report.helperBounds = helper.bounds;
  } catch (error) {
    report.fatalError = 'helper_failed: ' + (error.stack || error.message);
    fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
    console.error(report.fatalError);
    app.exit(1);
    return;
  }

  const rendererWin = new BrowserWindow({
    show: false,
    width: 120,
    height: 90,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  await rendererWin.loadURL('file:///' + path.join(OUT_DIR, 'renderer-blank.html').replace(/\\/g, '/'));

  // مهلة إضافية حتى تُدرِج desktopCapturer نافذة المساعدة
  await sleep(2000);
  const helperSource = await findHelperSource(helper.sourceId);
  report.helperSourceFound = !!helperSource;
  report.helperSourceBaseId = sourceBaseId(helper.sourceId);
  if (!helperSource) {
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1, height: 1 }, fetchWindowIcons: false });
    report.helperSourceFallbackSearch = sources.map((s) => ({ id: s.id, name: s.name }));
  }

  const clearHandler = installDisplayHandler(rendererWin, () => helperSource);
  const mover = startCursorMover();

  function shutdownHelper() {
    try { helper.child.stdin.write('exit\n'); } catch {}
    try { helper.child.stdin.end(); } catch {}
    setTimeout(() => { try { helper.child.kill(); } catch {} }, 500);
  }

  let sharedRefPath = null;
  let refCaptureSettings = null;

  try {
    // إطار مرجعي واحد بدون مؤشر لكل التسجيلات
    const refCapture = await captureReferenceFrame(rendererWin, helper.sourceId, mover);
    if (refCapture.error) {
      report.fatalError = 'ref_capture_failed: ' + refCapture.error;
      report.refCaptureSettings = refCapture.settings;
      fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
      console.error(report.fatalError);
      app.exit(1);
      return;
    }
    sharedRefPath = refCapture.refPngPath;
    refCaptureSettings = refCapture.settings;
    report.referenceSettings = refCaptureSettings;

    // المرجعية: getDisplayMedia مع cursor:'always' (متوقع ظهور المؤشر)
    for (let i = 0; i < 5; i++) {
      const rec = await runOneRecording(rendererWin, mover, 'getDisplayMedia', 'always', i, helper.sourceId, helper.bounds, sharedRefPath);
      report.findings.cursorAlways.push(rec);
      console.log(`always ${i}: cursor=${rec.cursorDetectedAny} error=${rec.error || ''} mime=${rec.mime || ''}`);
      if (i < 4) await sleep(300);
    }

    await sleep(600);

    // الاختبار: getDisplayMedia مع cursor:'never'
    for (let i = 0; i < 20; i++) {
      const rec = await runOneRecording(rendererWin, mover, 'getDisplayMedia', 'never', i, helper.sourceId, helper.bounds, sharedRefPath);
      report.findings.cursorNever.push(rec);
      console.log(`never ${i}: cursor=${rec.cursorDetectedAny} error=${rec.error || ''} mime=${rec.mime || ''}`);
      if (i < 19) await sleep(400);
    }

    const always = report.findings.cursorAlways;
    const never = report.findings.cursorNever;
    const alwaysShown = always.filter((r) => r.cursorDetectedAny).length;
    const neverHidden = never.filter((r) => !r.cursorDetectedAny).length;
    report.summary = {
      cursorAlways_total: always.length,
      cursorAlways_cursorDetected: alwaysShown,
      cursorAlways_detectionRatio: always.length ? +(alwaysShown / always.length).toFixed(3) : 0,
      cursorNever_total: never.length,
      cursorNever_cursorHidden: neverHidden,
      cursorNever_hiddenRatio: never.length ? +(neverHidden / never.length).toFixed(3) : 0,
      verdict:
        always.length >= 5 && alwaysShown >= 4 && never.length >= 20 && neverHidden >= 19
          ? 'PASS (cursor:always يظهر المؤشر وcursor:never يخفيه في 19/20)'
          : never.length >= 20 && neverHidden >= 19
            ? 'PARTIAL (cursor:never يعمل لكن cursor:always لم يثبت ظهور المؤشر)'
            : 'FAIL (cursor:never لم يخفَ المؤشر في العتبة)',
      threshold: '≥ 19/20 بدون مؤشر أصلي عند cursor:never، والمؤشر يظهر في المرجعية',
    };
  } catch (error) {
    report.fatalError = error.stack || error.message || String(error);
    report.summary = { verdict: 'FAIL (خطأ فادح أوقف المسبار)', error: report.fatalError };
  } finally {
    mover.stop();
    clearHandler();
    if (!rendererWin.isDestroyed()) rendererWin.destroy();
    shutdownHelper();
  }

  fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report.summary, null, 2));
  app.exit(report.summary.verdict && report.summary.verdict.startsWith('PASS') ? 0 : 1);
}

process.on('uncaughtException', (error) => {
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, 'uncaught-exception.log'), error.stack || error.message || String(error), 'utf8');
  } catch {}
  app.exit(1);
});

app.on('window-all-closed', () => {});

main().catch((error) => {
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, 'fatal.log'), error.stack || error.message || String(error), 'utf8');
  } catch {}
  console.error('FATAL:', error);
  app.exit(1);
});
