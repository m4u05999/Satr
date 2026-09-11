'use strict';

// عقد اللوحة فقط: كل قناة تمر بغلاف renderertrust في main، ولا توجد قناة لقراءة الرمز.
const fs = require('fs');
const path = require('path');
const connections = require('./connections');
const SERVICES = new Set(['github', 'netlify', 'supabase']);
const SAFE_ENGINE = /^[a-z][a-z0-9-]{0,63}$/;
const RESOURCE = {
  github: /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/,
  netlify: /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,
  supabase: /^[a-z0-9]{20}$/,
};
function projectDirectory(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || value !== value.trim()
      || /[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(value)
      || !path.isAbsolute(value) || value.split(/[\\/]/).includes('..')) return null;
  try { return fs.statSync(value).isDirectory() ? fs.realpathSync(value) : null; } catch { return null; }
}
function input(payload, fields, serviceRequired) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || Object.keys(payload).some((key) => !fields.includes(key))) return null;
  const cwd = projectDirectory(payload.cwd);
  if (!cwd || (serviceRequired && !SERVICES.has(payload.service))) return null;
  return { ...payload, cwd };
}
function register(ipcMain, managerProvider = () => connections.getManager()) {
  const bind = (name, fields, serviceRequired, validate, invoke) => {
    ipcMain.handle('satr:' + name, async (_event, payload) => {
      const p = input(payload, fields, serviceRequired);
      if (!p) return { ok: false, error: projectDirectory(payload && payload.cwd) ? 'bad_input' : 'bad_cwd' };
      if (!validate(p)) return { ok: false, error: 'bad_input' };
      try { return await invoke(managerProvider(), p); }
      catch { return { ok: false, error: 'storage_unavailable' }; }
    });
  };
  bind('connectionList', ['cwd', 'engine'], false,
    (p) => typeof p.engine === 'string' && SAFE_ENGINE.test(p.engine),
    (m, p) => m.list(p.cwd, p.engine));
  bind('connectionAuthenticate', ['cwd', 'service', 'token'], true,
    (p) => typeof p.token === 'string' && /^[\x21-\x7e]{8,8192}$/.test(p.token),
    (m, p) => m.authenticate(p.cwd, p.service, p.token));
  bind('connectionResources', ['cwd', 'service'], true, () => true,
    (m, p) => m.resources(p.cwd, p.service));
  bind('connectionSelect', ['cwd', 'service', 'resource', 'permissions'], true,
    (p) => typeof p.resource === 'string' && RESOURCE[p.service].test(p.resource)
      && Array.isArray(p.permissions) && p.permissions.length >= 1 && p.permissions.length <= 2
      && p.permissions.includes('read') && new Set(p.permissions).size === p.permissions.length
      && p.permissions.every((permission) => permission === 'read' || permission === 'write')
      && (p.service !== 'supabase' || !p.permissions.includes('write')),
    (m, p) => m.select(p.cwd, p.service, p.resource, p.permissions));
  bind('connectionTest', ['cwd', 'service'], true, () => true,
    (m, p) => m.test(p.cwd, p.service));
  bind('connectionDisconnect', ['cwd', 'service'], true, () => true,
    (m, p) => m.disconnect(p.cwd, p.service));
}
module.exports = { register, projectDirectory };
