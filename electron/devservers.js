/**
 * سجلّ أفضل جهد لآخر خادم تطوير شغّله الوكيل في كل مشروع.
 * لا ينفّذ أوامر؛ يخزّنها فقط كي يقرأها main.js من القرص عند استعادة صريحة من المستخدم.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_FILE = path.join(os.homedir(), '.satr', 'devservers.json');
const LOCAL_URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?(?:\/[^\s\x00-\x20<>"']*)?/gi;

let loadedFile = '';
let records = {};
const outputTails = new Map();

function storeFile() { return process.env.SATR_DEVSERVER_FILE || DEFAULT_FILE; }
function cwdKey(cwd) {
  const normalized = path.resolve(cwd).replace(/[\\/]+$/, '').toLowerCase();
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

function ensureLoaded() {
  const file = storeFile();
  if (loadedFile === file) return;
  loadedFile = file;
  records = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) records = parsed;
  } catch (e) {}
}

function persist() {
  try {
    const file = storeFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = file + '.tmp-' + process.pid;
    fs.writeFileSync(temp, JSON.stringify(records, null, 2), 'utf8');
    fs.renameSync(temp, file);
  } catch (e) {
    console.error('[devservers] تعذّر حفظ السجل:', e && e.message);
  }
}

function recordStart(cwd, command, label) {
  ensureLoaded();
  const key = cwdKey(cwd);
  const previous = records[key] && typeof records[key] === 'object' ? records[key] : {};
  records[key] = {
    command: String(command), label: String(label), updated_at: new Date().toISOString(),
    ...(previous.last_url ? { last_url: previous.last_url } : {}),
  };
  persist();
  return { ...records[key] };
}

function observeOutput(id, cwd, data) {
  ensureLoaded();
  const combined = (outputTails.get(id) || '') + String(data || '');
  const scan = combined.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const matches = scan.match(LOCAL_URL_RE);
  outputTails.set(id, scan.slice(-1024));
  if (!matches || !matches.length) return null;
  const lastUrl = matches[matches.length - 1].replace(/[),.;]+$/, '');
  const key = cwdKey(cwd);
  if (!records[key] || records[key].last_url === lastUrl) return lastUrl;
  records[key].last_url = lastUrl;
  records[key].updated_at = new Date().toISOString();
  persist();
  return lastUrl;
}

function forgetOutput(id) { outputTails.delete(id); }
function info(cwd) {
  ensureLoaded();
  const record = records[cwdKey(cwd)];
  return record && typeof record.command === 'string' ? { ...record } : null;
}

module.exports = { recordStart, observeOutput, forgetOutput, info };
