#!/usr/bin/env node
'use strict';
/**
 * معين مزيّف لـscripts/desktop-test.js — يحاكي بروتوكول native/satr-uia (أسطر JSON على stdio) بلا ويندوز.
 * يعيد ترقيم العناصر بترتيب المشي بعد كل لقطة كما يفعل المعين الحقيقي، فيختبر ترجمة مراجع النموذج.
 *
 * السلوك بمتغيّرات البيئة:
 *   FAKE_UIA_MODE  normal (افتراضي) · silent (لا يردّ على initialize) · crash-invoke-once · crash-invoke-always
 *   FAKE_UIA_FAIL  "<method>:<code>" يعيد ذلك الخطأ للطريقة المسمّاة؛ و"__bad_shape__" ردّ مشوّه الشكل
 *   FAKE_UIA_LOG   ملف تُلحق به الطلبات المستلمة سطراً سطراً (ليثبت الاختبار أن الحارس منع الوصول)
 *   FAKE_UIA_STATE ملف عدّاد الأعمار (crash-invoke-once يسقط في العمر الأول وحده)
 *   FAKE_UIA_SELF  رقم عملية «سطر» نفسه — نافذة بهذا الرقم تظهر في السرد لتُحجب
 * حقول hwnd وexePath في السرد مزروعة عمداً: وجودها في أي ردّ عام تسريب.
 */
const fs = require('fs');
const readline = require('readline');

const mode = process.env.FAKE_UIA_MODE || 'normal';
const [failMethod, failCode] = String(process.env.FAKE_UIA_FAIL || '').split(':');
const logFile = process.env.FAKE_UIA_LOG || '';
const stateFile = process.env.FAKE_UIA_STATE || '';
const selfPid = Number(process.env.FAKE_UIA_SELF) || 1;

let life = 1;
if (stateFile) {
  try { life = (Number(fs.readFileSync(stateFile, 'utf8')) || 0) + 1; } catch { life = 1; }
  fs.writeFileSync(stateFile, String(life));
}

const WINDOW = { x: 100, y: 100, w: 800, h: 600 };
const TARGETS = [
  { targetId: 'w7', pid: 4100, processName: 'Notepad', title: 'fake.txt - Notepad', className: 'Notepad', rect: WINDOW,
    hwnd: 1234567, exePath: 'C:\\Windows\\System32\\notepad.exe' },
  { targetId: 'w8', pid: 900, processName: 'consent', title: 'User Account Control', className: '', rect: { x: 600, y: 300, w: 700, h: 500 } },
  { targetId: 'w9', pid: selfPid, processName: 'electron', title: 'سطر', className: 'Chrome_WidgetWin_1', rect: { x: 0, y: 0, w: 1200, h: 900 } },
  { targetId: 'w10', pid: 5200, processName: 'chrome', title: 'Bank', className: 'Chrome_WidgetWin_1', rect: null },
];
// صورة PNG بنقطة واحدة — الاختبار يفحص الشكل لا المحتوى
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

let session = null;
let saved = false;
let lastSnapshot = null;

function tree() {
  const node = (role, name, rect, depth, extra) => Object.assign({ role, name, rect, enabled: true, focusable: true, isPassword: false, depth }, extra);
  const list = [
    node('window', 'fake.txt - Notepad', WINDOW, 0),
    node('edit', 'Text Editor', { x: 110, y: 150, w: 780, h: 500 }, 1),
    node('button', 'حفظ', { x: 120, y: 110, w: 60, h: 24 }, 1),
    node('button', 'Outside', { x: 950, y: 110, w: 60, h: 24 }, 1),
    // حقل سرّ وابنه: المعين الحقيقي يُسقطهما أصلاً، والمزيّف يرسلهما ليثبت دفاع desktopguard الثاني
    node('edit', 'كلمة المرور', { x: 120, y: 200, w: 200, h: 24 }, 1, { isPassword: true }),
    node('text', 'ابن حقل السرّ', null, 2),
    node('button', 'NoRect', null, 1),
  ];
  // بعد «حفظ» يظهر عنصر جديد في وسط الشجرة فيُزاح ترقيم ما بعده — كما يفعل المشي الحقيقي
  if (saved) list.splice(3, 0, node('text', 'Saved!', { x: 200, y: 110, w: 80, h: 24 }, 1));
  return list.map((n, i) => Object.assign({ ref: 'w7:e' + (i + 1) }, n));
}

function log(line) {
  if (logFile) fs.appendFileSync(logFile, line + '\n');
}

const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

function resolve(ref) {
  if (!session) throw { code: 'not_allowed', message: 'fake: no session' };
  const hit = lastSnapshot && lastSnapshot.find((n) => n.ref === ref);
  if (!hit) throw { code: 'stale_ref', message: 'fake: stale' };
  return hit;
}

function handle(method, p) {
  switch (method) {
    case 'initialize': return { version: 'fake', osBuild: '0', uiaAvailable: true, packageFullName: null, pid: process.pid };
    case 'targets/list': return JSON.parse(JSON.stringify(TARGETS));
    case 'session/select': {
      const t = TARGETS.find((x) => x.targetId === p.targetId);
      if (!t) throw { code: 'not_found', message: 'fake: unknown target' };
      if (t.pid !== p.pid || JSON.stringify(t.rect) !== JSON.stringify(p.rect)) throw { code: 'not_allowed', message: 'fake: mismatch' };
      session = t;
      lastSnapshot = null;
      return { ok: true, targetId: t.targetId };
    }
    case 'tree/snapshot': {
      if (!session || p.targetId !== session.targetId) throw { code: 'not_allowed', message: 'fake: not selected' };
      lastSnapshot = tree();
      return { nodes: lastSnapshot, truncated: false };
    }
    case 'element/invoke': {
      const hit = resolve(p.ref);
      log('element/invoke ' + p.ref + ' ' + hit.name);
      if (mode === 'crash-invoke-always' || (mode === 'crash-invoke-once' && life === 1)) process.exit(3);
      if (hit.name === 'حفظ') saved = true;
      return { ok: true };
    }
    case 'element/setValue': {
      const hit = resolve(p.ref);
      log('element/setValue ' + p.ref + ' ' + hit.name);
      return { ok: true, previous: '', value: p.text };
    }
    case 'element/state': {
      const hit = resolve(p.ref);
      return { role: hit.role, name: hit.name, rect: hit.rect, enabled: true, inside: true };
    }
    case 'input/key': {
      if (!session) throw { code: 'not_allowed', message: 'fake: no session' };
      const keys = String(p.keys).split('+').map((k) => k.trim()).map((k) => k.length === 1 ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1)).join('+');
      log('input/key ' + keys);
      return { ok: true, keys };
    }
    case 'input/scroll': {
      const hit = resolve(p.ref);
      log('input/scroll ' + p.ref + ' ' + hit.name);
      return { ok: true, via: 'pattern', before: 0, after: 10 };
    }
    case 'capture/window': {
      if (!session || p.targetId !== session.targetId) throw { code: 'not_allowed', message: 'fake: not selected' };
      return { png: TINY_PNG, width: 1, height: 1, sourceWidth: 1, sourceHeight: 1 };
    }
    default: throw { code: 'unknown_method', message: 'fake: ' + method };
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  const { id, method } = req;
  const p = req.params || {};
  if (method !== 'element/invoke' && method !== 'element/setValue' && method !== 'input/key' && method !== 'input/scroll') log(method);
  if (method === 'initialize' && mode === 'silent') return;
  if (method === 'shutdown') { out({ id, result: { ok: true }, ms: 0 }); process.exit(0); }
  if (method === failMethod && failCode) {
    if (failCode === '__bad_shape__') { process.stdout.write(JSON.stringify({ id, ms: 'x', result: {} }) + '\n'); return; }
    const error = { code: failCode, message: 'fake ' + failCode };
    if (failCode === 'target_changed') Object.assign(error, { was: 'button "حفظ"', now: 'button "Saved"' });
    if (method === 'element/invoke' || method === 'input/key') log(method + ' ' + (p.ref || p.keys || '') + ' FAIL');
    out({ id, error, ms: 0 });
    return;
  }
  try { out({ id, result: handle(method, p), ms: 0 }); }
  catch (e) { out({ id, error: { code: e.code || 'internal', message: e.message || 'fake' }, ms: 0 }); }
});
rl.on('close', () => process.exit(0));
