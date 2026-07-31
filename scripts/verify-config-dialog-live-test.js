// اختبار Chromium حيّ لمعالج .satr/verify.json: مراجعة قبل الكتابة + تأكيد استبدال مستقل + CSP.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const skillwriter = require('../electron/skillwriter');
const skills = require('../electron/skills');

const FIXTURE = path.join(__dirname, 'fixtures', 'verify-config-dialog-live.html');
const TIMEOUT_MS = 30000;

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function assertFixtureContract() {
  const source = fs.readFileSync(FIXTURE, 'utf8');
  const component = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'components', 'verify-config-dialog.js'), 'utf8');
  assert(source.includes('../../src/styles/base.css'), 'fixture لا يستورد base.css الحقيقي.');
  assert(source.includes('../../src/ui/components/verify-config-dialog.js'), 'fixture لا يستورد المكوّن الحقيقي.');
  assert(!/<script(?![^>]*\bsrc\s*=)[^>]*>/i.test(source), 'fixture يحوي script مضمّناً.');
  assert(!component.includes('innerHTML'), 'المكوّن يستعمل innerHTML.');
  assert(!/<style\b|\.style\b|setAttribute\(\s*['"]style['"]/i.test(component), 'المكوّن يستعمل نمطاً مضمّناً.');
}

function assertSkillwriterContract() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-skillwriter-'));
  const project = path.join(sandbox, 'project');
  const outside = path.join(sandbox, 'outside');
  fs.mkdirSync(project); fs.mkdirSync(outside);
  const baseSkill = {
    name: 'quality-review',
    description: 'يراجع جودة التغيير وفق معايير المشروع.',
    criteria: '# معايير المراجعة\n\n- افحص الصحة.\n- افحص الأمان.',
  };
  try {
    assert.strictEqual(skillwriter.createSkill(project, baseSkill, { overwrite: false }).error, 'confirmation_required');
    assert(!fs.existsSync(path.join(project, '.agents')), 'كتب الكاتب قبل التأكيد الصريح.');
    assert.strictEqual(skillwriter.createSkill(project, { ...baseSkill, name: '../escape' }, { confirmed: true, overwrite: false }).error, 'bad_name');
    assert.strictEqual(skillwriter.createSkill(project, { ...baseSkill, name: '..' }, { confirmed: true, overwrite: false }).error, 'bad_name');
    assert.strictEqual(skillwriter.createSkill(project, { ...baseSkill, criteria: 'x'.repeat(skillwriter.MAX_CRITERIA_BYTES + 1) }, { confirmed: true, overwrite: false }).error, 'bad_criteria');
    assert.strictEqual(skillwriter.createSkill(project, { ...baseSkill, criteria: 'api_key=abcdefghijklmnop-secret' }, { confirmed: true, overwrite: false }).error, 'secret');

    const originalRename = fs.renameSync;
    const renames = [];
    fs.renameSync = (source, target) => { renames.push([source, target]); return originalRename(source, target); };
    let created;
    try {
      created = skillwriter.createSkill(project, { ...baseSkill, criteria: baseSkill.criteria + '\u202E\u0001' }, { confirmed: true, overwrite: false });
    } finally {
      fs.renameSync = originalRename;
    }
    assert(created.ok && created.created === true && renames.length === 1, 'لم تستخدم الكتابة الجديدة temp+rename ذرية.');
    const target = path.join(project, '.agents', 'skills', baseSkill.name, 'SKILL.md');
    const firstSource = fs.readFileSync(target, 'utf8');
    assert(!/[\u0000-\u0009\u000B-\u001F\u007F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/.test(firstSource), 'بقيت محارف تحكم أو Bidi في المخرج.');
    assert(firstSource.endsWith(baseSkill.criteria + '\n'), 'جسم SKILL.md لا يساوي نص المعايير المنقّى.');
    const discovered = skills.discoverSkills(project, {
      home: path.join(sandbox, 'empty-home'), builtinRoot: path.join(sandbox, 'empty-builtin'),
    });
    assert(discovered.some((skill) => skill.name === baseSkill.name && skill.description === baseSkill.description),
      'لم يكتشف skills.discoverSkills المخرج بالاسم والوصف نفسيهما.');
    assert.strictEqual(skillwriter.createSkill(project, baseSkill, { confirmed: true, overwrite: false }).error, 'exists');

    let injectedFailure = false;
    fs.renameSync = (source, destination) => {
      if (!injectedFailure && source.endsWith('.tmp') && destination === target) {
        injectedFailure = true;
        throw new Error('injected rename failure');
      }
      return originalRename(source, destination);
    };
    let failedOverwrite;
    try {
      failedOverwrite = skillwriter.createSkill(project, { ...baseSkill, criteria: '# محتوى جديد' }, { confirmed: true, overwrite: true });
    } finally {
      fs.renameSync = originalRename;
    }
    assert.strictEqual(failedOverwrite.error, 'write_failed');
    assert.strictEqual(fs.readFileSync(target, 'utf8'), firstSource, 'لم يستعد الكاتب الملف السابق بعد فشل rename.');
    assert(!fs.readdirSync(path.dirname(target)).some((name) => name.endsWith('.tmp') || name.endsWith('.bak')),
      'ترك الكاتب ملف temp أو backup بعد الفشل.');

    const overwriteRenames = [];
    fs.renameSync = (source, destination) => {
      overwriteRenames.push([source, destination]);
      return originalRename(source, destination);
    };
    let overwritten;
    try {
      overwritten = skillwriter.createSkill(project, { ...baseSkill, criteria: '# معايير محدّثة' }, { confirmed: true, overwrite: true });
    } finally {
      fs.renameSync = originalRename;
    }
    assert(overwritten.ok && overwritten.overwritten === true && overwritten.created === false && overwriteRenames.length === 2,
      'لم ينفذ الكاتب الاستبدال المؤكد بنقل الهدف ثم الملف المؤقت.');
    assert(fs.readFileSync(target, 'utf8').endsWith('# معايير محدّثة\n'), 'لم يكتب الكاتب جسم المعايير المحدّث.');
    assert(!fs.readdirSync(path.dirname(target)).some((name) => name.endsWith('.tmp') || name.endsWith('.bak')),
      'ترك الكاتب ملف temp أو backup بعد الاستبدال الناجح.');

    const junctionProject = path.join(sandbox, 'junction-project');
    fs.mkdirSync(junctionProject);
    fs.symlinkSync(outside, path.join(junctionProject, '.agents'), 'junction');
    const junctionResult = skillwriter.createSkill(junctionProject, baseSkill, { confirmed: true, overwrite: false });
    assert.strictEqual(junctionResult.error, 'symlink');
    assert(!Object.hasOwn(junctionResult, 'path'), 'كشف رفض الرابط مساراً خارجياً.');

    const escapedProject = path.join(sandbox, 'escaped-project');
    fs.mkdirSync(escapedProject);
    const originalRealpath = fs.realpathSync;
    fs.realpathSync = (candidate) => path.resolve(candidate) === path.join(escapedProject, '.agents')
      ? outside : originalRealpath(candidate);
    let escaped;
    try {
      escaped = skillwriter.createSkill(escapedProject, baseSkill, { confirmed: true, overwrite: false });
    } finally {
      fs.realpathSync = originalRealpath;
    }
    assert.strictEqual(escaped.error, 'outside');
    assert(!Object.hasOwn(escaped, 'path'), 'كشف رفض الخروج مساراً خارجياً.');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

async function waitForResult(win) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await win.webContents.executeJavaScript('window.__verifyConfigResult || null', true);
    if (result) return result;
    await delay(50);
  }
  const progress = await win.webContents.executeJavaScript('window.__verifyConfigProgress || "unknown"', true);
  throw new Error('انتهت مهلة اختبار معالج التحقق؛ المرحلة: ' + progress);
}

async function main() {
  assertFixtureContract();
  assertSkillwriterContract();
  await app.whenReady();
  const consoleErrors = [];
  const win = new BrowserWindow({
    show: false, width: 960, height: 820,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2 || /securitypolicyviolation|content security policy|uncaught|unhandled/i.test(String(message))) {
      consoleErrors.push(String(message));
    }
  });
  try {
    await win.loadFile(FIXTURE);
    const result = await waitForResult(win);
    assert.strictEqual(result.pass, true, result.error || 'فشل اختبار المعالج داخل الصفحة.');
    assert.deepStrictEqual(consoleErrors, [], 'ظهرت أخطاء console أثناء اختبار المعالج.');
    console.log('verify-config-dialog-live: نجح — الكاتب الآمن، اكتشاف المهارة، مراجعة JSON، رفض المدخلات والسر، تأكيدا الاستبدال، صفر CSP.');
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

main().then(() => app.quit()).catch((error) => {
  console.error('verify-config-dialog-live:', error && error.stack ? error.stack : error);
  app.exit(1);
});
