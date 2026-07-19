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
