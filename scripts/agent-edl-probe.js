#!/usr/bin/env electron
'use strict';

// مسبار حيّ لمزامنة أفعال الوكيل مع إطارات تسجيل البرومو، ولتغطية الإدخال البشري
// من العالم المعزول. يستدعي preview/promocapture كما هما ولا يعدّل كود الإنتاج.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const { app, BrowserWindow, desktopCapturer } = require('electron');
const preview = require('../electron/preview');
const promo = require('../electron/promocapture');

const OUT_DIR = path.join(__dirname, '..', 'dist', 'agent-edl-probe');
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'edl-probe-page.html');
const WORLD_ID = 1013;
const SESSION_COUNT = 3;
const ACTIONS_PER_SESSION = 10;
const MAX_RUNTIME_MS = 8 * 60 * 1000;
const ANALYZE_ONLY = process.argv.includes('--analyze-only');
const PALETTE = [
  [230, 40, 55], [20, 190, 80], [35, 90, 230], [235, 190, 30], [190, 40, 200],
  [25, 190, 210], [235, 105, 25], [100, 60, 210], [140, 210, 35], [235, 70, 140],
];
const ACTION_DELAYS_MS = [1800, 4200, 3600, 4800, 3200, 4500, 3900, 5200, 3500, 4300];
const HUMAN_CASES = [
  ['normal', 'normal', 'normal', 'normal', 'stop', 'stop', 'stop', 'iframe', 'iframe', 'iframe'],
  ['normal', 'normal', 'normal', 'stop', 'stop', 'stop', 'stop', 'iframe', 'iframe', 'iframe'],
  ['normal', 'normal', 'normal', 'stop', 'stop', 'stop', 'iframe', 'iframe', 'iframe', 'iframe'],
];

fs.mkdirSync(OUT_DIR, { recursive: true });

let fatalStarted = false;
function cleanError(error) {
  return String(error && error.message ? error.message : error || 'unknown')
    .replace(/[A-Za-z]:\\[^\s]+/g, '<path>').slice(0, 400);
}

function writeFailure(kind, error) {
  try {
    fs.writeFileSync(path.join(OUT_DIR, 'failure.json'), JSON.stringify({
      status: 'FAIL', kind, reason: cleanError(error), at: new Date().toISOString(),
      environment: { electron: process.versions.electron, node: process.versions.node, platform: process.platform },
    }, null, 2), 'utf8');
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

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function framePage() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:100%;height:100%;display:grid;place-items:center;background:#e2e8f0}
    button{width:82%;height:72%;border:4px solid #475569;border-radius:12px;background:#f8fafc;font:24px Arial}
  </style></head><body><button id="frame-target" type="button">iframe target</button></body></html>`;
}

async function startFixtureServer() {
  const fixture = fs.readFileSync(FIXTURE_PATH, 'utf8');
  const server = http.createServer((request, response) => {
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'self' 'unsafe-inline'",
    });
    response.end(request.url === '/frame' ? framePage() : fixture);
  });
  const port = await listen(server);
  return { server, url: 'http://127.0.0.1:' + port + '/' };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: options.binary ? null : 'utf8',
    maxBuffer: options.maxBuffer || 16 * 1024 * 1024,
    timeout: options.timeout || 120000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const reason = result.error ? result.error.message : String(result.stderr || '').slice(0, 300);
    throw new Error(command + '_failed: ' + reason);
  }
  return result.stdout;
}

function nearestRank(values, percentile) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)];
}

function round(value, digits = 1) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function distanceRgb(a, b) {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

function analyzeVideo(videoPath, actions, sessionIndex) {
  const probe = JSON.parse(run('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_streams', '-show_frames',
    '-show_entries', 'stream=width,height,avg_frame_rate,r_frame_rate,duration,nb_frames:frame=pts_time,best_effort_timestamp_time',
    '-of', 'json', videoPath,
  ], { maxBuffer: 32 * 1024 * 1024 }));
  const stream = probe.streams && probe.streams[0] ? probe.streams[0] : {};
  const raw = run('ffmpeg', [
    '-v', 'error', '-i', videoPath, '-vf', 'crop=2:2:10:50,scale=1:1:flags=neighbor,format=rgb24',
    '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1',
  ], { binary: true, maxBuffer: 4 * 1024 * 1024 });
  const frames = Array.isArray(probe.frames) ? probe.frames : [];
  const count = Math.min(frames.length, Math.floor(raw.length / 3));
  const pixels = [];
  for (let index = 0; index < count; index += 1) {
    pixels.push([raw[index * 3], raw[index * 3 + 1], raw[index * 3 + 2]]);
  }
  const results = actions.map((action) => {
    const target = PALETTE[action.action_index];
    let detected = -1;
    let detectedDistance = Infinity;
    for (let frameIndex = 0; frameIndex < pixels.length; frameIndex += 1) {
      const currentDistance = distanceRgb(pixels[frameIndex], target);
      if (currentDistance <= 55) {
        detected = frameIndex;
        detectedDistance = currentDistance;
        break;
      }
    }
    if (detected < 0) {
      return { ...action, detected: false, frame_number: null, video_t_ms: null, error_ms: null };
    }
    const frame = frames[detected] || {};
    const seconds = Number(frame.best_effort_timestamp_time != null
      ? frame.best_effort_timestamp_time : frame.pts_time);
    const videoTMs = seconds * 1000;
    const sampleName = 'session-' + sessionIndex + '-event-' + String(action.action_index + 1).padStart(2, '0') + '.png';
    run('ffmpeg', [
      '-v', 'error', '-ss', String(Math.max(0, seconds)), '-i', videoPath,
      '-frames:v', '1', '-y', path.join(OUT_DIR, sampleName),
    ]);
    return {
      ...action,
      detected: true,
      frame_number: detected + 1,
      video_t_ms: round(videoTMs, 1),
      error_ms: round(videoTMs - action.t_ms, 1),
      beacon_rgb: pixels[detected],
      beacon_distance: round(detectedDistance, 1),
      sample: sampleName,
    };
  });
  return {
    video: {
      file: path.basename(videoPath), width: Number(stream.width), height: Number(stream.height),
      avg_frame_rate: stream.avg_frame_rate || '', r_frame_rate: stream.r_frame_rate || '',
      duration_s: round(Number(stream.duration), 3), decoded_frames: count,
    },
    actions: results,
  };
}

async function waitForFixture(wc) {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    try {
      const ready = await wc.executeJavaScript('window.__edlProbeReady === true && !!document.getElementById("human-frame")', true);
      if (ready) {
        const frameReady = await wc.executeJavaScript(`(function(){
          var f=document.getElementById('human-frame');
          return !!(f&&f.contentDocument&&f.contentDocument.getElementById('frame-target'));
        })()`, true);
        if (frameReady) return;
      }
    } catch {}
    await delay(50);
  }
  throw new Error('fixture_ready_timeout');
}

async function rectForAgent(wc, selector) {
  const result = await wc.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code: `(function(){
    var el=document.querySelector(${JSON.stringify(selector)}); if(!el)return null;
    el.scrollIntoView({block:'center',inline:'center'}); var r=el.getBoundingClientRect();
    return {x:Math.floor(r.left),y:Math.floor(r.top),width:Math.ceil(r.width),height:Math.ceil(r.height)};
  })()` }], true);
  if (!result || result.width < 1 || result.height < 1) throw new Error('agent_rect_missing');
  return result;
}

async function installHumanHook(wc) {
  return wc.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code: `(function(){
    var state={events:[],documents:0}; window.__satrEdlHumanProbe=state;
    var seen=new WeakSet();
    function push(type,event,offsetX,offsetY,scope){
      if(state.events.length>=240)return;
      state.events.push({type:type,x:Math.round(offsetX+event.clientX),y:Math.round(offsetY+event.clientY),
        at_epoch_ms:Date.now(),scope:scope});
    }
    function attach(doc,offsetX,offsetY,scope){
      if(!doc||seen.has(doc))return false; seen.add(doc); state.documents++;
      doc.addEventListener('mousemove',function(event){push('mousemove',event,offsetX,offsetY,scope);},true);
      doc.addEventListener('mousedown',function(event){push('mousedown',event,offsetX,offsetY,scope);},true);
      return true;
    }
    function attachFrame(frame){
      try{var r=frame.getBoundingClientRect();return attach(frame.contentDocument,
        r.left+(frame.clientLeft||0),r.top+(frame.clientTop||0),'iframe');}catch(error){return false;}
    }
    attach(document,0,0,'top');
    var frames=document.querySelectorAll('iframe');
    for(var index=0;index<frames.length;index++){
      attachFrame(frames[index]); frames[index].addEventListener('load',function(){attachFrame(this);},true);
    }
    return {installed:true,documents:state.documents};
  })()` }], true);
}

async function humanTargetPoint(wc, kind, jitter) {
  return wc.executeJavaScript(`(function(){
    var kind=${JSON.stringify(kind)},jitter=${Number(jitter)};
    if(kind==='iframe'){
      var frame=document.getElementById('human-frame'),button=frame.contentDocument.getElementById('frame-target');
      var fr=frame.getBoundingClientRect(),br=button.getBoundingClientRect();
      return {x:Math.round(fr.left+(frame.clientLeft||0)+br.left+br.width/2+jitter),
        y:Math.round(fr.top+(frame.clientTop||0)+br.top+br.height/2+jitter)};
    }
    var el=document.getElementById(kind==='stop'?'human-stop':'human-normal'),r=el.getBoundingClientRect();
    return {x:Math.round(r.left+r.width/2+jitter),y:Math.round(r.top+r.height/2+jitter)};
  })()`, true);
}

async function isolatedEvents(wc) {
  return wc.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code:
    `(window.__satrEdlHumanProbe&&window.__satrEdlHumanProbe.events?window.__satrEdlHumanProbe.events.slice():[])`,
  }], true);
}

async function runHumanAttempt(wc, kind, attemptIndex, recordingStartEpoch) {
  const point = await humanTargetPoint(wc, kind, (attemptIndex % 3) - 1);
  const before = await isolatedEvents(wc);
  const sentEpoch = Date.now();
  wc.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y, movementX: 1, movementY: 1 });
  wc.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await delay(18);
  wc.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await delay(70);
  const after = await isolatedEvents(wc);
  const fresh = after.slice(before.length);
  const down = fresh.find((event) => event.type === 'mousedown');
  const move = fresh.find((event) => event.type === 'mousemove');
  const coordinateError = down ? Math.hypot(down.x - point.x, down.y - point.y) : null;
  const timestampError = down ? down.at_epoch_ms - sentEpoch : null;
  const captured = !!down && coordinateError <= 1.5 && Math.abs(timestampError) <= 100;
  return {
    case: kind, attempt: attemptIndex + 1, expected: point,
    sent_t_ms: sentEpoch - recordingStartEpoch,
    captured, mousedown_seen: !!down, mousemove_seen: !!move,
    coordinate_error_px: round(coordinateError, 2), timestamp_error_ms: timestampError,
    captured_scope: down ? down.scope : null,
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
  let recordingStart = null;
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
    return receiver.webContents.executeJavaScript(`(async function(){
      const stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{mandatory:{
        chromeMediaSource:'desktop',chromeMediaSourceId:${JSON.stringify(event.source_id)},
        minWidth:${event.width},maxWidth:${event.width},minHeight:${event.height},maxHeight:${event.height},
        minFrameRate:30,maxFrameRate:30
      }}});
      const candidates=['video/mp4;codecs=avc1.42E01E','video/mp4;codecs=avc1','video/mp4','video/webm;codecs=vp9','video/webm'];
      const mime=candidates.find((item)=>MediaRecorder.isTypeSupported(item))||'';
      const options={videoBitsPerSecond:${event.width >= 1920 || event.height >= 1920 ? 16000000 : 10000000}};
      if(mime)options.mimeType=mime;
      const recorder=new MediaRecorder(stream,options),chunks=[];
      recorder.ondataavailable=(event)=>{if(event.data&&event.data.size)chunks.push(event.data);};
      const startEpochMs=Date.now(); recorder.start(1000);
      window.__edlRecorder={stream,recorder,chunks,mime,startEpochMs,blob:null};
      const track=stream.getVideoTracks()[0];
      return {start_epoch_ms:startEpochMs,mime:mime,settings:track.getSettings(),tracks:stream.getVideoTracks().length};
    })()`, true);
  }

  async function stopRecorder(event) {
    const stopped = await receiver.webContents.executeJavaScript(`new Promise((resolve,reject)=>{
      const state=window.__edlRecorder;if(!state)return reject(new Error('missing_recorder'));
      state.recorder.onstop=()=>{
        state.blob=new Blob(state.chunks,{type:state.mime||'video/webm'});
        state.stream.getTracks().forEach((track)=>track.stop());
        resolve({size:state.blob.size,type:state.blob.type,duration_ms:Date.now()-state.startEpochMs});
      };
      try{state.recorder.stop();}catch(error){reject(error);}
    })`, true);
    if (!stopped || stopped.size < 1024) throw new Error('empty_recording');
    const extension = /mp4/.test(stopped.type) ? 'mp4' : 'webm';
    const filename = promo.segmentFilename(event.session_id, new Date(), extension);
    const committed = controller.rendererCommit(event.session_id, Math.round(stopped.duration_ms), filename);
    if (!committed.ok) throw new Error('commit_failed');
    const sessionNumber = recordingStart.session_number;
    const outputPath = path.join(OUT_DIR, 'session-' + sessionNumber + '.' + extension);
    const download = new Promise((resolve, reject) => {
      pendingDownload = { filename, outputPath, resolve, reject };
    });
    await receiver.webContents.executeJavaScript(`(function(filename){
      const state=window.__edlRecorder,url=URL.createObjectURL(state.blob),anchor=document.createElement('a');
      anchor.href=url;anchor.download=filename;document.body.appendChild(anchor);anchor.click();anchor.remove();
      setTimeout(()=>URL.revokeObjectURL(url),10000);return true;
    })(${JSON.stringify(filename)})`, true);
    await download;
    recordingStart.stop = {
      file: path.basename(outputPath), bytes: stopped.size, container: stopped.type,
      duration_ms: Math.round(stopped.duration_ms),
    };
  }

  controller = promo.create({
    BrowserWindow, desktopCapturer,
    displaySession: receiver.webContents.session,
    ownerWebContents: receiver.webContents,
    downloadsPath: OUT_DIR,
    partition: 'agent-edl-probe-' + process.pid,
    isHttpUrl: (value) => /^https?:\/\//.test(value),
    readyDelayMs: 300,
    sourceAttempts: 10,
    onTarget(webContents) {
      if (webContents) preview.attachExternalWebContents(webContents);
    },
    emit(event) {
      if (event.type === 'capture_start') {
        startRecorder(event).then((result) => {
          recordingStart = { ...result, source_enumerated: event.source_enumerated };
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

  let report = {
    status: 'running', at: new Date().toISOString(),
    methodology: {
      sessions: SESSION_COUNT, agent_actions_per_session: ACTIONS_PER_SESSION,
      capture_path: 'production promocapture + production preview.clickElement; renderer recorder copied from preview-panel',
      beacon: 'full-page persistent color change caused by the click handler',
      requested_fps: 30, human_input: 'webContents.sendInputEvent', isolated_world_id: WORLD_ID,
      human_coordinate_tolerance_px: 1.5, human_timestamp_tolerance_ms: 100,
    },
    environment: {
      electron: process.versions.electron, node: process.versions.node, platform: process.platform,
      arch: process.arch, ffmpeg: '',
    },
    sessions: [], m1: {}, m2: {}, failures: [],
  };
  report.environment.ffmpeg = String(run('ffmpeg', ['-version'])).split(/\r?\n/)[0];

  try {
    if (ANALYZE_ONLY) {
      report = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'partial-report.json'), 'utf8'));
      if (!Array.isArray(report.sessions) || report.sessions.length !== SESSION_COUNT) {
        throw new Error('partial_sessions_incomplete');
      }
      report.status = 'analyzing';
      report.methodology.analysis_only_resume = true;
      report.environment.ffmpeg = String(run('ffmpeg', ['-version'])).split(/\r?\n/)[0];
    }
    for (let sessionIndex = ANALYZE_ONLY ? SESSION_COUNT : 0; sessionIndex < SESSION_COUNT; sessionIndex += 1) {
      recordingStart = { session_number: sessionIndex + 1 };
      const started = await controller.start({ aspect: '16:9', url });
      if (!started.ok) throw new Error('capture_start_' + started.error);
      recordingStart.session_number = sessionIndex + 1;
      const wc = controller.currentWebContents();
      await waitForFixture(wc);
      const hook = await installHumanHook(wc);
      // كل قيادة بشرية تُبطل إيجار أفعال الوكيل؛ لقطة جديدة هي عقد الإنتاج لاستعادته.
      const freshSnapshot = await preview.snapshot();
      if (!freshSnapshot || !freshSnapshot.ok) throw new Error('snapshot_lease_failed');
      const session = {
        session: sessionIndex + 1,
        source_enumerated: !!recordingStart.source_enumerated,
        recorder: {
          requested_fps: 30, actual_fps: recordingStart.settings.frameRate || null,
          width: recordingStart.settings.width || null, height: recordingStart.settings.height || null,
          mime: recordingStart.mime, isolated_documents: hook.documents,
        },
        agent_actions: [], human_attempts: [], recording: null,
      };

      for (let actionIndex = 0; actionIndex < ACTIONS_PER_SESSION; actionIndex += 1) {
        await delay(ACTION_DELAYS_MS[actionIndex]);
        const ref = '#agent-' + actionIndex;
        const rect = await rectForAgent(wc, ref);
        const invocationEpoch = Date.now();
        const result = await preview.clickElement(ref);
        session.agent_actions.push({
          session: sessionIndex + 1, action_index: actionIndex, type: 'click', ref, rect,
          t_ms: invocationEpoch - recordingStart.start_epoch_ms,
          tool_ok: !!(result && result.ok), dom_changed: !!(result && result.dom_changed),
        });
        if (!result || !result.ok) {
          throw new Error('agent_action_failed_' + (actionIndex + 1) + '_' + String(result && result.error || 'unknown'));
        }
      }

      for (let attemptIndex = 0; attemptIndex < HUMAN_CASES[sessionIndex].length; attemptIndex += 1) {
        session.human_attempts.push(await runHumanAttempt(
          wc, HUMAN_CASES[sessionIndex][attemptIndex], attemptIndex, recordingStart.start_epoch_ms));
        await delay(35);
      }
      await delay(1000);
      const stopped = await controller.stop();
      if (!stopped.ok) throw new Error('capture_stop_' + stopped.error);
      if (stopTask) await stopTask;
      session.recording = recordingStart.stop;
      report.sessions.push(session);
      fs.writeFileSync(path.join(OUT_DIR, 'partial-report.json'), JSON.stringify(report, null, 2), 'utf8');
    }

    const analyzedSessions = [];
    const allActions = [];
    for (const session of report.sessions) {
      const videoPath = path.join(OUT_DIR, session.recording.file);
      const analyzed = analyzeVideo(videoPath, session.agent_actions, session.session);
      session.video_analysis = analyzed.video;
      session.agent_actions = analyzed.actions;
      analyzedSessions.push(analyzed.video);
      allActions.push(...analyzed.actions);
    }

    const detected = allActions.filter((item) => item.detected && Number.isFinite(item.error_ms));
    const absoluteErrors = detected.map((item) => Math.abs(item.error_ms));
    const signedErrors = detected.map((item) => item.error_ms);
    const positive = signedErrors.filter((value) => value > 0).length;
    const negative = signedErrors.filter((value) => value < 0).length;
    const zero = signedErrors.length - positive - negative;
    const totalRecordingMs = report.sessions.reduce((sum, item) => sum + item.recording.duration_ms, 0);
    const density = allActions.length / (totalRecordingMs / 60000);
    const m1Passed = detected.length === SESSION_COUNT * ACTIONS_PER_SESSION
      && nearestRank(absoluteErrors, 0.95) <= 80 && density >= 6;
    const dominantSignFraction = detected.length ? Math.max(positive, negative, zero) / detected.length : 0;
    const medianAbsolute = nearestRank(absoluteErrors, 0.5);
    const p95Absolute = nearestRank(absoluteErrors, 0.95);
    const failureDrift = m1Passed ? 'within_threshold'
      : dominantSignFraction >= 0.9 && p95Absolute != null && medianAbsolute != null && p95Absolute - medianAbsolute <= 40
        ? 'fixed_compensable' : 'variable_not_compensable';
    report.m1 = {
      passed: m1Passed, threshold: 'absolute p95 <= 80ms and density >= 6/min and 30/30 detections',
      actions: allActions.length, detected: detected.length,
      absolute_error_ms: {
        median: round(medianAbsolute), p95: round(p95Absolute),
        p99: round(nearestRank(absoluteErrors, 0.99)), worst: round(nearestRank(absoluteErrors, 1)),
      },
      signed_error_ms: {
        median: round(nearestRank(signedErrors, 0.5)), min: round(nearestRank(signedErrors, 0.01)),
        max: round(nearestRank(signedErrors, 1)), positive, negative, zero,
      },
      drift_classification: failureDrift,
      anchor_density_per_minute: round(density, 2), total_recording_duration_ms: totalRecordingMs,
      videos: analyzedSessions,
    };

    const human = report.sessions.flatMap((session) => session.human_attempts.map((attempt) => ({
      session: session.session, ...attempt,
    })));
    const byCase = {};
    for (const kind of ['normal', 'stop', 'iframe']) {
      const items = human.filter((item) => item.case === kind);
      byCase[kind] = {
        attempts: items.length, captured: items.filter((item) => item.captured).length,
        rate_pct: round(items.filter((item) => item.captured).length / items.length * 100, 1),
        mousedown_seen: items.filter((item) => item.mousedown_seen).length,
        mousemove_seen: items.filter((item) => item.mousemove_seen).length,
        worst_coordinate_error_px: round(Math.max(...items.map((item) => item.coordinate_error_px || 0)), 2),
        worst_abs_timestamp_error_ms: Math.max(...items.map((item) => Math.abs(item.timestamp_error_ms || 0))),
      };
    }
    const capturedCount = human.filter((item) => item.captured).length;
    const humanRate = capturedCount / human.length * 100;
    report.m2 = {
      passed: humanRate >= 80, threshold: '>= 80% with coordinate error <= 1.5px and timestamp error <= 100ms',
      attempts: human.length, captured: capturedCount, rate_pct: round(humanRate, 1),
      mousedown_seen: human.filter((item) => item.mousedown_seen).length,
      mousemove_seen: human.filter((item) => item.mousemove_seen).length,
      by_case: byCase,
      attempts_detail: human,
    };

    if (!report.m1.passed) {
      report.failures.push('FAIL: M1 absolute p95/detection/density threshold failed; drift=' + failureDrift);
    }
    if (!report.m2.passed) {
      report.failures.push('FAIL: M2 human click capture rate was ' + report.m2.rate_pct + '% (<80%)');
    }
    report.status = report.failures.length ? 'FAIL' : 'PASS';
    report.completed_at = new Date().toISOString();
    fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
    fs.writeFileSync(path.join(OUT_DIR, 'beacon-events.csv'), [
      'session,action_index,t_ms,frame_number,video_t_ms,error_ms,rect_x,rect_y,rect_width,rect_height',
      ...allActions.map((item) => [item.session, item.action_index + 1, item.t_ms, item.frame_number,
        item.video_t_ms, item.error_ms, item.rect.x, item.rect.y, item.rect.width, item.rect.height].join(',')),
    ].join('\n') + '\n', 'utf8');
    for (const stale of ['failure.json', 'partial-report.json']) {
      try { fs.unlinkSync(path.join(OUT_DIR, stale)); } catch {}
    }

    process.stdout.write('agent-edl-probe: ' + report.status + '\n');
    for (const failure of report.failures) process.stdout.write(failure + '\n');
    process.stdout.write(JSON.stringify({ m1: report.m1, m2: {
      passed: report.m2.passed, attempts: report.m2.attempts, captured: report.m2.captured,
      rate_pct: report.m2.rate_pct, by_case: report.m2.by_case,
    } }, null, 2) + '\n');
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
