#!/usr/bin/env node
'use strict';

/**
 * فارز موسيقى الإعلان — قياس موضوعي للمرشّحات بلا استماع (ج10).
 *
 * الوكيل لا يسمع، فاختيار «الأفضل» بالأذن مستحيل عليه. هذا الفارز يقيس من عيّنات WAV
 * ما يقبل القياس فعلاً ويطابق عقد `promo/EDIT-PLAN.md` (سينمائي ملحمي هادئ البداية،
 * يتصاعد إلى ذروة الخاتمة، ≥62ث):
 *   • المدة الفعلية من ترويسة WAV.
 *   • **الطاقة الصاعدة**: ميل انحدار خطي على مغلّف RMS بنافذة ثانية + نسبة الثلث
 *     الأخير إلى الثلث الأول.
 *   • **ذروة الخاتمة**: طاقة الثواني 50..60 (نهاية الإعلان؛ آخر 5ث في أصل 65ث هامش)
 *     قياساً بالعشر السابقة، ونسبة أعلى نافذة في الخاتمة إلى أعلى نافذة قبلها.
 *   • **تقدير الإيقاع (BPM)**: ارتباط ذاتي لمغلّف بداية النغمات (فرق الطاقة الموجب)
 *     في نطاق 60..200 — تقدير تقريبي لا قياس مرجعي، وموسوم كذلك.
 *   • الذروة والاقتطاع (clipping) على كل قناة وصمت البداية/النهاية.
 * ما لا يقاس هنا: الغناء والذوق والمزاج — تبقى للاعتماد السمعي البشري.
 *
 * صفر اعتماديات (قراءة PCM مباشرة). التشغيل:
 *   node promo/analyze-music.js <file.wav> [more.wav ...]
 */

const fs = require('fs');
const path = require('path');

// ---------- قراءة WAV (‏PCM 16-bit فقط — وهو ما يعيده ace-step فعلاً) ----------
function readWav(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 44 || buf.slice(0, 4).toString('latin1') !== 'RIFF'
    || buf.slice(8, 12).toString('latin1') !== 'WAVE') throw new Error('ليس ملف WAV صالحاً');
  let pos = 12;
  let fmt = null;
  while (pos + 8 <= buf.length) {
    const id = buf.slice(pos, pos + 4).toString('latin1');
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') {
      fmt = {
        channels: buf.readUInt16LE(pos + 10),
        sampleRate: buf.readUInt32LE(pos + 12),
        byteRate: buf.readUInt32LE(pos + 16),
        bits: buf.readUInt16LE(pos + 22),
      };
    } else if (id === 'data') {
      if (!fmt) throw new Error('data قبل fmt');
      if (fmt.bits !== 16) throw new Error('عمق العيّنة غير مدعوم: ' + fmt.bits);
      return { fmt, data: buf.slice(pos + 8, Math.min(pos + 8 + size, buf.length)) };
    }
    pos += 8 + size + (size % 2);
  }
  throw new Error('لا كتلة data');
}

/** أحادي مطبَّع [-1,1] بمتوسط القنوات. */
function toMono(wav) {
  const { channels } = wav.fmt;
  const frames = Math.floor(wav.data.length / (2 * channels));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    for (let c = 0; c < channels; c += 1) sum += wav.data.readInt16LE((i * channels + c) * 2);
    out[i] = sum / channels / 32768;
  }
  return out;
}

// ---------- الطاقة والمغلّف ----------
function rmsWindows(mono, sampleRate, windowSec) {
  const size = Math.max(1, Math.round(sampleRate * windowSec));
  const out = [];
  for (let start = 0; start + size <= mono.length; start += size) {
    let acc = 0;
    for (let i = start; i < start + size; i += 1) acc += mono[i] * mono[i];
    out.push(Math.sqrt(acc / size));
  }
  return out;
}

/** ميل انحدار خطي مطبَّع بالمتوسط: >0 يعني طاقة صاعدة عبر المقطع. */
function trendSlope(values) {
  const n = values.length;
  if (n < 3) return 0;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) { num += (i - meanX) * (values[i] - meanY); den += (i - meanX) ** 2; }
  const slope = den ? num / den : 0;
  return meanY ? slope / meanY : 0; // لكل نافذة، نسبةً إلى المتوسط
}

// ---------- تقدير الإيقاع بالارتباط الذاتي لمغلّف البدايات ----------
function estimateBpm(mono, sampleRate) {
  const hop = 512;
  const frames = Math.floor(mono.length / hop);
  const energy = new Float32Array(frames);
  for (let f = 0; f < frames; f += 1) {
    let acc = 0;
    for (let i = f * hop; i < (f + 1) * hop; i += 1) acc += mono[i] * mono[i];
    energy[f] = Math.sqrt(acc / hop);
  }
  // مغلّف البدايات = الفرق الموجب فقط (صعود الطاقة)
  const onset = new Float32Array(frames);
  for (let f = 1; f < frames; f += 1) onset[f] = Math.max(0, energy[f] - energy[f - 1]);
  const mean = onset.reduce((a, b) => a + b, 0) / (frames || 1);
  for (let f = 0; f < frames; f += 1) onset[f] -= mean; // إزالة الانحياز قبل الارتباط

  const frameRate = sampleRate / hop;
  let best = { bpm: 0, score: 0 };
  for (let bpm = 60; bpm <= 200; bpm += 0.5) {
    const lag = Math.round((60 / bpm) * frameRate);
    if (lag < 2 || lag >= frames - 2) continue;
    let acc = 0;
    for (let f = 0; f + lag < frames; f += 1) acc += onset[f] * onset[f + lag];
    const score = acc / (frames - lag);
    if (score > best.score) best = { bpm, score };
  }
  return best.bpm;
}

// ---------- التقرير ----------
function analyze(file) {
  const wav = readWav(file);
  const mono = toMono(wav);
  const sr = wav.fmt.sampleRate;
  const seconds = Math.round((mono.length / sr) * 100) / 100;

  const env = rmsWindows(mono, sr, 1);
  const third = Math.max(1, Math.floor(env.length / 3));
  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
  const firstThird = avg(env.slice(0, third));
  const lastThird = avg(env.slice(-third));
  const promoEnd = Math.min(60, env.length);
  const finaleStart = Math.max(0, promoEnd - 10);
  const preFinaleStart = Math.max(0, finaleStart - 10);
  const finale = env.slice(finaleStart, promoEnd);
  const preFinale = env.slice(preFinaleStart, finaleStart);
  const beforeFinale = env.slice(0, finaleStart);
  const maxOf = (arr) => arr.length ? Math.max(...arr) : 0;
  const finaleMean = avg(finale);
  const preFinaleMean = avg(preFinale);
  const finalePeak = maxOf(finale);
  const earlierPeak = maxOf(beforeFinale);
  let peakWindow = 0;
  for (let i = 1; i < env.length; i += 1) {
    if (env[i] > env[peakWindow]) peakWindow = i;
  }

  let peak = 0;
  let clipped = 0;
  let clipRun = 0;
  let maxClipRun = 0;
  for (let i = 0; i + 1 < wav.data.length; i += 2) {
    const a = Math.abs(wav.data.readInt16LE(i)) / 32768;
    if (a > peak) peak = a;
    if (a >= (32767 / 32768)) {
      clipped += 1;
      clipRun += 1;
      if (clipRun > maxClipRun) maxClipRun = clipRun;
    } else {
      clipRun = 0;
    }
  }
  const leadIn = env.findIndex((v) => v > 0.01);
  const tailQuiet = env.length - 1 - [...env].reverse().findIndex((v) => v > 0.01);

  return {
    file: path.basename(file),
    seconds,
    sampleRate: sr,
    channels: wav.fmt.channels,
    bpm_estimate: estimateBpm(mono, sr),
    rms_mean: Math.round(avg(env) * 10000) / 10000,
    rise_ratio: firstThird ? Math.round((lastThird / firstThird) * 100) / 100 : 0,
    trend_slope: Math.round(trendSlope(env) * 10000) / 10000,
    finale_ratio: preFinaleMean ? Math.round((finaleMean / preFinaleMean) * 100) / 100 : 0,
    finale_peak_ratio: earlierPeak ? Math.round((finalePeak / earlierPeak) * 100) / 100 : 0,
    peak_window_sec: peakWindow,
    peak: Math.round(peak * 1000) / 1000,
    clipped_samples: clipped,
    max_clip_run: maxClipRun,
    sustained_clipping: maxClipRun >= 3,
    lead_in_sec: leadIn < 0 ? seconds : leadIn,
    last_loud_sec: tailQuiet,
  };
}

function main() {
  const files = process.argv.slice(2);
  if (!files.length) { console.error('الاستعمال: node promo/analyze-music.js <file.wav> [...]'); process.exit(1); }
  const rows = [];
  for (const f of files) {
    try { rows.push(analyze(f)); }
    catch (e) { console.log(path.basename(f) + ': فشل التحليل — ' + e.message); }
  }
  // العرض LTR للأرقام والمسارات
  console.log(['file', 'sec', 'bpm~', 'rms', 'rise', 'slope', 'final10', 'finalPeak',
    'peakAt', 'samplePeak', 'clipN', 'clipRun', 'clipped?', 'lead', 'lastLoud'].join('\t'));
  for (const r of rows) {
    console.log([r.file, r.seconds, r.bpm_estimate, r.rms_mean, r.rise_ratio, r.trend_slope,
      r.finale_ratio, r.finale_peak_ratio, r.peak_window_sec, r.peak, r.clipped_samples,
      r.max_clip_run, r.sustained_clipping, r.lead_in_sec, r.last_loud_sec].join('\t'));
  }
  console.log('\nملاحظة: bpm~ تقدير تقريبي بالارتباط الذاتي لا قياس مرجعي؛ '
    + 'rise = طاقة الثلث الأخير ÷ الثلث الأول، final10 = طاقة 50..60ث ÷ 40..50ث، '
    + 'finalPeak = أعلى نافذة في آخر 10ث ÷ أعلى نافذة قبلها. البداية الهادئة مقصودة ولا تُرفض. '
    + 'clipped? لا يصير true إلا مع 3 عينات Full Scale متتالية. '
    + 'الغناء والذوق خارج القياس — يبقيان للاعتماد السمعي البشري.');
}

if (require.main === module) main();
module.exports = { analyze, readWav, toMono, estimateBpm };
