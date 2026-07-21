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
assert.deepStrictEqual({
  trim_start_ms: proposed.storyboard.scenes[0].trim_start_ms,
  fit: proposed.storyboard.scenes[0].fit,
  caption_position: proposed.storyboard.scenes[0].caption_position,
  caption_style: proposed.storyboard.scenes[0].caption_style,
  clip_volume: proposed.storyboard.scenes[0].clip_volume,
  music_volume: proposed.storyboard.scenes[0].music_volume,
  voice_volume: proposed.storyboard.scenes[0].voice_volume,
}, {
  trim_start_ms: 0, fit: 'cover', caption_position: 'bottom', caption_style: 'box',
  clip_volume: 1, music_volume: 0.34, voice_volume: 1,
});
assert(events.some((event) => event.type === 'storyboard_proposed' && event.storyboard.scenes.length === 2));
assert(controller.assetUrl(clip).ok && controller.assetUrl(clip).url.startsWith('file:'));
assert.deepStrictEqual(controller.assetUrl(path.join(downloads, 'unknown.mp4')), { ok: false, error: 'not_in_storyboard' });
assert.strictEqual(controller.propose({ scenes: [{ segment_path: path.resolve(downloads, '..', 'outside.mp4') }] }).error, 'bad_asset');
assert.strictEqual(controller.propose({ scenes: [{ segment_path: clip, music: path.resolve(downloads, '..', 'outside.wav') }] }).error, 'bad_music');
assert.strictEqual(controller.propose({ scenes: [{ segment_path: clip, voice: path.resolve(downloads, '..', 'outside.wav') }] }).error, 'bad_voice');
assert.strictEqual(controller.propose({ scenes: [{ segment_path: clip, duration_ms: 121000 }] }).error, 'bad_duration');

const advanced = controller.propose({ scenes: [{
  id: 'advanced_scene', segment_path: clip, duration_ms: 1000, trim_start_ms: 450,
  fit: 'contain', caption_position: 'top', caption_style: 'minimal',
  clip_volume: 0.7, music_volume: 0.2, voice_volume: 0.85,
}] });
assert(advanced.ok);
assert.deepStrictEqual({
  id: advanced.storyboard.scenes[0].id,
  trim_start_ms: advanced.storyboard.scenes[0].trim_start_ms,
  fit: advanced.storyboard.scenes[0].fit,
  caption_position: advanced.storyboard.scenes[0].caption_position,
  caption_style: advanced.storyboard.scenes[0].caption_style,
  clip_volume: advanced.storyboard.scenes[0].clip_volume,
  music_volume: advanced.storyboard.scenes[0].music_volume,
  voice_volume: advanced.storyboard.scenes[0].voice_volume,
}, {
  id: 'advanced_scene', trim_start_ms: 450, fit: 'contain', caption_position: 'top',
  caption_style: 'minimal', clip_volume: 0.7, music_volume: 0.2, voice_volume: 0.85,
});

const cleaned = controller.propose({ scenes: [{
  segment_path: clip, duration_ms: 1000, trim_start_ms: -1, fit: 'stretch',
  caption_position: 'side', caption_style: 'outline', clip_volume: 'loud',
  music_volume: NaN, voice_volume: Infinity,
}] });
assert(cleaned.ok);
assert.deepStrictEqual({
  trim_start_ms: cleaned.storyboard.scenes[0].trim_start_ms,
  fit: cleaned.storyboard.scenes[0].fit,
  caption_position: cleaned.storyboard.scenes[0].caption_position,
  caption_style: cleaned.storyboard.scenes[0].caption_style,
  clip_volume: cleaned.storyboard.scenes[0].clip_volume,
  music_volume: cleaned.storyboard.scenes[0].music_volume,
  voice_volume: cleaned.storyboard.scenes[0].voice_volume,
}, {
  trim_start_ms: 0, fit: 'cover', caption_position: 'bottom', caption_style: 'box',
  clip_volume: 1, music_volume: 0.34, voice_volume: 1,
});

const finalName = 'satr-promo-final-2026-07-19-15-20-30.mp4';
assert(recording.SAFE_PROMO_FINAL_NAME.test(finalName));
assert.strictEqual(recording.recordingSavePath(downloads, finalName, () => false), path.join(downloads, finalName));
assert.strictEqual(recording.recordingSavePath(downloads, '../' + finalName, () => false), null);

console.log('promostudio: نجح — الحقول الاحترافية والتوافق الخلفي وحدود Downloads وحفظ نهائي فريد.');
