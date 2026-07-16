#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { EventEmitter } = require('events');
const recording = require('../electron/previewrecording');

class FakeItem extends EventEmitter {
  constructor(filename) { super(); this.filename = filename; this.savePath = ''; }
  getFilename() { return this.filename; }
  setSavePath(value) { this.savePath = value; }
}

const downloadsPath = path.resolve('tmp-preview-downloads');
const name = 'satr-preview-2026-07-16-10-20-30.mp4';
assert.strictEqual(recording.recordingSavePath(downloadsPath, '../outside.mp4'), null);
assert.strictEqual(recording.recordingSavePath('relative', name), null);
assert.strictEqual(recording.recordingSavePath(downloadsPath, name, () => false), path.join(downloadsPath, name));
assert.strictEqual(recording.recordingSavePath(downloadsPath, name,
  (candidate) => candidate === path.join(downloadsPath, name)), path.join(downloadsPath, 'satr-preview-2026-07-16-10-20-30-2.mp4'));

const session = new EventEmitter();
const owner = { id: 7 };
const emitted = [];
const detach = recording.attach(session, owner, { downloadsPath, exists: () => false, emit: (event) => emitted.push(event) });
const foreign = new FakeItem(name);
session.emit('will-download', {}, foreign, { id: 8 });
assert.strictEqual(foreign.savePath, '');
const unsafe = new FakeItem('report.pdf');
session.emit('will-download', {}, unsafe, owner);
assert.strictEqual(unsafe.savePath, '');
const item = new FakeItem(name);
session.emit('will-download', {}, item, owner);
assert.strictEqual(item.savePath, path.join(downloadsPath, name));
item.emit('done', {}, 'completed');
assert.deepStrictEqual(emitted[0], { type: 'preview_recording_saved', filename: name, path: item.savePath });
detach();
assert.strictEqual(session.listenerCount('will-download'), 0);

console.log('previewrecording: نجح — مسار تنزيل ثابت، اسم منقّى، عزل النافذة، وإشعار اكتمال.');
