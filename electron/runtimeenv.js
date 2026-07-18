'use strict';

const os = require('os');
const { version } = require('../package.json');

function environmentLine(engine, model) {
  const selectedModel = typeof model === 'string' && model.trim() ? model.trim() : 'default';
  return 'بيئة سطر: version=' + version + ' · engine=' + engine + ' · model=' + selectedModel
    + ' · os=' + process.platform + ' ' + os.release() + '.';
}

module.exports = { environmentLine };
