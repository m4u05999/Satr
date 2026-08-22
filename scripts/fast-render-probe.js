'use strict';

/**
 * مسبار م6: تصيير سريع بـ seek + requestVideoFrameCallback/captureStream(0)/requestFrame.
 *
 * ما يُقاس:
 *   1. السرعة: زمن التصيير ÷ مدة الفيديو.
 *   2. الحتمية: صيّر المشروع نفسه مرتين وقارن بصمة الإطارات.
 *   3. الصوت: هل ينجو المزج الحتمي بـ OfflineAudioContext؟ قياس الانحراف بين
 *      علامة بصرية وعلامة صوتية (p95 < 80ms).
 *   4. مرجع ffmpeg: نفس الخطة بـ ffmpeg + مقارنة بالأرقام.
 *
 * صفر تعديل على electron/ أو src/ أو package.json.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { performance } = require('perf_hooks');
const { app, BrowserWindow } = require('electron');

const OUT_DIR = path.join(__dirname, '..', 'dist', 'fast-render-probe');
const SRC_VIDEO = path.join(OUT_DIR, 'source.mp4');
const DURATION = 5;          // ثوانٍ
const FPS = 30;
const WIDTH = 640;
const HEIGHT = 480;
const SAMPLE_RATE = 48000;

// عزل البيانات وتعطيل كاش GPU كإجراء وقائي (مثل م3)
app.setPath('userData', path.join(OUT_DIR, 'user-data'));
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.appendFileSync(path.join(OUT_DIR, 'probe.log'), line + '\n', 'utf8');
  } catch {}
}

function logErr(msg) {
  const line = `[${new Date().toISOString()}] ERR ${msg}`;
  console.error(line);
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.appendFileSync(path.join(OUT_DIR, 'probe.log'), line + '\n', 'utf8');
  } catch {}
}

function writeReport(report) {
  fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
}

function runProcess(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const proc = spawn(bin, args, { windowsHide: true, ...opts });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (c) => { stdout += c.toString(); });
    proc.stderr.on('data', (c) => { stderr += c.toString(); });
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      const elapsedMs = performance.now() - started;
      if (code !== 0 && !opts.ignoreExitCode) {
        return reject(new Error(`${bin} exited ${code}: ${stderr || stdout}`.slice(0, 800)));
      }
      resolve({ code, stdout, stderr, elapsedMs });
    });
    if (opts.timeoutMs) {
      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
        reject(new Error(`${bin} timed out after ${opts.timeoutMs}ms`));
      }, opts.timeoutMs);
    }
  });
}

async function ensureSourceVideo() {
  if (fs.existsSync(SRC_VIDEO)) {
    log('source video exists');
    return SRC_VIDEO;
  }
  log('generating source video with ffmpeg');
  const filterComplex =
    `[0:v]format=yuv420p,drawbox=x=0:y=0:w=${WIDTH}:h=${HEIGHT}:color=white:t=fill:` +
    `enable='between(t,1,1.1)+between(t,2,2.1)+between(t,3,3.1)+between(t,4,4.1)'[v];` +
    `[1:a]volume='if(between(t,1,1.1)+between(t,2,2.1)+between(t,3,3.1)+between(t,4,4.1),1,0)'[a]`;
  await runProcess('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=c=black:s=${WIDTH}x${HEIGHT}:d=${DURATION}:r=${FPS}`,
    '-f', 'lavfi', '-i', `sine=frequency=1000:sample_rate=${SAMPLE_RATE}`,
    '-filter_complex', filterComplex,
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-crf', '23',
    '-c:a', 'aac', '-b:a', '128k',
    '-shortest', SRC_VIDEO,
  ], { timeoutMs: 60000 });
  log('source video generated');
  return SRC_VIDEO;
}

function writeRendererFiles() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const html = `<!doctype html>
<html dir="ltr"><head><meta charset="utf-8"><title>fast-render-probe</title></head>
<body>
<video id="srcVideo" style="display:none" crossorigin="anonymous" playsinline muted></video>
<canvas id="outCanvas" style="display:none"></canvas>
<script src="renderer.js"></script>
</body></html>`;
  fs.writeFileSync(path.join(OUT_DIR, 'renderer.html'), html, 'utf8');

  const js = `(function() {
    'use strict';

    function arrayBufferToBase64(ab) {
      const bytes = new Uint8Array(ab);
      let binary = '';
      const chunk = 65536;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      return btoa(binary);
    }

    function floatTo16BitPCM(input, output) {
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        output[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
    }

    function encodeWav(audioBuffer) {
      const numOfChan = audioBuffer.numberOfChannels;
      const length = audioBuffer.length * numOfChan * 2 + 44;
      const buffer = new ArrayBuffer(length);
      const view = new DataView(buffer);
      const channels = [];
      let offset = 0;
      let pos = 0;

      function setUint16(data) { view.setUint16(pos, data, true); pos += 2; }
      function setUint32(data) { view.setUint32(pos, data, true); pos += 4; }

      setUint32(0x46464952); // RIFF
      setUint32(length - 8);
      setUint32(0x45564157); // WAVE
      setUint32(0x20746d66); // fmt
      setUint32(16);
      setUint16(1);
      setUint16(numOfChan);
      setUint32(audioBuffer.sampleRate);
      setUint32(audioBuffer.sampleRate * 2 * numOfChan);
      setUint16(numOfChan * 2);
      setUint16(16);
      setUint32(0x61746164); // data
      setUint32(length - pos - 4);

      for (let i = 0; i < audioBuffer.numberOfChannels; i++) {
        channels.push(audioBuffer.getChannelData(i));
      }

      while (offset < audioBuffer.length) {
        for (let i = 0; i < numOfChan; i++) {
          const sample = Math.max(-1, Math.min(1, channels[i][offset]));
          view.setInt16(pos, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
          pos += 2;
        }
        offset++;
      }
      return buffer;
    }

    async function renderFastVideo(srcUrl, duration, fps) {
      const video = document.getElementById('srcVideo');
      const canvas = document.getElementById('outCanvas');
      video.src = srcUrl;
      video.load();
      await new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error('video load timeout')), 15000);
        video.addEventListener('loadedmetadata', () => { clearTimeout(to); resolve(); }, { once: true });
        video.addEventListener('error', () => { clearTimeout(to); reject(new Error(video.error ? video.error.message : 'video error')); }, { once: true });
      });
      video.pause();
      canvas.width = video.videoWidth || 640;
      canvas.height = video.videoHeight || 480;
      const ctx = canvas.getContext('2d', { alpha: false });
      const stream = canvas.captureStream(0);
      const [track] = stream.getVideoTracks();

      const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
      let recorder = null;
      let mime = '';
      for (const c of candidates) {
        if (MediaRecorder.isTypeSupported(c)) { recorder = new MediaRecorder(stream, { mimeType: c, videoBitsPerSecond: 8_000_000 }); mime = c; break; }
      }
      if (!recorder) throw new Error('no_recorder');

      const chunks = [];
      let recorderError = null;
      recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      recorder.onerror = (e) => { recorderError = e.message || 'recorder_error'; };
      const stopped = new Promise((resolve) => { recorder.onstop = resolve; });

      recorder.start(100);
      const frameInterval = 1 / fps;
      // نُنتج الإطارات أسرع من الزمن الحقيقي لكن بإيقاع ثابت يمنح المُرمّز فرصة للحاق
      const targetFrameIntervalMs = 20;
      const startedAt = performance.now();
      const frameTimes = [];
      let frameIndex = 0;

      for (let t = 0; t <= duration + 0.0001; t += frameInterval) {
        const target = Math.min(t, duration);
        video.currentTime = target;
        await new Promise((resolve, reject) => {
          const to = setTimeout(() => reject(new Error('seek timeout at ' + target)), 2000);
          video.addEventListener('seeked', () => { clearTimeout(to); resolve(); }, { once: true });
        });
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        track.requestFrame();
        frameTimes.push(target);
        frameIndex++;
        const nextFrameTime = startedAt + frameIndex * targetFrameIntervalMs;
        const wait = nextFrameTime - performance.now();
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
      }

      const elapsed = performance.now() - startedAt;
      // مهلة قصيرة للترميز الأخير
      await new Promise(r => setTimeout(r, 200));
      recorder.stop();
      await stopped;
      if (recorderError) throw new Error(recorderError);

      const blob = new Blob(chunks, { type: recorder.mimeType });
      if (!blob.size) throw new Error('empty_blob');
      const ab = await blob.arrayBuffer();
      return {
        base64: arrayBufferToBase64(ab),
        mime: recorder.mimeType,
        durationMs: elapsed,
        byteLength: ab.byteLength,
        frameCount: frameTimes.length,
        frameInterval,
      };
    }

    async function renderFastAudio(duration, sampleRate) {
      const offline = new OfflineAudioContext(2, Math.ceil(sampleRate * duration), sampleRate);
      const osc = offline.createOscillator();
      const gain = offline.createGain();
      osc.frequency.value = 1000;
      gain.gain.value = 0;
      osc.connect(gain);
      gain.connect(offline.destination);
      for (let t = 1; t < duration; t += 1) {
        gain.gain.setValueAtTime(1, t);
        gain.gain.setValueAtTime(0, t + 0.1);
      }
      osc.start(0);
      osc.stop(duration);
      const buffer = await offline.startRendering();
      const wav = encodeWav(buffer);
      return {
        base64: arrayBufferToBase64(wav),
        duration: buffer.duration,
        sampleRate: buffer.sampleRate,
        length: buffer.length,
      };
    }

    window.renderFastVideo = renderFastVideo;
    window.renderFastAudio = renderFastAudio;
  })();`;
  fs.writeFileSync(path.join(OUT_DIR, 'renderer.js'), js, 'utf8');
}

async function createWindow() {
  await app.whenReady();
  const win = new BrowserWindow({
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
  await win.loadURL('file:///' + path.join(OUT_DIR, 'renderer.html').replace(/\\/g, '/'));
  return win;
}

async function saveBase64(base64, outPath) {
  fs.writeFileSync(outPath, Buffer.from(base64, 'base64'));
}

async function renderFastVideoRun(win, runName) {
  const srcUrl = 'file:///' + SRC_VIDEO.replace(/\\/g, '/');
  const result = await win.webContents.executeJavaScript(
    `window.renderFastVideo(${JSON.stringify(srcUrl)}, ${DURATION}, ${FPS})`, true);
  if (result.error) throw new Error(result.error);
  const videoPath = path.join(OUT_DIR, `${runName}.webm`);
  await saveBase64(result.base64, videoPath);
  return { ...result, videoPath };
}

async function renderFastAudioRun(win, runName) {
  const result = await win.webContents.executeJavaScript(
    `window.renderFastAudio(${DURATION}, ${SAMPLE_RATE})`, true);
  if (result.error) throw new Error(result.error);
  const audioPath = path.join(OUT_DIR, `${runName}.wav`);
  await saveBase64(result.base64, audioPath);
  return { ...result, audioPath };
}

async function muxVideoAudio(videoPath, audioPath, outPath) {
  await runProcess('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', videoPath,
    '-i', audioPath,
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '128k',
    '-shortest', outPath,
  ], { timeoutMs: 60000 });
  return outPath;
}

async function frameHashes(videoPath, outTxt) {
  await runProcess('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', videoPath,
    '-an', '-f', 'framehash', '-hash', 'md5',
    outTxt,
  ], { timeoutMs: 60000 });
  const lines = fs.readFileSync(outTxt, 'utf8').split(/\r?\n/).filter(l => l && !l.startsWith('#'));
  return lines;
}

function compareFrameHashes(lines1, lines2) {
  const count = Math.min(lines1.length, lines2.length);
  let identical = 0;
  const mismatches = [];
  for (let i = 0; i < count; i++) {
    const h1 = lines1[i].trim().split(',').pop();
    const h2 = lines2[i].trim().split(',').pop();
    if (h1 === h2) identical++;
    else mismatches.push(i);
  }
  return {
    framesCompared: count,
    identical,
    different: count - identical,
    mismatchIndices: mismatches.slice(0, 10),
    extraFrames1: Math.max(0, lines1.length - count),
    extraFrames2: Math.max(0, lines2.length - count),
  };
}

async function detectAudioOnsets(filePath) {
  // نستخدم silencedetect: النغمات هي فترات الصوت بين فترات الصمت
  const { stderr } = await runProcess('ffmpeg', [
    '-y', '-hide_banner',
    '-i', filePath,
    '-af', 'silencedetect=noise=-40dB:d=0.05',
    '-f', 'null', '-',
  ], { timeoutMs: 60000, ignoreExitCode: true }); // silencedetect يخرج 0 غالباً
  const silenceStarts = [];
  const silenceEnds = [];
  const reStart = /silence_start:\s*([\d.]+)/g;
  const reEnd = /silence_end:\s*([\d.]+)/g;
  let m;
  while ((m = reStart.exec(stderr)) !== null) silenceStarts.push(parseFloat(m[1]));
  while ((m = reEnd.exec(stderr)) !== null) silenceEnds.push(parseFloat(m[1]));

  // النغمات هي فترات صوت بين فترتَي صمت: onset = نهاية صمت، ويليه صمت آخر
  const onsets = [];
  for (let i = 0; i < silenceEnds.length; i++) {
    const nextStart = silenceStarts[i + 1];
    if (nextStart == null) continue; // نهاية الملف، ليست نغمة
    const gap = nextStart - silenceEnds[i];
    if (gap >= 0.05 && gap <= 0.2) onsets.push(silenceEnds[i]);
  }
  return { onsets, silenceStarts, silenceEnds, raw: stderr };
}

async function detectVideoFlashes(filePath) {
  // استخراج متوسط سطوع الإطار (YAVG) مع الطابع الزمني الحقيقي عبر signalstats+metadata
  const metaPath = path.join(OUT_DIR, 'flash-metadata.txt');
  await runProcess('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', filePath,
    '-vf', `signalstats,metadata=print:file=${metaPath}`,
    '-f', 'null', '-',
  ], { timeoutMs: 60000, ignoreExitCode: true });

  const meta = fs.readFileSync(metaPath, 'utf8');
  const frames = [];
  const reFrame = /frame:\s*(\d+)\s+pts:\s*\S+\s+pts_time:([\d.]+)/;
  let currentFrame = null;
  for (const line of meta.split(/\r?\n/)) {
    const fm = reFrame.exec(line);
    if (fm) {
      currentFrame = { frame: parseInt(fm[1], 10), ptsTime: parseFloat(fm[2]) };
      frames.push(currentFrame);
      continue;
    }
    const ym = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(line);
    if (ym && currentFrame) {
      currentFrame.yavg = parseFloat(ym[1]);
    }
  }

  const validFrames = frames.filter(f => f.yavg != null);
  const mean = validFrames.reduce((a, f) => a + f.yavg, 0) / validFrames.length;
  const std = Math.sqrt(validFrames.reduce((sq, f) => sq + (f.yavg - mean) ** 2, 0) / validFrames.length);
  const threshold = mean + 3 * std;

  const flashes = [];
  for (let i = 0; i < validFrames.length; i++) {
    if (validFrames[i].yavg > threshold) {
      flashes.push({ frame: validFrames[i].frame, time: validFrames[i].ptsTime, yavg: validFrames[i].yavg });
      // تخطّي بقية الإطارات داخل نفس الومضة
      while (i + 1 < validFrames.length && validFrames[i + 1].yavg > threshold) i++;
    }
  }
  return { flashes, frameCount: validFrames.length, mean, std, threshold };
}

async function ffmpegReferenceRender(runName) {
  const outPath = path.join(OUT_DIR, `${runName}-ffmpeg.mp4`);
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', SRC_VIDEO,
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
    '-c:a', 'aac', '-b:a', '128k',
    outPath,
  ];
  const { elapsedMs } = await runProcess('ffmpeg', args, { timeoutMs: 120000 });
  return { outPath, elapsedMs };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const report = {
    probe: 'fast-render-probe',
    at: new Date().toISOString(),
    platform: process.platform,
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    source: { path: SRC_VIDEO, duration: DURATION, fps: FPS, width: WIDTH, height: HEIGHT },
    findings: {},
    summary: {},
  };

  try {
    writeRendererFiles();
    await ensureSourceVideo();
    const win = await createWindow();

    // ── 1+2. تصيير سريع للفيديو مرتين ────────────────────────────────
    log('fast video run 1');
    const run1 = await renderFastVideoRun(win, 'run1');
    log(`run1: ${run1.frameCount} frames, ${run1.durationMs.toFixed(1)}ms, ${run1.byteLength} bytes`);

    log('fast video run 2');
    const run2 = await renderFastVideoRun(win, 'run2');
    log(`run2: ${run2.frameCount} frames, ${run2.durationMs.toFixed(1)}ms, ${run2.byteLength} bytes`);

    // ── حتمية الفيديو ───────────────────────────────────────────────
    const hashes1 = await frameHashes(run1.videoPath, path.join(OUT_DIR, 'run1-framehash.txt'));
    const hashes2 = await frameHashes(run2.videoPath, path.join(OUT_DIR, 'run2-framehash.txt'));
    const videoDet = compareFrameHashes(hashes1, hashes2);
    log(`video determinism: ${videoDet.identical}/${videoDet.framesCompared} identical`);

    // ── 3. الصوت عبر OfflineAudioContext ─────────────────────────────
    log('fast audio render');
    const audioRun = await renderFastAudioRun(win, 'audio');
    log(`audio: ${audioRun.length} samples, ${audioRun.duration.toFixed(3)}s`);

    // ── ضم الفيديو السريع والصوت الحتمي ──────────────────────────────
    log('muxing fast video + audio');
    const muxedPath = path.join(OUT_DIR, 'fast-muxed.mp4');
    await muxVideoAudio(run1.videoPath, audioRun.audioPath, muxedPath);
    log('muxed: ' + muxedPath);

    // ── قياس الانحراف الصوتي/البصري ──────────────────────────────────
    const audioOnsets = await detectAudioOnsets(muxedPath);
    const videoFlashes = await detectVideoFlashes(muxedPath);
    const driftMsList = [];
    const pairs = [];
    const count = Math.min(audioOnsets.onsets.length, videoFlashes.flashes.length);
    for (let i = 0; i < count; i++) {
      const driftMs = Math.abs(audioOnsets.onsets[i] - videoFlashes.flashes[i].time) * 1000;
      driftMsList.push(driftMs);
      pairs.push({ audio: audioOnsets.onsets[i], video: videoFlashes.flashes[i].time, driftMs });
    }
    driftMsList.sort((a, b) => a - b);
    const p95 = driftMsList[Math.floor(driftMsList.length * 0.95)] ?? null;
    const maxDrift = driftMsList.length ? driftMsList[driftMsList.length - 1] : null;
    log(`drift markers=${driftMsList.length}, p95=${p95}ms, max=${maxDrift}ms`);

    // ── 4. مرجع ffmpeg ───────────────────────────────────────────────
    log('ffmpeg reference run 1');
    const ff1 = await ffmpegReferenceRender('run1');
    log(`ffmpeg ref1: ${ff1.elapsedMs.toFixed(1)}ms`);

    log('ffmpeg reference run 2');
    const ff2 = await ffmpegReferenceRender('run2');
    log(`ffmpeg ref2: ${ff2.elapsedMs.toFixed(1)}ms`);

    const ffHashes1 = await frameHashes(ff1.outPath, path.join(OUT_DIR, 'ffmpeg-run1-framehash.txt'));
    const ffHashes2 = await frameHashes(ff2.outPath, path.join(OUT_DIR, 'ffmpeg-run2-framehash.txt'));
    const ffmpegDet = compareFrameHashes(ffHashes1, ffHashes2);
    log(`ffmpeg determinism: ${ffmpegDet.identical}/${ffmpegDet.framesCompared} identical`);

    // ── تجميع التقرير ───────────────────────────────────────────────
    const fastRatio = run1.durationMs / (DURATION * 1000);
    const ffmpegRatio = ff1.elapsedMs / (DURATION * 1000);

    report.findings = {
      fastVideo: {
        run1: { durationMs: run1.durationMs, frameCount: run1.frameCount, byteLength: run1.byteLength, mime: run1.mime },
        run2: { durationMs: run2.durationMs, frameCount: run2.frameCount, byteLength: run2.byteLength, mime: run2.mime },
        determinism: videoDet,
        speedRatio: +fastRatio.toFixed(3),
      },
      fastAudio: {
        sampleRate: audioRun.sampleRate,
        length: audioRun.length,
        duration: audioRun.duration,
        audioPath: audioRun.audioPath,
      },
      mux: {
        path: muxedPath,
        audioOnsets: audioOnsets.onsets,
        videoFlashTimes: videoFlashes.flashes.map(f => f.time),
        driftPairs: pairs,
        driftMsList,
        p95DriftMs: p95,
        maxDriftMs: maxDrift,
      },
      ffmpegReference: {
        run1ElapsedMs: ff1.elapsedMs,
        run2ElapsedMs: ff2.elapsedMs,
        determinism: ffmpegDet,
        speedRatio: +ffmpegRatio.toFixed(3),
      },
    };

    report.summary = {
      fastSpeedRatio: +fastRatio.toFixed(3),
      ffmpegSpeedRatio: +ffmpegRatio.toFixed(3),
      speedWinner: fastRatio < ffmpegRatio ? 'fast' : 'ffmpeg',
      videoDeterministic: videoDet.identical === videoDet.framesCompared && videoDet.framesCompared > 0,
      ffmpegDeterministic: ffmpegDet.identical === ffmpegDet.framesCompared && ffmpegDet.framesCompared > 0,
      audioSurvivedMux: driftMsList.length > 0,
      p95DriftMs: p95,
      driftThreshold80ms: p95 !== null ? p95 < 80 : null,
      verdict:
        videoDet.identical === videoDet.framesCompared &&
        driftMsList.length > 0 &&
        p95 !== null && p95 < 80
          ? 'PASS (fast render حتمي والصوت ينجو بانحراف <80ms)'
          : 'PARTIAL/FAIL (يلزم مراجعة الأرقام)',
    };

    if (!win.isDestroyed()) win.destroy();
  } catch (error) {
    logErr(error.stack || error.message || String(error));
    report.fatalError = error.stack || error.message || String(error);
    report.summary = { verdict: 'FAIL (خطأ فادح أوقف المسبار)', error: report.fatalError };
  }

  writeReport(report);
  console.log(JSON.stringify(report.summary, null, 2));
  app.exit(report.summary.verdict && report.summary.verdict.startsWith('PASS') ? 0 : 1);
}

process.on('uncaughtException', (error) => {
  logErr('uncaughtException: ' + (error.stack || error.message));
  try { writeReport({ probe: 'fast-render-probe', at: new Date().toISOString(), fatalError: error.stack || error.message }); } catch {}
  app.exit(1);
});

app.on('window-all-closed', () => {});

main().catch((error) => {
  logErr('main catch: ' + (error.stack || error.message));
  try { writeReport({ probe: 'fast-render-probe', at: new Date().toISOString(), fatalError: error.stack || error.message }); } catch {}
  console.error('FATAL:', error);
  app.exit(1);
});
