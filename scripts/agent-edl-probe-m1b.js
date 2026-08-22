#!/usr/bin/env electron
'use strict';

// مسبار م1-ب: يربط ساعة أفعال الوكيل بـPTS منارة داخل الفيديو، ثم يفصل عدم يقين
// أخذ العينات عن الانزياح المتبقي. يستدعي مسار الإنتاج ولا يعدّل كوده.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const { app, BrowserWindow, desktopCapturer } = require('electron');
const preview = require('../electron/preview');
const promo = require('../electron/promocapture');

const OUT_DIR = path.join(__dirname, '..', 'dist', 'agent-edl-probe-m1b');
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'agent-edl-probe-m1b-page.html');
const SESSION_COUNT = 3;
const ACTIONS_PER_SESSION = 10;
const MAX_RUNTIME_MS = 5 * 60 * 1000;
const ANALYZE_ONLY = process.argv.includes('--analyze-only');
const REJUDGE_ONLY = process.argv.includes('--rejudge-only');
const ACTION_DELAYS_MS = [1300, 1700, 1400, 1900, 1600, 1800, 1500, 2000, 1600, 1700];
const SYNC_COLOR = [248, 248, 248];
const SYNC_END_COLOR = [248, 248, 30];
const PALETTE = [
  [230, 40, 55], [20, 190, 80], [35, 90, 230], [235, 190, 30], [190, 40, 200],
  [25, 190, 210], [235, 105, 25], [100, 60, 210], [140, 210, 35], [235, 70, 140],
];
const DEFAULT_PROFILE = { key: 'default', width: 1920, height: 1080, bitrate: 10000000 };
const FPS_PROFILES = [
  { key: 'motion-1080p-10mbps', width: 1920, height: 1080, bitrate: 10000000 },
  { key: 'motion-540p-4mbps', width: 960, height: 540, bitrate: 4000000 },
];

fs.mkdirSync(OUT_DIR, { recursive: true });

let fatalStarted = false;
function cleanError(error) {
  return String(error && error.message ? error.message : error || 'unknown')
    .replace(/[A-Za-z]:\\[^\s]+/g, '<path>').slice(0, 500);
}

function writeJson(filename, value) {
  const outputPath = path.join(OUT_DIR, filename);
  const partialPath = outputPath + '.partial';
  fs.writeFileSync(partialPath, JSON.stringify(value, null, 2), 'utf8');
  try { fs.unlinkSync(outputPath); } catch {}
  fs.renameSync(partialPath, outputPath);
}

function writeFailure(kind, error) {
  try {
    writeJson('failure.json', {
      status: 'FAIL', kind, reason: cleanError(error), at: new Date().toISOString(),
      environment: { electron: process.versions.electron, node: process.versions.node, platform: process.platform },
    });
  } catch {}
}

function fatal(kind, error) {
  if (fatalStarted) return;
  fatalStarted = true;
  writeFailure(kind, error);
  process.stderr.write('FAIL: ' + kind + ': ' + cleanError(error) + '\n');
  try { app.exit(1); } catch { process.exitCode = 1; }
  setTimeout(() => process.exit(1), 1000).unref();
}

process.on('uncaughtException', (error) => fatal('uncaught_exception', error));
process.on('unhandledRejection', (error) => fatal('unhandled_rejection', error));
const watchdog = setTimeout(() => fatal('timeout', 'maximum runtime exceeded'), MAX_RUNTIME_MS);
watchdog.unref();
app.on('window-all-closed', () => {});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: options.binary ? null : 'utf8',
    maxBuffer: options.maxBuffer || 32 * 1024 * 1024,
    timeout: options.timeout || 120000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const reason = result.error ? result.error.message : String(result.stderr || '').slice(0, 500);
    throw new Error(command + '_failed: ' + reason);
  }
  return result.stdout;
}

function runBinaryWithLog(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: null,
    maxBuffer: options.maxBuffer || 64 * 1024 * 1024,
    timeout: options.timeout || 120000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const reason = result.error ? result.error.message : String(result.stderr || '').slice(0, 500);
    throw new Error(command + '_failed: ' + reason);
  }
  return { stdout: result.stdout, stderr: String(result.stderr || '') };
}

function round(value, digits = 1) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function nearestRank(values, percentile) {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!finite.length) return null;
  return finite[Math.max(0, Math.ceil(percentile * finite.length) - 1)];
}

function median(values) {
  return nearestRank(values, 0.5);
}

function percentileItem(items, selector, percentile) {
  const ranked = items.filter((item) => Number.isFinite(selector(item)))
    .slice().sort((left, right) => selector(left) - selector(right));
  if (!ranked.length) return null;
  return ranked[Math.max(0, Math.ceil(percentile * ranked.length) - 1)];
}

function fraction(value) {
  const parts = String(value || '').split('/').map(Number);
  if (parts.length !== 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1]) || parts[1] === 0) return null;
  return parts[0] / parts[1];
}

function distanceRgb(left, right) {
  return Math.sqrt((left[0] - right[0]) ** 2 + (left[1] - right[1]) ** 2 + (left[2] - right[2]) ** 2);
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function startFixtureServer() {
  const fixture = fs.readFileSync(FIXTURE_PATH, 'utf8');
  const server = http.createServer((_request, response) => {
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'self' 'unsafe-inline'",
    });
    response.end(fixture);
  });
  const port = await listen(server);
  return { server, url: 'http://127.0.0.1:' + port + '/' };
}

async function waitForFixture(wc) {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    try {
      const ready = await wc.executeJavaScript(
        'window.__edlM1bReady === true && !!document.getElementById("sync-beacon-start")', true);
      if (ready) return;
    } catch {}
    await delay(50);
  }
  throw new Error('fixture_ready_timeout');
}

async function readHandlerEvent(wc, kind, index = null) {
  const events = await wc.executeJavaScript('window.__getEdlM1bEvents()', true);
  const matches = events.filter((event) => event.kind === kind && (index == null || event.index === index));
  const found = matches[matches.length - 1];
  if (!found || !Number.isFinite(found.date_now_ms) || !Number.isFinite(found.performance_now_ms)) {
    throw new Error('handler_timestamp_missing_' + kind);
  }
  return found;
}

function inspectFrames(videoPath) {
  const probe = JSON.parse(run('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_streams',
    '-show_entries', 'stream=width,height,avg_frame_rate,r_frame_rate,time_base,duration,nb_frames',
    '-of', 'json', videoPath,
  ]));
  const stream = probe.streams && probe.streams[0] ? probe.streams[0] : {};
  const decoded = runBinaryWithLog('ffmpeg', [
    '-nostdin', '-v', 'info', '-i', videoPath,
    '-vf', 'crop=2:2:10:50,scale=1:1:flags=neighbor,format=rgb24,showinfo',
    '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1',
  ]);
  const framePattern = /n:\s*(\d+)\s+pts:\s*(-?\d+)\s+pts_time:\s*([^\s]+)/g;
  const loggedFrames = [];
  let match;
  while ((match = framePattern.exec(decoded.stderr))) {
    loggedFrames.push({ index: Number(match[1]), pts_ticks: Number(match[2]), pts_ms: Number(match[3]) * 1000 });
  }
  const decodedCount = Math.floor(decoded.stdout.length / 3);
  if (decoded.stdout.length % 3 !== 0 || loggedFrames.length !== decodedCount) {
    throw new Error('showinfo_decode_frame_mismatch_' + loggedFrames.length + '_' + decodedCount);
  }
  const frames = loggedFrames.map((frame, index) => {
    if (frame.index !== index || !Number.isFinite(frame.pts_ms) || !Number.isFinite(frame.pts_ticks)) {
      throw new Error('invalid_showinfo_frame_' + index);
    }
    return frame;
  });
  if (!frames.length) throw new Error('no_decoded_frames');
  const pixels = frames.map((_frame, index) => [
    decoded.stdout[index * 3], decoded.stdout[index * 3 + 1], decoded.stdout[index * 3 + 2],
  ]);
  let monotonic = true;
  const deltas = [];
  for (let index = 1; index < frames.length; index += 1) {
    const delta = frames[index].pts_ms - frames[index - 1].pts_ms;
    if (!(delta > 0)) monotonic = false;
    if (delta > 0) deltas.push(delta);
  }
  if (!monotonic) throw new Error('non_monotonic_pts');
  const timeBase = fraction(stream.time_base);
  const loggedTimeBase = decoded.stderr.match(/config in time_base:\s*([^,\s]+)/);
  if (!Number.isFinite(timeBase) || !loggedTimeBase || loggedTimeBase[1] !== stream.time_base) {
    throw new Error('showinfo_time_base_mismatch');
  }
  const unitErrors = frames
    .map((frame) => Math.abs(frame.pts_ticks * timeBase * 1000 - frame.pts_ms));
  const maxUnitErrorMs = unitErrors.length ? Math.max(...unitErrors) : null;
  if (maxUnitErrorMs != null && maxUnitErrorMs > 0.05) throw new Error('pts_time_base_mismatch');

  const durationMs = Number(stream.duration) * 1000;
  const steadyDeltas = deltas.slice(Math.min(3, deltas.length));
  const medianDelta = median(steadyDeltas);
  const pixelDeltas = pixels.slice(1).map((pixel, index) => distanceRgb(pixel, pixels[index]));
  return {
    stream: {
      width: Number(stream.width), height: Number(stream.height), time_base: stream.time_base || '',
      avg_frame_rate: stream.avg_frame_rate || '', r_frame_rate: stream.r_frame_rate || '',
      duration_ms: round(durationMs, 3), nb_frames: Number(stream.nb_frames) || null,
    },
    frames, pixels, pts: {
      count: frames.length, strictly_monotonic: monotonic, max_time_base_error_ms: round(maxUnitErrorMs, 6),
      first_pts_ms: round(frames[0] && frames[0].pts_ms, 4),
      startup_gap_ms: round(deltas[0], 4),
      steady_delta_ms: {
        median: round(medianDelta, 4), p05: round(nearestRank(steadyDeltas, 0.05), 4),
        p95: round(nearestRank(steadyDeltas, 0.95), 4), max: round(nearestRank(steadyDeltas, 1), 4),
      },
      decoded_fps_by_duration: round(frames.length / (durationMs / 1000), 3),
      median_cadence_fps: medianDelta ? round(1000 / medianDelta, 3) : null,
      container_avg_fps: round(fraction(stream.avg_frame_rate), 3),
      gaps_over_1_5x_median: medianDelta
        ? steadyDeltas.filter((value) => value > medianDelta * 1.5).length : null,
      sampled_pixel_change_rate_pct: pixelDeltas.length
        ? round(pixelDeltas.filter((value) => value > 2).length / pixelDeltas.length * 100, 2) : null,
      sampled_pixel_repeat_rate_pct: pixelDeltas.length
        ? round(pixelDeltas.filter((value) => value <= 2).length / pixelDeltas.length * 100, 2) : null,
    },
  };
}

function findColor(frames, pixels, target, startIndex = 0) {
  let bestDistance = Infinity;
  for (let index = startIndex; index < pixels.length; index += 1) {
    const currentDistance = distanceRgb(pixels[index], target);
    bestDistance = Math.min(bestDistance, currentDistance);
    if (currentDistance <= 55) {
      if (index < 1) throw new Error('transition_without_previous_frame');
      return {
        index,
        pts_ms: frames[index].pts_ms,
        previous_pts_ms: frames[index - 1].pts_ms,
        frame_interval_ms: frames[index].pts_ms - frames[index - 1].pts_ms,
        distance: currentDistance,
        pixel: pixels[index],
      };
    }
  }
  return { index: -1, best_distance: bestDistance };
}

function summarizeErrors(actions) {
  const valid = actions.filter((item) => item.detected);
  const beforeAbs = valid.map((item) => Math.abs(item.before.error_ms));
  const afterAbs = valid.map((item) => Math.abs(item.after.error_ms));
  const signedAfter = valid.map((item) => item.after.error_ms);
  const halfFrames = valid.map((item) => item.quantization.action_half_frame_ms);
  const combinedHalf = valid.map((item) => item.quantization.combined_half_width_ms);
  const intervalMidAbs = valid.map((item) => Math.abs(item.quantization.interval_mid_error_ms));
  const residual = valid.map((item) => item.quantization.guaranteed_residual_ms);
  const normalized = valid.map((item) => item.quantization.abs_error_in_action_half_frames);
  return {
    detected: valid.length,
    before_beacon: {
      signed_median_ms: round(median(valid.map((item) => item.before.error_ms))),
      absolute_p95_ms: round(nearestRank(beforeAbs, 0.95)),
      absolute_worst_ms: round(nearestRank(beforeAbs, 1)),
    },
    after_beacon: {
      signed_median_ms: round(median(signedAfter)), min_ms: round(nearestRank(signedAfter, 0.01)),
      max_ms: round(nearestRank(signedAfter, 1)), range_ms: signedAfter.length
        ? round(Math.max(...signedAfter) - Math.min(...signedAfter)) : null,
      absolute_median_ms: round(median(afterAbs)), absolute_p95_ms: round(nearestRank(afterAbs, 0.95)),
      absolute_worst_ms: round(nearestRank(afterAbs, 1)),
    },
    quantization: {
      action_half_frame_p95_ms: round(nearestRank(halfFrames, 0.95)),
      interval_mid_absolute_p95_ms: round(nearestRank(intervalMidAbs, 0.95)),
      combined_beacon_action_half_width_p95_ms: round(nearestRank(combinedHalf, 0.95)),
      guaranteed_residual_p95_ms: round(nearestRank(residual, 0.95)),
      abs_error_in_action_half_frames_p95: round(nearestRank(normalized, 0.95), 2),
    },
  };
}

function analyzeSyncVideo(videoPath, capture) {
  const inspected = inspectFrames(videoPath);
  const beacon = findColor(inspected.frames, inspected.pixels, SYNC_COLOR);
  if (beacon.index < 0) throw new Error('sync_beacon_not_detected_' + round(beacon.best_distance));
  const endBeacon = findColor(inspected.frames, inspected.pixels, SYNC_END_COLOR, beacon.index + 1);
  if (endBeacon.index < 0) throw new Error('sync_end_beacon_not_detected_' + round(endBeacon.best_distance));
  const actions = capture.actions.map((action) => {
    const detected = findColor(inspected.frames, inspected.pixels, PALETTE[action.action_index], beacon.index + 1);
    if (detected.index < 0) {
      return { ...action, detected: false, best_distance: round(detected.best_distance, 1) };
    }
    const clockRelativeMs = action.invocation_performance_ms - capture.beacon.invocation_performance_ms;
    const wallClockRelativeMs = action.invocation_epoch_ms - capture.beacon.invocation_epoch_ms;
    const videoRelativeMs = detected.pts_ms - beacon.pts_ms;
    const beforeClockMs = action.invocation_epoch_ms - capture.recorder.start_epoch_ms;
    const beforeErrorMs = detected.pts_ms - beforeClockMs;
    const afterErrorMs = videoRelativeMs - clockRelativeMs;
    const afterWallErrorMs = videoRelativeMs - wallClockRelativeMs;
    const beaconCorrectionMs = beacon.pts_ms
      - (capture.beacon.invocation_epoch_ms - capture.recorder.start_epoch_ms);
    const lowVisualMs = detected.previous_pts_ms - beacon.pts_ms;
    const highVisualMs = detected.pts_ms - beacon.previous_pts_ms;
    const lowErrorMs = lowVisualMs - clockRelativeMs;
    const highErrorMs = highVisualMs - clockRelativeMs;
    const intervalMidErrorMs = (lowErrorMs + highErrorMs) / 2;
    const combinedHalfWidthMs = (highErrorMs - lowErrorMs) / 2;
    const guaranteedResidualMs = lowErrorMs > 0 ? lowErrorMs : highErrorMs < 0 ? Math.abs(highErrorMs) : 0;
    const actionHalfFrameMs = detected.frame_interval_ms / 2;
    return {
      ...action, detected: true,
      frame_number: detected.index + 1, beacon_frame_number: beacon.index + 1,
      before: {
        clock_t_ms: round(beforeClockMs, 3), video_t_ms: round(detected.pts_ms, 3),
        error_ms: round(beforeErrorMs, 3),
      },
      after: {
        clock_t_ms: round(clockRelativeMs, 3), video_t_ms: round(videoRelativeMs, 3),
        error_ms: round(afterErrorMs, 3),
      },
      wall_clock_diagnostic: {
        clock_t_ms: round(wallClockRelativeMs, 3), error_ms: round(afterWallErrorMs, 3),
      },
      handler_clock: {
        clock_t_ms: round(action.handler.date_now_ms - capture.beacon.handler.date_now_ms, 3),
        error_ms: round(videoRelativeMs
          - (action.handler.date_now_ms - capture.beacon.handler.date_now_ms), 3),
        invocation_to_handler_ms: round(action.handler.date_now_ms - action.invocation_epoch_ms, 3),
      },
      quantization: {
        action_frame_interval_ms: round(detected.frame_interval_ms, 3),
        action_half_frame_ms: round(actionHalfFrameMs, 3),
        beacon_frame_interval_ms: round(beacon.frame_interval_ms, 3),
        combined_half_width_ms: round(combinedHalfWidthMs, 3),
        interval_error_low_ms: round(lowErrorMs, 3), interval_error_high_ms: round(highErrorMs, 3),
        interval_mid_error_ms: round(intervalMidErrorMs, 3),
        guaranteed_residual_ms: round(guaranteedResidualMs, 3),
        abs_error_in_action_half_frames: actionHalfFrameMs
          ? round(Math.abs(afterErrorMs) / actionHalfFrameMs, 4) : null,
      },
      beacon_correction_ms: round(beaconCorrectionMs, 3),
      correction_identity_delta_ms: round(afterWallErrorMs - (beforeErrorMs - beaconCorrectionMs), 6),
      detected_rgb: detected.pixel, color_distance: round(detected.distance, 1),
    };
  });
  return {
    video: inspected.stream,
    pts: inspected.pts,
    beacon: {
      invocation_epoch_ms: capture.beacon.invocation_epoch_ms,
      invocation_performance_ms: capture.beacon.invocation_performance_ms,
      frame_number: beacon.index + 1, pts_ms: round(beacon.pts_ms, 3),
      previous_pts_ms: round(beacon.previous_pts_ms, 3), frame_interval_ms: round(beacon.frame_interval_ms, 3),
      recorder_clock_t_ms: capture.beacon.invocation_epoch_ms - capture.recorder.start_epoch_ms,
      correction_ms: round(beacon.pts_ms
        - (capture.beacon.invocation_epoch_ms - capture.recorder.start_epoch_ms), 3),
      detected_rgb: beacon.pixel, color_distance: round(beacon.distance, 1),
    },
    end_beacon: {
      invocation_epoch_ms: capture.end_beacon.invocation_epoch_ms,
      invocation_performance_ms: capture.end_beacon.invocation_performance_ms,
      frame_number: endBeacon.index + 1, pts_ms: round(endBeacon.pts_ms, 3),
      previous_pts_ms: round(endBeacon.previous_pts_ms, 3),
      frame_interval_ms: round(endBeacon.frame_interval_ms, 3),
      detected_rgb: endBeacon.pixel, color_distance: round(endBeacon.distance, 1),
    },
    clock_validation: (() => {
      const mainDateElapsed = capture.end_beacon.invocation_epoch_ms - capture.beacon.invocation_epoch_ms;
      const mainPerfElapsed = capture.end_beacon.invocation_performance_ms
        - capture.beacon.invocation_performance_ms;
      const rendererDateElapsed = capture.end_beacon.handler.date_now_ms - capture.beacon.handler.date_now_ms;
      const rendererPerfElapsed = capture.end_beacon.handler.performance_now_ms
        - capture.beacon.handler.performance_now_ms;
      const videoElapsed = endBeacon.pts_ms - beacon.pts_ms;
      return {
        main_date_elapsed_ms: round(mainDateElapsed, 3), main_monotonic_elapsed_ms: round(mainPerfElapsed, 3),
        renderer_date_elapsed_ms: round(rendererDateElapsed, 3),
        renderer_monotonic_elapsed_ms: round(rendererPerfElapsed, 3), video_pts_elapsed_ms: round(videoElapsed, 3),
        main_wall_vs_monotonic_delta_ms: round(mainDateElapsed - mainPerfElapsed, 3),
        renderer_wall_vs_monotonic_delta_ms: round(rendererDateElapsed - rendererPerfElapsed, 3),
        video_vs_main_monotonic_delta_ms: round(videoElapsed - mainPerfElapsed, 3),
        start_invocation_to_handler_ms: round(capture.beacon.handler.date_now_ms
          - capture.beacon.invocation_epoch_ms, 3),
        end_invocation_to_handler_ms: round(capture.end_beacon.handler.date_now_ms
          - capture.end_beacon.invocation_epoch_ms, 3),
      };
    })(),
    actions,
    summary: summarizeErrors(actions),
  };
}

async function main() {
  await app.whenReady();
  const { server, url } = await startFixtureServer();
  const receiver = new BrowserWindow({
    show: false, width: 640, height: 480,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  await receiver.loadURL(url);

  let controller;
  let activeRun = null;
  let pendingDownload = null;
  let stopTask = null;

  receiver.webContents.session.on('will-download', (_event, item) => {
    const pending = pendingDownload;
    if (!pending) return;
    item.setSavePath(pending.outputPath);
    item.once('done', (_doneEvent, state) => {
      pendingDownload = null;
      if (state === 'completed') {
        controller.downloadResult({ type: 'promo_recording_saved', filename: pending.filename, path: pending.outputPath });
        pending.resolve({ ok: true });
      } else {
        controller.downloadResult({ type: 'promo_recording_failed', filename: pending.filename });
        pending.reject(new Error('download_' + state));
      }
    });
  });

  async function startRecorder(event) {
    const profile = activeRun.profile;
    return receiver.webContents.executeJavaScript(`(async function(){
      const stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{mandatory:{
        chromeMediaSource:'desktop',chromeMediaSourceId:${JSON.stringify(event.source_id)},
        minWidth:${profile.width},maxWidth:${profile.width},minHeight:${profile.height},maxHeight:${profile.height},
        minFrameRate:30,maxFrameRate:30
      }}});
      const candidates=['video/mp4;codecs=avc1.42E01E','video/mp4;codecs=avc1','video/mp4','video/webm;codecs=vp9','video/webm'];
      const mime=candidates.find((item)=>MediaRecorder.isTypeSupported(item))||'';
      const options={videoBitsPerSecond:${profile.bitrate}};if(mime)options.mimeType=mime;
      const recorder=new MediaRecorder(stream,options),chunks=[];
      recorder.ondataavailable=(event)=>{if(event.data&&event.data.size)chunks.push(event.data);};
      const startEpochMs=Date.now();recorder.start(500);
      window.__edlM1bRecorder={stream,recorder,chunks,mime,startEpochMs,blob:null};
      const track=stream.getVideoTracks()[0];
      return {start_epoch_ms:startEpochMs,mime:mime,settings:track.getSettings(),tracks:stream.getVideoTracks().length};
    })()`, true);
  }

  async function stopRecorder(event) {
    const stopped = await receiver.webContents.executeJavaScript(`new Promise((resolve,reject)=>{
      const state=window.__edlM1bRecorder;if(!state)return reject(new Error('missing_recorder'));
      state.recorder.onstop=()=>{state.blob=new Blob(state.chunks,{type:state.mime||'video/webm'});
        state.stream.getTracks().forEach((track)=>track.stop());
        resolve({size:state.blob.size,type:state.blob.type,duration_ms:Date.now()-state.startEpochMs});};
      try{state.recorder.stop();}catch(error){reject(error);}
    })`, true);
    if (!stopped || stopped.size < 1024) throw new Error('empty_recording');
    const extension = /mp4/.test(stopped.type) ? 'mp4' : 'webm';
    const filename = promo.segmentFilename(event.session_id, new Date(), extension);
    const committed = controller.rendererCommit(event.session_id, Math.round(stopped.duration_ms), filename);
    if (!committed.ok) throw new Error('commit_failed');
    const outputPath = path.join(OUT_DIR, activeRun.output_stem + '.' + extension);
    const download = new Promise((resolve, reject) => {
      pendingDownload = { filename, outputPath, resolve, reject };
    });
    await receiver.webContents.executeJavaScript(`(function(filename){
      const state=window.__edlM1bRecorder,url=URL.createObjectURL(state.blob),anchor=document.createElement('a');
      anchor.href=url;anchor.download=filename;document.body.appendChild(anchor);anchor.click();anchor.remove();
      setTimeout(()=>URL.revokeObjectURL(url),10000);return true;
    })(${JSON.stringify(filename)})`, true);
    await download;
    activeRun.recording = {
      file: path.basename(outputPath), bytes: stopped.size, container: stopped.type,
      duration_ms: Math.round(stopped.duration_ms),
    };
  }

  controller = promo.create({
    BrowserWindow, desktopCapturer,
    displaySession: receiver.webContents.session,
    ownerWebContents: receiver.webContents,
    downloadsPath: OUT_DIR,
    partition: 'agent-edl-probe-m1b-' + process.pid,
    isHttpUrl: (value) => /^https?:\/\//.test(value),
    readyDelayMs: 300,
    sourceAttempts: 10,
    onTarget(webContents) {
      if (webContents) preview.attachExternalWebContents(webContents);
    },
    emit(event) {
      if (event.type === 'capture_start') {
        startRecorder(event).then((result) => {
          activeRun = { ...activeRun, recorder: {
            start_epoch_ms: result.start_epoch_ms, mime: result.mime,
            requested: activeRun.profile, settings: result.settings, tracks: result.tracks,
          }, source_enumerated: !!event.source_enumerated };
          controller.rendererReady(event.session_id, true, '');
        }).catch((error) => controller.rendererReady(event.session_id, false, cleanError(error)));
      } else if (event.type === 'capture_stop') {
        stopTask = stopRecorder(event).catch((error) => {
          controller.rendererAbort(event.session_id, cleanError(error));
          throw error;
        });
      }
    },
  });
  preview.setExternalTargetProvider(() => controller.currentWebContents(), () => {});

  let partial = {
    status: 'capturing', at: new Date().toISOString(),
    methodology: {
      sessions: SESSION_COUNT, actions_per_session: ACTIONS_PER_SESSION,
      capture_path: 'production promocapture + production preview.clickElement; MediaRecorder copied from preview-panel',
      zero: 'first detected PTS of a short start beacon; a distinct end beacon validates clock drift',
      action_clock: 'monotonic performance.now in Electron main immediately before preview.clickElement',
      handler_audit: 'Date.now and performance.now captured inside each renderer click handler',
      pts: 'PTS and sampled pixel extracted in one ffmpeg showinfo/rawvideo decode with strict time_base checks',
      session_validity: 'a session is censored as a whole unless all 10 actions are detected, the surface is visible, and end-beacon drift is <=80ms; at least two valid sessions are required',
      requested_fps: 30, capture_window_visible: true,
    },
    environment: {
      electron: process.versions.electron, node: process.versions.node, platform: process.platform,
      arch: process.arch, ffmpeg: String(run('ffmpeg', ['-version'])).split(/\r?\n/)[0],
    },
    sync_captures: [], fps_captures: [],
  };

  async function beginCapture(kind, outputStem, profile) {
    activeRun = { kind, output_stem: outputStem, profile, recording: null };
    stopTask = null;
    const started = await controller.start({ aspect: '16:9', url });
    if (!started.ok) throw new Error('capture_start_' + started.error);
    const wc = controller.currentWebContents();
    await waitForFixture(wc);
    const captureWindow = BrowserWindow.fromWebContents(wc);
    if (!captureWindow) throw new Error('capture_window_missing');
    captureWindow.setAlwaysOnTop(true, 'floating');
    captureWindow.showInactive();
    captureWindow.moveTop();
    activeRun.surface = {
      visible: captureWindow.isVisible(), minimized: captureWindow.isMinimized(),
      always_on_top: captureWindow.isAlwaysOnTop(), bounds: captureWindow.getBounds(),
    };
    await wc.executeJavaScript('window.__resetEdlM1b()', true);
    const snapshot = await preview.snapshot();
    if (!snapshot || !snapshot.ok) throw new Error('snapshot_lease_failed');
    return wc;
  }

  async function finishCapture() {
    await delay(500);
    const stopped = await controller.stop();
    if (!stopped.ok) throw new Error('capture_stop_' + stopped.error);
    if (stopTask) await stopTask;
    return activeRun;
  }

  try {
    let analyzedSessions;
    let fpsResults;
    if (REJUDGE_ONLY) {
      const existing = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'report.json'), 'utf8'));
      analyzedSessions = existing.m1b.sessions;
      fpsResults = existing.fps_probe.profiles;
      partial.methodology = existing.methodology;
      partial.environment = existing.environment;
    } else if (ANALYZE_ONLY) {
      partial = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'partial-report.json'), 'utf8'));
      if (partial.sync_captures.length !== SESSION_COUNT || partial.fps_captures.length !== FPS_PROFILES.length) {
        throw new Error('partial_captures_incomplete');
      }
    } else {
      try { fs.unlinkSync(path.join(OUT_DIR, 'failure.json')); } catch {}
      writeJson('partial-report.json', partial);
      for (let sessionIndex = 0; sessionIndex < SESSION_COUNT; sessionIndex += 1) {
        const wc = await beginCapture('sync', 'session-' + (sessionIndex + 1), DEFAULT_PROFILE);
        // نحتاج إطارين أساس على الأقل قبل الومضة؛ البداية المبكرة قد تجعل المنارة أول إطار في الملف.
        await delay(1500);
        const beaconEpoch = Date.now();
        const beaconPerformance = performance.now();
        const beaconResult = await preview.clickElement('#sync-beacon-start');
        if (!beaconResult || !beaconResult.ok) throw new Error('sync_beacon_action_failed');
        activeRun.beacon = {
          invocation_epoch_ms: beaconEpoch, invocation_performance_ms: beaconPerformance,
          handler: await readHandlerEvent(wc, 'sync_start'), tool_ok: true,
        };
        activeRun.actions = [];
        await delay(950);
        for (let actionIndex = 0; actionIndex < ACTIONS_PER_SESSION; actionIndex += 1) {
          await delay(ACTION_DELAYS_MS[actionIndex]);
          const invocationEpoch = Date.now();
          const invocationPerformance = performance.now();
          const result = await preview.clickElement('#agent-' + actionIndex);
          activeRun.actions.push({
            session: sessionIndex + 1, action_index: actionIndex,
            invocation_epoch_ms: invocationEpoch, invocation_performance_ms: invocationPerformance,
            handler: await readHandlerEvent(wc, 'action', actionIndex),
            tool_ok: !!(result && result.ok),
          });
          if (!result || !result.ok) throw new Error('agent_action_failed_' + (actionIndex + 1));
        }
        await delay(300);
        const endBeaconEpoch = Date.now();
        const endBeaconPerformance = performance.now();
        const endBeaconResult = await preview.clickElement('#sync-beacon-end');
        if (!endBeaconResult || !endBeaconResult.ok) throw new Error('sync_end_beacon_action_failed');
        activeRun.end_beacon = {
          invocation_epoch_ms: endBeaconEpoch, invocation_performance_ms: endBeaconPerformance,
          handler: await readHandlerEvent(wc, 'sync_end'), tool_ok: true,
        };
        await delay(900);
        const captured = await finishCapture();
        partial.sync_captures.push(captured);
        writeJson('partial-report.json', partial);
      }

      for (const profile of FPS_PROFILES) {
        const wc = await beginCapture('fps', profile.key, profile);
        await wc.executeJavaScript('window.__startEdlM1bMotion()', true);
        await delay(9000);
        await wc.executeJavaScript('window.__stopEdlM1bMotion()', true);
        const captured = await finishCapture();
        partial.fps_captures.push(captured);
        writeJson('partial-report.json', partial);
      }
    }

    if (!REJUDGE_ONLY) {
      analyzedSessions = partial.sync_captures.map((capture) => {
        const analyzed = analyzeSyncVideo(path.join(OUT_DIR, capture.recording.file), capture);
        return { session: capture.actions[0].session, recorder: capture.recorder,
          surface: capture.surface, recording: capture.recording, ...analyzed };
      });
      fpsResults = partial.fps_captures.map((capture) => {
        const inspected = inspectFrames(path.join(OUT_DIR, capture.recording.file));
        return { profile: capture.profile, recorder: capture.recorder, surface: capture.surface,
          recording: capture.recording,
          video: inspected.stream, pts: inspected.pts };
      });
    }
    const allActions = analyzedSessions.flatMap((session) => session.actions);
    const sessionAssessments = analyzedSessions.map((session) => {
      const reasons = [];
      if (session.summary.detected !== ACTIONS_PER_SESSION) reasons.push('incomplete_action_detection');
      if (Math.abs(session.clock_validation.video_vs_main_monotonic_delta_ms) > 80) {
        reasons.push('end_beacon_clock_validation_over_80ms');
      }
      if (!session.surface.visible || session.surface.minimized) reasons.push('capture_surface_not_visible');
      return { session: session.session, valid: reasons.length === 0, reasons };
    });
    const validSessionIds = new Set(sessionAssessments.filter((item) => item.valid).map((item) => item.session));
    const validSessions = analyzedSessions.filter((session) => validSessionIds.has(session.session));
    const validActions = validSessions.flatMap((session) => session.actions);
    const minimumSessionsPassed = validSessions.length >= 2;
    const globalSummary = summarizeErrors(validActions);
    const sensitivityAllSessions = summarizeErrors(allActions);
    const identityWorst = nearestRank(validActions.filter((item) => item.detected)
      .map((item) => Math.abs(item.correction_identity_delta_ms)), 1);
    const validDetected = globalSummary.detected === validSessions.length * ACTIONS_PER_SESSION;
    // Date.now تشخيصي وقد يقع توقف جدولة بين أخذه وأخذ performance.now؛ الحكم يستخدم
    // الساعة الرتيبة وحدها، وتتحقق منارة النهاية من بقاء خط PTS ضمن العتبة عبر الجلسة.
    const clockValidationPass = validSessions.every((session) =>
      Math.abs(session.clock_validation.video_vs_main_monotonic_delta_ms) <= 80);
    const primaryPass = minimumSessionsPassed && validDetected && clockValidationPass
      && globalSummary.after_beacon.absolute_p95_ms <= 80;
    const withinSession = validSessions.every((session) => session.summary.after_beacon.range_ms <= 80);
    const residualPass = globalSummary.quantization.guaranteed_residual_p95_ms <= 80;
    const correctionProven = identityWorst <= 0.01;
    const conditionalPass = !primaryPass && minimumSessionsPassed && validDetected && clockValidationPass
      && withinSession && residualPass && correctionProven;
    const verdict = primaryPass ? 'SURVIVES_PRIMARY'
      : conditionalPass ? 'SURVIVES_MEASURED_BEACON_CORRECTION' : 'FALLS_FINAL';

    const fpsDelta = fpsResults.length === 2
      ? fpsResults[1].pts.decoded_fps_by_duration - fpsResults[0].pts.decoded_fps_by_duration : null;

    const report = {
      status: verdict === 'FALLS_FINAL' ? 'FAIL' : 'PASS', verdict,
      threshold: 'at least two complete 10-action sessions; after-beacon absolute p95 <= 80ms with start/end clock validation; fallback requires every within-session range <= 80ms and interval residual p95 <= 80ms',
      completed_at: new Date().toISOString(), methodology: partial.methodology, environment: partial.environment,
      m1b: {
        sessions: analyzedSessions, global: globalSummary,
        session_assessments: sessionAssessments,
        valid_sessions: validSessions.length, minimum_valid_sessions_passed: minimumSessionsPassed,
        valid_actions_detected: validDetected, clock_validation_passed: clockValidationPass,
        sensitivity_all_sessions: sensitivityAllSessions,
        primary_pass: primaryPass,
        p95_making_sample: (() => {
          const item = percentileItem(validActions.filter((action) => action.detected),
            (action) => Math.abs(action.after.error_ms), 0.95);
          return item ? { session: item.session, action: item.action_index + 1,
            absolute_error_ms: Math.abs(item.after.error_ms),
            action_frame_interval_ms: item.quantization.action_frame_interval_ms,
            combined_half_width_ms: item.quantization.combined_half_width_ms,
            guaranteed_residual_ms: item.quantization.guaranteed_residual_ms } : null;
        })(),
        fallback: {
          passed: conditionalPass, every_within_session_range_le_80ms: withinSession,
          quantization_residual_p95_le_80ms: residualPass,
          correction_identity_worst_abs_ms: round(identityWorst, 6), correction_derived_from_beacon: correctionProven,
        },
      },
      fps_probe: {
        profiles: fpsResults, decoded_fps_improvement_low_res: round(fpsDelta, 3),
        interpretation: fpsDelta != null && fpsDelta >= 2
          ? 'lower_resolution_materially_improved_decoded_fps'
          : 'lower_resolution_did_not_materially_improve_decoded_fps',
      },
      caveats: [
        'MediaRecorder.start timing is diagnostic only; the verdict uses main-process monotonic time relative to the start beacon PTS.',
        'PTS brackets measure capture sampling uncertainty, not the exact compositor presentation instant.',
        'Invalid sessions remain in sensitivity_all_sessions and are never partially pooled into the verdict sample.',
        'The paired fps profiles are descriptive: resolution and bitrate change together and their order is not counterbalanced.',
      ],
    };
    writeJson('report.json', report);
    fs.writeFileSync(path.join(OUT_DIR, 'events.csv'), [
      'session,action,clock_after_ms,video_after_ms,error_after_ms,error_before_ms,action_frame_ms,combined_half_ms,residual_ms,normalized_half_frames',
      ...allActions.map((item) => [item.session, item.action_index + 1,
        item.after && item.after.clock_t_ms, item.after && item.after.video_t_ms,
        item.after && item.after.error_ms, item.before && item.before.error_ms,
        item.quantization && item.quantization.action_frame_interval_ms,
        item.quantization && item.quantization.combined_half_width_ms,
        item.quantization && item.quantization.guaranteed_residual_ms,
        item.quantization && item.quantization.abs_error_in_action_half_frames].join(',')),
    ].join('\n') + '\n', 'utf8');
    for (const stale of ['failure.json', 'partial-report.json']) {
      try { fs.unlinkSync(path.join(OUT_DIR, stale)); } catch {}
    }
    process.stdout.write('agent-edl-probe-m1b: ' + report.status + ' ' + verdict + '\n');
    process.stdout.write(JSON.stringify({ m1b: report.m1b.global, fallback: report.m1b.fallback,
      fps_probe: report.fps_probe }, null, 2) + '\n');
  } finally {
    try { await controller.stopAll({ discard: true }); } catch {}
    preview.setExternalTargetProvider(null);
    preview.destroy();
    if (!receiver.isDestroyed()) receiver.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().then(() => {
  clearTimeout(watchdog);
  if (!fatalStarted) app.exit(0);
}).catch((error) => fatal('probe_failed', error));
