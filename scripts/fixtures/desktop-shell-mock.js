// إضافة قنوات سطح ويندوز إلى جسر الـharness المزيف (electron/testspriteharness-client.js) — يُلحق به
// في خادم الاختبار وحده فلا يتغيّر ملفٌّ يُشحن. الغاية: تشغيل القشرة الحقيقية (src/index.html بـCSP
// الإنتاج) مع قنوات desktop* تحت السيطرة، وعدّ نداءاتها من الصفحة.
(() => {
  const state = {
    available: true,
    targetsCalls: 0,
    selectCalls: [],
    clearCalls: 0,
    violations: [],
    targets: [{
      targetId: 'w5', pid: 4321, processName: 'notepad.exe',
      title: 'desktop-step5.txt - Notepad', rect: { x: 10, y: 10, w: 800, h: 600 },
    }],
  };
  window.__DESKTOP_SHELL__ = state;
  window.addEventListener('securitypolicyviolation', (event) => {
    state.violations.push(event.effectiveDirective + ' ← ' + event.blockedURI);
  });
  // window.satr هنا Proxy على كائن الـharness بلا مصيدة set — فالكتابة تصل الهدف كما في ui-audit
  window.satr.desktopStatus = async () => ({ available: state.available === true });
  window.satr.desktopTargets = async () => {
    state.targetsCalls += 1;
    return { ok: true, targets: state.targets.map((t) => Object.assign({}, t, { rect: Object.assign({}, t.rect) })) };
  };
  window.satr.desktopSelect = async (targetId, pid) => {
    state.selectCalls.push([targetId, pid]);
    const target = state.targets.find((t) => t.targetId === targetId && t.pid === pid);
    if (!target) return { ok: false, error: 'not_found', message: 'النافذة لم تعد في القائمة — حدّث القائمة واختر من جديد.' };
    return { ok: true, target: Object.assign({}, target, { rect: Object.assign({}, target.rect) }) };
  };
  window.satr.desktopClear = async () => { state.clearCalls += 1; return { ok: true }; };
})();
