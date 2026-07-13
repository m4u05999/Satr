/**
 * تضمين (vendoring) xterm.js في src/vendor للواجهة
 *
 * الواجهة صفر اعتماديات npm وقت التشغيل (القاعدة 5 في CLAUDE.md) — لذا لا نحمّل
 * xterm.js من node_modules بل ننسخ ملفات التوزيع من devDependencies إلى src/vendor/.
 *
 * مصدر xterm.js المصحّح: node_modules/@xterm/xterm/lib/xterm.js من الإصدار 6.0.0.
 * bundle الأصلي ينشئ أربعة عناصر <style> وقت التشغيل، وهذا يخالف CSP الصارمة في «سطر».
 * التحويل أدناه يغيّر وسيلة حمل CSS فقط إلى constructable CSSStyleSheet على document؛
 * ويبقي نص CSS ومنطق تحديثه كما هما. البصمات والعدادات تجعل ترقية xterm تفشل صراحةً
 * حتى تُراجع مواضع الحقن الجديدة بدلاً من إنتاج vendor ناقص بصمت.
 *
 * يُشغَّل يدوياً فقط عند ترقية إصدار xterm.js:
 *     node scripts/vendor-xterm.js
 */
const fs = require('fs');
const path = require('path');

const EXPECTED_XTERM_VERSION = '6.0.0';
const EXPECTED_STYLE_SITES = 4;
const nm = path.join(__dirname, '..', 'node_modules', '@xterm');
const outDir = path.join(__dirname, '..', 'src', 'vendor');

const copies = [
  ['xterm', path.join(nm, 'xterm', 'lib', 'xterm.js'), path.join(outDir, 'xterm.js')],
  ['xterm', path.join(nm, 'xterm', 'css', 'xterm.css'), path.join(outDir, 'xterm.css')],
  ['addon-fit', path.join(nm, 'addon-fit', 'lib', 'addon-fit.js'), path.join(outDir, 'addon-fit.js')],
];

function count(source, needle) {
  return source.split(needle).length - 1;
}

function assertCount(source, needle, expected, label) {
  const actual = count(source, needle);
  if (actual !== expected) {
    throw new Error(`vendor-xterm: ${label}: expected ${expected}, found ${actual}`);
  }
}

function replaceExact(source, before, after, label) {
  assertCount(source, before, 1, label);
  return source.replace(before, after);
}

function replaceSection(source, startMarker, endMarker, replacement, label) {
  assertCount(source, startMarker, 1, `${label} start`);
  assertCount(source, endMarker, 1, `${label} end`);
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (end <= start) throw new Error(`vendor-xterm: ${label}: invalid marker order`);
  return source.slice(0, start) + replacement + source.slice(end);
}

function replaceAssignment(source, assignment, endMarker, replacement, label) {
  assertCount(source, assignment, 1, `${label} assignment`);
  const start = source.indexOf(assignment);
  const end = source.indexOf(endMarker, start);
  if (end <= start) throw new Error(`vendor-xterm: ${label}: missing assignment end`);
  const value = source.slice(start + assignment.length, end);
  return source.slice(0, start) + replacement(value) + source.slice(end);
}

function patchXterm(source) {
  assertCount(source, 'createElement("style")', EXPECTED_STYLE_SITES, 'runtime <style> sites');
  assertCount(source, '_styleElement', EXPECTED_STYLE_SITES, 'viewport _styleElement anchors');

  const strictAnchor = '"use strict";var e={';
  const helpers = '"use strict";const __satrSheetDocuments=new WeakMap;function __satrAdoptStyleSheet(e){const t=new e.defaultView.CSSStyleSheet;return e.adoptedStyleSheets=[...e.adoptedStyleSheets,t],__satrSheetDocuments.set(t,e),t}function __satrRemoveStyleSheet(e){const t=__satrSheetDocuments.get(e);t&&(t.adoptedStyleSheets=t.adoptedStyleSheets.filter((t=>t!==e)),__satrSheetDocuments.delete(e))}function __satrStyleSheetText(e){return Array.from(e.cssRules,(e=>e.cssText)).join("\\n")}var e={';
  source = replaceExact(source, strictAnchor, helpers, 'CSSStyleSheet helpers anchor');

  source = replaceExact(
    source,
    'this._styleElement=s.mainDocument.createElement("style"),t.appendChild(this._styleElement),this._register((0,o.toDisposable)((()=>this._styleElement.remove())))',
    'this._styleElement=__satrAdoptStyleSheet(s.mainDocument),this._register((0,o.toDisposable)((()=>__satrRemoveStyleSheet(this._styleElement))))',
    'viewport stylesheet lifecycle'
  );
  source = replaceAssignment(
    source,
    'this._styleElement.textContent=',
    '}))),this._register(this._bufferService.onResize',
    (value) => `this._styleElement.replaceSync(${value})`,
    'viewport stylesheet update'
  );

  source = replaceExact(
    source,
    'this._themeStyleElement.remove(),this._dimensionsStyleElement.remove()',
    '__satrRemoveStyleSheet(this._themeStyleElement),__satrRemoveStyleSheet(this._dimensionsStyleElement)',
    'DOM renderer stylesheet disposal'
  );
  source = replaceExact(
    source,
    'this._dimensionsStyleElement||(this._dimensionsStyleElement=this._document.createElement("style"),this._screenElement.appendChild(this._dimensionsStyleElement))',
    'this._dimensionsStyleElement||(this._dimensionsStyleElement=__satrAdoptStyleSheet(this._document))',
    'dimensions stylesheet creation'
  );
  source = replaceExact(
    source,
    'this._dimensionsStyleElement.textContent=t',
    'this._dimensionsStyleElement.replaceSync(t)',
    'dimensions stylesheet update'
  );
  source = replaceExact(
    source,
    'this._themeStyleElement||(this._themeStyleElement=this._document.createElement("style"),this._screenElement.appendChild(this._themeStyleElement))',
    'this._themeStyleElement||(this._themeStyleElement=__satrAdoptStyleSheet(this._document))',
    'theme stylesheet creation'
  );
  source = replaceExact(
    source,
    'this._themeStyleElement.textContent=t',
    'this._themeStyleElement.replaceSync(t)',
    'theme stylesheet update'
  );

  const genericStart = 'const j=new Map;class $';
  const genericEnd = 'function q(e,t=v.mainWindow.document.head)';
  const genericReplacement = 'const j=new Map;function __satrDisposeGlobalStyleSheet(e){for(const t of j.get(e)??[])__satrRemoveStyleSheet(t);j.delete(e),__satrRemoveStyleSheet(e)}class ${constructor(){this._currentCssStyle="",this._styleSheet=void 0}setStyle(e){e!==this._currentCssStyle&&(this._currentCssStyle=e,this._styleSheet?(this._styleSheet.replaceSync(e),j.get(this._styleSheet)?.forEach((t=>t.replaceSync(e)))):this._styleSheet=V(v.mainWindow.document.head,(t=>t.replaceSync(e))))}dispose(){this._styleSheet&&(__satrDisposeGlobalStyleSheet(this._styleSheet),this._styleSheet=void 0)}}function V(e=v.mainWindow.document.head,i,s){const r=__satrAdoptStyleSheet(e.ownerDocument??v.mainWindow.document);if(i?.(r),s&&s.add((0,p.toDisposable)((()=>__satrDisposeGlobalStyleSheet(r)))),e===v.mainWindow.document.head){const e=new Set;j.set(r,e);for(const{window:i,disposables:n}of(0,t.getWindows)()){if(i===v.mainWindow)continue;const t=n.add(G(r,e,i));s?.add(t)}}return r}function G(e,i,s){const r=new p.DisposableStore,n=__satrAdoptStyleSheet(s.document);return n.replaceSync(__satrStyleSheetText(e)),r.add((0,p.toDisposable)((()=>__satrRemoveStyleSheet(n)))),i.add(n),r.add((0,p.toDisposable)((()=>i.delete(n)))),r}';
  source = replaceSection(source, genericStart, genericEnd, genericReplacement, 'shared stylesheet utility');
  source = replaceExact(source, 's.sheet?.insertRule(`${t} {${i}}`,0)', 's.insertRule(`${t} {${i}}`,0)', 'shared rule insertion');
  source = replaceExact(source, 'i.sheet?.deleteRule(r[e])', 'i.deleteRule(r[e])', 'shared rule deletion');
  source = replaceExact(
    source,
    'function Z(e){return e?.sheet?.rules?e.sheet.rules:e?.sheet?.cssRules?e.sheet.cssRules:[]}',
    'function Z(e){return e?.rules??e?.cssRules??[]}',
    'shared rule enumeration'
  );

  assertCount(source, 'createElement("style")', 0, 'patched runtime <style> sites');
  assertCount(source, '._styleElement.textContent=', 0, 'patched viewport textContent');
  assertCount(source, '._dimensionsStyleElement.textContent=', 0, 'patched dimensions textContent');
  assertCount(source, '._themeStyleElement.textContent=', 0, 'patched theme textContent');
  return source;
}

const versions = new Map();
for (const [pkg] of copies) {
  if (!versions.has(pkg)) {
    versions.set(pkg, JSON.parse(fs.readFileSync(path.join(nm, pkg, 'package.json'), 'utf8')).version);
  }
}
if (versions.get('xterm') !== EXPECTED_XTERM_VERSION) {
  throw new Error(`vendor-xterm: expected @xterm/xterm@${EXPECTED_XTERM_VERSION}, found ${versions.get('xterm')}; review CSP patch anchors before upgrading`);
}

const outputs = copies.map(([pkg, src, dst]) => {
  let content = fs.readFileSync(src);
  if (path.basename(dst) === 'xterm.js') content = Buffer.from(patchXterm(content.toString('utf8')), 'utf8');
  return { pkg, dst, content };
});

fs.mkdirSync(outDir, { recursive: true });
for (const { pkg, dst, content } of outputs) {
  fs.writeFileSync(dst, content);
  console.log('vendor-xterm: ' + path.basename(dst) + ' ← @xterm/' + pkg + '@' + versions.get(pkg));
}
