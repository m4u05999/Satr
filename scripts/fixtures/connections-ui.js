// تُحاكى حدود IPC وحدها؛ المكوّن وأوراقه من الإنتاج بلا نسخ لمنطق الخدمات.
import { ConnectionView, connectionSheet } from '/src/ui/components/connection-view.js';
import { controlsSheet } from '/src/ui/lib/panel.css.js';
import '/src/ui/components/mcp-panel.js';

document.adoptedStyleSheets = [controlsSheet, connectionSheet];
if (new URLSearchParams(location.search).get('theme') === 'light') document.documentElement.dataset.theme = 'light';
const cwd = 'D:\\Satr-Scene\\project-a';
const services = [
  { id: 'github', label: 'GitHub', authStatus: 'authenticated', account: { id: '123', label: 'حساب تجريبي' },
    resource: { id: 'demo/arabic-notes', label: 'مستودع الملاحظات التجريبي' }, permissions: ['read'],
    lastTest: { ok: true, at: '2026-09-08T10:00:00.000Z' }, lastEngineUse: null },
  { id: 'netlify', label: 'Netlify', authStatus: 'needs-auth', account: { id: 'demo-netlify', label: 'حساب موقع تجريبي' },
    resource: { id: '11111111-2222-4333-8444-555555555555', label: 'موقع العرض التجريبي' }, permissions: ['read'],
    lastTest: { ok: false, at: '2026-09-08T09:00:00.000Z' }, lastEngineUse: null },
  { id: 'supabase', label: 'Supabase', authStatus: 'disconnected', account: null, resource: null,
    permissions: [], lastTest: null, lastEngineUse: null },
];
const response = () => ({ ok: true, services: structuredClone(services) });
const handlers = {
  connectionList: async () => response(),
  connectionAuthenticate: async () => ({ ok: false, error: 'auth_expired' }),
  connectionResources: async () => ({ ok: true, resources: [
    { id: 'demo/arabic-notes', label: 'مستودع الملاحظات التجريبي' },
    { id: 'demo/second-repo', label: 'مستودع آخر للتجربة' },
  ], truncated: false }),
  connectionSelect: async () => ({ ok: true }),
  connectionTest: async () => ({ ok: true }),
  connectionDisconnect: async () => ({ ok: true }),
  mcpStatus: async () => ({ ok: true, servers: [] }),
};
const calls = [];
window.satr = Object.fromEntries(Object.keys(handlers).map((name) => [name, (...args) => {
  // حتى المشهد لا يحتفظ بنص رمز الوصول ضمن سجل الاستدعاءات.
  calls.push({ name, args: name === 'connectionAuthenticate' ? [args[0], args[1], '[محجوب]'] : structuredClone(args) });
  return handlers[name](...args);
}]));
const violations = [];
document.addEventListener('securitypolicyviolation', (event) => violations.push(event.violatedDirective));
const host = document.getElementById('connection-host');
const view = new ConnectionView(host, () => {
  document.getElementById('scene-notice').textContent = 'هذا مشهد تجريبي؛ لم تفتح صفحة خارجية ولم يرسل أي رمز.';
});
window.connectionScene = { view, host, handlers, calls, response, cwd, violations };
window.connectionScene.ready = view.open(cwd, 'codex').then(() => document.fonts.ready);
