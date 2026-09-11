#!/usr/bin/env node
'use strict';
/**
 * اختبار electron/desktop.js القطعي — بمعين مزيّف (scripts/lib/fake-uia-helper.js) يحاكي بروتوكول
 * native/satr-uia بلا ويندوز. التشغيل: npm run test:desktop (node وحده؛ يعمل على POSIX أيضاً).
 *
 * يثبت: الإقلاع ومهلته · الانهيار وإعادة الإقلاع مرة ثم نهاية الجلسة · رفض الردّ غير المطابق ·
 * ترجمة رموز المعين إلى رموز §٧ · تسلسل surface ثم الحارس قبل المعين (الفعل المرفوض لا يصل المعين) ·
 * صيغة سطر اللقطة الحرفية · التفاضل بعد الفعل يحفظ مراجع النموذج رغم إعادة ترقيم المعين · سطر سجل
 * عربي لكل فعل · عدم تسجيل الخادم بلا علم أو بلا معين وثبات القرار لكل جلسة · عدم تسريب مسار أو مقبض.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FAKE = path.join(__dirname, 'lib', 'fake-uia-helper.js');
const desktopModule = require('../electron/desktop');
const envbrief = require('../electron/envbrief');
const autogate = require('../electron/autogate');
const { createDesktop, resolveHelperPath, shouldRegister, MESSAGES } = desktopModule;

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  ✓ ' + name); return; }
  failed++;
  console.error('  ✗ ' + name + (detail === undefined ? '' : ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))));
}

const ARABIC = /[؀-ۿ]/;
const LINE_RE = /^\[w[1-9][0-9]*:e[1-9][0-9]*\] [a-z]+( ".*")?$/;
const LEAKS = ['hwnd', '1234567', 'notepad.exe', 'System32', 'exePath', 'className'];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-desktop-test-'));
const allOutputs = [];
let seq = 0;

function makeDesktop(env = {}, extra = {}) {
  seq += 1;
  const logFile = path.join(tmp, 'log-' + seq + '.txt');
  const stateFile = path.join(tmp, 'state-' + seq + '.txt');
  const events = [];
  const children = [];
  const spawn = (command, args, opts) => {
    const child = cp.spawn(command, args, Object.assign({}, opts, {
      env: Object.assign({}, process.env, { FAKE_UIA_LOG: logFile, FAKE_UIA_STATE: stateFile, FAKE_UIA_SELF: String(process.pid) }, env),
    }));
    children.push(child);
    return child;
  };
  const desktop = createDesktop(Object.assign({
    command: process.execPath, args: [FAKE], spawn, emit: (e) => events.push(e), bootTimeoutMs: 5000, pollMs: 50,
  }, extra));
  const calls = () => { try { return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
  const record = (r) => { allOutputs.push(JSON.stringify(r)); return r; };
  return { desktop, events, children, calls, record };
}

const activity = (events) => events.filter((e) => e.type === 'desktop_activity').map((e) => e.text);
const refOf = (text, role, name) => {
  const line = String(text || '').split('\n').find((l) => l.endsWith('] ' + role + (name ? ' "' + name + '"' : '')));
  return line ? line.slice(1, line.indexOf(']')) : null;
};
const exitedWithin = (child, ms) => new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode) { resolve(true); return; }
  const t = setTimeout(() => resolve(false), ms);
  child.once('exit', () => { clearTimeout(t); resolve(true); });
});

async function selectedAndSnapped(d) {
  const sel = d.record(await d.desktop.selectTarget({ targetId: 'w7', pid: 4100 }));
  const snap = d.record(await d.desktop.snapshot('w7'));
  return { sel, snap };
}

async function main() {
  console.log('[1] المسار وقرار التسجيل (§٦) — لا خادم بلا علم صريح ومعين موجود، والقرار ثابت للجلسة');
  const emptyRoot = fs.mkdtempSync(path.join(tmp, 'root-'));
  const exe = path.join(tmp, 'satr-uia.exe');
  fs.writeFileSync(exe, '');
  check('SATR_UIA_EXE يُقدَّم حين يوجد', resolveHelperPath({ SATR_UIA_EXE: exe }, emptyRoot) === exe);
  check('لا معين في أي موضع ⇒ null', resolveHelperPath({}, emptyRoot) === null);
  check('SATR_UIA_EXE لملف غائب لا يُعتمد', resolveHelperPath({ SATR_UIA_EXE: path.join(tmp, 'missing.exe') }, emptyRoot) === null);
  check('shouldRegister: علم صريح + معين ⇒ true', shouldRegister(true, true) === true);
  check('shouldRegister: بلا علم ⇒ false', shouldRegister(false, true) === false && shouldRegister(undefined, true) === false);
  check('shouldRegister: علم نصّي أو رقمي لا يكفي', shouldRegister('true', true) === false && shouldRegister(1, true) === false);
  check('shouldRegister: بلا معين ⇒ false', shouldRegister(true, false) === false);

  const agent = require('../electron/agent');
  const on = agent.desktopRegistration({ desktopControl: true, available: true });
  check('agent: علم + معين ⇒ يُسجَّل بلا إشعار', on.enabled === true && on.notice === '');
  const off = agent.desktopRegistration({ desktopControl: false, available: true });
  check('agent: بلا علم ⇒ لا يُسجَّل', off.enabled === false && off.notice === '');
  const missing = agent.desktopRegistration({ desktopControl: true, available: false });
  check('agent: علم بلا معين ⇒ لا يُسجَّل وإشعار عربي واحد بلا مسار',
    missing.enabled === false && ARABIC.test(missing.notice) && !/[A-Za-z]:\\/.test(missing.notice), missing);
  check('agent: السياقات المعزولة لا تسجّله أبداً',
    agent.desktopRegistration({ desktopControl: true, available: true, internalPolicy: { mode: 'text-only' } }).enabled === false);
  agent.pinDesktopDecision('sess-pinned-on', true);
  agent.pinDesktopDecision('sess-pinned-off', false);
  check('agent: قرار مثبَّت بالتسجيل لا يسقطه إطفاء العلم أثناء الجلسة',
    agent.desktopRegistration({ desktopControl: false, available: false, sessionId: 'sess-pinned-on' }).enabled === true);
  check('agent: قرار مثبَّت بعدم التسجيل لا يقلبه تشغيل العلم أثناء الجلسة',
    agent.desktopRegistration({ desktopControl: true, available: true, sessionId: 'sess-pinned-off' }).enabled === false);
  agent.pinDesktopDecision('sess-pinned-on', false);
  check('agent: التثبيت مرة واحدة لا يُعاد كتابته',
    agent.desktopRegistration({ desktopControl: false, available: false, sessionId: 'sess-pinned-on' }).enabled === true);

  const agentSrc = fs.readFileSync(path.join(ROOT, 'electron', 'agent.js'), 'utf8');
  check('agent.js يسجّل satr-desktop بقرار الجلسة وحده', /if \(desktopPlan\.enabled && sdk\.createSdkMcpServer && sdk\.tool && z\)/.test(agentSrc));
  check('اسم الخادم satr-desktop مسجَّل في موضع واحد', (agentSrc.match(/'satr-desktop':/g) || []).length === 1);
  check('الموجز يتبع القرار نفسه', agentSrc.includes("envbrief.build('sdk', model, { desktop: desktopPlan.enabled })"));
  const browserAutoBlock = agentSrc.slice(agentSrc.indexOf('const BROWSER_AUTO_TOOLS'), agentSrc.indexOf(']);', agentSrc.indexOf('const BROWSER_AUTO_TOOLS')));
  check('لا أداة سطح مكتب في BROWSER_AUTO_TOOLS', !browserAutoBlock.includes('desktop'));
  check('لا أداة سطح مكتب في AUTO_SAFE_TOOLS', ![...autogate.AUTO_SAFE_TOOLS].some((n) => n.includes('desktop')));
  check('وضع auto يُجبرها على المربع', autogate.autoNeedsPrompt('mcp__satr-desktop__desktop_click', 'auto') === true);
  check('تفويض المتصفح لا يعفيها', autogate.decideAutoApproval('mcp__satr-desktop__desktop_type', {
    permissionMode: 'default', alwaysAllowed: new Set(), browserControl: true, readOnly: false, browserTool: false,
  }) === 'prompt');
  check('مربع الإذن يأخذ تفاصيل النافذة والعنصر من desktop.permissionDetail',
    agentSrc.includes('DESKTOP_TOOL_RE.test(String(toolName || \'\')) ? desktop.permissionDetail(toolName, input)'));

  const z = require('zod');
  const fakeSdk = { tool: (name, description, shape, handler) => ({ name, description, shape, handler }) };
  const toolDefs = agent.desktopTools(fakeSdk, z, desktopModule);
  check('الأدوات الثماني بأسماء §٧', JSON.stringify(toolDefs.map((t) => t.name)) === JSON.stringify(envbrief.DESKTOP_TOOL_NAMES));
  const shot = toolDefs.find((t) => t.name === 'desktop_screenshot');
  check('desktop_screenshot «آخر الملاذ» وdesktop_snapshot الافتراضي', shot.description.includes('آخر الملاذ') && shot.description.includes('desktop_snapshot هي الافتراضي'));
  check('لا أداة تقبل إحداثيات', toolDefs.every((t) => !['x', 'y', 'point', 'coordinates'].some((k) => k in t.shape)));
  check('لا desktop_evaluate', !toolDefs.some((t) => /evaluate/.test(t.name)));

  console.log('[2] الإقلاع والسرد — النافذة المختارة وحدها قابلة للاختيار، والحقول بقائمة سماح');
  const d = makeDesktop();
  const listed = d.record(await d.desktop.listTargets());
  check('listTargets ينجح', listed.ok === true, listed);
  check('المحجوبة (UAC) ونافذة سطر نفسها والمصغّرة لا تُعرض', listed.ok && listed.targets.map((t) => t.targetId).join(',') === 'w7', listed.targets);
  check('حقول الهدف العام خمسة لا غير', listed.ok && Object.keys(listed.targets[0]).sort().join(',') === 'pid,processName,rect,targetId,title');
  check('لا مقبض ولا مسار في السرد', !LEAKS.some((k) => JSON.stringify(listed).includes(k)));

  console.log('[3] مهلة الإقلاع — معين لا يردّ يُقتل ولا يُعلّق');
  const silent = makeDesktop({ FAKE_UIA_MODE: 'silent' }, { bootTimeoutMs: 300 });
  const t0 = Date.now();
  const bootFail = silent.record(await silent.desktop.listTargets());
  check('إقلاع بلا ردّ ⇒ closed بعد المهلة', bootFail.ok === false && bootFail.error === 'closed' && Date.now() - t0 < 3000, bootFail);
  check('رسالة الإقلاع عربية', ARABIC.test(bootFail.message));
  check('العملية الصامتة قُتلت', await exitedWithin(silent.children[0], 3000));

  console.log('[4] الاختيار (الحارس ١) — لنافذة مسموحة وحدها');
  check('نافذة سطر نفسها لا تُختار', (await d.desktop.selectTarget({ targetId: 'w9', pid: process.pid })).error === 'not_allowed');
  check('نافذة UAC لا تُختار', (await d.desktop.selectTarget({ targetId: 'w8', pid: 900 })).error === 'not_allowed');
  check('نافذة مصغّرة لا تُختار', (await d.desktop.selectTarget({ targetId: 'w10', pid: 5200 })).error === 'not_allowed');
  check('اختيار مشوّه ⇒ bad_input', (await d.desktop.selectTarget({ targetId: 'x', pid: 1 })).error === 'bad_input');
  check('نافذة غابت ⇒ not_found', (await d.desktop.selectTarget({ targetId: 'w11', pid: 1 })).error === 'not_found');
  const beforeSelect = d.calls().filter((c) => c === 'tree/snapshot').length;
  check('لقطة قبل الاختيار ⇒ not_allowed', (await d.desktop.snapshot('w7')).error === 'not_allowed');
  check('ولم تصل المعين', d.calls().filter((c) => c === 'tree/snapshot').length === beforeSelect);
  const { sel, snap } = await selectedAndSnapped(d);
  check('اختيار المفكرة ينجح بهدف عام', sel.ok === true && sel.target.targetId === 'w7' && !('className' in sel.target), sel);

  console.log('[5] اللقطة — صيغة المتصفح الحرفية بمراجع جيل اللقطة');
  check('اللقطة تنجح', snap.ok === true, snap);
  // أسطر العناصر وحدها — سطر الرأس «[العناصر — …]» عنوان لا عنصر (كرأس لقطة المتصفح)
  const lines = snap.text.split('\n').filter((l) => l.startsWith('[w'));
  check('كل سطر بصيغة [w<جيل>:e<n>] role "name"', lines.length >= 4 && lines.every((l) => LINE_RE.test(l)), lines);
  check('مرجع النموذج بجيل اللقطة لا برقم نافذة المعين', lines.every((l) => l.startsWith('[w' + snap.generation + ':e')) && !snap.text.includes('[w7:'));
  check('حقل السرّ وابنه غائبان', !snap.text.includes('كلمة المرور') && !snap.text.includes('ابن حقل السرّ'));
  check('رأس اللقطة يسمّي النافذة', snap.text.includes('النافذة: المفكرة (w7)'));
  check('سطر سجل للقطة', activity(d.events).includes('قُرئت شجرة نافذة المفكرة'), activity(d.events));
  const snapCalls = d.calls().filter((c) => c === 'tree/snapshot').length;
  check('لقطة نافذة غير مختارة ⇒ not_allowed بلا وصول', (await d.desktop.snapshot('w8')).error === 'not_allowed'
    && d.calls().filter((c) => c === 'tree/snapshot').length === snapCalls);

  console.log('[6] التسلسل surface ⇒ الحارس ⇒ المعين — المرفوض لا يصل المعين');
  const invokes = () => d.calls().filter((c) => c.startsWith('element/invoke')).length;
  const outsideRef = refOf(snap.text, 'button', 'Outside');
  const noRectRef = refOf(snap.text, 'button', 'NoRect');
  const saveRef = refOf(snap.text, 'button', 'حفظ');
  const editRef = refOf(snap.text, 'edit', 'Text Editor');
  check('المراجع مقروءة من نصّ اللقطة', !!(outsideRef && noRectRef && saveRef && editRef), { outsideRef, noRectRef, saveRef, editRef });
  const outside = d.record(await d.desktop.click(outsideRef));
  check('عنصر خارج مستطيل النافذة ⇒ not_allowed', outside.error === 'not_allowed' && outside.message.includes('خارج النطاق المأذون'), outside);
  check('ولم يصل النقر المعين', invokes() === 0);
  check('تمرير عنصر بلا مستطيل ⇒ not_allowed بلا وصول', (await d.desktop.scroll(noRectRef, 3)).error === 'not_allowed'
    && !d.calls().some((c) => c.startsWith('input/scroll')));
  check('مُحدِّد CSS ⇒ bad_selector', (await d.desktop.click('#save')).error === 'bad_selector');
  check('مرجع المتصفح s1:e2 ⇒ stale_ref', (await d.desktop.click('s1:e2')).error === 'stale_ref');
  check('مرجع فارغ ⇒ bad_selector', (await d.desktop.click('  ')).error === 'bad_selector');
  check('الصيغة القديمة e3 ⇒ stale_ref', (await d.desktop.click('e3')).error === 'stale_ref');
  check('نصّ ليس نصاً ⇒ bad_input', (await d.desktop.type(editRef, 5)).error === 'bad_input');
  check('dy=0 وdy=99 ⇒ bad_input', (await d.desktop.scroll(editRef, 0)).error === 'bad_input' && (await d.desktop.scroll(editRef, 99)).error === 'bad_input');
  const snap2 = d.record(await d.desktop.snapshot('w7'));
  const stale = d.record(await d.desktop.click(saveRef));
  check('مرجع الجيل السابق بعد لقطة جديدة ⇒ stale_ref', stale.error === 'stale_ref' && stale.message === MESSAGES.stale_ref, stale);
  check('ولم يصل المعين', invokes() === 0);
  check('رسالة stale_ref توجّه إلى desktop_snapshot لا browser_snapshot', stale.message.includes('desktop_snapshot') && !stale.message.includes('browser_snapshot'));

  console.log('[7] الفعل والسجل والتفاضل — المراجع تبقى صالحة رغم إعادة ترقيم المعين');
  const save2 = refOf(snap2.text, 'button', 'حفظ');
  const noRect2 = refOf(snap2.text, 'button', 'NoRect');
  const edit2 = refOf(snap2.text, 'edit', 'Text Editor');
  const clicked = d.record(await d.desktop.click(save2));
  check('النقر ينجح', clicked.ok === true, clicked);
  check('المعين نقر «حفظ» بمرجعه هو', d.calls().includes('element/invoke w7:e3 حفظ'), d.calls());
  check('سطر السجل للنقر', activity(d.events).includes('نُقر على [حفظ] في نافذة المفكرة'));
  check('التفاضل يعلن العنصر الجديد بمرجع في الجيل نفسه', clicked.ok && clicked.text.includes('[تغيّر الشجرة المختصر')
    && clicked.text.includes('[w' + snap2.generation + ':e8] text "Saved!"'), clicked.text);
  const noRectClick = d.record(await d.desktop.click(noRect2));
  check('مرجع النموذج بعد إعادة الترقيم يصل العنصر نفسه (w7:e8 الآن)', noRectClick.ok === true && d.calls().includes('element/invoke w7:e8 NoRect'), d.calls());
  const typed = d.record(await d.desktop.type(edit2, 'hello'));
  check('الكتابة تنجح وتتحقق بالقراءة الثانية', typed.ok === true && typed.text.includes('تطابق المكتوب'), typed);
  check('سطر السجل للكتابة بالطول لا بالنص', activity(d.events).includes('كُتب نص (الطول 5) في [Text Editor] في نافذة المفكرة'));
  const keyed = d.record(await d.desktop.pressKey('ctrl+s'));
  check('المفاتيح تنجح بصيغتها المعيارية', keyed.ok === true && keyed.text.includes('ضُغط Ctrl+S'), keyed);
  check('سطر السجل للمفاتيح', activity(d.events).includes('ضُغط Ctrl+S في نافذة المفكرة'));
  const keyCalls = d.calls().filter((c) => c.startsWith('input/key')).length;
  check('مفتاح فارغ أو طويل ⇒ bad_key بلا وصول', (await d.desktop.pressKey('')).error === 'bad_key'
    && (await d.desktop.pressKey('x'.repeat(40))).error === 'bad_key' && d.calls().filter((c) => c.startsWith('input/key')).length === keyCalls);
  const scrolled = d.record(await d.desktop.scroll(edit2, 2));
  check('التمرير ينجح بالنسبة', scrolled.ok === true && scrolled.text.includes('ScrollPattern'), scrolled);
  const waitRef = d.record(await d.desktop.waitFor({ ref: edit2 }));
  check('انتظار العنصر يجده متاحاً', waitRef.ok === true && waitRef.found === true, waitRef);
  const genBefore = d.desktop._state().generation;
  const waitText = d.record(await d.desktop.waitFor({ text: 'saved' }));
  check('انتظار النص يجده ويعيد لقطة جديدة', waitText.ok === true && waitText.found === true && waitText.text.includes('لقطة جديدة'), waitText);
  check('وجيل اللقطة تقدّم', d.desktop._state().generation > genBefore);
  check('انتظار بلا ref ولا text ⇒ bad_input', (await d.desktop.waitFor({})).error === 'bad_input');
  check('مهلة خارج الحدّ ⇒ bad_input', (await d.desktop.waitFor({ text: 'x', timeout: 100 })).error === 'bad_input');
  const pic = d.record(await d.desktop.screenshot('w7'));
  check('الصورة PNG للنافذة المختارة', pic.ok === true && pic.mimeType === 'image/png' && pic.base64.length > 10 && pic.note.includes('آخر الملاذ'), pic);
  const picked = d.record(await d.desktop.targets());
  check('desktop_targets يعيد المختارة وحدها', picked.ok === true && picked.targets.length === 1 && picked.text.includes('w7') && picked.text.includes('ولا غيرها'), picked);
  const acts = activity(d.events);
  const successes = [snap, snap2, clicked, noRectClick, typed, keyed, scrolled, waitRef, waitText, pic].filter((r) => r.ok).length;
  check('سطر سجل واحد لكل فعل ناجح — لا فعل بلا سطر', acts.length === successes, { acts: acts.length, successes });
  check('السجل بلا النص المكتوب وبلا عنوان النافذة', !acts.some((l) => l.includes('hello') || l.includes('fake.txt')));
  check('كل سطر سجل عربي بلا سطر ثانٍ', acts.every((l) => ARABIC.test(l) && !/[\r\n]/.test(l)));

  console.log('[8] تفاصيل مربع الإذن — النافذة والعنصر والنص');
  // مرجع من الجيل الحالي: انتظار النص أعلاه أخذ لقطات جديدة فأبطل edit2 (وهذا هو المقصود)
  const editNow = refOf((await d.desktop.snapshot('w7')).text, 'edit', 'Text Editor');
  const detail = d.desktop.permissionDetail('mcp__satr-desktop__desktop_type', { ref: editNow, text: 'سطر جديد' });
  check('يعرض النافذة', detail.includes('النافذة: المفكرة (w7)'), detail);
  check('يعرض العنصر من اللقطة', detail.includes('edit «Text Editor»'), detail);
  check('يعرض النص المراد كتابته', detail.includes('النص المراد كتابته: "سطر جديد"'), detail);
  check('مرجع ليس من آخر لقطة يُعلَن', d.desktop.permissionDetail('mcp__satr-desktop__desktop_click', { ref: 'w999:e1' }).includes('سيُرفض stale_ref'));
  check('المفاتيح في المربع', d.desktop.permissionDetail('mcp__satr-desktop__desktop_press_key', { keys: 'Ctrl+S' }).includes('المفاتيح: Ctrl+S'));
  check('لا مقبض ولا مسار في التفاصيل', !LEAKS.some((k) => detail.includes(k)));

  console.log('[9] التسليم البشري — الأدوات معلّقة ونهايته تُبطل المراجع');
  const current = refOf((await d.desktop.snapshot('w7')).text, 'edit', 'Text Editor');
  check('startHandoff', d.desktop.startHandoff().ok === true);
  check('اللقطة أثناء التسليم ⇒ handoff', (await d.desktop.snapshot('w7')).error === 'handoff');
  check('الفعل أثناء التسليم ⇒ handoff', (await d.desktop.type(current, 'x')).error === 'handoff');
  d.desktop.endHandoff();
  check('مرجع ما قبل التسليم ⇒ stale_ref', (await d.desktop.type(current, 'x')).error === 'stale_ref');

  console.log('[10] سحب الاختيار — كل فعل بعده closed والمعين يُغلق');
  await d.desktop.snapshot('w7');
  check('clearTarget', (await d.desktop.clearTarget()).ok === true);
  check('الفعل بعد السحب ⇒ closed', (await d.desktop.snapshot('w7')).error === 'closed');
  check('المعين خرج مع الجلسة', await exitedWithin(d.children[d.children.length - 1], 3000));

  console.log('[11] ترجمة رموز المعين إلى §٧ (قرار الخطوة ٤ المعلن)');
  const table = [
    ['element/invoke', 'stale_ref', 'stale_ref'], ['element/invoke', 'target_changed', 'stale_ref'],
    ['element/invoke', 'closed', 'closed'], ['element/invoke', 'not_found', 'not_found'],
    ['element/invoke', 'not_allowed', 'not_allowed'], ['element/invoke', 'focus_failed', 'not_allowed'],
    ['element/invoke', 'read_only', 'not_allowed'], ['element/invoke', 'disabled', 'not_allowed'],
    ['element/invoke', 'unsupported_pattern', 'not_found'], ['element/invoke', 'uia_unavailable', 'closed'],
    ['element/invoke', 'internal', 'not_found'], ['input/key', 'bad_key', 'bad_key'],
  ];
  for (const [method, helperCode, expected] of table) {
    const t = makeDesktop({ FAKE_UIA_FAIL: method + ':' + helperCode });
    const { snap: s } = await selectedAndSnapped(t);
    const r = t.record(method === 'input/key' ? await t.desktop.pressKey('Enter') : await t.desktop.click(refOf(s.text, 'button', 'حفظ')));
    const clean = ARABIC.test(r.message || '') && !/browser_snapshot|open_preview|browser_handoff/.test(r.message || '');
    check(helperCode + ' ⇒ ' + expected + ' برسالة عربية لسطح المكتب', r.ok === false && r.error === expected && clean, r);
    if (helperCode === 'target_changed') check('target_changed يحمل كان/صار', r.message.includes('كان «button "حفظ"»') && r.message.includes('صار «button "Saved"»'), r.message);
    if (helperCode === 'closed') {
      const after = await t.desktop.click(refOf(s.text, 'button', 'حفظ'));
      check('بعد closed من المعين تنتهي الجلسة (الحارس يعيد closed بلا وصول)', after.error === 'closed'
        && t.calls().filter((c) => c.startsWith('element/invoke')).length === 1, after);
    }
    await t.desktop.shutdown();
  }

  console.log('[12] الانهيار وإعادة الإقلاع مرة واحدة لكل جلسة');
  const once = makeDesktop({ FAKE_UIA_MODE: 'crash-invoke-once' });
  const o1 = await selectedAndSnapped(once);
  const crash1 = once.record(await once.desktop.click(refOf(o1.snap.text, 'button', 'حفظ')));
  check('انهيار أثناء الفعل ⇒ closed برسالة «لا يُعرف إن وقع»', crash1.error === 'closed' && crash1.message === MESSAGES.helper_failed, crash1);
  const again = once.record(await once.desktop.snapshot('w7'));
  check('النداء التالي يعيد الإقلاع ويربط النافذة نفسها', again.ok === true && again.text.includes('أُعيد تشغيل معين سطح المكتب'), again);
  check('إعادة إقلاع واحدة محسوبة', once.desktop._state().stats.restarts === 1 && once.children.length === 2);
  const afterRestart = once.record(await once.desktop.click(refOf(again.text, 'button', 'حفظ')));
  check('الجلسة تعمل بعد إعادة الربط', afterRestart.ok === true, afterRestart);
  await once.desktop.shutdown();

  const always = makeDesktop({ FAKE_UIA_MODE: 'crash-invoke-always' });
  const a1 = await selectedAndSnapped(always);
  await always.desktop.click(refOf(a1.snap.text, 'button', 'حفظ'));
  const a2 = await always.desktop.snapshot('w7');
  check('الانهيار الأول يُعاد منه', a2.ok === true, a2);
  const crash2 = await always.desktop.click(refOf(a2.text, 'button', 'حفظ'));
  check('الانهيار الثاني ⇒ closed', crash2.error === 'closed', crash2);
  const gone = await always.desktop.snapshot('w7');
  check('لا إعادة ثانية: الجلسة انتهت برسالة الانهيار الثاني', gone.error === 'closed' && gone.message === MESSAGES.helper_gone, gone);
  check('عمليتان لا أكثر (الأصلية + إعادة واحدة ثم لا شيء)', always.children.length === 2, always.children.length);
  await always.desktop.shutdown();

  console.log('[13] الردّ غير المطابق يُرفض والمعين يُقتل');
  const bad = makeDesktop({ FAKE_UIA_FAIL: 'tree/snapshot:__bad_shape__' });
  await bad.desktop.selectTarget({ targetId: 'w7', pid: 4100 });
  const badSnap = bad.record(await bad.desktop.snapshot('w7'));
  check('ردّ بـms غير عددي ⇒ closed لا نتيجة', badSnap.ok === false && badSnap.error === 'closed', badSnap);
  check('المعين الكاذب قُتل', await exitedWithin(bad.children[0], 3000));
  await bad.desktop.shutdown();

  console.log('[14] لا تسريب مسار ولا مقبض في أي ردّ عام');
  const leaked = allOutputs.filter((o) => LEAKS.some((k) => o.includes(k)));
  check('صفر ردّ يحمل hwnd/exePath/مسار المعين', leaked.length === 0, leaked.slice(0, 2));
  check('صفر ردّ يحمل مسار المعين المزيّف', !allOutputs.some((o) => o.includes('fake-uia-helper')));

  console.log('[15] بنية الوحدات والقنوات');
  const desktopSrc = fs.readFileSync(path.join(ROOT, 'electron', 'desktop.js'), 'utf8');
  const head = desktopSrc.slice(0, desktopSrc.indexOf("'use strict'"));
  for (const ban of ['لا desktop_evaluate', 'لا نقر بالإحداثيات', 'لا نموذج رؤية', 'لا تعداد بلا اختيار المستخدم']) {
    check('رأس desktop.js يكتب: ' + ban, head.includes(ban));
  }
  check('desktop.js بلا Electron', !/require\(['"]electron['"]\)/.test(desktopSrc));
  check('spawn بلا صدفة', desktopSrc.includes('shell: false') && !/shell:\s*true/.test(desktopSrc));
  const mainSrc = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
  check('علم desktopControl boolean صارم في مسار SDK وحده', (mainSrc.match(/desktopControl: payload\.desktopControl === true/g) || []).length === 1
    && !/desktopControl/.test(mainSrc.slice(mainSrc.indexOf("if (payload.engine === 'codex')"), mainSrc.indexOf('// المسار الافتراضي: Agent SDK'))));
  check('قناة الاختيار بـregex صارم ومفتاحين لا غير', mainSrc.includes("const SAFE_DESKTOP_TARGET_ID = /^w[1-9][0-9]{0,8}$/;")
    && mainSrc.includes("keys !== 'pid,targetId'"));
  const publicFn = mainSrc.slice(mainSrc.indexOf('function publicDesktopTarget'), mainSrc.indexOf('function publicDesktopResult'));
  check('ردّ القناة بقائمة سماح بلا مقبض ولا صنف ولا مسار', publicFn.length > 0 && !/hwnd|className|exePath|path/.test(publicFn));
  check('المعين يُغلق عند before-quit', mainSrc.includes('desktop.shutdown(), // معين سطح ويندوز'));
  const preloadSrc = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8');
  check('preload يكشف الثلاث بالاسم', preloadSrc.includes("desktopTargets: () => ipcRenderer.invoke('satr:desktopTargets')")
    && preloadSrc.includes("desktopSelect: (targetId, pid) => ipcRenderer.invoke('satr:desktopSelect', { targetId, pid })")
    && preloadSrc.includes("desktopClear: () => ipcRenderer.invoke('satr:desktopClear')"));

  await d.desktop.shutdown();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  console.log('');
  if (failed) { console.error('desktop-test: FAIL — ' + failed + ' من ' + (passed + failed)); process.exit(1); }
  console.log('desktop-test: ok — ' + passed + '/' + passed);
}

main().catch((e) => {
  console.error('desktop-test: FAIL — ' + (e && e.stack || e));
  process.exit(1);
});
