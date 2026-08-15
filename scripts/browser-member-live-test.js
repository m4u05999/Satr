'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'browser-member-live.html');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assertStaticContract() {
  const html = fs.readFileSync(FIXTURE, 'utf8');
  const appSource = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'app.js'), 'utf8');
  const panelSource = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'components', 'preview-panel.js'), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const suite = fs.readFileSync(path.join(ROOT, 'scripts', 'full-suite.js'), 'utf8');
  assert(html.includes("script-src 'self'") && html.includes("style-src 'self'"), 'fixture بلا CSP صارم');
  assert(!/<script(?![^>]*\bsrc\s*=)[^>]*>|<style\b|\sstyle\s*=|\son[a-z]+\s*=/i.test(html), 'fixture يحوي inline محجوباً');
  assert.strictEqual(packageJson.scripts['test:browser-member-live'], 'electron scripts/browser-member-live-test.js');
  assert(suite.includes("'test:browser-member-live'"), 'الاختبار غير مضاف إلى full-suite');
  assert(appSource.includes("previewEl.addEventListener('agent-screenshot'") && appSource.includes('currentBlock.addScreenshot'), 'القشرة لا تربط لقطة preview ببطاقة الأداة');
  assert(appSource.includes("previewEl.addEventListener('preview-error-wave'") && appSource.includes("chatEl.addActionNotice('ظهرت '"), 'القشرة لا تحول موجة الأخطاء إلى إشعار فعل');
  assert(panelSource.includes("new CustomEvent('preview-fix'") && appSource.includes("previewEl.addEventListener('preview-fix'"), 'زر أصلحه غير مربوط بمسار الإرسال');
  assert(panelSource.includes('control_conflict') && panelSource.includes('flashConflict'), 'لوحة المعاينة لا تستقبل حدث التنازع');
}

async function main() {
  assertStaticContract();
  await app.whenReady();
  const errors = [];
  const win = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) errors.push(String(message)); });
  try {
    await win.loadFile(FIXTURE);
    const deadline = Date.now() + 30000;
    let result = null;
    while (!result && Date.now() < deadline) {
      result = await win.webContents.executeJavaScript('window.__browserMemberResult || null', true);
      if (!result) await delay(50);
    }
    assert(result, 'انتهت مهلة اختبار المتصفح العضو');
    assert.strictEqual(result.pass, true, result.error || 'فشل fixture');
    assert.deepStrictEqual(result.violations, [], 'رُصد خرق CSP');
    assert.deepStrictEqual(errors, [], 'ظهرت أخطاء console');

    // اختبار شارة التنازع (control_conflict) — بثّ اصطناعي بالأسباب الثلاثة
    const conflictResult = await win.webContents.executeJavaScript(`(async () => {
      const panel = document.querySelector('satr-preview-panel');
      const root = panel.shadowRoot;
      const badge = root.getElementById('pvConflictBadge');
      const headButtons = () => Array.from(root.querySelectorAll('.pv-head button'));
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const fire = (reason) => window.satr.__firePreviewEvent({ type: 'control_conflict', reason });
      const isShown = () => badge.classList.contains('show');
      const headButtonsReachable = () => headButtons().every((btn) => {
        const r = btn.getBoundingClientRect();
        const br = badge.getBoundingClientRect();
        if (!isShown() || !br.width) return true;
        return r.bottom <= br.top || r.top >= br.bottom || r.right <= br.left || r.left >= br.right;
      });

      fire('input_changed');
      await wait(50);
      if (!isShown() || badge.textContent !== 'أوقفنا خطوة الوكيل لأنك تفاعلت مع الصفحة — القيادة لك.') {
        throw new Error('شارة التنازع لم تظهر بنص input_changed الصحيح');
      }
      if (!headButtonsReachable()) throw new Error('شارة التنازع حجبت زراً في رأس اللوحة');

      fire('target_changed');
      await wait(50);
      if (!isShown() || badge.textContent !== 'أوقفنا خطوة الوكيل لأن الصفحة تغيّرت منذ لقطتها.') {
        throw new Error('شارة التنازع لم تظهر بنص target_changed الصحيح');
      }

      fire('ref_removed');
      await wait(50);
      if (!isShown() || badge.textContent !== 'أوقفنا خطوة الوكيل لأن الصفحة تغيّرت منذ لقطتها.') {
        throw new Error('شارة التنازع لم تظهر بنص ref_removed الصحيح');
      }
      if (!headButtonsReachable()) throw new Error('شارة التنازع (ref_removed) حجبت زراً في رأس اللوحة');

      fire('input_changed');
      await wait(3800);
      if (!isShown()) throw new Error('شارة التنازع اختفت قبل انقضاء المؤقت المتجدد');
      await wait(800);
      if (isShown()) throw new Error('شارة التنازع لم تختفِ بعد 4 ثوانٍ من آخر حدث');

      return true;
    })()`, true);
    assert.strictEqual(conflictResult, true, 'فشل اختبار شارة التنازع');

    console.log('browser-member-live: نجح — لقطة الأداة، أصلحه، موجة الأخطاء، 🎯، وشارة الخادم، وشارة التنازع.');
  } finally { if (!win.isDestroyed()) win.destroy(); }
}

main().then(() => app.exit(0)).catch((error) => { console.error(error.stack || error); app.exit(1); });
