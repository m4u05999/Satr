/**
 * سطر 2.0 — جسر آمن بين الواجهة والعملية الرئيسية
 * الواجهة لا تصل لـ Node مباشرة، فقط عبر window.satr
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('satr', {
  preflight: () => ipcRenderer.invoke('satr:preflight'),
  features: () => ipcRenderer.invoke('satr:features'),
  activityList: (cwd) => ipcRenderer.invoke('satr:activityList', { cwd }),
  activityClear: (cwd, confirmed) => ipcRenderer.invoke('satr:activityClear', { cwd, confirmed }),
  providers: () => ipcRenderer.invoke('satr:providers'),
  claudeModels: () => ipcRenderer.invoke('satr:claudeModels'),
  claudeAccount: () => ipcRenderer.invoke('satr:claudeAccount'),
  codexStatus: () => ipcRenderer.invoke('satr:codexStatus'),
  codexModels: () => ipcRenderer.invoke('satr:codexModels'),
  codexRateLimits: () => ipcRenderer.invoke('satr:codexRateLimits'),
  kimiStatus: () => ipcRenderer.invoke('satr:kimiStatus'),
  kimiModels: () => ipcRenderer.invoke('satr:kimiModels'), // نماذج Kimi المعلنة عبر ACP (مُنقّاة في main)
  kimiLogin: (cwd) => ipcRenderer.invoke('satr:kimiLogin', cwd), // يشغّل `kimi login` في طرفية مرئية دون أتمتة إدخال
  keysList: () => ipcRenderer.invoke('satr:keysList'),
  keySet: (name, value) => ipcRenderer.invoke('satr:keySet', { name, value }),
  keyDelete: (name) => ipcRenderer.invoke('satr:keyDelete', { name }),
  pickFolder: () => ipcRenderer.invoke('satr:pickFolder'),
  send: (payload) => ipcRenderer.invoke('satr:send', payload),
  stop: () => ipcRenderer.invoke('satr:stop'),
  listSessions: () => ipcRenderer.invoke('satr:listSessions'),
  readSession: (project, id) => ipcRenderer.invoke('satr:readSession', { project, id }),
  sessionMetaList: () => ipcRenderer.invoke('satr:sessionMetaList'),
  sessionMetaSet: (sessionId, patch) => ipcRenderer.invoke('satr:sessionMetaSet', { ...(patch || {}), sessionId }),
  sessionFork: (sessionId, upToMessageId, title) => ipcRenderer.invoke('satr:sessionFork', {
    sessionId, upToMessageId, title,
  }),
  rewindFiles: (cwd, sessionId, userMessageId, dryRun, confirmed, previewToken) => ipcRenderer.invoke('satr:rewindFiles', {
    cwd, sessionId, userMessageId, dryRun, confirmed, previewToken,
  }),
  listCodexSessions: () => ipcRenderer.invoke('satr:listCodexSessions'),
  readCodexSession: (id) => ipcRenderer.invoke('satr:readCodexSession', { id }),
  nameCodexSession: (id, name) => ipcRenderer.invoke('satr:nameCodexSession', { id, name }),
  archiveCodexSession: (id) => ipcRenderer.invoke('satr:archiveCodexSession', { id }),
  deleteCodexSession: (id) => ipcRenderer.invoke('satr:deleteCodexSession', { id }),
  forkCodexSession: (id) => ipcRenderer.invoke('satr:forkCodexSession', { id }),
  listKimiSessions: () => ipcRenderer.invoke('satr:listKimiSessions'),
  readKimiSession: (id) => ipcRenderer.invoke('satr:readKimiSession', { id }),
  listFiles: (cwd) => ipcRenderer.invoke('satr:listFiles', cwd),
  readFile: (cwd, rel) => ipcRenderer.invoke('satr:readFile', { cwd, rel }), // عارض القراءة (1.2)
  writeFile: (cwd, rel, content, version) => ipcRenderer.invoke('satr:writeFile', { cwd, rel, content, version }), // تحرير خفيف في العارض (الدفعة 4)
  searchFiles: (cwd, query) => ipcRenderer.invoke('satr:searchFiles', { cwd, query }), // بحث محتوى المشروع (الدفعة 4.6)
  gitChanges: (cwd) => ipcRenderer.invoke('satr:gitChanges', { cwd }), // لوحة تغييرات git (الدفعة 4.7)
  gitAction: (cwd, op, rel, message) => ipcRenderer.invoke('satr:gitAction', { cwd, op, rel, message }), // أفعال git (stage/unstage/discard/commit)
  exportChat: (engine, sessionId, cwd) => ipcRenderer.invoke('satr:exportChat', { engine, sessionId, cwd }), // تصدير المحادثة (الدفعة 4.8)
  lastChat: (engine) => ipcRenderer.invoke('satr:lastChat', { engine }),     // ذاكرة المحوّلات (1.3)
  forgetChat: (engine) => ipcRenderer.invoke('satr:forgetChat', { engine }),
  listChats: () => ipcRenderer.invoke('satr:listChats'),                     // تصفح محادثات المحوّلات (الدفعة 4)
  readChat: (provider, id) => ipcRenderer.invoke('satr:readChat', { provider, id }),
  taskLedger: (engine, sessionId) => ipcRenderer.invoke('satr:taskLedger', { engine, sessionId }),
  taskAction: (engine, sessionId, action) => ipcRenderer.invoke('satr:taskAction', { engine, sessionId, action }),
  checkpointLatest: (engine, sessionId) => ipcRenderer.invoke('satr:checkpointLatest', { engine, sessionId }),
  checkpointRestore: (engine, sessionId, checkpointId, cwd) => ipcRenderer.invoke('satr:checkpointRestore', { engine, sessionId, checkpointId, cwd }),
  verifyCheckpoint: (engine, sessionId, checkpointId, cwd, checks) => ipcRenderer.invoke('satr:verifyCheckpoint', { engine, sessionId, checkpointId, cwd, checks }),
  verifyConfigCreate: (cwd, commands, overwrite, confirmed) => ipcRenderer.invoke('satr:verifyConfigCreate', {
    cwd, commands, overwrite, confirmed,
  }),
  memoryList: (cwd, query) => ipcRenderer.invoke('satr:memoryList', { cwd, query }),
  memorySave: (cwd, candidate) => ipcRenderer.invoke('satr:memorySave', { cwd, candidate }),
  memoryUpdate: (cwd, id, patch) => ipcRenderer.invoke('satr:memoryUpdate', { cwd, id, patch }),
  memoryDelete: (cwd, id) => ipcRenderer.invoke('satr:memoryDelete', { cwd, id }),
  researchStart: (cwd, question, count) => ipcRenderer.invoke('satr:researchStart', { cwd, question, count }),
  researchStop: (runId) => ipcRenderer.invoke('satr:researchStop', { runId }),
  researchLatest: (cwd) => ipcRenderer.invoke('satr:researchLatest', { cwd }),
  executionStart: (cwd, task, confirmed) => ipcRenderer.invoke('satr:executionStart', { cwd, task, confirmed }),
  executionStop: (runId) => ipcRenderer.invoke('satr:executionStop', { runId }),
  executionLatest: (cwd) => ipcRenderer.invoke('satr:executionLatest', { cwd }),
  executionTeamStart: (cwd, agents, confirmed, mode, timeoutSeconds) => ipcRenderer.invoke('satr:executionTeamStart', {
    cwd, agents, confirmed, mode, timeoutSeconds,
  }),
  executionTeamStop: (runId) => ipcRenderer.invoke('satr:executionTeamStop', { runId }),
  executionTeamExtend: (runId) => ipcRenderer.invoke('satr:executionTeamExtend', { runId }),
  executionTeamLatest: (cwd) => ipcRenderer.invoke('satr:executionTeamLatest', { cwd }),
  executionReviewStart: (teamId) => ipcRenderer.invoke('satr:executionReviewStart', { teamId }),
  executionReviewStop: (reviewId) => ipcRenderer.invoke('satr:executionReviewStop', { reviewId }),
  executionReviewLatest: (teamId) => ipcRenderer.invoke('satr:executionReviewLatest', { teamId }),
  executionFileDiff: (teamId, artifactId, rel) => ipcRenderer.invoke('satr:executionFileDiff', {
    teamId, artifactId, rel,
  }),
  executionVerificationPrepare: (teamId, reviewId) => ipcRenderer.invoke('satr:executionVerificationPrepare', { teamId, reviewId }),
  executionVerificationRun: (teamId, reviewId, artifactId, confirmed) => ipcRenderer.invoke('satr:executionVerificationRun', { teamId, reviewId, artifactId, confirmed }),
  executionVerificationStop: (artifactId) => ipcRenderer.invoke('satr:executionVerificationStop', { artifactId }),
  executionVerificationLatest: (teamId) => ipcRenderer.invoke('satr:executionVerificationLatest', { teamId }),
  executionPreviewStart: (cwd, teamId, artifactId, confirmed) => ipcRenderer.invoke('satr:executionPreviewStart', {
    cwd, teamId, artifactId, confirmed,
  }),
  executionPreviewStop: () => ipcRenderer.invoke('satr:executionPreviewStop'),
  executionMerge: (teamId, reviewId, confirmed) => ipcRenderer.invoke('satr:executionMerge', { teamId, reviewId, confirmed }),
  opsRoomLoad: (roomId) => ipcRenderer.invoke('satr:opsRoomLoad', { roomId }),
  opsRoomHistory: (cwd) => ipcRenderer.invoke('satr:opsRoomHistory', { cwd }),
  opsRoomRestore: (cwd, roomId, artifactId, confirmed) => ipcRenderer.invoke('satr:opsRoomRestore', {
    cwd, roomId, artifactId, confirmed,
  }),
  opsRoomArtifactDelete: (cwd, roomId, artifactId, confirmed) => ipcRenderer.invoke('satr:opsRoomArtifactDelete', {
    cwd, roomId, artifactId, confirmed,
  }),
  opsBrainstormStart: (cwd, brief, teamId) => ipcRenderer.invoke('satr:opsBrainstormStart', { cwd, brief, teamId }),
  opsBrainstormStop: (runId) => ipcRenderer.invoke('satr:opsBrainstormStop', { runId }),
  opsBrainstormLatest: (cwd) => ipcRenderer.invoke('satr:opsBrainstormLatest', { cwd }),
  opsPlanStart: (cwd, task) => ipcRenderer.invoke('satr:opsPlanStart', { cwd, task }),
  opsPlanStop: (runId) => ipcRenderer.invoke('satr:opsPlanStop', { runId }),
  opsPlanLatest: (cwd) => ipcRenderer.invoke('satr:opsPlanLatest', { cwd }),
  opsRoomDecision: (roomId, text, teamId, artifactId, confirmed) => ipcRenderer.invoke('satr:opsRoomDecision', { roomId, text, teamId, artifactId, confirmed }),
  // قنوات Enterprise (الدفعة 3) — تفشل بهدوء في البناء المجتمعي (لا معالج مسجَّل)
  eeUsage: () => ipcRenderer.invoke('satr:ee:usage'),
  eeAudit: () => ipcRenderer.invoke('satr:ee:audit'),
  listSkills: (cwd) => ipcRenderer.invoke('satr:listSkills', cwd),
  mcpStatus: (cwd, engine) => ipcRenderer.invoke('satr:mcpStatus', { cwd, engine }),
  mcpAction: (cwd, name, action, engine) => ipcRenderer.invoke('satr:mcpAction', { cwd, name, action, engine }),
  // C3: تسجيل دخول موصّل Codex — الرابط لا يعبر هنا؛ الفتح بمعرّف الطلب فقط
  mcpOauthStart: (cwd, name) => ipcRenderer.invoke('satr:mcpOauthStart', { cwd, name }),
  mcpOauthOpen: (id) => ipcRenderer.invoke('satr:mcpOauthOpen', { id }),
  mcpOauthCancel: (id) => ipcRenderer.invoke('satr:mcpOauthCancel', { id }),
  contextUsage: (cwd, sessionId, engine) => ipcRenderer.invoke('satr:contextUsage', { cwd, sessionId, engine }),
  listCommands: (cwd) => ipcRenderer.invoke('satr:listCommands', cwd),
  listAgents: (cwd) => ipcRenderer.invoke('satr:listAgents', cwd),
  downloadUpdate: () => ipcRenderer.invoke('satr:downloadUpdate'),
  restartUpdate: () => ipcRenderer.invoke('satr:restartUpdate'),
  permission: (id, allow, always, turn) => ipcRenderer.invoke('satr:permission', { id, allow, always, turn }),
  answerQuestion: (id, selections) => ipcRenderer.invoke('satr:answerQuestion', { id, selections }), // AskUserQuestion (SDK)
  elicitationDone: (id, action, content) => ipcRenderer.invoke('satr:elicitationDone', { id, action, ...(content === undefined ? {} : { content }) }), // إدخال موصّلات Claude غير السري
  backgroundTask: (toolUseId) => ipcRenderer.invoke('satr:backgroundTask', { toolUseId }), // الدفعة D: Bash/وكيل Claude الجاري
  stopSdkTask: (taskId) => ipcRenderer.invoke('satr:stopSdkTask', { taskId }), // إيقاف مهمة SDK الخلفية فقط
  steer: (text) => ipcRenderer.invoke('satr:steer', { text }), // C1: توجيه الدور الجاري (Codex — turn/steer)
  handoffDone: (id, done) => ipcRenderer.invoke('satr:handoffDone', { id, done }), // التسليم البشري browser_handoff (استلمت/إلغاء)
  secretDone: (id, done) => ipcRenderer.invoke('satr:secretDone', { id, done }), // إدخال سر داخل حقل المعاينة بلا إعادة قيمته
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
  termList: () => ipcRenderer.invoke('satr:termList'),
  termReadBuffer: (id, tailBytes) => ipcRenderer.invoke('satr:termReadBuffer', { id, tailBytes }),
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
  previewOpenAgent: (url) => ipcRenderer.invoke('satr:previewOpenAgent', { url }),
  previewNavigateAgent: (url) => ipcRenderer.invoke('satr:previewNavigateAgent', { url }),
  previewAction: (action) => ipcRenderer.invoke('satr:previewAction', { action }),
  previewBounds: (x, y, width, height) => ipcRenderer.invoke('satr:previewBounds', { x, y, width, height }),
  previewPick: () => ipcRenderer.invoke('satr:previewPick'),             // م-2: التحديد بالتأشير
  previewPickCancel: () => ipcRenderer.invoke('satr:previewPickCancel'),
  previewFrame: () => ipcRenderer.invoke('satr:previewFrame'),           // م-5: إطار للتسجيل
  previewElementShot: (selector) => ipcRenderer.invoke('satr:previewElementShot', { selector }),
  previewClose: () => ipcRenderer.invoke('satr:previewClose'),
  promoCaptureStart: (aspect, url, confirmed) => ipcRenderer.invoke('satr:promoCaptureStart', { aspect, url, confirmed }),
  promoCaptureStop: () => ipcRenderer.invoke('satr:promoCaptureStop'),
  promoCaptureReady: (sessionId, ok, error) => ipcRenderer.invoke('satr:promoCaptureReady', { sessionId, ok, error }),
  promoCaptureCommit: (sessionId, durationMs, filename) => ipcRenderer.invoke('satr:promoCaptureCommit', {
    sessionId, durationMs, filename,
  }),
  promoCaptureAbort: (sessionId, error) => ipcRenderer.invoke('satr:promoCaptureAbort', { sessionId, error }),
  promoStudioState: () => ipcRenderer.invoke('satr:promoStudioState'),
  promoAssetUrl: (assetPath) => ipcRenderer.invoke('satr:promoAssetUrl', { path: assetPath }),
  devServerInfo: (cwd) => ipcRenderer.invoke('satr:devServerInfo', { cwd }),
  devServerRestart: (cwd) => ipcRenderer.invoke('satr:devServerRestart', { cwd }),
  onPreview: (callback) => {
    const handler = (_e, obj) => callback(obj);
    ipcRenderer.on('satr:preview', handler);
    return () => ipcRenderer.removeListener('satr:preview', handler);
  },
  onPromoCapture: (callback) => {
    const handler = (_e, obj) => callback(obj);
    ipcRenderer.on('satr:promo', handler);
    return () => ipcRenderer.removeListener('satr:promo', handler);
  },
});
