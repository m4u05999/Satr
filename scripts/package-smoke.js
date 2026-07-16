#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');

const asar = path.resolve(process.argv[2] || '');
const expectedVersion = String(process.argv[3] || '');
assert(asar && expectedVersion, 'usage: package-smoke <app.asar> <version>');

const pkg = require(path.join(asar, 'package.json'));
const testsprite = require(path.join(asar, 'electron', 'testsprite.js'));
const claudeauth = require(path.join(asar, 'electron', 'claudeauth.js'));
require(path.join(asar, 'node_modules', 'node-pty'));

assert.strictEqual(pkg.version, expectedVersion);
assert.strictEqual(testsprite.requested('أنا أريد إختبار .', { available: true }), true);
assert.strictEqual(claudeauth.parseStatus(JSON.stringify({ loggedIn: false, authMethod: 'none' })).loggedIn, false);

console.log(JSON.stringify({ version: pkg.version, testspriteIntent: true, claudeAuthGate: true, nodePty: true }));
