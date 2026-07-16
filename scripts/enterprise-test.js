#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const path = require('path');

const licensingPath = require.resolve('../enterprise/licensing');
const enterprisePath = require.resolve('../enterprise');
const originalLicensing = require.cache[licensingPath];

require.cache[licensingPath] = {
  id: licensingPath,
  filename: licensingPath,
  loaded: true,
  exports: {
    check: () => ({
      active: true,
      features: ['usage_panel', 'audit_log'],
    }),
    LICENSE_PATH: 'test-license',
  },
};

delete require.cache[enterprisePath];

try {
  const enterprise = require('../enterprise');
  const flags = [];
  const providers = [];
  const channels = [];
  const subscribers = [];

  enterprise.register({
    setFlag: (name, enabled) => flags.push([name, enabled]),
    registerProvider: (name) => providers.push(name),
    registerIpc: (channel) => channels.push(channel),
    subscribe: (handler) => subscribers.push(handler),
  });

  assert.deepStrictEqual(flags, [['usage_panel', true], ['audit_log', true]]);
  assert.deepStrictEqual(providers, []);
  assert.deepStrictEqual(channels, ['satr:ee:usage', 'satr:ee:audit']);
  assert.strictEqual(subscribers.length, 2);
  assert.strictEqual(fs.existsSync(path.join(__dirname, '..', 'enterprise', 'providers', 'ollama.js')), false);

  console.log('✓ Enterprise retains usage and audit registration only');
  console.log('✓ Enterprise does not register Ollama or local_models');
} finally {
  delete require.cache[enterprisePath];
  if (originalLicensing) require.cache[licensingPath] = originalLicensing;
  else delete require.cache[licensingPath];
}

const featuresPath = require.resolve('../electron/features');
const originalLoad = Module._load;
delete require.cache[featuresPath];
Module._load = function loadWithoutEnterprise(request) {
  if (request === '../enterprise') throw new Error('enterprise intentionally absent');
  return originalLoad.apply(this, arguments);
};

try {
  const features = require('../electron/features');
  const state = features.init();
  assert.strictEqual(state.loaded, false);
  assert.strictEqual(features.isEnterprise(), false);
  assert.strictEqual(features.enabled('usage_panel'), false);
  assert.strictEqual(features.enabled('audit_log'), false);
  assert.strictEqual(typeof require('../electron/adapters').get('ollama').start, 'function');
  console.log('✓ Community falls back cleanly without enterprise and keeps Ollama registered');
} finally {
  Module._load = originalLoad;
  delete require.cache[featuresPath];
}
