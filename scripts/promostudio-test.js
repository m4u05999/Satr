#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const studio = require('../electron/promostudio');
const recording = require('../electron/previewrecording');

const downloads = path.resolve('tmp-promo-studio-downloads');
const clip = path.join(downloads, 'clip.mp4');
const image = path.join(downloads, 'cover.webp');
const music = path.join(downloads, 'music.wav');
const voice = path.join(downloads, 'voice.wav');
const existing = new Set([clip, image, music, voice]);
const events = [];
const controller = studio.create({
  downloadsPath: downloads,
  exists: (candidate) => existing.has(candidate),
  aspectForPath: (candidate) => candidate === clip ? '9:16' : '',
  emit: (event) => events.push(event),
});

assert.strictEqual(studio.localAsset(downloads, path.resolve(downloads, '..', 'outside.mp4'), studio.VIDEO_EXTENSIONS, () => true), '');
assert.strictEqual(studio.localAsset(downloads, 'https://example.com/video.mp4', studio.VIDEO_EXTENSIONS, () => true), '');
assert.strictEqual(studio.localAsset(downloads, path.join(downloads, 'script.js'), studio.VIDEO_EXTENSIONS, () => true), '');
assert.strictEqual(studio.localAsset(downloads, clip, studio.VIDEO_EXTENSIONS, () => true,
  (candidate) => candidate === path.resolve(downloads) ? path.resolve(downloads) : path.resolve(downloads, '..', 'escape.mp4')), '');

const proposed = controller.propose({ scenes: [
  { segment_path: clip, caption: 'عنوان عربي', duration_ms: 1200, transition: 'cut', music, voice },
  { asset: image, caption: 'مشهد ثانٍ', duration_ms: 800, transition: 'fade' },
] });
assert(proposed.ok && proposed.storyboard.aspect === '9:16' && proposed.storyboard.scenes.length === 2);
assert.strictEqual(proposed.storyboard.scenes[1].asset_type, 'image');
assert(events.some((event) => event.type === 'storyboard_proposed' && event.storyboard.scenes.length === 2));
assert(controller.assetUrl(clip).ok && controller.assetUrl(clip).url.startsWith('file:'));
assert.deepStrictEqual(controller.assetUrl(path.join(downloads, 'unknown.mp4')), { ok: false, error: 'not_in_storyboard' });
assert.strictEqual(controller.propose({ scenes: [{ segment_path: path.resolve(downloads, '..', 'outside.mp4') }] }).error, 'bad_asset');
assert.strictEqual(controller.propose({ scenes: [{ segment_path: clip, music: path.resolve(downloads, '..', 'outside.wav') }] }).error, 'bad_music');
assert.strictEqual(controller.propose({ scenes: [{ segment_path: clip, voice: path.resolve(downloads, '..', 'outside.wav') }] }).error, 'bad_voice');
assert.strictEqual(controller.propose({ scenes: [{ segment_path: clip, duration_ms: 121000 }] }).error, 'bad_duration');

const finalName = 'satr-promo-final-2026-07-19-15-20-30.mp4';
assert(recording.SAFE_PROMO_FINAL_NAME.test(finalName));
assert.strictEqual(recording.recordingSavePath(downloads, finalName, () => false), path.join(downloads, finalName));
assert.strictEqual(recording.recordingSavePath(downloads, '../' + finalName, () => false), null);

console.log('promostudio: نجح — storyboard محلي، حدود المشاهد، منع الخروج من Downloads، وحفظ نهائي فريد.');
