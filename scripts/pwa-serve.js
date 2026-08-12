'use strict';
/**
 * خادم ثابت صغير لتطبيق الجوال (‏pwa/) — للتجربة المحلية على شبكة واحدة.
 *
 * القناة (‏electron/mobilelink.js) تخدم عقد الاقتران/الاستقصاء/الردّ فقط، لا
 * الملفات الثابتة. هذا الخادم يخدم `pwa/` كي يفتحه الجوال من المتصفح. صفر
 * اعتماديات (‏http المدمجة)، ويستمع على كل الواجهات ليصله الجوال على الشبكة نفسها.
 *
 * التشغيل: node scripts/pwa-serve.js [منفذ]
 * ملاحظة أمنية: أداة تطوير محلية — لا تشغّلها على شبكة عامة غير موثوقة.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(path.resolve(__dirname, '..'), 'pwa');
const PORT = Number(process.argv[2]) || 8790;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** يمنع الخروج من مجلد pwa/ (‏traversal) — المسار يُحلّ ويُتحقق أنه داخل الجذر. */
function safePath(urlPath) {
  const clean = decodeURIComponent((urlPath || '/').split('?')[0]);
  const rel = clean === '/' ? 'index.html' : clean.replace(/^\/+/, '');
  const full = path.resolve(ROOT, rel);
  const root = path.resolve(ROOT);
  return full === root || full.startsWith(root + path.sep) ? full : null;
}

/**
 * صفحة فحص «السياق الآمن» — عطل مثبت حياً (2026-08-12): WebCrypto
 * (‏`crypto.subtle`) **غير موجود** خارج السياق الآمن، فأي تشغيل عبر HTTP على
 * عنوان شبكة يجعل الاقتران مستحيلاً بنيوياً. هذه الصفحة تُظهر الحقيقة بلا لبس.
 */
const CHECK_PAGE = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>فحص السياق الآمن</title>
<style>body{font-family:system-ui;background:#111;color:#eee;padding:24px;line-height:2}
b{font-size:1.4em}.ok{color:#5f5}.no{color:#f66}code{direction:ltr;display:inline-block}</style></head>
<body><h2>فحص السياق الآمن</h2>
<div>العنوان: <code id=u></code></div>
<div>سياق آمن (isSecureContext): <b id=s></b></div>
<div>WebCrypto (crypto.subtle): <b id=c></b></div>
<div id=t style="margin-top:18px"></div>
<script>
document.getElementById('u').textContent = location.origin;
const sec = window.isSecureContext, sub = !!(window.crypto && window.crypto.subtle);
const put=(id,v)=>{const e=document.getElementById(id);e.textContent=v?'نعم ✓':'لا ✗';e.className=v?'ok':'no';};
put('s',sec); put('c',sub);
if (sub) {
  crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits'])
    .then(()=>{document.getElementById('t').innerHTML='<b class=ok>توليد المفاتيح نجح — الاقتران ممكن على هذا العنوان.</b>';})
    .catch(e=>{document.getElementById('t').innerHTML='<b class=no>فشل التوليد: '+e.message+'</b>';});
} else {
  document.getElementById('t').innerHTML='<b class=no>المتصفح يحجب WebCrypto هنا — يلزم HTTPS.</b>';
}
</script></body></html>`;

const handler = (req, res) => {
  if ((req.url || '').split('?')[0] === '/check') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(CHECK_PAGE);
    return;
  }
  const file = safePath(req.url);
  if (!file) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store', // تجربة حيّة: لا نريد نسخة قديمة في الجوال
    });
    res.end(buf);
  });
};

// HTTPS إن توفّرت شهادة محلية (dist/mobile-tls) — لازمة لأن WebCrypto محجوب
// خارج السياق الآمن؛ وإلا HTTP عادي (يكفي لفحص /check فقط).
const TLS_DIR = path.join(path.resolve(__dirname, '..'), 'dist', 'mobile-tls');
let server = null;
let scheme = 'http';
try {
  const key = fs.readFileSync(path.join(TLS_DIR, 'key.pem'));
  const cert = fs.readFileSync(path.join(TLS_DIR, 'cert.pem'));
  server = require('node:https').createServer({ key, cert }, handler);
  scheme = 'https';
} catch (e) {
  server = http.createServer(handler);
}

// العنوان الذي يخرج منه النظام فعلاً — يتخطى محوّلات WSL/Hyper-V الافتراضية
function outbound() {
  return new Promise((resolve) => {
    let done = false;
    const sock = require('node:dgram').createSocket('udp4');
    const finish = (v) => { if (done) return; done = true; try { sock.close(); } catch (e) {} resolve(v); };
    const timer = setTimeout(() => finish(null), 700);
    if (timer.unref) timer.unref();
    sock.on('error', () => { clearTimeout(timer); finish(null); });
    try {
      sock.connect(53, '8.8.8.8', () => {
        let a = null;
        try { a = sock.address() && sock.address().address; } catch (e) { a = null; }
        clearTimeout(timer);
        finish(a && a !== '0.0.0.0' ? a : null);
      });
    } catch (e) { clearTimeout(timer); finish(null); }
  });
}

server.listen(PORT, '0.0.0.0', async () => {
  const ip = (await outbound()) || '127.0.0.1';
  console.log('تطبيق الجوال يُخدم من: ' + ROOT);
  console.log('افتح على الجوال:  ' + scheme + '://' + ip + ':' + PORT + '/');
  console.log('فحص السياق الآمن:  ' + scheme + '://' + ip + ':' + PORT + '/check');
  const alt = [];
  try {
    const ifs = os.networkInterfaces();
    for (const n of Object.keys(ifs)) {
      for (const i of ifs[n] || []) {
        if (i && i.family === 'IPv4' && !i.internal && i.address !== ip) alt.push(i.address + ' [' + n + ']');
      }
    }
  } catch (e) { /* اختياري */ }
  if (alt.length) console.log('عناوين أخرى (غالباً محوّلات افتراضية لا يصلها الجوال): ' + alt.join('، '));
  console.log('أوقفه بـ Ctrl+C.');
});
