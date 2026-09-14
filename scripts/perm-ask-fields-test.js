#!/usr/bin/env node
/**
 * حارس حقلَي طلب الإذن من المحرّك (‏OBS-192) — `defaultToNo` و`suppressAlwaysAllowRule`.
 *
 * العقد كما كتبه SDK ‏≥ 0.3.268 في `sdk.d.ts` عند `CanUseTool` (نصّاً):
 *   defaultToNo:              «The ask must not be approvable by a single stray keystroke:
 *                              open the prompt on its decline option and offer no one-key
 *                              approve shortcut.»
 *   suppressAlwaysAllowRule:  «The ask must not offer a persistent "don't ask again" choice:
 *                              the rule it would write grants more than this ask's own action.»
 *
 * ما يفحصه الحارس على **مصدر الإنتاج نفسه** لا على إعادة كتابة له:
 *   (١) `askFlags` النقيّة تضيّق ولا توسّع أبداً.
 *   (٢) ذيل `canUseTool` مستخرَجاً من `electron/agent.js` ومُشغَّلاً في `vm`:
 *       suppress ⇒ `alwaysEligible:false` في الحدث و`neverAlways/suppressAlways` في pending؛
 *       defaultToNo ⇒ الحقل في الحدث؛ وبلا الحقلين لا يتغيّر شكل الحدث القائم.
 *   (٣) `resolvePermission` مستخرجةً كذلك: ردّ واجهة بـ`always:true` على طلب مضيَّق **لا**
 *       يضيف الأداة إلى `alwaysAllowed` ولا يضيف نطاقاً إلى `trustedBrowserOrigins`.
 *       هذا هو الحارس الفعلي: التضييق في العملية الرئيسية لا في الواجهة (واجهة مخترقة
 *       أو مصحّح DevTools يستطيعان الكذب في وسيط `always`).
 *   (٤) المربع حيّاً في Chromium: `defaultToNo` يركّز «رفض»، ولا نقرة مولّدة بلوحة المفاتيح
 *       تقبل، و`alwaysEligible:false` يخفي صفّ «الموافقة الدائمة».
 *
 * ⚠️ **حدّ مُصرَّح به**: لم يُرَ طلب إذن حقيقي من المحرّك يحمل الحقلين (لا يُعرف متى
 * يضبطهما)؛ هذا الحارس يثبت سلوك «سطر» **إن وصلا**، لا أنهما يصلان.
 * التشغيل: electron scripts/perm-ask-fields-test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { app, BrowserWindow } = require('electron');
const { askFlags } = require('../electron/autogate');

const ROOT = path.resolve(__dirname, '..');
const AGENT_FILE = path.join(ROOT, 'electron', 'agent.js');
const FIXTURE = path.join(__dirname, 'fixtures', 'perm-ask-fields.html');
const TIMEOUT_MS = 30000;

let passed = 0;
function check(label, cond) {
  assert.ok(cond, 'فشل: ' + label);
  passed++;
  console.log('✓ ' + label);
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// حارس تعليق: خطأ إقلاع في Electron يعلّق العملية بدل أن ينهيها (درس مسجّل)
const watchdog = setTimeout(() => {
  console.error('perm-ask-fields: انتهت المهلة الكلية.');
  app.exit(1);
}, TIMEOUT_MS + 15000);

const SOURCE = fs.readFileSync(AGENT_FILE, 'utf8');
function section(start, end) {
  const from = SOURCE.indexOf(start);
  assert.ok(from >= 0, 'تعذّر إيجاد بداية القطعة في agent.js: ' + start);
  const to = SOURCE.indexOf(end, from + start.length);
  assert.ok(to > from, 'تعذّر إيجاد نهاية القطعة في agent.js بعد: ' + start);
  return SOURCE.slice(from, to);
}

// ---------------------------------------------------------------- (١) askFlags النقيّة
function pureChecks() {
  check('بلا الحقلين: الأهلية كما قرّرها سطر (true)', askFlags({ baseAlwaysEligible: true }).alwaysEligible === true);
  check('بلا الحقلين: neverAlways يبقى false', askFlags({ baseAlwaysEligible: true }).neverAlways === false);
  check('suppress يطفئ الأهلية', askFlags({ baseAlwaysEligible: true, suppressAlwaysAllowRule: true }).alwaysEligible === false);
  check('suppress يثبّت neverAlways', askFlags({ baseAlwaysEligible: true, suppressAlwaysAllowRule: true }).neverAlways === true);
  check('suppress بقيمة غير منطقية (1) يضيّق أيضاً — fail-safe',
    askFlags({ baseAlwaysEligible: true, suppressAlwaysAllowRule: 1 }).alwaysEligible === false);
  check('لا توسيع: قائمة سطر تمنع الدوام ولو صمت المحرّك',
    askFlags({ baseAlwaysEligible: false }).alwaysEligible === false);
  check('لا توسيع: المحرّك لا يرفع أهلية منعها سطر',
    askFlags({ baseAlwaysEligible: false, suppressAlwaysAllowRule: false }).alwaysEligible === false);
  check('baseNeverAlways القائم (forcePrompt) يبقى', askFlags({ baseNeverAlways: true }).neverAlways === true);
  check('defaultToNo يُنقل منطقياً', askFlags({ defaultToNo: 'yes' }).defaultToNo === true);
  check('defaultToNo غائب = false', askFlags({}).defaultToNo === false);
  // لا حالة يوسّع فيها المحرّك: جرد كل التوافيق
  for (const base of [true, false]) {
    for (const sup of [true, false, undefined, 0, 1, 'x']) {
      const flags = askFlags({ baseAlwaysEligible: base, suppressAlwaysAllowRule: sup });
      assert.ok(!(flags.alwaysEligible && !base), 'askFlags وسّعت الأهلية: base=' + base + ' sup=' + String(sup));
    }
  }
  check('جرد التوافيق: لا توفيقة ترفع الأهلية فوق قرار سطر', true);
}

// ------------------------------------------- (٢) ذيل canUseTool من مصدر الإنتاج في vm
function runAskSite() {
  const body = section('      const turnEligible = !NEVER_TURN_TOOLS.has(toolName);', '\n    },\n  };');
  const events = [];
  const pending = new Map();
  const sandbox = {
    emit: (event) => events.push(event),
    pending,
    askFlags,
    NEVER_TURN_TOOLS: new Set(['NeverTurnTool']),
    NEVER_ALWAYS_TOOLS: new Set(['NeverAlwaysTool']),
    DESKTOP_TOOL_RE: /^mcp__satr-desktop__/,
    desktop: { permissionDetail: () => 'تفاصيل سطح المكتب' },
  };
  vm.createContext(sandbox);
  // غلاف لا يغيّر جسد الإنتاج: يمرّر ما يحسبه `canUseTool` قبل هذه النقطة فقط.
  const wrapped = '({ run(ctx) { const { toolName, input, requester, id, signal, browserClass,'
    + ' defaultToNo, suppressAlwaysAllowRule } = ctx;\n' + body + '\n} })';
  const runner = vm.runInContext(wrapped, sandbox);
  return {
    events,
    pending,
    ask(ctx) {
      // القيمة المُعادة وعد pending لا يُنتظر (يُحلّ عبر resolvePermission)
      runner.run(Object.assign({ input: {}, requester: '', signal: null, browserClass: null }, ctx));
      return events[events.length - 1];
    },
  };
}

function askSiteChecks() {
  const site = runAskSite();

  // (ج) بلا الحقلين: السلوك القائم بلا تغيير
  const plain = site.ask({ toolName: 'Bash', id: 'p-plain' });
  check('بلا الحقلين: نوع الحدث permission_request', plain.type === 'permission_request');
  check('بلا الحقلين: alwaysEligible = true (Bash ليست في قائمة سطر)', plain.alwaysEligible === true);
  check('بلا الحقلين: الحدث لا يحمل defaultToNo أصلاً', !('defaultToNo' in plain));
  check('بلا الحقلين: pending.neverAlways = false', site.pending.get('p-plain').neverAlways === false);
  check('بلا الحقلين: pending.suppressAlways = false', site.pending.get('p-plain').suppressAlways === false);

  // قائمة سطر تبقى سارية حين يصمت المحرّك
  const listed = site.ask({ toolName: 'NeverAlwaysTool', id: 'p-listed' });
  check('قائمة سطر وحدها تكفي لمنع الدوام', listed.alwaysEligible === false);

  // (أ) suppressAlwaysAllowRule يضيّق
  const suppressed = site.ask({ toolName: 'Bash', id: 'p-sup', suppressAlwaysAllowRule: true });
  check('suppress: alwaysEligible = false في الحدث', suppressed.alwaysEligible === false);
  check('suppress: pending.neverAlways = true', site.pending.get('p-sup').neverAlways === true);
  check('suppress: pending.suppressAlways = true', site.pending.get('p-sup').suppressAlways === true);

  // (ب) defaultToNo يُبثّ
  const soft = site.ask({ toolName: 'Bash', id: 'p-def', defaultToNo: true });
  check('defaultToNo: الحدث يحمل الحقل', soft.defaultToNo === true);
  check('defaultToNo وحده لا يمسّ أهلية الدوام', soft.alwaysEligible === true);
  check('defaultToNo وحده لا يثبّت neverAlways', site.pending.get('p-def').neverAlways === false);

  return site.pending;
}

// ------------------------------- (٣) resolvePermission من مصدر الإنتاج: الردّ الكاذب لا يُثمر
function resolveChecks(askPending) {
  // القطعة تنتهي عند `},` التالية للدالة؛ نعيد القوس المغلق وحده لتصير تعريفاً صالحاً.
  const body = section('    resolvePermission(id, allow, always, turn) {',
    '\n    },\n    // رد الواجهة على أسئلة AskUserQuestion') + '\n    }';
  const alwaysAllowed = new Set();
  const turnAllowed = new Set();
  const pending = askPending;
  const sandbox = {
    connectionGate: { resolvePermission: () => false },
    pending, alwaysAllowed, turnAllowed,
    NEVER_ALWAYS_TOOLS: new Set(['NeverAlwaysTool']),
    actionBudget: { extend() {}, consume: () => ({ allowed: true }) },
  };
  vm.createContext(sandbox);
  // الإنتاج يفحص `trustedBrowserOrigins instanceof Set`، و`instanceof` لا يعبر العوالم:
  // ‏Set من عالم المضيف يفشل داخل vm ويُسقط فرع ثقة النطاق صامتاً (أخضر كاذب لو مرّ).
  // لذا يُنشأ داخل عالم الصندوق.
  const trustedBrowserOrigins = vm.runInContext('new Set()', sandbox);
  sandbox.trustedBrowserOrigins = trustedBrowserOrigins;
  const resolvePermission = vm.runInContext('({ ' + body + ' })', sandbox).resolvePermission;

  // الواجهة تكذب: always=true على طلب مضيَّق من المحرّك
  const results = new Map();
  for (const [id, entry] of pending) entry.resolve = (value) => results.set(id, value);

  resolvePermission('p-sup', true, true, false);
  check('suppress: ردّ الواجهة بـalways=true لا يضيف الأداة إلى alwaysAllowed', !alwaysAllowed.has('Bash'));
  check('suppress: الطلب نفسه يُسمح لمرة واحدة (لا رفض إضافي)', results.get('p-sup').behavior === 'allow');
  check('suppress: التصنيف مؤقّت لا دائم', results.get('p-sup').decisionClassification === 'user_temporary');

  // الحالة القائمة بلا الحقلين: الدوام يعمل كما كان (وإلا صار الحارس أخضر بلا معنى)
  resolvePermission('p-plain', true, true, false);
  check('بلا الحقلين: الدوام يعمل كما كان (Bash في alwaysAllowed)', alwaysAllowed.has('Bash'));

  // فرع ثقة النطاق لا يمرّ بـneverAlways — لذا يلزمه suppressAlways صراحةً
  let trusted = null;
  pending.set('b-sup', {
    resolve: (value) => { trusted = value; }, toolName: 'mcp__satr-terminal__browser_navigate', input: {},
    turnEligible: false, originTrust: true, origin: 'https://example.test',
    neverAlways: true, suppressAlways: true,
  });
  resolvePermission('b-sup', true, true, false);
  check('suppress: ثقة النطاق لا تُكتب رغم always=true', trustedBrowserOrigins.size === 0);
  check('suppress: فعل المتصفح نفسه سُمح لمرة واحدة', trusted.behavior === 'allow');

  pending.set('b-open', {
    resolve: () => {}, toolName: 'mcp__satr-terminal__browser_navigate', input: {},
    turnEligible: false, originTrust: true, origin: 'https://example.test',
    neverAlways: false, suppressAlways: false,
  });
  resolvePermission('b-open', true, true, false);
  check('بلا suppress: ثقة النطاق تُكتب كما كانت', trustedBrowserOrigins.has('https://example.test'));
}

// ------------------------------------------------------- عقد المصدر (نصّي، يمنع التفافاً)
function sourceContract() {
  check('agent.js يلتقط الحقلين من وسيط canUseTool الثالث',
    /canUseTool: async \(toolName, input, \{[^}]*defaultToNo[^}]*suppressAlwaysAllowRule[^}]*\}\)/.test(SOURCE));
  check('agent.js يستورد askFlags من autogate', /require\('\.\/autogate'\)/.test(SOURCE) && /askFlags/.test(SOURCE));
  const askCalls = (SOURCE.match(/askFlags\(\{/g) || []).length;
  check('كل مواضع بثّ permission_request الثلاثة تمرّ على askFlags (' + askCalls + ')', askCalls === 3);
  const emits = (SOURCE.match(/type: 'permission_request'/g) || []).length;
  check('لا موضع بثّ رابعاً بلا askFlags (' + emits + ' مواضع)', emits === 3);
  check('لا موضع يبثّ alwaysEligible محسوباً خارج askFlags',
    !/alwaysEligible: (?!ask\.|costAsk\.|browserAsk\.)/.test(SOURCE));
  const dialog = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'components', 'perm-dialog.js'), 'utf8');
  check('perm-dialog يخفي «الموافقة الدائمة» عند alwaysEligible === false',
    /_always\.hidden = this\._current\.alwaysEligible === false/.test(dialog));
}

// ----------------------------------------------------------- (٤) المربع حيّاً في Chromium
async function domChecks(win) {
  const probe = await win.webContents.executeJavaScript(`(async () => {
    const dialog = document.querySelector('satr-perm-dialog');
    const root = dialog.shadowRoot;
    const q = (sel) => root.querySelector(sel);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
    const click = (el, detail) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, detail }));
    const out = {};

    // (أ) طلب حسّاس: defaultToNo + alwaysEligible:false
    window.__permCalls.length = 0;
    dialog.closeAll();
    dialog.request({ id: 'sensitive', tool: 'Bash', detail: 'rm -rf /', defaultToNo: true, alwaysEligible: false, turnEligible: false });
    await settle();
    out.sensitive = {
      open: dialog.hasAttribute('open'),
      focused: root.activeElement ? root.activeElement.className : null,
      alwaysHidden: q('.always').hidden,
      hintHidden: q('.sensitive').hidden,
      hint: q('.sensitive').textContent,
    };
    // نقرة مولَّدة بلوحة المفاتيح (detail = 0) على «موافقة» — يجب ألّا تقبل
    click(q('.allow'), 0);
    out.sensitive.afterKeyboardClick = window.__permCalls.length;
    // Enter على زرّ القبول — يجب أن يُمنع قبل أن يولّد نقرة أصلية
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true, cancelable: true });
    q('.allow').dispatchEvent(enter);
    out.sensitive.enterPrevented = enter.defaultPrevented;
    out.sensitive.afterEnter = window.__permCalls.length;
    // Enter على «رفض» يبقى مسموحاً (لا نغلق الباب على لوحة المفاتيح)
    const denyEnter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true, cancelable: true });
    q('.deny').dispatchEvent(denyEnter);
    out.sensitive.denyEnterPrevented = denyEnter.defaultPrevented;
    // نقرة مؤشّر حقيقية (detail = 1) تقبل
    click(q('.allow'), 1);
    out.sensitive.afterPointerClick = window.__permCalls.length;
    out.sensitive.pointerCall = window.__permCalls[0] || null;

    // (ب) طلب عادي: السلوك القائم بلا تغيير
    window.__permCalls.length = 0;
    dialog.closeAll();
    dialog.request({ id: 'plain', tool: 'Read', detail: 'package.json', alwaysEligible: true, turnEligible: true });
    await settle();
    out.plain = {
      focused: root.activeElement ? root.activeElement.className : null,
      alwaysHidden: q('.always').hidden,
      hintHidden: q('.sensitive').hidden,
    };
    click(q('.allow'), 0); // لوحة المفاتيح تبقى عاملة في الطلب العادي
    out.plain.afterKeyboardClick = window.__permCalls.length;
    out.plain.call = window.__permCalls[0] || null;
    dialog.closeAll();
    return out;
  })()`, true);

  console.log('  قياس المربع: ' + JSON.stringify(probe));
  check('الطلب الحسّاس يفتح المربع', probe.sensitive.open === true);
  check('الطلب الحسّاس يركّز «رفض» لا «موافقة»', probe.sensitive.focused === 'deny');
  check('الطلب الحسّاس يخفي «الموافقة الدائمة» (alwaysEligible:false)', probe.sensitive.alwaysHidden === true);
  check('الطلب الحسّاس يعرض سطر التحذير العربي', probe.sensitive.hintHidden === false && /طلب حسّاس/.test(probe.sensitive.hint));
  check('نقرة مولَّدة بلوحة المفاتيح لا تَقبل', probe.sensitive.afterKeyboardClick === 0);
  check('Enter على زرّ القبول يُمنع', probe.sensitive.enterPrevented === true && probe.sensitive.afterEnter === 0);
  check('Enter على «رفض» يبقى عاملاً (لا يُمنع)', probe.sensitive.denyEnterPrevented === false);
  check('نقرة المؤشّر الصريحة تَقبل', probe.sensitive.afterPointerClick === 1 && probe.sensitive.pointerCall.allow === true);
  check('نقرة المؤشّر لا ترسل always', probe.sensitive.pointerCall.always === false);
  check('الطلب العادي يركّز «موافقة» كما كان', probe.plain.focused === 'allow');
  check('الطلب العادي يُظهر «الموافقة الدائمة»', probe.plain.alwaysHidden === false);
  check('الطلب العادي يخفي سطر التحذير', probe.plain.hintHidden === true);
  check('الطلب العادي يقبل بلوحة المفاتيح كما كان',
    probe.plain.afterKeyboardClick === 1 && probe.plain.call.allow === true);
}

async function main() {
  pureChecks();
  const askPending = askSiteChecks();
  resolveChecks(askPending);
  sourceContract();

  await app.whenReady();
  const consoleErrors = [];
  const win = new BrowserWindow({
    show: false, width: 900, height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2 || /securitypolicyviolation|content security policy|uncaught|unhandled/i.test(String(message))) {
      consoleErrors.push(String(message));
    }
  });
  try {
    await win.loadFile(FIXTURE);
    await delay(150);
    const ready = await win.webContents.executeJavaScript('window.__permReady === true', true);
    assert.ok(ready, 'لم يُحمّل مكوّن مربع الإذن في الصفحة.');
    await domChecks(win);
    assert.deepStrictEqual(consoleErrors, [], 'ظهرت أخطاء console أو CSP أثناء الاختبار.');
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
  console.log('\nالنتيجة: ' + passed + '/' + passed + ' ناجحة — حقلا طلب الإذن يضيّقان في العملية الرئيسية والمربع.');
}

main().then(() => { clearTimeout(watchdog); app.exit(0); }).catch((error) => {
  console.error('perm-ask-fields:', error && error.stack ? error.stack : error);
  app.exit(1);
});
