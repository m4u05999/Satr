#!/usr/bin/env electron
'use strict';

// اختبار حيّ لطبقة الصوت في تسجيل البرومو (الدفعة 1 — «أشرح بصوتي»).
// يشغّل <satr-preview-panel> الإنتاجي داخل Chromium تحت CSP الصارمة، بمصدر صوتي
// **حقيقي** (مذبذب) ومصدر صورة حقيقي (canvas)، ويثبت خمسة عقود:
//   1. الترميز المختار يعلن صوتاً فعلاً (كان يعلن الفيديو وحده ⇒ ملف صامت بلا خطأ).
//   2. المسار الصوتي فيه **إشارة** لا مجرّد وجود track (المؤشّر الحيّ يتحرّك).
//   3. الإذن يُطلب لكل تسجيلة — لا «موافقة دائمة» ولا تسجيل بلا موافقة (fail-closed).
//   4. صوت النظام مطفأ افتراضياً، وتفعيله يعرض التحذير المقرّر.
//   5. تعذّر ترميز الصوت ⇒ رفضٌ معلن، لا ملفٌ صامت صامتاً.
// ffprobe اختياري: إن وُجد يُقاس مسار الصوت داخل الملف الناتج فعلاً.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { app, BrowserWindow } = require('electron');

const RESULT_FILE = path.join(os.tmpdir(), 'satr-promo-audio-live-' + process.pid + '.json');
const TIMEOUT_MS = 90000;

// حصانة التعليق: خطأ في العملية الرئيسية قد يعلّق Electron بحوار بدل أن ينهيه.
function die(reason) {
  try { fs.writeFileSync(RESULT_FILE, JSON.stringify({ ok: false, reason: String(reason) })); } catch (error) {}
  console.error('promo-audio-live: ✗ ' + reason);
  process.exit(1);
}
process.on('uncaughtException', (error) => die('uncaught:' + (error && error.message)));
process.on('unhandledRejection', (error) => die('unhandled:' + (error && error.message)));
const guard = setTimeout(() => die('timeout بعد ' + TIMEOUT_MS + 'ms'), TIMEOUT_MS);
guard.unref();

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'satr-audio-udata-')));
app.on('window-all-closed', () => {}); // نافذة واحدة تُعاد — الثانية بعد الإتلاف تفشل ERR_FAILED

const checks = [];
function check(name, passed, detail) {
  checks.push({ name, passed: !!passed, detail });
  if (!passed) throw new Error('فشل الفحص «' + name + '»: ' + JSON.stringify(detail));
}

function probeAudioStream(file) {
  for (const binary of ['ffprobe', 'ffprobe.exe']) {
    const probe = spawnSync(binary, ['-v', 'error', '-select_streams', 'a',
      '-show_entries', 'stream=codec_name,channels', '-of', 'json', file], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) continue;
    try {
      const parsed = JSON.parse(probe.stdout || '{}');
      return { available: true, streams: (parsed.streams || []) };
    } catch (error) { return { available: false }; }
  }
  return { available: false };
}

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({
    show: true, width: 1080, height: 760,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  // منع أي تنزيل فعلي (المكوّن ينقر <a download> بعد نجاح commit)
  win.webContents.session.on('will-download', (event) => event.preventDefault());
  await win.loadFile(path.join(__dirname, 'fixtures', 'promo-audio-live.html'));

  // الـfixture يستورد المكوّن بـ await أعلى المستوى، فوعده يُسند **بعد** حدث التحميل.
  await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (window.__promoAudioReady) { clearInterval(timer); resolve(true); }
      else if (Date.now() - started > 15000) { clearInterval(timer); reject(new Error('fixture_never_started')); }
    }, 25);
  })`, true);
  const result = await win.webContents.executeJavaScript(`Promise.race([
    window.__promoAudioReady,
    new Promise((_, reject) => setTimeout(() => reject(new Error('fixture_timeout')), 60000)),
  ])`, true);

  // ---------- 1. الترميز يعلن صوتاً ----------
  const recorder = result.recorder || {};
  check('mime-declares-audio', /mp4a|opus|vorbis/i.test(recorder.mime || ''),
    { mime: recorder.mime, stepError: result.__error });
  check('one-audio-track', recorder.audioTracks === 1 && recorder.videoTracks === 1, recorder);

  // ---------- 2. إشارة فعلية لا مجرّد مسار ----------
  check('meter-visible', result.meterShown === true, result.meterShown);
  check('mic-signal-present', result.meterLevel > 0, { level: result.meterLevel });
  check('raw-mic-constraints', result.micConstraints
    && result.micConstraints.echoCancellation === false
    && result.micConstraints.noiseSuppression === false
    && result.micConstraints.autoGainControl === false, result.micConstraints);
  check('device-picker', result.deviceCount === 3 && result.deviceLabelled.length > 0,
    { count: result.deviceCount, label: result.deviceLabelled });

  // ---------- 3. الإذن لكل تسجيلة ----------
  check('consent-before-start', result.consentShownBeforeStart === true && result.startsBeforeConsent === 0,
    { shown: result.consentShownBeforeStart, starts: result.startsBeforeConsent });
  check('consent-names-device', /ميكروفون/.test(result.consentBody), result.consentBody);
  check('consent-hidden-after-start', result.consentHiddenAfterStart === true, result.consentHiddenAfterStart);
  check('consent-not-remembered', result.consentAskedAgain === true && result.startsAfterFirst === 1,
    { again: result.consentAskedAgain, starts: result.startsAfterFirst });
  check('consent-cancel-closes', result.consentCancelled === true, result.consentCancelled);
  check('bypass-fails-closed', result.bypassRefused === true && result.bypassNoRecorder === true,
    { refused: result.bypassRefused, noRecorder: result.bypassNoRecorder });

  // ---------- 4. صوت النظام: مطفأ افتراضياً + تحذير مقرّر ----------
  check('system-audio-default-off', result.systemDefaultOff === true && result.warningHiddenByDefault === true,
    { off: result.systemDefaultOff, hidden: result.warningHiddenByDefault });
  check('system-audio-warning', result.systemWarningShown === true
    && result.systemWarning.includes('يسجّل صوت الجهاز كله')
    && result.systemWarning.includes('لا نافذة المنتج وحدها'), result.systemWarning);
  check('mic-system-exclusive', /يُسقط/.test(result.exclusivityNote), result.exclusivityNote);
  const systemRecorder = result.systemRecorder || {};
  check('system-audio-consent-carries-full-warning', result.systemConsentShown === true
    && result.systemConsentWarning.includes('صوت النظام يسجّل كل ما يصدر عن جهازك')
    && result.systemConsentWarning.includes('أغلق ما لا تريد سماعه'),
    { shown: result.systemConsentShown, warning: result.systemConsentWarning });
  check('system-audio-records-one-track', systemRecorder.audioTracks === 1
    && /mp4a|opus|vorbis/i.test(systemRecorder.mime || '')
    && result.systemCaptureArgs && result.systemCaptureArgs.audio.system === true,
    { recorder: systemRecorder, args: result.systemCaptureArgs });
  check('capture-start-carries-intent', result.captureStartArgs && result.captureStartArgs.confirmed === true
    && result.captureStartArgs.audio && result.captureStartArgs.audio.system === false,
    result.captureStartArgs);

  // ---------- 5. تعذّر الترميز ⇒ رفض معلن ----------
  check('scenario-completed', !result.__error, { stepError: result.__error });
  check('codec-refusal-declared', result.codecRefusalSeen === true && result.codecNoRecorder === true
    && result.codecNoCommit === true && result.codecNotRecording === true, {
      refused: result.codecRefusalSeen, noRecorder: result.codecNoRecorder,
      noCommit: result.codecNoCommit, notRecording: result.codecNotRecording });
  check('codec-refusal-message', /صامت/.test(result.codecMessage), result.codecMessage);

  // ---------- عدم التراجع: المسار بلا صوت كما كان ----------
  check('silent-path-unchanged', result.silentPathSkipsConsent === true
    && result.silentRecorder.audioTracks === 0, result.silentRecorder);
  check('csp-strict', /script-src 'self'/.test(result.csp) && !/unsafe-inline/.test(result.csp), result.csp);
  check('committed-file', /^satr-promo-segment-.*\.(mp4|webm)$/.test(result.commitFilename)
    && result.blobBytes > 1024, { name: result.commitFilename, bytes: result.blobBytes });

  // ---------- قياس اختياري: مسار الصوت داخل الملف الناتج ----------
  let probeNote = 'ffprobe غير متاح — تُخطّى قياسة الملف الناتج';
  const mediaFile = path.join(os.tmpdir(), 'satr-promo-audio-' + process.pid + '.mp4');
  fs.writeFileSync(mediaFile, Buffer.from(result.blobBase64, 'base64'));
  const probed = probeAudioStream(mediaFile);
  if (probed.available) {
    check('file-has-audio-stream', probed.streams.length === 1, probed.streams);
    probeNote = 'ffprobe: مسار صوتي واحد داخل الملف (' + (probed.streams[0] || {}).codec_name + ')';
  }
  try { fs.unlinkSync(mediaFile); } catch (error) {}

  fs.writeFileSync(RESULT_FILE, JSON.stringify({ ok: true, checks, result: {
    mime: result.recorder.mime, meterLevel: result.meterLevel, bytes: result.blobBytes,
  } }, null, 2));
  if (!win.isDestroyed()) win.destroy();
  console.log('promo-audio-live: ' + checks.length + '/' + checks.length + ' — ترميز «'
    + result.recorder.mime + '» بمسار صوتي واحد، مؤشّر ' + result.meterLevel + '%، '
    + result.blobBytes + ' bytes. ' + probeNote);
  app.exit(0);
}

main().catch((error) => die(error && error.message ? error.message : String(error)));
