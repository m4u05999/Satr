#!/usr/bin/env node
'use strict';

const harness = require('../electron/testspriteharness');

function startCli() {
  const port = harness.parsePort(process.argv.slice(2), process.env);
  const server = harness.createHarnessServer();
  server.listen(port, harness.HOST, () => {
    console.log(`TestSprite harness: http://${harness.HOST}:${port}`);
    console.log('واجهة Web بمحاكاة preload فقط؛ لا تغطي Electron/IPC/PTY الحقيقي.');
  });
  const close = () => server.close(() => process.exit(0));
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
}

if (require.main === module) startCli();

module.exports = harness;
