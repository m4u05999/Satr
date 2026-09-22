'use strict';
// مدير أبناء المعاينة: Electron ينشئ علاقة opener الأصلية، ونحن نملك العرض ودورة حياته.
const MAX_POPUPS = 3;
const IDLE_MS = 10 * 60 * 1000;
function popupHint(url) {
  try {
    const u = new URL(url), q = u.searchParams;
    return q.get('display') === 'popup' || q.get('redirect_uri') === 'gis_transform'
      || (q.get('response_type') === 'token' && q.has('origin'))
      || /\/(oidclink|oauth\/oidc)(\/|$)/.test(u.pathname);
  } catch { return false; }
}
function callbackHint(url) {
  try { const u = new URL(url); return u.searchParams.has('code') || new URLSearchParams(u.hash.slice(1)).has('access_token'); }
  catch { return false; }
}
function createPopupManager({ WebContentsView, host, root, changed, wire, allowed, warn,
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  const records = [];
  let closing = false;
  const active = () => records.length ? records[records.length - 1] : null;
  const find = wc => records.find(r => r.wc === wc);
  function touch(wc) {
    const record = find(wc);
    if (!record) return;
    clearTimer(record.timer);
    record.timer = setTimer(() => {
      warn('أُغلقت نافذة منبثقة بعد عشر دقائق بلا تفاعل. أعد بدء الربط إن لم يكتمل.');
      close(record.wc);
    }, IDLE_MS);
    if (record.timer && record.timer.unref) record.timer.unref();
  }
  function retire(wc) {
    const record = find(wc);
    if (!record) return false;
    // افصل السجل قبل التدمير؛ أحداث destroyed قد تعود متداخلة.
    records.splice(records.indexOf(record), 1);
    clearTimer(record.timer);
    for (const child of records.filter(r => r.parent === wc)) close(child.wc);
    try { const win = host(); if (win && !win.isDestroyed()) win.contentView.removeChildView(record.view); } catch {}
    if (!closing) changed();
    return true;
  }
  function close(wc) {
    if (!retire(wc)) return false;
    try { if (!wc.isDestroyed()) wc.close({ waitForBeforeUnload: false }); } catch {}
    return true;
  }
  function closeAll() {
    closing = true;
    for (const record of records.slice().reverse()) close(record.wc);
    closing = false;
  }
  function handler(parent, details) {
    const win = host(), top = active();
    if (!win || win.isDestroyed() || parent.isDestroyed()
        || parent !== (top ? top.wc : root()) || records.length >= MAX_POPUPS
        || !(details.url === 'about:blank' || allowed(details.url))) {
      warn('حُجبت نافذة منبثقة؛ الصفحة الأصلية ما زالت مفتوحة. أغلق نافذة الربط السابقة ثم أعد المحاولة.');
      return { action: 'deny' };
    }
    return {
      action: 'allow',
      createWindow(options) {
        // إبقاء خيارات Electron الداخلية ضروري لعلاقة opener وPOST؛ لا loadURL بديلة.
        const preferences = { ...options.webPreferences, session: parent.session,
          sandbox: true, contextIsolation: true, nodeIntegration: false,
          nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false,
          webSecurity: true, allowRunningInsecureContent: false, backgroundThrottling: false };
        delete preferences.preload;
        const child = new WebContentsView({ ...options, webPreferences: preferences });
        const wc = child.webContents;
        // احفظ WebContents بذاتها: getter العرض قد يصير undefined بعد destroyed.
        const dimension = (value, fallback, min, max) => Number.isFinite(value)
          ? Math.max(min, Math.min(max, Math.round(value))) : fallback;
        const record = { view: child, wc, parent, timer: null,
          width: dimension(options.width, 500, 240, 1200),
          height: dimension(options.height, 650, 240, 1000),
          x: Number.isFinite(options.x) ? options.x : null,
          y: Number.isFinite(options.y) ? options.y : null };
        records.push(record);
        wc.once('destroyed', () => retire(wc));
        wc.once('render-process-gone', () => close(wc));
        wire(wc);
        win.contentView.addChildView(child);
        touch(wc);
        changed();
        return wc;
      },
    };
  }
  function bounds(box, viewport) {
    const record = active();
    if (!record || !box || !(box.width > 0) || !(box.height > 0)) return box;
    const width = Math.min(box.width, viewport ? viewport.width : record.width);
    const height = Math.min(box.height, viewport && viewport.height || record.height);
    // إحداثيات window.open شاشة، وحدود المعاينة داخل النافذة؛ نحولها ونحصرها داخل اللوحة.
    const win = host(), content = win && win.getContentBounds ? win.getContentBounds() : {x:0,y:0};
    const x = record.x === null ? box.x + Math.floor((box.width - width) / 2)
      : Math.max(box.x, Math.min(box.x + box.width - width, record.x - (content.x || 0)));
    const y = record.y === null ? box.y
      : Math.max(box.y, Math.min(box.y + box.height - height, record.y - (content.y || 0)));
    return {x: Math.round(x), y: Math.round(y), width, height};
  }
  return { active, find, handler, touch, close, closeAll, bounds,
    records: () => records.slice(), count: () => records.length };
}
module.exports = { createPopupManager, popupHint, callbackHint, MAX_POPUPS, IDLE_MS };
