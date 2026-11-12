// حارس قناة قراءة بايتات الأصل للتصدير — promostudio.assetRead (الدفعة 5 من مخرج الإعلانات).
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const studio = require('../electron/promostudio');

let checks = 0;
const eq = (actual, expected, message) => { assert.deepStrictEqual(actual, expected, message); checks += 1; };

const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-promo-read-'));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-promo-outside-'));
try {
  const clip = path.join(downloads, 'clip.mp4');
  const other = path.join(downloads, 'other.mp4');
  const image = path.join(downloads, 'shot.png');
  const secret = path.join(outside, 'secret.mp4');
  const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
  for (const file of [clip, other, image, secret]) fs.writeFileSync(file, bytes);
  const controller = studio.create({ downloadsPath: downloads });

  eq(controller.assetRead(clip, 0, 10).error, 'not_in_storyboard', 'لا قراءة قبل اقتراح storyboard');
  eq(controller.propose({ scenes: [{ asset: clip, duration_ms: 3000 }, { asset: image, duration_ms: 1000 }] }).ok, true, 'اقتراح');

  const head = controller.assetRead(clip, 0, 16);
  eq([head.ok, head.size, [...head.bytes]], [true, 1000, [...bytes.subarray(0, 16)]], 'أول 16 بايتاً والحجم');
  eq([...controller.assetRead(clip, 990, 100).bytes], [...bytes.subarray(990)], 'القراءة تُقصّ عند نهاية الملف');
  eq(controller.assetRead(clip, 1000, 10).bytes.length, 0, 'قراءة عند النهاية بالضبط = فارغة');
  eq([controller.assetRead(clip, 0, 0).ok, controller.assetRead(clip, 0, 0).size], [true, 1000], 'طول صفري يعيد الحجم');

  eq(controller.assetRead(other, 0, 10).error, 'not_in_storyboard', 'ملف في Downloads خارج الـstoryboard');
  eq(controller.assetRead(secret, 0, 10).error, 'not_in_storyboard', 'ملف خارج Downloads');
  eq(controller.assetRead(image, 0, 10).error, 'bad_asset', 'الصور لا تُقرأ بايتاتها');
  eq(controller.assetRead(path.join(downloads, '..', path.basename(outside), 'secret.mp4'), 0, 10).error, 'not_in_storyboard', 'مسار بالصعود');
  for (const [label, offset, length] of [['إزاحة سالبة', -1, 10], ['إزاحة كسرية', 1.5, 10], ['إزاحة نصية', '0', 10], ['طول سالب', 0, -1],
    ['طول فوق الحد', 0, studio.MAX_ASSET_READ_BYTES + 1], ['طول NaN', 0, NaN], ['إزاحة بعد النهاية', 1001, 1], ['طول غائب', 0, undefined]]) {
    eq(controller.assetRead(clip, offset, length).error, 'bad_range', label);
  }
  eq(controller.assetRead(clip, 0, studio.MAX_ASSET_READ_BYTES).ok, true, 'الحد نفسه مقبول');
  eq(controller.assetRead(42, 0, 1).error, 'not_in_storyboard', 'مسار غير نصي');

  // أصل storyboard خبيث لا يصل أصلاً: التنقية ترفض ما هو خارج Downloads
  eq(controller.propose({ scenes: [{ asset: secret, duration_ms: 3000 }] }).ok, false, 'اقتراح بأصل خارج Downloads مرفوض');
  controller.clear();
  eq(controller.assetRead(clip, 0, 10).error, 'not_in_storyboard', 'بعد clear لا قراءة');

  console.log('promo-asset-read-test: ok — ' + checks + ' فحصاً (الحصر في الـstoryboard وDownloads، النطاقات، السقف).');
} finally {
  fs.rmSync(downloads, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
}
