#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const STAGE_PREFIX = '.enterprise-stage-';

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertPlainPath(root, candidate, label) {
  const relative = path.relative(root, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`${label} خارج مستودع Community`);
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) break;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && current !== candidate)) {
      throw new Error(`${label} يمر عبر رابط أو مسار غير صالح`);
    }
  }
}

function assertSourceFile(source, relative) {
  let current = source;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`ملف Enterprise لا يجوز أن يكون رابطاً: ${relative}`);
  }
  const resolved = fs.realpathSync.native(current);
  if (!isInside(source, resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`ملف Enterprise خرج من المستودع الخاص: ${relative}`);
  }
  return resolved;
}

function prepareStage({ projectRoot, source, packageFiles, distRoot, copyFile = fs.copyFileSync }) {
  const realProjectRoot = fs.realpathSync.native(projectRoot);
  if (fs.lstatSync(source).isSymbolicLink() || fs.realpathSync.native(source) !== source) {
    throw new Error('مستودع Enterprise تبدل إلى رابط أو مسار آخر');
  }
  const resolvedDist = path.resolve(distRoot);
  assertPlainPath(realProjectRoot, resolvedDist, 'مجلد staging');
  fs.mkdirSync(resolvedDist, { recursive: true });
  assertPlainPath(realProjectRoot, resolvedDist, 'مجلد staging');
  if (fs.realpathSync.native(resolvedDist) !== resolvedDist) {
    throw new Error('مجلد staging يجب أن يكون مساراً حقيقياً داخل مستودع Community');
  }

  const stagePath = fs.mkdtempSync(path.join(resolvedDist, STAGE_PREFIX));
  try {
    for (const relative of packageFiles) {
      const input = assertSourceFile(source, relative);
      const output = path.join(stagePath, ...relative.split('/'));
      fs.mkdirSync(path.dirname(output), { recursive: true });
      copyFile(input, output, fs.constants.COPYFILE_EXCL);
    }
    return stagePath;
  } catch (error) {
    cleanupStage({ projectRoot, distRoot, stagePath });
    throw error;
  }
}

function cleanupStage({ projectRoot, distRoot, stagePath }) {
  if (!stagePath) return;
  const realProjectRoot = fs.realpathSync.native(projectRoot);
  const resolvedDist = path.resolve(distRoot);
  assertPlainPath(realProjectRoot, resolvedDist, 'مجلد staging');
  if (!fs.existsSync(stagePath)) return;
  const relative = path.relative(resolvedDist, stagePath);
  if (path.dirname(relative) !== '.' || !path.basename(stagePath).startsWith(STAGE_PREFIX)) {
    throw new Error('رفض تنظيف مجلد staging غير مملوك');
  }
  const stat = fs.lstatSync(stagePath);
  if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync.native(stagePath) !== stagePath) {
    throw new Error('رفض تنظيف رابط staging أو مسار مستبدل');
  }
  fs.rmSync(stagePath, { recursive: true, force: false });
}

function createStageHooks({
  projectRoot, source, packageFiles, distRoot, fileSet, beforePack, afterPack, verifySource,
}) {
  let stagePath = null;
  let exitHandler = null;
  let busy = false;

  const cleanup = () => {
    if (stagePath) {
      const owned = stagePath;
      stagePath = null;
      cleanupStage({ projectRoot, distRoot, stagePath: owned });
    }
    if (exitHandler) process.removeListener('exit', exitHandler);
    exitHandler = null;
    busy = false;
  };

  return {
    async beforePack(context) {
      if (busy) throw new Error('بناء Enterprise متداخل في إعداد واحد غير مدعوم');
      busy = true;
      try {
        if (beforePack) await beforePack(context);
        if (verifySource) verifySource();
        stagePath = prepareStage({ projectRoot, source, packageFiles, distRoot });
        fileSet.from = stagePath;
        const effectiveFiles = context && context.packager && context.packager.config.files;
        const effectiveFileSet = Array.isArray(effectiveFiles)
          ? effectiveFiles.find((entry) => entry && typeof entry === 'object' && entry.to === fileSet.to)
          : null;
        if (!effectiveFileSet) throw new Error('تعذر تثبيت مسار staging في إعداد electron-builder الفعلي');
        effectiveFileSet.from = stagePath;
        exitHandler = () => cleanup();
        process.once('exit', exitHandler);
      } catch (error) {
        cleanup();
        throw error;
      }
    },
    async afterPack(context) {
      try {
        if (afterPack) await afterPack(context);
      } finally {
        cleanup();
      }
    },
    cleanup,
    currentStage: () => stagePath,
  };
}

module.exports = { STAGE_PREFIX, cleanupStage, createStageHooks, prepareStage };
