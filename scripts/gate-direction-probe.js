/**
 * OBS-128 — مسبار: لماذا يرسو عنصر قائمة عربي LTR في بوابة أول التشغيل على Electron 44؟
 *
 * `test:gate-live` يبلّغ `{"kind":"pixel","tag":"LI"}` على 44 ويصمت على 33، والسمة `dir`
 * صحيحة في الحالتين (وإلا لأبلغ `attribute`). فالانحراف في **التخطيط** لا في السمة.
 *
 * هذا المسبار يطبع الأرقام الخام لكل `li` مخالف — صندوقه، وموضع أول محرف قوي، وموضع
 * العلامة والجسم، والأنماط المحسوبة — كي يُشغَّل بالأمر نفسه في الشجرتين فيُقارَن رقمٌ
 * برقم. تشخيصيّ لا حارس: يطبع ولا يفشل.
 *
 * التشغيل (في كل شجرة): npx --no-install electron scripts/gate-direction-probe.js
 */
const path = require('path');
const { app, BrowserWindow } = require('electron');

const FIXTURE = path.join(__dirname, 'fixtures', 'gate-direction.html');
const TIMEOUT_MS = 30000;

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// يُنفَّذ داخل الصفحة: يعيد قياس كل li بمنطق gate-live-test نفسه زائد سياق التخطيط
const PROBE = `(() => {
  const STRONG = /[A-Za-z\\u0600-\\u06FF\\u0750-\\u077F\\u0870-\\u089F\\u08A0-\\u08FF\\uFB50-\\uFDFF\\uFE70-\\uFEFF]/;
  const el = document.querySelector('satr-gate');
  const root = (el && el.shadowRoot) || document;
  const out = [];
  for (const li of root.querySelectorAll('li')) {
    const walk = document.createTreeWalker(li, NodeFilter.SHOW_TEXT);
    let node, rect = null, ch = '';
    while ((node = walk.nextNode())) {
      const at = node.data.search(STRONG);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at); range.setEnd(node, at + 1);
      const box = range.getBoundingClientRect();
      if (box.width || box.height) { rect = box; ch = node.data[at]; break; }
    }
    const box = li.getBoundingClientRect();
    const cs = getComputedStyle(li);
    const mark = li.querySelector('.gate-mark');
    const body = li.querySelector('.gate-body');
    const t = li.querySelector('.t');
    out.push({
      text: (li.textContent || '').slice(0, 34),
      firstChar: ch,
      dirAttr: li.getAttribute('dir'),
      computedDir: cs.direction,
      display: cs.display,
      flexDirection: cs.flexDirection,
      unicodeBidi: cs.unicodeBidi,
      textAlign: cs.textAlign,
      writingMode: cs.writingMode,
      liBox: box ? [Math.round(box.left), Math.round(box.right), Math.round(box.width), Math.round(box.height)] : null,
      firstBox: rect ? [Math.round(rect.left), Math.round(rect.right)] : null,
      fromRight: rect ? Math.round(box.right - rect.right) : null,
      fromLeft: rect ? Math.round(rect.left - box.left) : null,
      markLeft: mark ? Math.round(mark.getBoundingClientRect().left) : null,
      bodyLeft: body ? Math.round(body.getBoundingClientRect().left) : null,
      tLeft: t ? Math.round(t.getBoundingClientRect().left) : null,
      tRight: t ? Math.round(t.getBoundingClientRect().right) : null,
      tDir: t ? t.getAttribute('dir') : null,
      tComputedDir: t ? getComputedStyle(t).direction : null,
      tTextAlign: t ? getComputedStyle(t).textAlign : null,
    });
  }
  return { versions: { electron: '', chrome: '' }, rows: out };
})()`;

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({
    show: false, width: 1100, height: 900,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  try {
    await win.loadFile(FIXTURE, { hash: process.argv.includes('--legacy') ? 'legacy' : '' });
    // البوابة تُبنى بعد preflight غير متزامن — ننتظر ظهور عناصر القائمة
    const deadline = Date.now() + TIMEOUT_MS;
    let result = null;
    while (Date.now() < deadline) {
      result = await win.webContents.executeJavaScript(PROBE, true);
      if (result && result.rows.length) break;
      await delay(200);
    }
    console.log('electron=' + process.versions.electron + ' chrome=' + process.versions.chrome);
    if (!result || !result.rows.length) { console.log('  لم تُبنَ قائمة البوابة خلال المهلة.'); return; }

    // الحارس يقيس عند **390px** أيضاً (شاشة ضيقة) حيث يلتفّ النصّ — وهو المقاس الذي
    // أهمله أول قياس. الالتفاف يغيّر أين يقع أول محرف قوي داخل صندوق متعدد الأسطر.
    for (const width of [390, 1280]) {
      win.setContentSize(width, 900);
      await delay(400);
      const narrow = await win.webContents.executeJavaScript(PROBE, true);
      const bad = [];
      for (const r of narrow.rows) {
        if (r.fromRight === null || Math.abs(r.fromRight - r.fromLeft) < 1) continue;
        const got = r.fromRight <= r.fromLeft ? 'rtl' : 'ltr';
        if (got !== 'rtl') bad.push(r);
      }
      console.log('\n  — عند ' + width + 'px: ' + (bad.length ? bad.length + ' عنصراً يرسو LTR' : 'كل العناصر ترسو RTL'));
      for (const r of bad) {
        console.log('    ✗ ' + JSON.stringify(r.text) + '  أول محرف: ' + JSON.stringify(r.firstChar));
        console.log('      fromRight=' + r.fromRight + ' · fromLeft=' + r.fromLeft
          + ' · liBox=' + JSON.stringify(r.liBox) + ' · firstBox=' + JSON.stringify(r.firstBox));
        console.log('      t: dir=' + r.tDir + ' · t[l,r]=[' + r.tLeft + ',' + r.tRight + ']'
          + ' · mark.left=' + r.markLeft + ' · body.left=' + r.bodyLeft);
      }
    }
    win.setContentSize(1100, 900);
    await delay(300);

    for (const r of result.rows) {
      const verdict = r.fromRight === null ? '—'
        : (Math.abs(r.fromRight - r.fromLeft) < 1 ? 'متعادل'
          : (r.fromRight <= r.fromLeft ? 'rtl' : 'ltr'));
      console.log('\n  li: ' + JSON.stringify(r.text) + '  أول محرف قوي: ' + JSON.stringify(r.firstChar));
      console.log('    الرسو المقيس = ' + verdict + '  (fromRight=' + r.fromRight + ' · fromLeft=' + r.fromLeft + ')');
      console.log('    dir=' + r.dirAttr + ' · computed=' + r.computedDir + ' · display=' + r.display
        + ' · flexDirection=' + r.flexDirection);
      console.log('    unicode-bidi=' + r.unicodeBidi + ' · text-align=' + r.textAlign + ' · writing-mode=' + r.writingMode);
      console.log('    liBox[l,r,w,h]=' + JSON.stringify(r.liBox) + ' · firstBox[l,r]=' + JSON.stringify(r.firstBox));
      console.log('    mark.left=' + r.markLeft + ' · body.left=' + r.bodyLeft
        + ' · t[l,r]=[' + r.tLeft + ',' + r.tRight + ']');
      console.log('    t: dir=' + r.tDir + ' · computed=' + r.tComputedDir + ' · text-align=' + r.tTextAlign);
    }

    // القسم الحاسم: ابنٌ `dir=ltr` داخل حاوية `dir=rtl` — وهي حالة العنصر الذي كسر
    // الحارس (‏«ثبّت Claude Code» حُسم LTR إحصائياً: 4 محارف عربية مقابل 11 لاتينياً).
    // `text-align` **موروثة** لا مضبوطة على العنصر، فالسؤال: أتُحلّ إلى `right` المطلقة
    // (فيرسو النصّ يميناً رغم dir) أم تبقى `start` النسبية (فتتبع dir=ltr فترسو يساراً)؟
    const synthetic = await win.webContents.executeJavaScript(`(() => {
      const host = document.createElement('div');
      const sheet = new CSSStyleSheet();
      sheet.replaceSync('.probe-root{direction:rtl;text-align:start;width:400px}'
        + '.probe-root.explicit{text-align:right}.probe-child{font-size:16px}');
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      document.body.appendChild(host);
      const measure = (rootDir, childDir, explicit) => {
        host.innerHTML = '';
        const root = document.createElement('div');
        root.className = 'probe-root' + (explicit ? ' explicit' : '');
        root.dir = rootDir;
        const child = document.createElement('div');
        child.className = 'probe-child';
        child.dir = childDir;
        child.textContent = 'ثبّت Claude Code';
        root.appendChild(child); host.appendChild(root);
        const walk = document.createTreeWalker(child, NodeFilter.SHOW_TEXT);
        const node = walk.nextNode();
        const range = document.createRange();
        range.setStart(node, 0); range.setEnd(node, 1);
        const first = range.getBoundingClientRect();
        const box = child.getBoundingClientRect();
        const fromRight = Math.round(box.right - first.right);
        const fromLeft = Math.round(first.left - box.left);
        return {
          childDir, explicit,
          computedTextAlign: getComputedStyle(child).textAlign,
          anchored: Math.abs(fromRight - fromLeft) < 1 ? 'متعادل' : (fromRight <= fromLeft ? 'rtl' : 'ltr'),
          fromRight, fromLeft,
        };
      };
      const rows = [
        measure('rtl', 'rtl', false), measure('rtl', 'ltr', false),
        measure('rtl', 'rtl', true), measure('rtl', 'ltr', true),
      ];
      host.remove();
      return rows;
    })()`, true);
    console.log('\n  — الاختبار الحاسم: ابن داخل حاوية dir=rtl، والنصّ «ثبّت Claude Code» —');
    for (const s of synthetic) {
      console.log('    الحاوية text-align=' + (s.explicit ? 'right (صريحة)' : 'start (موروثة)')
        + ' · الابن dir=' + s.childDir
        + ' ⇒ محسوبة=' + s.computedTextAlign + ' · الرسو=' + s.anchored
        + '  (fromRight=' + s.fromRight + ' · fromLeft=' + s.fromLeft + ')');
    }
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

process.on('uncaughtException', (e) => { console.error('gate-direction-probe: فشل —', (e && e.stack) || e); app.exit(1); });
main().then(() => app.exit(0)).catch((e) => { console.error('gate-direction-probe: فشل —', (e && e.message) || e); app.exit(1); });
