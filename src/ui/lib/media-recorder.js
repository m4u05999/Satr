export function pickRecMime() {
  const candidates = [
    { mime: 'video/mp4;codecs=avc1.42E01E', container: 'video/mp4', ext: 'mp4' },
    { mime: 'video/mp4;codecs=avc1', container: 'video/mp4', ext: 'mp4' },
    { mime: 'video/mp4', container: 'video/mp4', ext: 'mp4' },
    { mime: 'video/webm;codecs=vp9', container: 'video/webm', ext: 'webm' },
    { mime: 'video/webm', container: 'video/webm', ext: 'webm' },
  ];
  const Recorder = window.MediaRecorder;
  for (const candidate of candidates) {
    if (Recorder && Recorder.isTypeSupported(candidate.mime)) return candidate;
  }
  return { mime: '', container: 'video/webm', ext: 'webm' };
}

// نافذة سطر تُلتقط بأبعاد المصدر؛ نجاح الطلب وحده لا يثبت تعطيل التصغير.
export async function prepareAppRecording(videoTrack, pixels) {
  const fail = (code) => Object.assign(new Error(code), { code });
  if (!pixels || typeof pixels !== 'object' || Array.isArray(pixels)
      || !Number.isInteger(pixels.width) || pixels.width < 1 || pixels.width > 10000
      || !Number.isInteger(pixels.height) || pixels.height < 1 || pixels.height > 10000) {
    throw fail('bad_capture_dimensions');
  }
  let settings, capture, video, frameId, timer;
  try {
    // منع التصغير وحده قد يختار حجماً أكبر؛ نطلب بكسلات مساحة العرض صراحةً.
    await videoTrack.applyConstraints({ resizeMode: { exact: 'none' },
      width: { exact: pixels.width }, height: { exact: pixels.height } });
    videoTrack.contentHint = 'detail';
    // قد تتغير الأبعاد بعد أول إطار؛ عنصر منفصل يقيس الناتج قبل إعلان الجاهزية.
    video = document.createElement('video');
    video.muted = true;
    video.srcObject = new MediaStream([videoTrack]);
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(fail('native_capture_unavailable')), 3000);
    });
    await Promise.race([video.play(), deadline]);
    await Promise.race([new Promise((resolve) => {
      frameId = video.requestVideoFrameCallback(() => { frameId = null; resolve(); });
    }), deadline]);
    settings = videoTrack.getSettings();
    capture = { width: video.videoWidth, height: video.videoHeight };
  } catch {
    throw fail('native_capture_unavailable');
  } finally {
    clearTimeout(timer);
    if (video) {
      if (frameId != null) { try { video.cancelVideoFrameCallback(frameId); } catch {} }
      try { video.pause(); } catch {}
      try { video.srcObject = null; } catch {}
    }
    // المسار مستعار من المسجّل؛ لا نوقفه عند فصل عنصر القياس.
  }
  if (!settings || settings.resizeMode !== 'none') throw fail('native_capture_unavailable');
  const { width, height } = capture;
  if ([settings.width, settings.height, width, height]
      .some(value => !Number.isInteger(value) || value < 1 || value > 10000)) {
    throw fail('bad_capture_dimensions');
  }
  const candidates = [
    { mime: 'video/mp4;codecs=avc1.64002A', container: 'video/mp4', ext: 'mp4' },
    { mime: 'video/mp4;codecs=avc1.640033', container: 'video/mp4', ext: 'mp4' },
  ];
  const Recorder = window.MediaRecorder;
  const format = candidates.find((candidate) => Recorder && Recorder.isTypeSupported(candidate.mime)) || pickRecMime();
  // هذا معدل مطلوب من المُرمّز، وليس قياساً لمعدل الفيديو المحفوظ.
  const options = { videoBitsPerSecond: Math.min(80000000, Math.max(24000000, Math.round(width * height * 30 * 0.4))) };
  if (format.mime) options.mimeType = format.mime;
  return { capture: { width, height }, format, options };
}
