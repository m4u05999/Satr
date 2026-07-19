'use strict';

(() => {
  const calls = [];
  const channels = { event: new Set(), term: new Set(), preview: new Set() };
  let sessionSeq = 0;
  let autoRespond = true;
  let sessionRows = [];
  const sessionMeta = {};

  function remember(name, args) {
    calls.push({ name, args: Array.from(args), at: Date.now() });
  }

  function subscribe(channel, callback) {
    if (typeof callback !== 'function') return () => {};
    channels[channel].add(callback);
    return () => channels[channel].delete(callback);
  }

  function publish(channel, value) {
    for (const callback of channels[channel]) {
      try { callback(value); } catch (error) { /* عزل مستمع fixture كي لا يكسر البقية */ }
    }
  }

  function later(callback) {
    setTimeout(callback, 20);
  }

  const api = {
    preflight: async () => ({
      node: { ok: true, version: '22.0.0' },
      claude: { ok: true, version: 'TestSprite harness', outdated: false },
    }),
    features: async () => ({}),
    activityList: async function activityList() {
      remember('activityList', arguments);
      return {
        ok: true,
        count: 1,
        entries: [{ ts: Date.now(), kind: 'result', engine: 'sdk', is_error: false, duration_ms: 20 }],
      };
    },
    activityClear: async function activityClear() {
      remember('activityClear', arguments);
      return { ok: false, error: 'disabled_in_harness' };
    },
    providers: async () => ({
      providers: [],
      integrations: [{ name: 'testsprite', label: 'TestSprite', keyName: 'TESTSPRITE_API_KEY', kind: 'integration' }],
    }),
    codexStatus: async () => ({ installed: true, loggedIn: true }),
    keysList: async () => ({ names: [] }),
    keySet: async () => ({ ok: false, error: 'disabled_in_harness' }),
    keyDelete: async () => ({ ok: false, error: 'disabled_in_harness' }),
    pickFolder: async () => 'D:\\sater\\satr-2',
    lastChat: async () => ({ sid: null }),
    forgetChat: async () => ({ ok: true }),
    listChats: async () => [],
    listSessions: async () => sessionRows.map((row) => ({ ...row })),
    listCodexSessions: async () => [],
    sessionMetaList: async () => ({ ok: true, entries: { ...sessionMeta } }),
    sessionMetaSet: async function sessionMetaSet(sessionId, patch) {
      remember('sessionMetaSet', arguments);
      const previous = sessionMeta[sessionId] || {};
      const next = { ...previous, ...(patch || {}) };
      if (next.title === '') delete next.title;
      if (next.pinned === false) delete next.pinned;
      if (Object.keys(next).length) sessionMeta[sessionId] = next;
      else delete sessionMeta[sessionId];
      return { ok: true, entry: sessionMeta[sessionId] || {} };
    },
    readChat: async () => ({ messages: [] }),
    readSession: async () => ({ messages: [] }),
    readCodexSession: async () => ({ messages: [] }),
    taskLedger: async () => ({ ok: true, tasks: [] }),
    taskAction: async () => ({ ok: true }),
    checkpointLatest: async () => ({ ok: true, checkpoint: null }),
    checkpointRestore: async () => ({ ok: false, error: 'disabled_in_harness' }),
    verifyCheckpoint: async () => ({ ok: false, error: 'disabled_in_harness' }),
    verifyConfigCreate: async () => ({ ok: false, error: 'disabled_in_harness' }),
    listFiles: async () => ['src/index.html', 'src/ui/app.js', 'src/styles/base.css'],
    searchFiles: async () => ({ ok: true, results: [] }),
    readFile: async (_cwd, rel) => ({ ok: true, rel, content: 'TestSprite harness: قراءة تجريبية فقط.', version: 'harness' }),
    writeFile: async () => ({ ok: false, error: 'disabled_in_harness' }),
    gitChanges: async () => ({ ok: true, files: [] }),
    gitAction: async () => ({ ok: false, error: 'disabled_in_harness' }),
    exportChat: async () => ({ ok: false, error: 'disabled_in_harness' }),
    listSkills: async () => [],
    listAgents: async () => [],
    listCommands: async () => ({ ok: true, commands: [] }),
    listBgProcs: async () => [],
    killBgProc: async () => ({ ok: true }),
    memoryList: async () => ({ ok: true, items: [] }),
    memorySave: async () => ({ ok: false, error: 'disabled_in_harness' }),
    memoryUpdate: async () => ({ ok: false, error: 'disabled_in_harness' }),
    memoryDelete: async () => ({ ok: false, error: 'disabled_in_harness' }),
    researchLatest: async () => ({ ok: true, run: null }),
    researchStart: async () => ({ ok: false, error: 'disabled_in_harness' }),
    researchStop: async () => ({ ok: true }),
    mcpStatus: async () => ({ ok: true, servers: [] }),
    mcpAction: async () => ({ ok: false, error: 'disabled_in_harness' }),
    contextUsage: async () => ({ ok: true, usage: { percentage: 42, totalTokens: 42, maxTokens: 100, categories: [] } }),
    opsBrainstormLatest: async () => ({ ok: true, run: null }),
    opsPlanLatest: async () => ({ ok: true, run: null }),
    executionTeamLatest: async () => ({ ok: true, team: null }),
    executionReviewLatest: async () => ({ ok: true, review: null }),
    executionVerificationLatest: async () => ({ ok: true, verification: null }),
    opsRoomLoad: async () => ({ ok: true, room: { room_id: 'testsprite-harness', entries: [] } }),
    opsRoomHistory: async () => ({ ok: true, rooms: [] }),
    eeUsage: async () => ({ ok: false }),
    eeAudit: async () => ({ ok: false }),
    permission: async () => ({ ok: true }),
    answerQuestion: async () => ({ ok: true }),
    undoEdit: async () => ({ ok: false, error: 'disabled_in_harness' }),
    downloadUpdate: async () => ({ ok: false, error: 'disabled_in_harness' }),
    restartUpdate: async () => ({ ok: false, error: 'disabled_in_harness' }),

    send: async (payload) => {
      remember('send', [payload]);
      const sessionId = 'testsprite-harness-' + (++sessionSeq);
      if (autoRespond) later(() => {
        publish('event', { type: 'system', subtype: 'init', session_id: sessionId });
        publish('event', {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'هذه استجابة محاكاة من بيئة TestSprite؛ لم يُستدعَ أي نموذج حقيقي.' }],
          },
        });
        publish('event', { type: 'result', session_id: sessionId, cost_usd: 0, duration_ms: 20 });
        publish('event', { type: 'proc_done', code: 0 });
      });
      return { started: true, engine: (payload && payload.engine) || 'sdk' };
    },
    stop: async function stop() {
      remember('stop', arguments);
      publish('event', { type: 'proc_done', code: 0 });
      return { stopped: true };
    },
    onEvent: (callback) => subscribe('event', callback),

    termStart: async () => {
      const id = 'testsprite-harness-term';
      later(() => publish('term', { type: 'data', id, data: 'TestSprite harness terminal\r\n' }));
      return { ok: true, id };
    },
    termInput: async () => ({ ok: true }),
    termResize: async () => ({ ok: true }),
    termKill: async () => ({ ok: true }),
    onTerm: (callback) => subscribe('term', callback),

    previewOpen: async () => ({ ok: false, error: 'disabled_in_harness' }),
    previewNavigate: async () => ({ ok: false, error: 'disabled_in_harness' }),
    previewAction: async () => ({ ok: false, error: 'disabled_in_harness' }),
    previewBounds: async () => ({ ok: true }),
    previewPick: async () => ({ ok: false, error: 'disabled_in_harness' }),
    previewPickCancel: async () => ({ ok: true }),
    previewFrame: async () => ({ ok: false, error: 'disabled_in_harness' }),
    previewClose: async () => ({ ok: true }),
    onPreview: (callback) => subscribe('preview', callback),
  };

  window.satr = new Proxy(api, {
    get(target, property) {
      if (property in target) return target[property];
      if (typeof property !== 'string') return undefined;
      return async function harnessFallback() {
        remember(property, arguments);
        return { ok: false, error: 'not_implemented_in_harness' };
      };
    },
  });

  window.__SATR_TESTSPRITE_HARNESS__ = {
    version: 1,
    calls,
    emitEvent(value) { publish('event', value); },
    setAutoRespond(value) { autoRespond = value !== false; },
    setSessions(value) { sessionRows = Array.isArray(value) ? value.map((row) => ({ ...row })) : []; },
    clearCalls() { calls.length = 0; },
  };
  document.documentElement.dataset.testspriteHarness = 'true';
})();
