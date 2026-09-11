'use strict';

// خادم HTTPS وأصول PWA ونواة القرائية من الإنتاج؛ لا اقتران أو قراءة لمخزن مستخدم.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const mobilecrypto = require('../electron/mobilecrypto');
const mobiletls = require('../electron/mobiletls');
const { start: createMobileLink } = require('../electron/mobilelink');
function productionReadability() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preview.js'), 'utf8');
  const marker = 'const READABILITY_FN = `';
  const start = src.indexOf(marker);
  if (start < 0) throw new Error('READABILITY_FN غير موجود في الإنتاج.');
  const open = start + marker.length - 1;
  const close = src.indexOf('`;', open + 1);
  if (close < 0) throw new Error('READABILITY_FN غير منتهى.');
  const raw = src.slice(open + 1, close);
  if (raw.includes('${')) throw new Error('نواة القياس تحوي استبدالاً غير متوقع.');
  return new Function('return `' + raw + '`;')();
}

async function sizeForEvidence(win, width, height) {
  win.setContentSize(width, height);
  for (let attempt = 0; attempt < 100; attempt++) {
    const actual = await win.webContents.executeJavaScript('({ width: innerWidth, height: innerHeight })', true);
    if (actual.width === width && actual.height === height) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('لم تستقر أبعاد لقطة التشخيص.');
}



async function testPwaReadability() {
  const { app, BrowserWindow } = require('electron');
  await app.whenReady();
  const tlsMaterial = mobiletls.generateCert('127.0.0.1');
  const previousEnsureCert = mobiletls.ensureCert;
  let link, win;
  const samples = [], failures = [], consoleErrors = [];
  let assets = [];
  const certificateError = (event, contents, url, _error, certificate, callback) => {
    if (!win || contents !== win.webContents) return;
    event.preventDefault();
    let allowed = false;
    try {
      allowed = new URL(url).origin === link.url
        && certificate.data.trim() === tlsMaterial.cert.trim();
    } catch {}
    callback(allowed);
  };
  try {
    // شهادة جديدة في الذاكرة فقط؛ بقية خادم القناة وحصر الامتدادات وMIME هي الإنتاج نفسه.
    try {
      mobiletls.ensureCert = (host) => { assert.equal(host, '127.0.0.1'); return tlsMaterial; };
      link = await createMobileLink({
        crypto: mobilecrypto,
        identity: mobilecrypto.generateKeyPair(),
        pair: { completePairing() { throw new Error('readability must not pair'); }, listDevices: () => [] },
        envelope: require('../electron/mobileenvelope'),
        app: { getAppPath: () => ROOT },
      }, { host: '127.0.0.1', port: 0 });
    } finally { mobiletls.ensureCert = previousEnsureCert; }
    app.on('certificate-error', certificateError);
    win = new BrowserWindow({
      show: false, width: 1000, height: 800,
      webPreferences: {
        contextIsolation: true, sandbox: true, nodeIntegration: false,
        backgroundThrottling: false, partition: 'pwa-readability-' + crypto.randomUUID(),
      },
    });
    win.webContents.session.setCertificateVerifyProc((request, callback) => {
      const exact = request.hostname === '127.0.0.1' && request.certificate.data.trim() === tlsMaterial.cert.trim();
      callback(exact ? 0 : -2);
    });
    win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    win.webContents.session.setPermissionCheckHandler(() => false);
    win.webContents.on('console-message', (_event, level, message) => {
      if (level >= 2) consoleErrors.push(String(message));
    });
    await win.loadURL(link.url + '/');
    const expectedAssets = ['arabic', 'latin'].flatMap(subset => [400, 500, 700].map(weight => {
      const file = 'ibm-plex-sans-arabic-' + subset + '-' + weight + '-normal.woff2';
      const bytes = fs.readFileSync(path.join(ROOT, 'src', 'vendor', 'fonts', file));
      return { file, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
    }));
    assets = await win.webContents.executeJavaScriptInIsolatedWorld(1014, [{ code: '(' + (async function (expected) {
      return Promise.all(expected.map(async asset => {
        const response = await fetch('./fonts/' + asset.file, { cache: 'no-store' });
        const bytes = await response.arrayBuffer();
        const hash = await crypto.subtle.digest('SHA-256', bytes);
        return { file: asset.file, status: response.status, mime: response.headers.get('content-type'),
          size: bytes.byteLength, sha256: Array.from(new Uint8Array(hash)).map(value => value.toString(16).padStart(2, '0')).join('') };
      }));
    }).toString() + ')(' + JSON.stringify(expectedAssets) + ')' }], true);
    for (let index = 0; index < expectedAssets.length; index++) {
      const expected = expectedAssets[index], actual = assets[index];
      if (actual.status !== 200 || actual.mime !== 'font/woff2' || actual.size !== expected.size || actual.sha256 !== expected.sha256) {
        failures.push('asset ' + expected.file + ' status=' + actual.status + ' mime=' + actual.mime + ' bytesMatch=' + (actual.sha256 === expected.sha256));
      }
    }
    const script = productionReadability();
    for (const width of [390, 1000]) {
      await sizeForEvidence(win, width, 800);
      for (const screen of ['pin', 'pair', 'main']) {
        await win.webContents.executeJavaScript('(' + function (name) {
          // عرض هندسي للشاشة الموجودة؛ لا PIN أو نقر أو تزوير حساب أو جلسة.
          for (const element of document.querySelectorAll('.screen')) {
            element.classList.toggle('active', element.id === name + 'Screen');
          }
          document.getElementById('pushSupported').classList.toggle('hidden', name !== 'main');
          document.getElementById('pushUnsupported').classList.add('hidden');
          window.scrollTo(0, 0);
        }.toString() + ')(' + JSON.stringify(screen) + ')', true);
        const actual = await win.webContents.executeJavaScript('({ width: innerWidth, height: innerHeight, active: document.querySelector(".screen.active")?.id })', true);
        assert.equal(actual.width, width, 'pwa-readability: actual width differs before measurement');
        assert.equal(actual.active, screen + 'Screen', 'pwa-readability: requested screen is not active');
        const data = await win.webContents.executeJavaScriptInIsolatedWorld(1013, [{ code: script }], true);
        samples.push({ screen, requestedWidth: width, actual, readability: data });
        const label = screen + '@' + width;
        for (const kind of ['font', 'contrast', 'direction', 'overflow']) {
          if (data.counts[kind] !== 0) failures.push(label + ' ' + kind + '=' + data.counts[kind]);
        }
        if (data.viewport.width !== width) failures.push(label + ' wrong measured width');
        if (data.lang !== 'ar' || data.doc_dir !== 'rtl') failures.push(label + ' document language/direction missing');
        if (data.scanned < 2) failures.push(label + ' insufficient measured text: ' + data.scanned);
        if (data.truncated !== false) failures.push(label + ' truncated=' + data.truncated);
        for (const kind of ['shadow_roots', 'iframes', 'direction']) {
          if (data.unseen[kind] !== 0) failures.push(label + ' unseen.' + kind + '=' + data.unseen[kind]);
        }
        console.log('PWA_READABILITY ' + label + ' actual=' + actual.width + ' counts=' + JSON.stringify(data.counts)
          + ' unseen=' + JSON.stringify(data.unseen) + ' truncated=' + data.truncated);
      }
    }
    const directory = path.join(ROOT, 'dist', 'pwa-readability-test');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'latest.json'), JSON.stringify({
      at: new Date().toISOString(), transport: 'production mobilelink HTTPS', assets, samples, failures, consoleErrors,
      limits: 'نواة الإنتاج في Electron معزول، لا المعاينة ولا قبول هاتف. بطاقات الحالة والإذن المخفية والنصوص غير الدلالية والأزرار خارج القياس.',
    }, null, 2), 'utf8');
    assert.equal(failures.length, 0, 'pwa-readability: ' + failures.join('; '));
    console.log('pwa-readability: PASS 6/6 — production HTTPS; actual widths=390,1000; counts/unseen=0; truncated=false');
    return { samples, failures };
  } finally {
    mobiletls.ensureCert = previousEnsureCert;
    app.removeListener('certificate-error', certificateError);
    if (win && !win.isDestroyed()) win.destroy();
    if (link) await link.stop();
  }
}

module.exports = { testPwaReadability };
if (require.main === module || (process.argv[1] && path.resolve(process.argv[1]) === __filename)) {
  const { app } = require('electron');
  const profile = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'satr-pwa-readability-'));
  app.setPath('userData', profile);
  app.setPath('sessionData', profile);
  console.log('pwa-readability: starting isolated profile');
  const timeout = setTimeout(() => { console.error('pwa-readability: timeout'); app.exit(1); }, 30000);
  app.disableHardwareAcceleration();
  testPwaReadability().then(() => { clearTimeout(timeout); app.exit(0); }).catch(error => {
    clearTimeout(timeout); console.error(error && error.stack || error); app.exit(1);
  });
}
