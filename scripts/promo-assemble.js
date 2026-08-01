#!/usr/bin/env node
'use strict';

/**
 * مجمّع إعلان «سطر» (60ث) — يقصّ مقاطع promo/footage/ حسب قائمة المونتاج (EDIT-PLAN.md)
 * ويوحّد ترميزها (1080p60 H.264) ثم يدمجها بقطع حادّ، ويركّب الموسيقى مع خفوت النهاية.
 *
 * صفر اعتماديات — يستدعي ffmpeg (من FFMPEG أو D:\sater\tools أو PATH). المقاطع الغائبة
 * (لقطات الواجهة قبل تسجيلها) تُستبدَل ببطاقة نائبة داكنة بشريط ذهبي فيظهر الإيقاع كاملاً؛
 * الناتج يُسمّى -rough ما دام فيها نائب، و-60s حين تكتمل كلها. لا قصّ صامت — كل نائب يُسجَّل.
 *
 * التشغيل: node scripts/promo-assemble.js   (الموسيقى اختيارية: promo/footage/music.mp3)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FOOT = path.join(ROOT, 'promo', 'footage');
const W = 1920, H = 1080, FPS = 60;

function resolveFfmpeg() {
  if (process.env.FFMPEG && fs.existsSync(process.env.FFMPEG)) return process.env.FFMPEG;
  const guesses = [
    path.join('D:', 'sater', 'tools', 'ffmpeg.exe'),
    // تثبيت winget الرسمي (Gyan.FFmpeg) — روابطه لا تدخل PATH الجلسات القائمة
    path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
  ];
  for (const guess of guesses) if (fs.existsSync(guess)) return guess;
  return 'ffmpeg';
}
const FFMPEG = resolveFfmpeg();

// قائمة المونتاج — الترتيب والأزمنة من EDIT-PLAN.md (المجموع 60.0ث)
// ss = بداية القصّ داخل المصدر، t = المدة المعروضة. optional = لقطة واجهة تُسجَّل لاحقاً.
const SEGMENTS = [
  { file: '01-hook.mp4',        ss: 0,   t: 10.0 },
  { file: '02-title-otlob.mp4', ss: 0,   t: 2.0 },
  // §1 من تسجيل جلسة حقيقية طولها ~17 دقيقة: النافذة المختارة (216ث) هي لحظة نمو بطاقة
  // الفرق سطراً سطراً — اختيرت بمسح الجلسة كاملة بورقة اتصال إطار/دقيقة ثم تدقيق ثانوي.
  { file: '03-ui-otlob.mp4',    ss: 216, t: 8.0, optional: true, label: 'لقطة الواجهة: اطلب' },
  { file: '04-title-3ayen.mp4', ss: 0,   t: 2.0 },
  { file: '05-ui-3ayen.mp4',    ss: 0,   t: 7.9, optional: true, label: 'لقطة الواجهة: عايِن' },
  { file: '06-title-sallem.mp4',ss: 0,   t: 2.0 },
  { file: '07-ui-sallem.mp4',   ss: 0,   t: 8.0, optional: true, label: 'لقطة الواجهة: سلّم' },
  { file: '08-watch.mp4',       ss: 0,   t: 3.5 },
  { file: '09-crescendo.mp4',   ss: 0,   t: 5.5 },
  { file: '10-cine-birds.mp4',  ss: 1.2, t: 2.5 },
  { file: '11-cta.mp4',         ss: 0,   t: 8.4 },
];

// الطول الفعلي للإعلان = مجموع مدد القائمة (يحكم قصّ الموسيقى وخفوت النهاية)
const TOTAL = Math.round(SEGMENTS.reduce((sum, s) => sum + s.t, 0) * 1000) / 1000;

const run = (args) => {
  const r = spawnSync(FFMPEG, args, { stdio: ['ignore', 'ignore', 'inherit'] });
  if (r.status !== 0) throw new Error('ffmpeg فشل (كود ' + r.status + '): ' + args.join(' '));
};

// فلتر توحيد: قصّ للمدة، تحجيم داخل 1920×1080 مع حشو (pad) للحفاظ على النسبة، 60fps، SAR=1
const NORM = 'scale=' + W + ':' + H + ':force_original_aspect_ratio=decrease,'
  + 'pad=' + W + ':' + H + ':(ow-iw)/2:(oh-ih)/2:color=0x111110,setsar=1,fps=' + FPS + ',format=yuv420p';

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'promo-asm-'));
  const parts = [];
  let missing = 0;

  SEGMENTS.forEach((seg, i) => {
    const src = path.join(FOOT, seg.file);
    const out = path.join(tmp, 'p' + String(i).padStart(2, '0') + '.mp4');
    if (fs.existsSync(src)) {
      console.log('✓ قصّ', seg.file, '→', seg.t + 'ث');
      run(['-y', '-ss', String(seg.ss), '-i', src, '-t', String(seg.t),
        '-vf', NORM, '-an', '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', out]);
    } else if (seg.optional) {
      missing += 1;
      console.log('▢ نائب', seg.file, '(' + seg.label + ') — سجّله ثم أعد التجميع');
      // بطاقة نائبة: خلفية داكنة + شريط ذهبي متوسّط (بلا نص عربي — drawtext لا يشكّل العربية)
      run(['-y', '-f', 'lavfi', '-i', 'color=c=0x111110:s=' + W + 'x' + H + ':r=' + FPS,
        '-t', String(seg.t),
        '-vf', 'drawbox=x=(iw-560)/2:y=(ih-6)/2:w=560:h=6:color=0xD9A441@0.9:t=fill,format=yuv420p',
        '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', out]);
    } else {
      throw new Error('مقطع إلزامي غائب: ' + seg.file + ' — صيّر مشاهد typography أولاً (npx electron scripts/promo-render.js).');
    }
    parts.push(out);
  });

  // قائمة الدمج (concat demuxer — كل الأجزاء بنفس الترميز الآن)
  const listFile = path.join(tmp, 'concat.txt');
  fs.writeFileSync(listFile, parts.map((p) => "file '" + p.replace(/\\/g, '/') + "'").join('\n'), 'utf8');
  const silent = path.join(tmp, 'video.mp4');
  run(['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', silent]);

  const music = path.join(FOOT, 'music.mp3');
  const hasMusic = fs.existsSync(music);
  const suffix = missing ? 'rough' : '60s';
  const outName = process.env.PROMO_OUT || ('satr-promo-' + suffix + '.mp4');
  const finalOut = path.join(ROOT, 'promo', outName);

  if (hasMusic) {
    // ج10: الخفوت يحاذي **الطول الفعلي** المحسوب من قائمة المونتاج لا الرقم الثابت 60،
    // وإلا انقطع الخفوت قبل تمامه حين يقلّ المجموع عن دقيقة (المجموع اليوم 59.8ث).
    const fadeDur = Math.min(4, Math.max(1, TOTAL / 12));
    const fadeStart = Math.max(0, TOTAL - fadeDur);
    console.log('♪ تركيب الموسيقى مع خفوت النهاية (المجموع ' + TOTAL.toFixed(2)
      + 'ث · الخفوت من ' + fadeStart.toFixed(2) + 'ث)');
    run(['-y', '-i', silent, '-i', music,
      '-filter_complex', '[1:a]atrim=0:' + TOTAL.toFixed(3)
        + ',afade=t=out:st=' + fadeStart.toFixed(3) + ':d=' + fadeDur.toFixed(3) + '[a]',
      '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', finalOut]);
  } else {
    console.log('♪ لا موسيقى (ضع promo/footage/music.mp3) — الناتج صامت');
    run(['-y', '-i', silent, '-c', 'copy', finalOut]);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  const kb = Math.round(fs.statSync(finalOut).size / 1024);
  console.log('\n=== ' + path.basename(finalOut) + ' (' + kb + 'KB) ===');
  if (missing) console.log('نواقص: ' + missing + ' لقطة واجهة (بطاقات نائبة) + ' + (hasMusic ? '' : 'الموسيقى. '));
  console.log('المدة: ' + TOTAL.toFixed(2) + 'ث · ' + W + 'x' + H + ' · ' + FPS + 'fps');
}

try { main(); } catch (e) { console.error('promo-assemble:', e.message); process.exit(1); }
