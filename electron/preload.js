/**
 * سطر 2.0 — جسر آمن بين الواجهة والعملية الرئيسية
 * الواجهة لا تصل لـ Node مباشرة، فقط عبر window.satr
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('satr', {
  preflight: () => ipcRenderer.invoke('satr:preflight'),
  features: () => ipcRenderer.invoke('satr:features'),
  providers: () => ipcRenderer.invoke('satr:providers'),
  keysList: () => ipcRenderer.invoke('satr:keysList'),
  keySet: (name, value) => ipcRenderer.invoke('satr:keySet', { name, value }),
  keyDelete: (name) => ipcRenderer.invoke('satr:keyDelete', { name }),
  pickFolder: () => ipcRenderer.invoke('satr:pickFolder'),
  send: (payload) => ipcRenderer.invoke('satr:send', payload),
  stop: () => ipcRenderer.invoke('satr:stop'),
  listSessions: () => ipcRenderer.invoke('satr:listSessions'),
  readSession: (project, id) => ipcRenderer.invoke('satr:readSession', { project, id }),
  listFiles: (cwd) => ipcRenderer.invoke('satr:listFiles', cwd),
  readFile: (cwd, rel) => ipcRenderer.invoke('satr:readFile', { cwd, rel }), // عارض القراءة (1.2)
  writeFile: (cwd, rel, content) => ipcRenderer.invoke('satr:writeFile', { cwd, rel, content }), // تحرير خفيف في العارض (الدفعة 4)
  searchFiles: (cwd, query) => ipcRenderer.invoke('satr:searchFiles', { cwd, query }), // بحث محتوى المشروع (الدفعة 4.6)
  gitChanges: (cwd) => ipcRenderer.invoke('satr:gitChanges', { cwd }), // لوحة تغييرات git (الدفعة 4.7)
  exportChat: (engine, sessionId, cwd) => ipcRenderer.invoke('satr:exportChat', { engine, sessionId, cwd }), // تصدير المحادثة (الدفعة 4.8)
  lastChat: (engine) => ipcRenderer.invoke('satr:lastChat', { engine }),     // ذاكرة المحوّلات (1.3)
  forgetChat: (engine) => ipcRenderer.invoke('satr:forgetChat', { engine }),
  listChats: () => ipcRenderer.invoke('satr:listChats'),                     // تصفح محادثات المحوّلات (الدفعة 4)
  readChat: (provider, id) => ipcRenderer.invoke('satr:readChat', { provider, id }),
  // قنوات Enterprise (الدفعة 3) — تفشل بهدوء في البناء المجتمعي (لا معالج مسجَّل)
  eeUsage: () => ipcRenderer.invoke('satr:ee:usage'),
  eeAudit: () => ipcRenderer.invoke('satr:ee:audit'),
  listSkills: (cwd) => ipcRenderer.invoke('satr:listSkills', cwd),
  mcpStatus: (cwd) => ipcRenderer.invoke('satr:mcpStatus', cwd),
  mcpAction: (cwd, name, action) => ipcRenderer.invoke('satr:mcpAction', { cwd, name, action }),
  contextUsage: (cwd, sessionId) => ipcRenderer.invoke('satr:contextUsage', { cwd, sessionId }),
  listCommands: (cwd) => ipcRenderer.invoke('satr:listCommands', cwd),
  listAgents: (cwd) => ipcRenderer.invoke('satr:listAgents', cwd),
  restartUpdate: () => ipcRenderer.invoke('satr:restartUpdate'),
  permission: (id, allow, always) => ipcRenderer.invoke('satr:permission', { id, allow, always }),
  undoEdit: (id) => ipcRenderer.invoke('satr:undoEdit', id),
  listBgProcs: () => ipcRenderer.invoke('satr:listBgProcs'),
  killBgProc: (id) => ipcRenderer.invoke('satr:killBgProc', id),
  onEvent: (callback) => {
    const handler = (_e, obj) => callback(obj);
    ipcRenderer.on('satr:event', handler);
    return () => ipcRenderer.removeListener('satr:event', handler);
  },
  // الطرفية المدمجة (المرحلة 8) — قناة أحداث مستقلة عالية الإنتاجية satr:term
  termStart: (cwd, cols, rows) => ipcRenderer.invoke('satr:termStart', { cwd, cols, rows }),
  termInput: (id, data) => ipcRenderer.invoke('satr:termInput', { id, data }),
  termResize: (id, cols, rows) => ipcRenderer.invoke('satr:termResize', { id, cols, rows }),
  termKill: (id) => ipcRenderer.invoke('satr:termKill', { id }),
  onTerm: (callback) => {
    const handler = (_e, obj) => callback(obj);
    ipcRenderer.on('satr:term', handler);
    return () => ipcRenderer.removeListener('satr:term', handler);
  },
  // لوحة المعاينة المدمجة (م-1 — الدفعة 5) — قناة أحداث مستقلة satr:preview
  previewOpen: (url) => ipcRenderer.invoke('satr:previewOpen', { url }),
  previewNavigate: (url) => ipcRenderer.invoke('satr:previewNavigate', { url }),
  previewAction: (action) => ipcRenderer.invoke('satr:previewAction', { action }),
  previewBounds: (x, y, width, height) => ipcRenderer.invoke('satr:previewBounds', { x, y, width, height }),
  previewClose: () => ipcRenderer.invoke('satr:previewClose'),
  onPreview: (callback) => {
    const handler = (_e, obj) => callback(obj);
    ipcRenderer.on('satr:preview', handler);
    return () => ipcRenderer.removeListener('satr:preview', handler);
  },
});
