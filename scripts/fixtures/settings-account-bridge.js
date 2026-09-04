// جسر satr مزيّف لاختبار OBS-099: يعدّ كل استدعاء كي يثبت الاختبار أن الإغلاق
// (‏✕ / Escape / نقر خارج اللوحة) لا يستدعي تحديث الحسابات، وأن مستمعَي
// topbar.js (النشاط المحلي + إصدارات المحرّكات) ما زالا يعملان عند الفتح.
window.__satrCalls = {
  claudeAccount: 0, codexStatus: 0, codexLimits: 0, codexUsage: 0,
  activityList: 0, engineUpdates: 0, appVersion: 0, features: 0, providers: 0,
};
window.satr = {
  providers: async () => { window.__satrCalls.providers++; return { providers: [], integrations: [] }; },
  keysList: async () => ({ names: [] }),
  keySet: async () => ({ ok: true }),
  keyDelete: async () => ({ ok: true }),
  pickFolder: async () => null,
  features: async () => { window.__satrCalls.features++; return { edition: 'community' }; },
  eeUsage: async () => ({ today: {} }),
  eeAudit: async () => ({ todayCount: 0, path: '' }),
  appVersion: async () => {
    window.__satrCalls.appVersion++;
    return { ok: true, version: '9.9.9-fixture', packaged: true, msix: false };
  },
  checkUpdates: async () => ({ ok: false }),
  engineUpdates: async () => {
    window.__satrCalls.engineUpdates++;
    return {
      ok: true, anyBehind: false,
      engines: [{ id: 'claude', label: 'Claude Code', installed: '1.2.3', latest: '1.2.3', behind: false }],
    };
  },
  activityList: async () => {
    window.__satrCalls.activityList++;
    return { entries: [{ kind: 'prompt', ts: 1756900000000, engine: 'sdk' }] };
  },
  activityClear: async () => ({ ok: true }),
  claudeAccount: async () => {
    window.__satrCalls.claudeAccount++;
    return { ok: true, email: 'user@example.com', organization: 'satr-org', subscriptionType: 'pro' };
  },
  codexStatus: async () => {
    window.__satrCalls.codexStatus++;
    return { ok: true, installed: true, auth: { ok: true, method: 'chatgpt', plan: 'plus' } };
  },
  codexLimits: async () => {
    window.__satrCalls.codexLimits++;
    return { ok: true, limits: { planType: 'plus', primary: { usedPercent: 42 } } };
  },
  codexUsage: async () => {
    window.__satrCalls.codexUsage++;
    return { ok: true, usage: { recentTokens: 1234567, lifetimeTokens: 98765432 } };
  },
};
