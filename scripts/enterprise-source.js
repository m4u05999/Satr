#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const CONTRACT_VERSION = 1;
const MANIFEST_NAME = 'satr-enterprise.json';
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SAFE_PACKAGE_FILE = /^(?!\.)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error(`تعذر قراءة عقد Enterprise: ${file}`); }
}

function resolveEnterpriseSource(value, options = {}) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('اضبط SATR_ENTERPRISE_DIR على المسار المطلق للمستودع الخاص');
  }
  if (!path.isAbsolute(value)) throw new Error('يجب أن يكون SATR_ENTERPRISE_DIR مساراً مطلقاً');

  let source;
  try { source = fs.realpathSync.native(path.resolve(value)); }
  catch { throw new Error('مستودع Enterprise غير موجود'); }

  const projectRoot = path.resolve(options.projectRoot || PROJECT_ROOT);
  if (isInside(projectRoot, source)) {
    throw new Error('يجب أن يبقى مستودع Enterprise خارج مستودع Community');
  }

  const manifestPath = path.join(source, MANIFEST_NAME);
  const manifest = readJson(manifestPath);
  if (manifest.name !== '@satr/enterprise' || manifest.contractVersion !== CONTRACT_VERSION || manifest.main !== 'index.js') {
    throw new Error(`عقد Enterprise غير متوافق؛ المطلوب contractVersion=${CONTRACT_VERSION}`);
  }

  if (!Array.isArray(manifest.packageFiles) || !manifest.packageFiles.length
      || manifest.packageFiles.some((file) => typeof file !== 'string' || !SAFE_PACKAGE_FILE.test(file))) {
    throw new Error('قائمة packageFiles في عقد Enterprise غير صالحة');
  }
  const packageFiles = [...new Set(manifest.packageFiles)];
  if (!packageFiles.includes(manifest.main) || !packageFiles.includes('LICENSE')) {
    throw new Error('يجب أن تضم packageFiles نقطة الدخول والرخصة التجارية');
  }

  for (const required of packageFiles) {
    const file = path.join(source, required);
    let stat;
    try { stat = fs.statSync(file); } catch { stat = null; }
    if (!stat || !stat.isFile()) throw new Error(`ملف Enterprise مطلوب ومفقود: ${required}`);
  }

  return { source, manifest: { ...manifest, packageFiles }, manifestPath };
}

module.exports = { CONTRACT_VERSION, MANIFEST_NAME, PROJECT_ROOT, resolveEnterpriseSource };
