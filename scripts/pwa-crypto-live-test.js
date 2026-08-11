/**
 * سطر — اختبار حي لتوافق طبقة التعمية PWA مع mobilecrypto.js
 *
 * يحمّل pwa/crypto.js في Chromium حقيقي (Electron) ويتحقق من أن WebCrypto
 * يعيد إنتاج عقد التوافق البايتي في scripts/fixtures/mobilecrypto-vectors.json.
 *
 * التشغيل: electron scripts/pwa-crypto-live-test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const CRYPTO_JS = path.join(ROOT, 'pwa', 'crypto.js');
const VECTORS_PATH = path.join(__dirname, 'fixtures', 'mobilecrypto-vectors.json');
const TIMEOUT_MS = 30000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function injectScript(win, filePath) {
  const code = fs.readFileSync(filePath, 'utf8');
  await win.webContents.executeJavaScript(code, true);
}

async function waitForSatrCrypto(win) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const ok = await win.webContents.executeJavaScript('!!window.SatrCrypto', true);
    if (ok) return;
    await delay(50);
  }
  throw new Error('انتهت مهلة تحميل SatrCrypto.');
}

async function runVectorTests(win, vectors) {
  return win.webContents.executeJavaScript(`
    (async () => {
      const v = window.VECTORS;
      const c = window.SatrCrypto;
      const dec = new TextDecoder();

      try {
        // 1) اشتقاق الجلستين من المفاتيح الثابتة
        const d = await c.deriveSession({
          myPrivate: v.keys.desktop_private,
          myPublic: v.keys.desktop_public,
          theirPublic: v.keys.mobile_public,
          pairId: v.pair_id,
          role: 'desktop'
        });
        const m = await c.deriveSession({
          myPrivate: v.keys.mobile_private,
          myPublic: v.keys.mobile_public,
          theirPublic: v.keys.desktop_public,
          pairId: v.pair_id,
          role: 'mobile'
        });

        // لا نستطيع تصدير مفاتيح AES، لذا نثبت التوافق عبر فكّ الإطارات وإعادة الختم
        for (const entry of v.frames) {
          const receiver = entry.direction === 'd2m' ? m : d;
          const plain = await c.open(receiver, c.base64urlToBytes(entry.frame_b64url));
          const text = dec.decode(plain);
          if (text !== entry.plaintext_utf8) {
            throw new Error('فكّ الإطار لا يطابق النص المتوقع: ' + entry.note);
          }
        }

        // 2) إعادة ختم النصوص المعروفة والمقارنة بايتياً
        const d2 = await c.deriveSession({
          myPrivate: v.keys.desktop_private,
          myPublic: v.keys.desktop_public,
          theirPublic: v.keys.mobile_public,
          pairId: v.pair_id,
          role: 'desktop'
        });
        for (const entry of v.frames) {
          if (entry.direction !== 'd2m') continue;
          const frame = await c.seal(d2, entry.plaintext_utf8);
          const expected = c.base64urlToBytes(entry.frame_b64url);
          if (frame.length !== expected.length) {
            throw new Error('طول الإطار المُعاد ختمه لا يطابق المتوقع: ' + entry.note);
          }
          for (let i = 0; i < frame.length; i += 1) {
            if (frame[i] !== expected[i]) {
              throw new Error('بايت ' + i + ' مختلف في الإطار: ' + entry.note);
            }
          }
        }

        const m2 = await c.deriveSession({
          myPrivate: v.keys.mobile_private,
          myPublic: v.keys.mobile_public,
          theirPublic: v.keys.desktop_public,
          pairId: v.pair_id,
          role: 'mobile'
        });
        for (const entry of v.frames) {
          if (entry.direction !== 'm2d') continue;
          const frame = await c.seal(m2, entry.plaintext_utf8);
          const expected = c.base64urlToBytes(entry.frame_b64url);
          if (frame.length !== expected.length) {
            throw new Error('طول إطار الجوال لا يطابق: ' + entry.note);
          }
          for (let i = 0; i < frame.length; i += 1) {
            if (frame[i] !== expected[i]) {
              throw new Error('بايت ' + i + ' مختلف في إطار الجوال: ' + entry.note);
            }
          }
        }

        // 3) SAS متطابق
        const sas = await c.sas({
          desktopPublic: v.keys.desktop_public,
          mobilePublic: v.keys.mobile_public,
          pairId: v.pair_id
        });
        if (sas !== v.sas.expected) {
          throw new Error('SAS لا يطابق: ' + sas + ' ≠ ' + v.sas.expected);
        }

        return { pass: true };
      } catch (err) {
        return { pass: false, error: err && err.message ? err.message : String(err) };
      }
    })()
  `, true);
}

async function main() {
  assert(fs.existsSync(CRYPTO_JS), 'pwa/crypto.js غير موجود');
  assert(fs.existsSync(VECTORS_PATH), 'vectors غير موجود');

  const vectors = JSON.parse(fs.readFileSync(VECTORS_PATH, 'utf8'));

  await app.whenReady();
  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      allowRunningInsecureContent: false
    }
  });

  try {
    await win.loadFile(path.join(ROOT, 'pwa', 'index.html'));
    await win.webContents.executeJavaScript(`window.VECTORS = ${JSON.stringify(vectors)};`, true);
    await waitForSatrCrypto(win);

    const result = await runVectorTests(win, vectors);
    if (!result || !result.pass) {
      throw new Error('فشل اختبار التوافق البايتي: ' + (result && result.error));
    }

    console.log('pwa-crypto-live-test: نجح — WebCrypto يعيد إنتاج mobilecrypto بايتاً ببايت');
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

main().then(() => app.exit(0)).catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  app.exit(1);
});
