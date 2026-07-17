#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-enterprise-boundary-'));
const privateSource = path.join(tempRoot, 'private-checkout');
fs.mkdirSync(privateSource);
fs.writeFileSync(path.join(privateSource, 'index.js'), 'module.exports = { register() {} };\n');
fs.writeFileSync(path.join(privateSource, 'LICENSE'), 'Proprietary\n');
fs.writeFileSync(path.join(privateSource, 'satr-enterprise.json'), JSON.stringify({
  name: '@satr/enterprise', contractVersion: 1, main: 'index.js', packageFiles: ['index.js', 'LICENSE'],
}));

const sourceModule = require('./enterprise-source');

try {
  const resolved = sourceModule.resolveEnterpriseSource(privateSource);
  assert.strictEqual(resolved.source, fs.realpathSync.native(privateSource));
  assert.throws(() => sourceModule.resolveEnterpriseSource('relative/path'), /مساراً مطلقاً/);
  assert.throws(() => sourceModule.resolveEnterpriseSource(root), /خارج مستودع Community/);

  const incompatible = path.join(tempRoot, 'incompatible');
  fs.mkdirSync(incompatible);
  fs.writeFileSync(path.join(incompatible, 'index.js'), 'module.exports = {};\n');
  fs.writeFileSync(path.join(incompatible, 'LICENSE'), 'Proprietary\n');
  fs.writeFileSync(path.join(incompatible, 'satr-enterprise.json'), JSON.stringify({
    name: '@satr/enterprise', contractVersion: 2, main: 'index.js', packageFiles: ['index.js', 'LICENSE'],
  }));
  assert.throws(() => sourceModule.resolveEnterpriseSource(incompatible), /غير متوافق/);
  fs.writeFileSync(path.join(incompatible, 'satr-enterprise.json'), JSON.stringify({
    name: '@satr/enterprise', contractVersion: 1, main: 'index.js', packageFiles: ['../index.js', 'LICENSE'],
  }));
  assert.throws(() => sourceModule.resolveEnterpriseSource(incompatible), /packageFiles/);
  console.log('✓ private Enterprise checkout requires an external compatible contract');

  const previous = process.env.SATR_ENTERPRISE_DIR;
  process.env.SATR_ENTERPRISE_DIR = privateSource;
  const configPath = require.resolve('./ee-builder-config');
  delete require.cache[configPath];
  const config = require('./ee-builder-config');
  const fileSet = config.files.find((entry) => entry && typeof entry === 'object' && entry.to === 'enterprise');
  assert(fileSet);
  assert.strictEqual(fileSet.from, fs.realpathSync.native(privateSource));
  assert(!config.files.includes('enterprise/**/*'));
  assert.strictEqual(config.publish, null);
  assert.strictEqual(config.extraMetadata.satrEdition, 'enterprise');
  assert.strictEqual(config.extraMetadata.satrEnterpriseContract, 1);
  assert.strictEqual(config.directories.output, 'dist/enterprise');
  assert.deepStrictEqual(fileSet.filter, ['index.js', 'LICENSE']);
  if (previous === undefined) delete process.env.SATR_ENTERPRISE_DIR;
  else process.env.SATR_ENTERPRISE_DIR = previous;
  delete require.cache[configPath];
  console.log('✓ Enterprise build injects private source and disables publishing');

  assert.strictEqual(fs.existsSync(path.join(root, 'enterprise')), false);
  const packageJson = require('../package.json');
  assert(Array.isArray(packageJson.build.publish) && packageJson.build.publish[0].provider === 'github');
  assert.match(packageJson.scripts['dist:ee'], /--publish never(?:\s|$)/);
  assert(packageJson.build.files.includes('!enterprise/**'));
  assert(fs.readFileSync(path.join(root, '.gitignore'), 'utf8').includes('/enterprise/'));

  const featuresPath = require.resolve('../electron/features');
  const originalLoad = Module._load;
  delete require.cache[featuresPath];
  Module._load = function loadWithoutEnterprise(request) {
    if (request === '../enterprise') throw new Error('enterprise intentionally absent');
    return originalLoad.apply(this, arguments);
  };
  try {
    const features = require('../electron/features');
    assert.strictEqual(features.init().loaded, false);
    assert.strictEqual(features.isEnterprise(), false);
    assert.strictEqual(features.enabled('usage_panel'), false);
    assert.strictEqual(features.enabled('audit_log'), false);
    assert.strictEqual(features.edition(), 'community');
    assert.deepStrictEqual(features.snapshot(), {
      edition: 'community', runtimeStatus: 'community', enterprise: false, flags: {}, info: null,
    });
    assert.strictEqual(typeof require('../electron/adapters').get('ollama').start, 'function');
  } finally {
    Module._load = originalLoad;
    delete require.cache[featuresPath];
  }
  const updater = require('../electron/updater');
  assert.strictEqual(updater.shouldEnableUpdates({ isPackaged: true }, { edition: 'community' }), true);
  assert.strictEqual(updater.shouldEnableUpdates({ isPackaged: true }, { edition: 'enterprise' }), false);
  assert.strictEqual(updater.shouldEnableUpdates({ isPackaged: false }, { edition: 'community' }), false);
  console.log('✓ Community contains no proprietary source and falls back cleanly');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
