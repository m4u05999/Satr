// لوحة المعاينة المدمجة (م-1 — الدفعة 5 «سطر يرى الويب»): متصفح داخل النافذة عبر
// WebContentsView الأصلية في Electron (صفر اعتماديات — قاعدة CLAUDE.md ‏5).
// العرض المضمّن **محتوى غير موثوق بالتعريف** (قرار العزل المثبّت في ROADMAP):
//   - webContents منفصلة تماماً عن واجهة «سطر»: sandbox + contextIsolation،
//     **بلا preload إطلاقاً** (لا window.satr ولا أي جسر — الصفحة معزولة كمتصفح عادي)
//   - partition دائمة مستقلة ('persist:preview') — كوكيز المعاينة لا تلمس جلسة الواجهة
//   - http/https حصراً (will-navigate يحجب غيرها)، النوافذ المنبثقة تُحوَّل لنفس العرض
//   - طلبات أذونات الويب (كاميرا/ميكروفون/إشعارات/موقع…) مرفوضة كلها
// الواجهة ترسم «إطار» اللوحة (رأس + مساحة فارغة) وتبلّغ مستطيلها عبر satr:previewBounds —
// العرض الأصلي يطفو فوق تلك المساحة (إحداثيات DIP تطابق CSS px عند zoom=1).
// أحداث للواجهة عبر قناة مستقلة satr:preview: nav/title/loading/failed.

const { WebContentsView, session } = require('electron');

let view = null;      // WebContentsView الحيّة (تُنشأ عند الفتح وتُدمَّر عند الإغلاق)
let hostWin = null;   // النافذة المضيفة
let sender = null;    // دالة بثّ الأحداث للواجهة (يمرّرها main.js)
let lastBounds = null; // آخر مستطيل أبلغته الواجهة — يُطبَّق عند إنشاء عرض جديد

const PARTITION = 'persist:preview';

// ---------- التقاط الـ console وأخطاء الشبكة (البند 1 — «الوكيل يرى أخطاء التشغيل») ----------
// الوكيل يبني صفحة ويعاينها لكنه أعمى عن أخطاء JavaScript وقت التشغيل وفشل طلبات الشبكة.
// نلتقطها من الصفحة المعزولة ونبثّها له عبر أداة browser_console فتُغلق حلقة «ابنِ→عايِن→صحّح».
// مخزنان دائريّان يُصفَّران عند تنقّل الإطار الرئيسي (كي يعكسا الصفحة الحالية).
let consoleBuf = []; // {level, message, line, source}
let netErrBuf = [];  // {url, error, type}
const LOG_CAP = 300;
const LEVELS = ['verbose', 'info', 'warning', 'error']; // ترميز Electron لـ console-message
function pushLog(arr, item) { arr.push(item); if (arr.length > LOG_CAP) arr.shift(); }
function resetLogs() { consoleBuf = []; netErrBuf = []; }

function emit(ev) {
  if (typeof sender === 'function') { try { sender(ev); } catch (e) {} }
}

// http/https حصراً — تُستخدم في التحقق وفي حارس التنقل
function isHttpUrl(u) {
  try {
    const p = new URL(String(u));
    return (p.protocol === 'http:' || p.protocol === 'https:') && String(u).length <= 2048;
  } catch (e) { return false; }
}

// رفض كل أذونات الويب لجلسة المعاينة (مرة واحدة لكل partition — آمن للتكرار)
let permsWired = false;
function wirePermissions() {
  if (permsWired) return;
  permsWired = true;
  try {
    session.fromPartition(PARTITION).setPermissionRequestHandler((wc, permission, cb) => cb(false));
  } catch (e) {}
}

// التقاط طلبات الشبكة الفاشلة على مستوى جلسة المعاينة (مرة واحدة — مستقلة عن العرض)
let netWired = false;
function wireNetwork() {
  if (netWired) return;
  netWired = true;
  try {
    session.fromPartition(PARTITION).webRequest.onErrorOccurred((details) => {
      // ERR_ABORTED = أُلغي بتنقّل جديد (ليس خطأً) — نتجاهله كي لا نضجّ سجل الوكيل
      if (!details || details.error === 'net::ERR_ABORTED') return;
      pushLog(netErrBuf, {
        url: String(details.url || '').slice(0, 500),
        error: String(details.error || ''),
        type: String(details.resourceType || ''),
      });
    });
  } catch (e) {}
}

function wireEvents(wc) {
  const nav = () => emit({
    type: 'nav',
    url: wc.getURL(),
    canGoBack: wc.navigationHistory ? wc.navigationHistory.canGoBack() : wc.canGoBack(),
    canGoForward: wc.navigationHistory ? wc.navigationHistory.canGoForward() : wc.canGoForward(),
  });
  wc.on('did-navigate', nav);
  wc.on('did-navigate-in-page', nav);
  wc.on('page-title-updated', (e, title) => emit({ type: 'title', title: String(title || '').slice(0, 200) }));
  wc.on('did-start-loading', () => emit({ type: 'loading', loading: true }));
  wc.on('did-stop-loading', () => emit({ type: 'loading', loading: false }));
  // التقاط رسائل console الصفحة (تشمل الأخطاء غير الملتقطة) للوكيل عبر browser_console
  wc.on('console-message', (e, level, message, line, sourceId) => {
    pushLog(consoleBuf, {
      level: Number(level) || 0,
      message: String(message || '').slice(0, 2000),
      line: Number(line) || 0,
      source: String(sourceId || '').slice(0, 300),
    });
  });
  // تصفير السجلّ عند تنقّل الإطار الرئيسي لصفحة جديدة (لا للتنقّل داخل الصفحة) — يعكس الحالية
  wc.on('did-start-navigation', (e, url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) resetLogs();
  });
  // فشل التحميل الرئيسي فقط (-3 = أُجهض بتنقل جديد — ليس خطأ)
  wc.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
    if (isMainFrame && code !== -3) emit({ type: 'failed', code, desc: String(desc || ''), url: String(url || '') });
  });
  // نافذة منبثقة (target=_blank…): لا نوافذ — رابط http/https يُفتح في نفس العرض
  wc.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) { try { wc.loadURL(url); } catch (e) {} }
    return { action: 'deny' };
  });
  // حارس التنقل: http/https حصراً (يمنع file:// وjavascript: وغيرهما)
  wc.on('will-navigate', (e, url) => { if (!isHttpUrl(url)) e.preventDefault(); });
}

function ensureView(win, send) {
  hostWin = win;
  sender = send;
  if (view && !view.webContents.isDestroyed()) return view;
  wirePermissions();
  wireNetwork();
  view = new WebContentsView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: PARTITION,
      // لا preload — الصفحة المعروضة لا ترى أي واجهة لـ «سطر»
    },
  });
  view.setBackgroundColor('#ffffff'); // المواقع تفترض خلفية فاتحة قبل رسم أنماطها
  wireEvents(view.webContents);
  win.contentView.addChildView(view);
  if (lastBounds) view.setBounds(lastBounds);
  return view;
}

// فتح المعاينة على عنوان (تُنشأ الـ view عند أول فتح بعد كل إغلاق — دورة حياة بسيطة)
function open(win, send, url) {
  if (!isHttpUrl(url)) return { error: 'bad_url' };
  const v = ensureView(win, send);
  try { v.webContents.loadURL(String(url)); } catch (e) { return { error: 'load_failed' }; }
  return { ok: true };
}

function navigate(url) {
  if (!view || view.webContents.isDestroyed()) return { error: 'closed' };
  if (!isHttpUrl(url)) return { error: 'bad_url' };
  try { view.webContents.loadURL(String(url)); } catch (e) { return { error: 'load_failed' }; }
  return { ok: true };
}

function action(name) {
  if (!view || view.webContents.isDestroyed()) return { error: 'closed' };
  const wc = view.webContents;
  const h = wc.navigationHistory;
  try {
    if (name === 'back') { if (h ? h.canGoBack() : wc.canGoBack()) (h ? h.goBack() : wc.goBack()); }
    else if (name === 'forward') { if (h ? h.canGoForward() : wc.canGoForward()) (h ? h.goForward() : wc.goForward()); }
    else if (name === 'reload') wc.reload();
  } catch (e) {}
  return { ok: true };
}

// الواجهة تبلّغ مستطيل مساحة العرض داخل النافذة (تقيسه بـ getBoundingClientRect)
function setBounds(b) {
  lastBounds = b;
  if (view && !view.webContents.isDestroyed()) view.setBounds(b);
  return { ok: true };
}

// ---------- التحديد بالتأشير (م-2) ----------
// نحقن سكربتاً في الصفحة المعزولة عبر executeJavaScript يعيد Promise يُحلّ عند نقر
// المستخدم على عنصر (أو Escape ⇒ null). لا preload في العرض (معزول) فهذا المسار الوحيد
// لإخراج بيانات العنصر: قيمة الـ Promise تعود مباشرة لـ executeJavaScript. العنصر
// يُلتقط بـ outerHTML مقتطع + نص + selector تقريبي — يكفي النموذج ليجده بـ Grep في المصدر.
// **أمان**: outerHTML من صفحة غير موثوقة ⇒ يُغلَّف كـ «محتوى» في القشرة ويُقتطع (حقن
// برومبت محتمل موثّق في ROADMAP — م-2 وصف فقط بلا أفعال تلقائية، والمستخدم يبادر ويرسل).
const PICK_SCRIPT = `(function(){
  return new Promise(function(resolve){
    if (window.__satrPick) { try { window.__satrPick.cleanup(); } catch(e){} }
    var box = document.createElement('div');
    box.setAttribute('data-satr-pick','1');
    box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #D9A441;background:rgba(217,164,65,.14);border-radius:2px;transition:left .04s,top .04s,width .04s,height .04s;';
    document.documentElement.appendChild(box);
    var current = null;
    function esc(s){ try { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g,'\\\\$&'); } catch(e){ return s; } }
    function cssPath(el){
      if (el.id) return '#' + esc(el.id);
      var parts = [], e = el, guard = 0;
      while (e && e.nodeType === 1 && guard++ < 5) {
        if (e.id) { parts.unshift('#' + esc(e.id)); break; }
        var sel = e.tagName.toLowerCase();
        if (e.classList && e.classList.length)
          sel += '.' + Array.prototype.slice.call(e.classList, 0, 2).map(esc).join('.');
        var par = e.parentElement;
        if (par) {
          var same = Array.prototype.filter.call(par.children, function(c){ return c.tagName === e.tagName; });
          if (same.length > 1) sel += ':nth-of-type(' + (same.indexOf(e) + 1) + ')';
        }
        parts.unshift(sel);
        e = e.parentElement;
      }
      return parts.join(' > ');
    }
    function describe(el){
      var html = '';
      try { html = el.outerHTML || ''; } catch(e){}
      if (html.length > 600) html = html.slice(0, 600) + '…';
      var text = '';
      try { text = (el.textContent || '').replace(/\\s+/g, ' ').trim(); } catch(e){}
      if (text.length > 140) text = text.slice(0, 140) + '…';
      return { selector: cssPath(el), tag: el.tagName.toLowerCase(), html: html, text: text };
    }
    function move(e){
      var el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el === box) return;
      current = el;
      var r = el.getBoundingClientRect();
      box.style.left = r.left + 'px'; box.style.top = r.top + 'px';
      box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
    }
    function pick(e){
      var el = current || document.elementFromPoint(e.clientX, e.clientY);
      e.preventDefault(); e.stopPropagation();
      var data = el ? describe(el) : null;
      cleanup(); resolve(data);
    }
    function swallow(e){ e.preventDefault(); e.stopPropagation(); } // يمنع تفعيل الروابط/الأزرار
    function key(e){ if (e.key === 'Escape') { cleanup(); resolve(null); } }
    function cleanup(){
      document.removeEventListener('mousemove', move, true);
      document.removeEventListener('click', pick, true);
      document.removeEventListener('mousedown', swallow, true);
      document.removeEventListener('pointerdown', swallow, true);
      document.removeEventListener('keydown', key, true);
      if (box.parentNode) box.parentNode.removeChild(box);
      window.__satrPick = null;
    }
    document.addEventListener('mousemove', move, true);
    document.addEventListener('click', pick, true);
    document.addEventListener('mousedown', swallow, true);
    document.addEventListener('pointerdown', swallow, true);
    document.addEventListener('keydown', key, true);
    window.__satrPick = { cleanup: cleanup, cancel: function(){ cleanup(); resolve(null); } };
  });
})()`;

async function startPick() {
  if (!view || view.webContents.isDestroyed()) return { error: 'closed' };
  try {
    const pick = await view.webContents.executeJavaScript(PICK_SCRIPT, true);
    return { ok: true, pick: pick || null }; // null = أُلغي (Escape/إلغاء)
  } catch (e) { return { error: 'pick_failed' }; }
}

// إلغاء وضع التحديد من الواجهة (زر «تحديد» ثانيةً أو إغلاق) — يحلّ الـ Promise بـ null
async function cancelPick() {
  if (view && !view.webContents.isDestroyed()) {
    try { await view.webContents.executeJavaScript('window.__satrPick && window.__satrPick.cancel && window.__satrPick.cancel()', true); } catch (e) {}
  }
  return { ok: true };
}

// ---------- أدوات قراءة الصفحة للوكيل (م-3) ----------
// يستهلكها خادم MCP الداخلي في agent.js (preview.js موديول مشترك بين العمليتين مثل
// term.js — نفس نسخة الـ view). العرض تُنشئه القشرة عبر open_preview؛ هذه الأدوات
// تعمل على الـ view القائمة (قراءة فقط — لا أفعال، م-4 خلف بوابة قرار مستقلة).
// **أمان**: المحتوى المُستخرَج من صفحة غير موثوقة ⇒ نصّ مغلّف يقرؤه النموذج (حقن
// برومبت محتمل موثّق — قراءة فقط، الوكيل يطلبه عمداً ليفحص).
function currentWC() {
  return (view && !view.webContents.isDestroyed()) ? view.webContents : null;
}

// انتظار انتهاء أي تحميل جارٍ (open_preview قبله بلحظة) بمهلة — كي يقرأ الوكيل بعد الجهوز
function waitReady(wc, ms) {
  if (!wc.isLoadingMainFrame || !wc.isLoadingMainFrame()) return Promise.resolve();
  return new Promise((res) => {
    const t = setTimeout(res, ms || 8000);
    wc.once('did-stop-loading', () => { clearTimeout(t); res(); });
  });
}

// سكربت استخراج snapshot نصي مفيد للنموذج: عنوان + روابط + عناوين + أزرار + نص الجسم
const READ_SCRIPT = `(function(){
  function txt(el){ try { return (el.textContent||'').replace(/\\s+/g,' ').trim(); } catch(e){ return ''; } }
  function q(sel){ try { return Array.prototype.slice.call(document.querySelectorAll(sel)); } catch(e){ return []; } }
  var headings = q('h1,h2,h3,h4').slice(0,40).map(function(h){ return h.tagName.toLowerCase()+': '+txt(h).slice(0,120); }).filter(function(x){ return x.split(': ')[1]; });
  var links = q('a[href]').slice(0,50).map(function(a){ var t=txt(a).slice(0,60); return (t||'(بلا نص)')+' → '+a.getAttribute('href'); });
  var buttons = q('button,[role=button],input[type=submit],input[type=button]').slice(0,40).map(function(b){ return (txt(b)||b.value||'').slice(0,60); }).filter(Boolean);
  var inputs = q('input,textarea,select').slice(0,30).map(function(i){ return (i.tagName.toLowerCase())+(i.type?('['+i.type+']'):'')+(i.name?(' name='+i.name):'')+(i.placeholder?(' ph="'+i.placeholder.slice(0,40)+'"'):''); });
  var body = txt(document.body).slice(0, 4000);
  return { title: document.title, url: location.href, headings: headings, links: links, buttons: buttons, inputs: inputs, bodyText: body };
})()`;

async function readPage() {
  const wc = currentWC();
  if (!wc) return { error: 'closed' };
  await waitReady(wc);
  try {
    const data = await wc.executeJavaScript(READ_SCRIPT, true);
    return { ok: true, page: data };
  } catch (e) { return { error: 'read_failed' }; }
}

// سجلّ الـ console وأخطاء الشبكة الملتقطة للصفحة الحالية (لا executeJavaScript — بثّ حيّ).
// LEVELS يترجم ترميز Electron، والأخطاء تُبرَز أولاً في العرض ليركّز عليها الوكيل.
function getConsole() {
  if (!currentWC()) return { error: 'closed' };
  const logs = consoleBuf.slice(-150).map((l) => ({
    level: LEVELS[l.level] || 'log',
    message: l.message,
    line: l.line,
    source: l.source,
  }));
  return { ok: true, logs, netErrors: netErrBuf.slice(-80) };
}

// ---------- لقطة شجرة الوصول بمُعرّفات ثابتة (ترقية أفعال المتصفح 2026-07-12) ----------
// نمط Playwright MCP / browser-use المعتمد صناعياً: بدل أن يخمّن النموذج مُحدِّد CSS من
// outerHTML (هشّ)، يأخذ **لقطة مدمجة** لكل عنصر تفاعلي فيها `role "name" [ref=eN]`، ثم
// يتصرّف بـ ref حتمياً (browser_click/type يقبلان ref). نسِم كل عنصر بـ data-satr-ref="eN"
// فيُحلّ الفعل عبر [data-satr-ref="eN"] بلا تخمين. **الـ ref يصير قديماً بعد أي تنقّل/تغيّر
// DOM** (القاعدة الصناعية المثبّتة) — يُعاد أخذ اللقطة بعد كل فعل. كفاءة رموز: ~مئات مقابل
// آلاف للـDOM الخام. صفر اعتماديات، بلا preload (يطابق عزل العرض) — كله executeJavaScript.
const SNAPSHOT_SCRIPT = `(function(){
  function vis(el){
    if (!el || el.nodeType !== 1) return false;
    var s; try { s = getComputedStyle(el); } catch(e){ return false; }
    if (!s || s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return false;
    var r = el.getBoundingClientRect();
    return r.width >= 1 && r.height >= 1;
  }
  function clean(s){ return String(s || '').replace(/\\s+/g, ' ').trim(); }
  function esc(s){ try { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s); } catch(e){ return String(s); } }
  function name(el){
    var n = el.getAttribute && el.getAttribute('aria-label');
    if (n && clean(n)) return clean(n);
    var lb = el.getAttribute && el.getAttribute('aria-labelledby');
    if (lb) { var t = ''; lb.split(/\\s+/).forEach(function(id){ var e = document.getElementById(id); if (e) t += ' ' + (e.textContent || ''); }); if (clean(t)) return clean(t); }
    var tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      var ph = el.getAttribute('placeholder'); if (ph) return clean(ph);
      if (el.id) { var l; try { l = document.querySelector('label[for="' + esc(el.id) + '"]'); } catch(e){} if (l && clean(l.textContent)) return clean(l.textContent); }
      var nm = el.getAttribute('name'); if (nm) return clean(nm);
      if (el.value && (el.type || '') !== 'password') return clean(el.value).slice(0, 80);
      return '';
    }
    if (tag === 'img') return clean(el.getAttribute('alt'));
    if (tag === 'textarea') return clean(el.getAttribute('placeholder') || el.getAttribute('name'));
    if (tag === 'select') return clean(el.getAttribute('name') || el.getAttribute('aria-label'));
    return clean(el.textContent).slice(0, 120);
  }
  function role(el){
    var r = el.getAttribute && el.getAttribute('role'); if (r) return clean(r);
    var tag = el.tagName.toLowerCase();
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      var t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'submit' || t === 'button' || t === 'reset') return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      return 'textbox';
    }
    if (/^h[1-6]$/.test(tag)) return 'heading';
    return tag;
  }
  var SEL = 'a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=switch],[role=combobox],[contenteditable=""],[contenteditable=true],[onclick],[tabindex]:not([tabindex="-1"])';
  try { Array.prototype.forEach.call(document.querySelectorAll('[data-satr-ref]'), function(e){ e.removeAttribute('data-satr-ref'); }); } catch(e){}
  var els; try { els = Array.prototype.slice.call(document.querySelectorAll(SEL)); } catch(e){ els = []; }
  var out = [], n = 0, CAP = 200;
  for (var i = 0; i < els.length && out.length < CAP; i++) {
    var el = els[i];
    if (!vis(el)) continue;
    var ref = 'e' + (++n);
    try { el.setAttribute('data-satr-ref', ref); } catch(e){ continue; }
    var nm = name(el);
    var line = '[' + ref + '] ' + role(el) + (nm ? ' "' + nm.replace(/"/g, "'") + '"' : '');
    if (el.disabled) line += ' (معطّل)';
    out.push(line);
  }
  return { title: document.title, url: location.href, count: out.length, elements: out, truncated: out.length >= CAP };
})()`;

async function snapshot() {
  const wc = currentWC();
  if (!wc) return { error: 'closed' };
  await waitReady(wc);
  try {
    const data = await wc.executeJavaScript(SNAPSHOT_SCRIPT, true);
    return { ok: true, snap: data };
  } catch (e) { return { error: 'snapshot_failed' }; }
}

// انتظار ظهور نص أو عنصر (selector) في الصفحة بمهلة — للصفحات الديناميكية (SPA/بعد فعل).
// استقصاء دوري عبر executeJavaScript (بلا globals في الصفحة). يعيد {ok, found}.
const WAIT_FN = `function(opt){
  try {
    if (opt.selector) return { found: !!document.querySelector(opt.selector) };
    if (opt.text) return { found: ((document.body && document.body.innerText) || '').indexOf(opt.text) !== -1 };
  } catch(e){ return { found: false, err: 1 }; }
  return { found: false };
}`;

async function waitFor(cond, timeoutMs) {
  const wc = currentWC();
  if (!wc) return { error: 'closed' };
  const c = cond || {};
  if (!c.text && !c.selector) return { error: 'bad_condition' };
  const deadline = Date.now() + Math.min(Math.max(Number(timeoutMs) || 8000, 500), 30000);
  const arg = JSON.stringify({ text: c.text ? String(c.text).slice(0, 200) : '', selector: c.selector ? String(c.selector) : '' });
  while (Date.now() < deadline) {
    try {
      const r = await wc.executeJavaScript('(' + WAIT_FN + ')(' + arg + ')', true);
      if (r && r.err) return { error: 'bad_condition' };
      if (r && r.found) return { ok: true, found: true };
    } catch (e) {}
    await new Promise((res) => setTimeout(res, 250));
  }
  return { ok: true, found: false };
}

async function screenshot() {
  const wc = currentWC();
  if (!wc) return { error: 'closed' };
  await waitReady(wc);
  try {
    const img = await wc.capturePage();
    const png = img.toPNG();
    if (!png || !png.length) return { error: 'empty' };
    return { ok: true, base64: png.toString('base64') };
  } catch (e) { return { error: 'shot_failed' }; }
}

// ---------- أدوات الفعل في المعاينة (م-4 + ترقية ref 2026-07-12 — خلف إذن إلزامي) ----------
// الهدف (loc) إمّا **ref حتمي** من browser_snapshot (مثل e5 ⇒ [data-satr-ref="e5"]) أو
// مُحدِّد CSS (تراجع للتوافق مع م-4). يُهرَّب بـ JSON.stringify — لا حقن.
// **الأمان (حرج)**: أدوات agent.js تمرّ بـ canUseTool مثل Bash — مربع الإذن العربي كل
// مرة، bypassPermissions وحده يعفيها (لا acceptEdits). الإذن اليدوي لكل فعل أقوى من
// قائمة نطاقات (يعفي فعلاً لا نطاقاً) فلم تلزم. الكتابة عبر native value setter
// ليلتقطها React/Vue (input/change events)، والنقر el.click() بعد scrollIntoView.
// resolve: ref (^e\\d+$) ⇒ سمة data-satr-ref؛ غيره ⇒ querySelector (قد يرمي ⇒ bad_selector).
const CLICK_FN = `function(loc){
  function resolve(l){ l=String(l); if(/^e[0-9]+$/.test(l)) return document.querySelector('[data-satr-ref="'+l+'"]'); return document.querySelector(l); }
  var el; try { el = resolve(loc); } catch(e){ return {ok:false, reason:'bad_selector'}; }
  if (!el) return {ok:false, reason:'not_found'};
  try { el.scrollIntoView({block:'center', inline:'center'}); } catch(e){}
  try { el.click(); } catch(e){ return {ok:false, reason:'click_error'}; }
  return {ok:true, tag: el.tagName.toLowerCase(), text: (el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,80)};
}`;
const TYPE_FN = `function(loc, text){
  function resolve(l){ l=String(l); if(/^e[0-9]+$/.test(l)) return document.querySelector('[data-satr-ref="'+l+'"]'); return document.querySelector(l); }
  var el; try { el = resolve(loc); } catch(e){ return {ok:false, reason:'bad_selector'}; }
  if (!el) return {ok:false, reason:'not_found'};
  try {
    el.focus();
    var tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      var proto = tag === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      var desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, text); else el.value = text;
      el.dispatchEvent(new Event('input', {bubbles:true}));
      el.dispatchEvent(new Event('change', {bubbles:true}));
    } else if (el.isContentEditable) {
      el.textContent = text;
      el.dispatchEvent(new Event('input', {bubbles:true}));
    } else { return {ok:false, reason:'not_editable'}; }
  } catch(e){ return {ok:false, reason:'type_error'}; }
  return {ok:true, tag: el.tagName.toLowerCase()};
}`;

async function clickElement(locator) {
  const wc = currentWC();
  if (!wc) return { error: 'closed' };
  await waitReady(wc);
  try {
    const r = await wc.executeJavaScript('(' + CLICK_FN + ')(' + JSON.stringify(String(locator)) + ')', true);
    return r && r.ok ? { ok: true, tag: r.tag, text: r.text } : { error: (r && r.reason) || 'click_failed' };
  } catch (e) { return { error: 'click_failed' }; }
}

async function typeText(locator, text) {
  const wc = currentWC();
  if (!wc) return { error: 'closed' };
  await waitReady(wc);
  try {
    const r = await wc.executeJavaScript(
      '(' + TYPE_FN + ')(' + JSON.stringify(String(locator)) + ',' + JSON.stringify(String(text)) + ')', true);
    return r && r.ok ? { ok: true, tag: r.tag } : { error: (r && r.reason) || 'type_failed' };
  } catch (e) { return { error: 'type_failed' }; }
}

// ---------- إكمال طقم الأفعال (البند 2) — قائمة منسدلة/مفتاح/تمرير/تحويم ----------
// select/hover يُحلّان الهدف بنفس منطق ref-أو-selector (resolve مضمّن). press_key عبر
// sendInputEvent (أحداث مفاتيح حقيقية موثوقة — تُرسل للعرض المعزول وحده، فتُطلق سلوك
// النموذج الأصلي مثل إرسال النموذج بـ Enter، بعكس الحدث المُصطنع غير الموثوق).
const SELECT_FN = `function(loc, val){
  function resolve(l){ l=String(l); if(/^e[0-9]+$/.test(l)) return document.querySelector('[data-satr-ref="'+l+'"]'); return document.querySelector(l); }
  var el; try { el = resolve(loc); } catch(e){ return {ok:false, reason:'bad_selector'}; }
  if (!el) return {ok:false, reason:'not_found'};
  if (el.tagName !== 'SELECT') return {ok:false, reason:'not_select'};
  var opts = Array.prototype.slice.call(el.options), match = null, i;
  for (i=0;i<opts.length;i++){ if (opts[i].value === val){ match = opts[i]; break; } }
  if (!match) for (i=0;i<opts.length;i++){ if ((opts[i].textContent||'').replace(/\\s+/g,' ').trim() === val){ match = opts[i]; break; } }
  if (!match) return {ok:false, reason:'no_option'};
  el.value = match.value;
  el.dispatchEvent(new Event('input', {bubbles:true}));
  el.dispatchEvent(new Event('change', {bubbles:true}));
  return {ok:true, label: (match.textContent||'').replace(/\\s+/g,' ').trim().slice(0,80)};
}`;
const HOVER_FN = `function(loc){
  function resolve(l){ l=String(l); if(/^e[0-9]+$/.test(l)) return document.querySelector('[data-satr-ref="'+l+'"]'); return document.querySelector(l); }
  var el; try { el = resolve(loc); } catch(e){ return {ok:false, reason:'bad_selector'}; }
  if (!el) return {ok:false, reason:'not_found'};
  try { el.scrollIntoView({block:'center', inline:'center'}); } catch(e){}
  try {
    var r = el.getBoundingClientRect();
    var opt = {bubbles:true, cancelable:true, clientX:r.left+r.width/2, clientY:r.top+r.height/2};
    el.dispatchEvent(new MouseEvent('mouseover', opt));
    el.dispatchEvent(new MouseEvent('mouseenter', {bubbles:false, clientX:opt.clientX, clientY:opt.clientY}));
    el.dispatchEvent(new MouseEvent('mousemove', opt));
  } catch(e){ return {ok:false, reason:'hover_error'}; }
  return {ok:true, tag: el.tagName.toLowerCase()};
}`;
const SCROLL_FN = `function(dir, amount){
  var before = window.scrollY || document.documentElement.scrollTop || 0;
  var amt = amount || Math.round((window.innerHeight || 600) * 0.9);
  if (dir === 'top') window.scrollTo(0, 0);
  else if (dir === 'bottom') window.scrollTo(0, document.documentElement.scrollHeight);
  else if (dir === 'up') window.scrollBy(0, -amt);
  else window.scrollBy(0, amt);
  var after = window.scrollY || document.documentElement.scrollTop || 0;
  return {ok:true, scrollY: Math.round(after), moved: Math.round(after - before), max: Math.round(document.documentElement.scrollHeight)};
}`;

async function selectOption(locator, value) {
  const wc = currentWC();
  if (!wc) return { error: 'closed' };
  await waitReady(wc);
  try {
    const r = await wc.executeJavaScript(
      '(' + SELECT_FN + ')(' + JSON.stringify(String(locator)) + ',' + JSON.stringify(String(value)) + ')', true);
    return r && r.ok ? { ok: true, label: r.label } : { error: (r && r.reason) || 'select_failed' };
  } catch (e) { return { error: 'select_failed' }; }
}

async function hover(locator) {
  const wc = currentWC();
  if (!wc) return { error: 'closed' };
  await waitReady(wc);
  try {
    const r = await wc.executeJavaScript('(' + HOVER_FN + ')(' + JSON.stringify(String(locator)) + ')', true);
    return r && r.ok ? { ok: true, tag: r.tag } : { error: (r && r.reason) || 'hover_failed' };
  } catch (e) { return { error: 'hover_failed' }; }
}

async function scroll(direction, amount) {
  const wc = currentWC();
  if (!wc) return { error: 'closed' };
  await waitReady(wc);
  const dir = ['up', 'down', 'top', 'bottom'].indexOf(String(direction)) >= 0 ? String(direction) : 'down';
  const amt = Number(amount) > 0 ? Math.min(Number(amount), 20000) : 0;
  try {
    const r = await wc.executeJavaScript('(' + SCROLL_FN + ')(' + JSON.stringify(dir) + ',' + JSON.stringify(amt) + ')', true);
    return r && r.ok ? { ok: true, scrollY: r.scrollY, moved: r.moved, max: r.max } : { error: 'scroll_failed' };
  } catch (e) { return { error: 'scroll_failed' }; }
}

// أحداث مفاتيح حقيقية عبر sendInputEvent (على العنصر المركّز في العرض المعزول). خريطة
// أسماء ودّية → keyCodes Electron. الحصر بقائمة بيضاء (لا حروف عامة — الكتابة عبر browser_type).
const KEY_MAP = {
  Enter: 'Return', Tab: 'Tab', Escape: 'Escape', Backspace: 'Backspace', Delete: 'Delete',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
};
function pressKey(key) {
  const wc = currentWC();
  if (!wc) return { error: 'closed' };
  const code = KEY_MAP[String(key)];
  if (!code) return { error: 'bad_key' };
  try {
    wc.focus();
    wc.sendInputEvent({ type: 'keyDown', keyCode: code });
    wc.sendInputEvent({ type: 'keyUp', keyCode: code });
  } catch (e) { return { error: 'press_failed' }; }
  return { ok: true, key: String(key) };
}

// ---------- التقاط إطار للتسجيل (م-5) ----------
// المكوّن يطلب إطاراً دورياً (~8/ث) فنعيد PNG base64؛ الواجهة ترسمه على <canvas>
// وتسجّله بـ MediaRecorder ⇒ webm (صفر اعتماديات — كله APIs Chromium). حجم الإطار =
// أبعاد العرض. عائد سريع (بلا waitReady) — التسجيل يلتقط الحالة اللحظية أثناء التصفح.
async function captureFrame() {
  const wc = currentWC();
  if (!wc) return { error: 'closed' };
  try {
    const img = await wc.capturePage();
    const png = img.toPNG();
    if (!png || !png.length) return { error: 'empty' };
    const size = img.getSize();
    return { ok: true, base64: png.toString('base64'), width: size.width, height: size.height };
  } catch (e) { return { error: 'capture_failed' }; }
}

// إغلاق اللوحة = تدمير العرض كلياً (يحرّر الذاكرة؛ partition الدائمة تحفظ الكوكيز)
function close() {
  if (!view) return { ok: true };
  try { if (hostWin && !hostWin.isDestroyed()) hostWin.contentView.removeChildView(view); } catch (e) {}
  try { if (!view.webContents.isDestroyed()) view.webContents.close(); } catch (e) {}
  view = null;
  return { ok: true };
}

// عند إغلاق التطبيق (نفس فلسفة bgprocs/term)
function destroy() { close(); hostWin = null; sender = null; }

module.exports = { open, navigate, action, setBounds, startPick, cancelPick, readPage, snapshot, waitFor, getConsole, screenshot, clickElement, typeText, selectOption, hover, scroll, pressKey, captureFrame, close, destroy, isHttpUrl };
