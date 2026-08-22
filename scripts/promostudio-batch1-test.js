#!/usr/bin/env node
'use strict';

/**
 * اختبار قطعي لـ `electron/promostudio.js` — الدفعة 1:
 * الاستيراد من التنزيلات · حفظ/فتح المشروع · الأصول المفقودة.
 *
 * التشغيل: node scripts/promostudio-batch1-test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const studio = require('../electron/promostudio');

const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-promo-batch1-'));
const clip = path.join(downloads, 'clip.mp4');
const image = path.join(downloads, 'cover.webp');
const music = path.join(downloads, 'music.wav');
const outside = path.resolve(downloads, '..', 'outside.mp4');
const projectFile = path.join(downloads, 'test.satr-promo.json');
const badProject = path.join(downloads, 'bad.txt');

fs.writeFileSync(clip, 'clip');
fs.writeFileSync(image, 'image');
fs.writeFileSync(music, 'music');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('[ok] ' + name);
  } catch (error) {
    failed += 1;
    console.log('[FAIL] ' + name + ' :: ' + (error && error.message ? error.message : error));
  }
}

test('listDownloads يقبل الملفات داخل التنزيلات فقط', () => {
  const result = studio.listDownloads(downloads, ['.mp4', '.webp']);
  assert(result.ok);
  const names = result.files.map((file) => file.name).sort();
  assert.deepStrictEqual(names, ['clip.mp4', 'cover.webp']);
});

test('listDownloads يرفض الامتدادات غير المطلوبة', () => {
  const result = studio.listDownloads(downloads, ['.wav']);
  assert(result.ok);
  assert.strictEqual(result.files.length, 1);
  assert.strictEqual(result.files[0].name, 'music.wav');
});

test('listDownloads يرفض المسار النسبي', () => {
  const result = studio.listDownloads('relative/path', ['.mp4']);
  assert(!result.ok);
  assert.strictEqual(result.error, 'bad_downloads_path');
});

test('saveProject يكتب schema بإصدار وذرّياً', () => {
  const storyboard = { aspect: '16:9', scenes: [
    { asset: clip, asset_type: 'video', caption: 'عنوان', duration_ms: 1000, transition: 'cut' },
    { asset: image, asset_type: 'image', caption: '', duration_ms: 800, transition: 'fade' },
  ] };
  const result = studio.saveProject(downloads, storyboard, projectFile);
  assert(result.ok);
  assert.strictEqual(result.path, projectFile);
  assert(fs.existsSync(projectFile));
  const raw = fs.readFileSync(projectFile, 'utf8');
  const parsed = JSON.parse(raw);
  assert.strictEqual(parsed.version, studio.PROJECT_SCHEMA_VERSION);
  assert.strictEqual(parsed.aspect, '16:9');
  assert.strictEqual(parsed.scenes.length, 2);
  assert.strictEqual(parsed.scenes[0].caption, 'عنوان');
  // التأكد من عدم وجود ملف temp متبقٍ
  assert(!fs.existsSync(projectFile + '.tmp'));
});

test('saveProject يرفض المسار خارج التنزيلات', () => {
  const result = studio.saveProject(downloads, { aspect: '16:9', scenes: [{ asset: clip, duration_ms: 1000 }] }, outside);
  assert(!result.ok);
  assert.strictEqual(result.error, 'bad_path');
});

test('saveProject يرفض امتداداً غير صحيح', () => {
  const result = studio.saveProject(downloads, { aspect: '16:9', scenes: [{ asset: clip, duration_ms: 1000 }] }, badProject);
  assert(!result.ok);
  assert.strictEqual(result.error, 'bad_path');
});

test('loadProject يستعيد المشروع ويحافظ على بصمته', () => {
  const result = studio.loadProject(projectFile, downloads);
  assert(result.ok);
  assert.strictEqual(result.storyboard.aspect, '16:9');
  assert.strictEqual(result.storyboard.scenes.length, 2);
  assert.deepStrictEqual(result.missing, []);
});

test('loadProject يبقي المشروع صالحاً رغم أصل مفقود', () => {
  const existingClip = path.join(downloads, 'existing.mp4');
  fs.writeFileSync(existingClip, 'clip');
  const storyboard = { aspect: '9:16', scenes: [
    { asset: existingClip, asset_type: 'video', caption: 'مشهد موجود', duration_ms: 1000 },
    { asset: image, asset_type: 'image', caption: 'صورة موجودة', duration_ms: 600 },
  ] };
  const saved = studio.saveProject(downloads, storyboard, path.join(downloads, 'missing.satr-promo.json'));
  assert(saved.ok);
  fs.unlinkSync(existingClip);
  fs.unlinkSync(image);
  const loaded = studio.loadProject(saved.path, downloads);
  assert(loaded.ok);
  assert.strictEqual(loaded.storyboard.scenes.length, 2);
  assert.strictEqual(loaded.storyboard.scenes[0].asset_missing, true);
  assert.strictEqual(loaded.storyboard.scenes[1].asset_missing, true);
  assert(loaded.missing.length >= 1);
  // إعادة الصورة للاختبارات اللاحقة
  fs.writeFileSync(image, 'image');
});

test('loadProject يرفض schema غير صالح', () => {
  const badFile = path.join(downloads, 'bad.satr-promo.json');
  fs.writeFileSync(badFile, '{"version":99,"scenes":[]}', 'utf8');
  const result = studio.loadProject(badFile, downloads);
  assert(!result.ok);
  assert.strictEqual(result.error, 'bad_schema');
});

test('loadProject يرفض المسار خارج التنزيلات', () => {
  const result = studio.loadProject(outside, downloads);
  assert(!result.ok);
  assert.strictEqual(result.error, 'bad_path');
});

console.log(`\npromostudio-batch1: ${passed} نجح، ${failed} فشل`);

// تنظيف
for (const file of fs.readdirSync(downloads)) {
  try { fs.unlinkSync(path.join(downloads, file)); } catch {}
}
try { fs.rmdirSync(downloads); } catch {}

process.exit(failed ? 1 : 0);
