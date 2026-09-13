'use strict';
/**
 * مراقب الاتصال — يبدأ **بعد** أول خطأ شبكة مصنَّف (neterror) لا دائماً، ويفحص حلّ الأسماء كل
 * بضع ثوانٍ حتى تعود الشبكة أو ينقضي سقفه، ويبثّ حدثين فقط: `connectivity {online:false}` عند
 * أول فشل مؤكَّد و`connectivity {online:true, downMs}` عند العودة. (2026-09-13)
 *
 * لماذا فحص DNS لا `navigator.onLine`: على هذا الجهاز محوّلا Hyper-V وVirtualBox «Up» دائماً
 * فيبقى Chromium يظنّ الجهاز متصلاً بينما الواي-فاي ساقط. حلّ اسم مضيف حقيقي هو الدليل الوحيد.
 *
 * لا يفحص إلا عند الحاجة (خصوصية وبطارية)، ويتوقف بنفسه بعد `maxMs` مع حدث `gaveUp` معلن —
 * لا صمت. كل التوقيت والبحث قابل للحقن للاختبار القطعي بلا شبكة.
 */

const DEFAULT_HOSTS = ['api.anthropic.com', 'api.openai.com', 'www.google.com'];

function create(options = {}) {
  const lookup = options.lookup || ((host) => require('node:dns').promises.lookup(host));
  const now = options.now || Date.now;
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const intervalMs = Number.isFinite(options.intervalMs) ? options.intervalMs : 5000;
  const maxMs = Number.isFinite(options.maxMs) ? options.maxMs : 20 * 60 * 1000;
  const hosts = Array.isArray(options.hosts) && options.hosts.length ? options.hosts : DEFAULT_HOSTS;
  const onChange = typeof options.onChange === 'function' ? options.onChange : () => {};

  let timer = null;
  let watching = false;
  let offlineSince = 0;
  let announcedOffline = false;
  let lastCode = '';
  let lastEngine = '';
  let probing = false;

  async function probe() {
    for (const host of hosts) {
      try { await lookup(host); return true; } catch { /* جرّب التالي */ }
    }
    return false;
  }

  function stop() {
    if (timer) { clearTimer(timer); timer = null; }
    watching = false;
    probing = false;
  }

  function schedule() {
    if (!watching) return;
    timer = setTimer(() => { timer = null; tick().catch(() => {}); }, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  async function tick() {
    if (!watching || probing) return;
    probing = true;
    let online = false;
    try { online = await probe(); } finally { probing = false; }
    if (!watching) return;
    if (online) {
      const downMs = announcedOffline ? Math.max(0, now() - offlineSince) : 0;
      const wasAnnounced = announcedOffline;
      stop();
      // عودة بلا إعلان انقطاع سابق = الخطأ كان عابراً والشبكة سليمة الآن؛ نقولها كي يعيد المحاولة.
      onChange({ type: 'connectivity', online: true, downMs, recovered: wasAnnounced, engine: lastEngine });
      return;
    }
    if (!announcedOffline) {
      announcedOffline = true;
      onChange({ type: 'connectivity', online: false, code: lastCode, engine: lastEngine, since: new Date(offlineSince).toISOString() });
    }
    if (now() - offlineSince >= maxMs) {
      stop();
      onChange({ type: 'connectivity', online: false, gaveUp: true, code: lastCode, engine: lastEngine, downMs: now() - offlineSince });
      return;
    }
    schedule();
  }

  /** يُستدعى عند كل خطأ شبكة مصنَّف؛ يبدأ المراقبة إن لم تكن جارية ويفحص فوراً. */
  function noteFailure(info = {}) {
    lastCode = typeof info.code === 'string' ? info.code.slice(0, 40) : lastCode;
    lastEngine = typeof info.engine === 'string' ? info.engine.slice(0, 40) : lastEngine;
    if (watching) return false;
    watching = true;
    announcedOffline = false;
    offlineSince = now();
    tick().catch(() => {});
    return true;
  }

  return {
    noteFailure,
    stop,
    isWatching: () => watching,
    // للاختبار: فحص واحد صريح بلا مراقبة
    probe,
  };
}

module.exports = { create, DEFAULT_HOSTS };
