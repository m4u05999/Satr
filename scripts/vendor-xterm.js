/**
 * تضمين (vendoring) xterm.js في src/vendor للواجهة
 *
 * الواجهة صفر اعتماديات npm وقت التشغيل (القاعدة 5 في CLAUDE.md) — لذا لا نحمّل
 * xterm.js من node_modules بل ننسخ ملفَي التوزيع (lib/xterm.js و css/xterm.css)
 * من devDependency ‏@xterm/xterm إلى src/vendor/ والناتج يُلتزَم في git.
 *
 * يُشغَّل يدوياً فقط عند ترقية إصدار xterm.js:
 *     node scripts/vendor-xterm.js
 */
const fs = require('fs');
const path = require('path');

const nm = path.join(__dirname, '..', 'node_modules', '@xterm');
const outDir = path.join(__dirname, '..', 'src', 'vendor');

const copies = [
  ['xterm', path.join(nm, 'xterm', 'lib', 'xterm.js'), path.join(outDir, 'xterm.js')],
  ['xterm', path.join(nm, 'xterm', 'css', 'xterm.css'), path.join(outDir, 'xterm.css')],
  ['addon-fit', path.join(nm, 'addon-fit', 'lib', 'addon-fit.js'), path.join(outDir, 'addon-fit.js')],
];

fs.mkdirSync(outDir, { recursive: true });
for (const [pkg, src, dst] of copies) {
  const version = JSON.parse(fs.readFileSync(path.join(nm, pkg, 'package.json'), 'utf8')).version;
  fs.copyFileSync(src, dst);
  console.log('vendor-xterm: ' + path.basename(dst) + ' ← @xterm/' + pkg + '@' + version);
}
