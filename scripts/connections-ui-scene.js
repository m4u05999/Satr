// مشهد محلي محصور بملفات واجهة التوصيلات؛ لا يقرأ حسابات المستخدم أو أسراره.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
const ASSETS = new Map([
  ['/', 'scripts/fixtures/connections-ui.html'],
  ['/scripts/fixtures/connections-ui.html', 'scripts/fixtures/connections-ui.html'],
  ['/scripts/fixtures/connections-ui.css', 'scripts/fixtures/connections-ui.css'],
  ['/scripts/fixtures/connections-ui.js', 'scripts/fixtures/connections-ui.js'],
  ['/src/styles/base.css', 'src/styles/base.css'],
  ['/src/vendor/fonts.css', 'src/vendor/fonts.css'],
  ['/src/ui/lib/sheet.js', 'src/ui/lib/sheet.js'],
  ['/src/ui/lib/text-dir.js', 'src/ui/lib/text-dir.js'],
  ['/src/ui/lib/panel.css.js', 'src/ui/lib/panel.css.js'],
  ['/src/ui/components/connection-view.js', 'src/ui/components/connection-view.js'],
  ['/src/ui/components/mcp-panel.js', 'src/ui/components/mcp-panel.js'],
]);
for (const name of fs.readdirSync(path.join(ROOT, 'src/vendor/fonts'))) {
  if (/^ibm-plex-sans-arabic-(?:arabic|latin)-(?:400|500|700)-normal\.woff2$/.test(name)) {
    ASSETS.set('/src/vendor/fonts/' + name, 'src/vendor/fonts/' + name);
  }
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.woff2': 'font/woff2' };

async function startScene({ port = 4186 } = {}) {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
    let pathname;
    try { pathname = new URL(req.url, 'http://127.0.0.1').pathname; } catch { res.writeHead(400); res.end(); return; }
    const file = ASSETS.get(pathname);
    if (!file) { res.writeHead(404); res.end(); return; }
    fs.readFile(path.join(ROOT, file), (error, data) => {
      if (error) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)], 'Content-Length': data.length });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    server,
    url: 'http://127.0.0.1:' + server.address().port + '/',
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

module.exports = { startScene };
if (require.main === module) {
  startScene().then(({ url }) => console.log('مشهد توصيلات تجريبي: ' + url)).catch((error) => {
    console.error('تعذر تشغيل المشهد: ' + error.code);
    process.exitCode = 1;
  });
}
