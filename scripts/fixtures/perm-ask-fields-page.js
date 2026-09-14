// صفحة حارس `perm-ask-fields` (‏OBS-192): تزرع جسراً مزيّفاً باسم `window.satr` **قبل**
// تحميل المكوّن الحقيقي، لأن `_answer` يستدعي `window.satr.permission` مباشرةً (نفس الأصل).
// الجسر يسجّل النداءات ولا يتصل بشيء — لا شبكة ولا IPC في هذا الحارس.
window.__permCalls = [];
window.satr = {
  permission(id, allow, always, turn) {
    window.__permCalls.push({ id, allow, always, turn });
    return true;
  },
};
await import('../../src/ui/components/perm-dialog.js');
window.__permReady = true;
