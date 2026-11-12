// اختيار إعداد مرمّز الفيديو للتصدير (WebCodecs).
// السلاسل بحسب الدقة ومعدل الإطارات: المسبار (الدفعة 0) أثبت أن avc1.640028 مرفوض عند 4K
// وأن avc1.42001f مرفوض عند 1080p، وأن المرمّز العتادي قد يُعلن مدعوماً ثم يفشل عند التهيئة.

export const EXPORT_PRESETS = Object.freeze({
  '1080p30': Object.freeze({ label: '1080p · 30 إطاراً', scale: 1, fps: 30, bitrate: 12e6, codecs: ['avc1.640028', 'avc1.4d0028', 'avc1.420028'] }),
  '1080p60': Object.freeze({ label: '1080p · 60 إطاراً', scale: 1, fps: 60, bitrate: 18e6, codecs: ['avc1.64002A', 'avc1.4d002A', 'avc1.42002A'] }),
  '4k30': Object.freeze({ label: '4K · 30 إطاراً', scale: 2, fps: 30, bitrate: 35e6, codecs: ['avc1.640033', 'avc1.4d0033'] }),
});

export const ASPECT_BASE = Object.freeze({
  '16:9': Object.freeze({ width: 1920, height: 1080 }),
  '9:16': Object.freeze({ width: 1080, height: 1920 }),
  '1:1': Object.freeze({ width: 1080, height: 1080 }),
});

export function presetSize(aspect, presetName) {
  const base = ASPECT_BASE[aspect] || ASPECT_BASE['16:9'];
  const preset = EXPORT_PRESETS[presetName] || EXPORT_PRESETS['1080p30'];
  return { width: base.width * preset.scale, height: base.height * preset.scale, fps: preset.fps };
}

function configFor(codec, size, preset, acceleration) {
  return {
    codec, width: size.width, height: size.height, framerate: preset.fps, bitrate: preset.bitrate,
    bitrateMode: 'variable', latencyMode: 'quality', hardwareAcceleration: acceleration, avc: { format: 'avc' },
  };
}

// أول إعداد يقبله isConfigSupported، أو null. القبول هنا لا يثبت التشغيل: المستدعي يعيد
// المحاولة بـprefer-software إن أطلق المرمّز خطأ بعد التهيئة.
export async function pickEncoderConfig(aspect, presetName, acceleration = 'no-preference') {
  if (typeof VideoEncoder !== 'function') return null;
  const preset = EXPORT_PRESETS[presetName];
  if (!preset) return null;
  const size = presetSize(aspect, presetName);
  for (const codec of preset.codecs) {
    const config = configFor(codec, size, preset, acceleration);
    try {
      const support = await VideoEncoder.isConfigSupported(config);
      if (support && support.supported) return config;
    } catch {}
  }
  return null;
}

// ما يدعمه هذا الجهاز: أي الإعدادات متاحة لمقاس معيّن، وهل AAC متاح.
export async function probeExportSupport(aspect) {
  const result = { video: {}, audio: false, engine: false };
  if (typeof VideoEncoder !== 'function' || typeof AudioEncoder !== 'function' || typeof OfflineAudioContext !== 'function') return result;
  try {
    const audio = await AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 192000 });
    result.audio = !!(audio && audio.supported);
  } catch {}
  for (const name of Object.keys(EXPORT_PRESETS)) {
    result.video[name] = !!(await pickEncoderConfig(aspect, name));
  }
  result.engine = result.audio && result.video['1080p30'] === true;
  return result;
}
