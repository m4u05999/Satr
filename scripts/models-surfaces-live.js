'use strict';
// تجربة نقر على واجهة الإنتاج وطبقة المتصفح الأصلية في منزل مستقل، بلا أدوار مدفوعة.
const fs = require('fs'), path = require('path'), http = require('http'), assert = require('assert');
const { spawn } = require('child_process');
const core = require('./lib/live-test-run');
const { connectMain } = require('./lib/live-test-client');
const { completionExitCode } = require('./live-test');
const repo = path.resolve(__dirname, '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
async function main() {
  const [action, id] = process.argv.slice(2);
  if (action === 'prepare') {
    const run = core.prepareRun(repo, {});
    const dir = path.join(run.paths.root, 'models-surfaces'); fs.mkdirSync(dir);
    write(path.join(dir, 'criteria.json'), { time: new Date().toISOString(), mode: 'source', budgetMinutes: 20,
      maxAttemptsPerFailure: 2, paidTurns: 0,
      pass: 'تظهر الأسطح فوق المعاينة والطرفية، حدود العرض الأصلية صفر طوال فتحها وتستعاد عند إغلاقها بلا تغيير الصفحة.',
      fail: 'حدود العرض غير صفر تحت سطح مفتوح أو لا تعود بعد إغلاقه.',
      limits: ['لا تسجيل ولا قبول بشري.', 'الفحص البصري للمصدر؛ لا يثبت تشغيل الحزمة.', 'البوابة المعزولة لا تحمل اعتماد المالك؛ تُخفى لتجربة التبويبات فقط.'] });
    console.log(JSON.stringify({ id: run.id })); return;
  }
  const run = core.loadRun(repo, id), dir = path.join(run.paths.root, 'models-surfaces');
  assert(fs.existsSync(dir), 'experiment_not_prepared');
  if (action === 'launch') {
    const server = http.createServer((_req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>تجربة التبويبات</title></head><body><h1>صفحة اختبار التبويبات</h1><p>هذه الصفحة المحلية تبقى مفتوحة أثناء عرض إعدادات سطر.</p></body></html>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    write(path.join(dir, 'page.json'), { url: 'http://127.0.0.1:' + server.address().port });
    const child = spawn(require('electron'), [path.join(__dirname, 'models-surfaces-live-launch.js'), id, '--live-debug'],
      { cwd: repo, env: core.buildChildEnv(process.env, run), stdio: 'inherit', shell: false });
    child.once('error', () => { server.close(); process.exitCode = 1; });
    child.once('exit', code => { server.close(); process.exitCode = completionExitCode(repo, id, code); });
    return;
  }
  assert(['verify', 'setup'].includes(action), 'bad_action');
  const client = await connectMain(repo, id);
  const results = [];
  const url = JSON.parse(fs.readFileSync(path.join(dir, 'page.json'))).url;
  const native = () => JSON.parse(fs.readFileSync(path.join(dir, 'native.json')));
  async function until(test, label) {
    const end = Date.now() + 8000;
    while (Date.now() < end) { try { if (await test()) return; } catch {} await pause(80); }
    throw Error('timeout: ' + label);
  }
  async function click(id) {
    const state = await client.evaluate('(()=>{const e=document.getElementById(' + JSON.stringify(id) + ');return {exists:!!e,visible:!!e&&e.checkVisibility(),disabled:!!e&&e.disabled}})()');
    assert(state.exists && state.visible && !state.disabled, 'button_not_interactive: ' + id);
    await client.evaluate('document.getElementById(' + JSON.stringify(id) + ').click()');
  }
  async function held(expected, label) {
    await until(() => {
      const n = native(); return n.views.length === 1 && n.views.every(v => v.url.replace(/\/$/, '') === url) && n.views.every(v => expected ? v.bounds.width === 0 || v.bounds.height === 0 : v.bounds.width > 100 && v.bounds.height > 50);
    }, label);
    const n = native();
    assert(n.views.every(v => v.url.replace(/\/$/, '') === url), 'preview_page_changed');
    const layout = await client.evaluate('({ scrollX, width: innerWidth, scrollWidth: document.documentElement.scrollWidth, left: document.documentElement.getBoundingClientRect().left })');
    assert.equal(layout.scrollX, 0, 'document_scrolled_sideways: ' + label);
    assert.equal(layout.left, 0, 'document_shifted: ' + label);
    assert(layout.scrollWidth <= layout.width + 1, 'document_overflow: ' + label);
    results.push({ label, native: n, layout });
  }
  async function shot(name) {
    name += '-' + (process.argv[5] || 'final');
    name += Number(process.argv[4]) === 1000 ? '-narrow' : Number(process.argv[4]) === 1440 ? '-wide' : '-normal';
    write(path.join(dir, 'shot-request.json'), { name });
    await until(() => fs.existsSync(path.join(dir, name + '.png')), 'screenshot ' + name);
  }
  try {
    write(path.join(dir, 'window-request.json'), { id: Date.now(), width: Number(process.argv[4]) || 1180 });
    await until(() => native().focused && native().bounds.width === (Number(process.argv[4]) || 1180), 'window-foreground-and-size');
    await until(() => client.evaluate('!!customElements.get("satr-preview-panel") && !!document.querySelector("satr-preview-panel").openWith'), 'components');
    await client.evaluate('(()=>{document.querySelector("satr-gate").hidden=true;document.getElementById("cwd").value=' + JSON.stringify(run.paths.workspace) + ';document.getElementById("cwd").dispatchEvent(new Event("change",{bubbles:true}));return true})()');
    await client.evaluate('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
    await client.evaluate('document.querySelector("satr-preview-panel").openWith(' + JSON.stringify(url) + ')');
    await held(false, 'initial-browser');
    await client.evaluate('(()=>{if(document.getElementById("termPanel").hidden)document.getElementById("termToggle").click()})()');
    assert(await client.evaluate('!document.getElementById("termPanel").hidden'), 'terminal_not_open');
    await held(false, 'browser-and-terminal');
    if (action === 'setup') { await shot('ready'); return; }
    for (const [button, pop] of [['settingsBtn','settingsPop'],['shortcutsToggle','shortcutsPop'],['sessionChangesToggle','sessionChangesPop']]) {
      if (button !== 'settingsBtn') await client.evaluate('(()=>{if(document.getElementById("topTools").hidden)document.getElementById("topMore").click()})()');
      await click(button);
      assert(await client.evaluate('!document.getElementById(' + JSON.stringify(pop) + ').hidden'), 'popup_not_open');
      await held(true, pop + '-open');
      if (button === 'settingsBtn') await shot('settings-over-browser');
      await client.evaluate('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
      await held(false, pop + '-escape');
    }
    await click('settingsBtn');
    await client.evaluate('document.getElementById("notesDialog").hidden=false');
    await click('settingsClose');
    await held(true, 'another-dialog-remains');
    await client.evaluate('document.getElementById("notesDialog").hidden=true');
    await held(false, 'all-overlays-closed');
    await client.evaluate('document.querySelector("satr-preview-panel").close()');
    await until(() => native().views.length === 0, 'destroy-preview');
    await click('settingsBtn');
    await client.evaluate('document.querySelector("satr-preview-panel").openWith(' + JSON.stringify(url) + ')');
    await held(true, 'reopen-preview-under-settings');
    await click('settingsClose');
    await held(false, 'reopened-preview-restored');
    await shot('restored');
    write(path.join(dir, 'verified-' + (Number(process.argv[4]) || 1180) + '-' + (process.argv[5] || 'final') + '.json'), { pass: true, checks: results.length, time: new Date().toISOString(), results });
    console.log(JSON.stringify({ pass: true, checks: results.length, evidence: dir }));
  } catch (error) {
    write(path.join(dir, 'failed-' + Date.now() + '.json'), { message: error.message, results });
    throw error;
  } finally { client.close(); }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
