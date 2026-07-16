#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const claudeauth = require('../electron/claudeauth');

async function main() {
  assert.deepStrictEqual(claudeauth.parseStatus(JSON.stringify({
    loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', ['access' + 'Token']: 'fixture-value',
  })), { checked: true, loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' });
  assert.strictEqual(claudeauth.parseStatus('{bad json'), null);
  assert.strictEqual(claudeauth.parseStatus('{}'), null);

  const envAuth = await claudeauth.probe('missing-command', { env: { ANTHROPIC_API_KEY: 'secret' } });
  assert.deepStrictEqual(envAuth, { checked: true, loggedIn: true, authMethod: 'environment', apiProvider: '' });

  const root = path.resolve(__dirname, '..');
  const mainSource = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8');
  const gateSource = fs.readFileSync(path.join(root, 'src', 'ui', 'components', 'gate.js'), 'utf8');
  const appSource = fs.readFileSync(path.join(root, 'src', 'ui', 'app.js'), 'utf8');
  assert(mainSource.includes('claudeauth.probe') && mainSource.includes('claude.loggedIn = auth.loggedIn'));
  assert(gateSource.includes('claude auth login') && gateSource.includes('r.claude.loggedIn === true'));
  assert(appSource.includes('OAuth session expired') && appSource.includes('claudeAuthErrorMessage'));
  console.log('claude-auth: نجح — كشف تسجيل الخروج بلا أسرار، بوابة login، ورسالة انتهاء OAuth.');
}

main().catch((error) => {
  console.error('claude-auth:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
