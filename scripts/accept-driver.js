#!/usr/bin/env node
'use strict';

/**
 * سطر — سائق القبول الآلي المصوَّر (‏`accept:driver`).
 *
 * ينقل السائق الشخصي `drive-step5.js` إلى المستودع سكربتاً عاماً بسيناريوهات **معلنة**:
 * يشغّل نسخة سطر **مبنية** بمنفذ تصحيح Chromium وملف شخصي منسوخ، ثم ينفّذ خطوات السيناريو
 * عبر بروتوكول DevTools (‏Node 26 فيه WebSocket مدمج — **صفر تبعية npm**): ينقر في الشجرة
 * الظلية الحقيقية، ينقر «سماح» في مربعات الإذن داخل نسخة الاختبار وحدها ويسجّل كل نقرة،
 * يلتقط صورة عند كل خطوة، يجمع الأدلة في `<out>/evidence.json`، ثم يحكم بدالة **نقية**
 * `judge()` ويكتب تقريراً عربياً مصوَّراً.
 *
 * لماذا الحكم دالة نقية: لأن «العضّة» (‏`--bite`) تعيد الحكم على الأدلة نفسها بمعيار معكوس
 * بلا دور نموذج ثانٍ — فيثبت أن السائق يسجّل فشلاً ولا يكون حارساً أخضر كاذباً.
 *
 *   node scripts/accept-driver.js --scenario step5 --exe <Satr.exe> --profile <src> --out <dir>
 *     [--note <file>] [--port 9333] [--bite] [--report] [--pre] [--dry-run]
 *     [--skip-human] [--keep-storage]
 *
 * العقد الثابت (‏OBS-178): قبل أول خطوة تُصفَّر مفاتيح `localStorage` التي تبدأ بـ`satr_`
 * ويُسجَّل ما صُفِّر في الأدلة والتقرير — لأن ملفاً شخصياً موروثاً حمل `satr_desktop_control=1`
 * فصار «التفعيل» لا-انتقالاً بلا إشعار وقِيس فشلاً كاذباً. `--keep-storage` يعطّل التصفير بإعلان.
 *
 * حدّ معلَن: السائق **لا يقرأ ولا يكتب سرّاً**. خطوات إدخال الرموز الشخصية معلَنة
 * `human: true`؛ يتوقف عندها بتعليمات عربية وينتظر ملف علم `<out>/continue-<n>.txt`.
 *
 * كل ما يُكتب (ملف شخصي منسوخ · صور · سجلات · أدلة · تقرير) داخل `--out` وحده.
 * التوثيق: `docs/internals/77-accept-driver.md`.
 */

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ACT_TOOLS = ['desktop_click', 'desktop_type', 'desktop_press_key', 'desktop_scroll'];
const READ_TOOLS = ['desktop_targets', 'desktop_snapshot', 'desktop_wait_for', 'desktop_screenshot'];
const TURN_TIMEOUT_MS = 180000;
const DEFAULT_PORT = 9333;

// ---------- أدوات صغيرة ----------
function log(msg) { process.stdout.write('[accept-driver] ' + msg + '\n'); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
function bare(tool) { return String(tool || '').replace(/^mcp__satr-desktop__/, ''); }
function hasArabic(s) { return /[؀-ۿ]/.test(String(s || '')); }
function words(s) { return String(s || '').trim().split(/\s+/).filter(Boolean).length; }

// ---------- وسائط سطر الأوامر ----------
function parseArgs(argv) {
  const opts = {
    scenario: 'step5', exe: '', profile: '', out: '', note: '', port: DEFAULT_PORT,
    bite: false, report: false, pre: false, dryRun: false, skipHuman: false, keepStorage: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--scenario') opts.scenario = String(next() || '');
    else if (a === '--exe') opts.exe = String(next() || '');
    else if (a === '--profile') opts.profile = String(next() || '');
    else if (a === '--out') opts.out = String(next() || '');
    else if (a === '--note') opts.note = String(next() || '');
    else if (a === '--port') opts.port = Number(next()) || DEFAULT_PORT;
    else if (a === '--bite') opts.bite = true;
    else if (a === '--report') opts.report = true;
    else if (a === '--pre') opts.pre = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--skip-human') opts.skipHuman = true;
    else if (a === '--keep-storage') opts.keepStorage = true;
  }
  if (opts.bite) opts.report = true; // العضّة إعادة حكم لا تشغيل
  return opts;
}

// ---------- PowerShell: ملف سكربت مؤقت أوضح من اقتباسات -Command المتداخلة ----------
function psRunner(outDir) {
  return function ps(script) {
    const file = path.join(outDir, 'tmp-' + Date.now() + '.ps1');
    fs.writeFileSync(file, '\uFEFF' + script, 'utf8');
    try {
      return execFileSync('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
        { encoding: 'utf8', timeout: 60000 });
    } finally { try { fs.unlinkSync(file); } catch (e) { /* مؤقت */ } }
  };
}

/**
 * إيقاف نسخ الاختبار **بالمسار وحده** — عمليات المسار الآخر (سطر الإنتاج التي يعمل فيها
 * المالك أو القائد) لا تُلمس. الاسم `Satr.exe` مشترك بين النسختين فلا يصلح معياراً.
 */
function stopBuildInstances(ps, exe) {
  const prefix = path.dirname(path.dirname(path.resolve(exe))) + path.sep;
  const out = ps(
    '$hits = Get-CimInstance Win32_Process -Filter "Name=\'Satr.exe\'" | Where-Object { $_.ExecutablePath -like "'
    + prefix + '*" }\n'
    + 'foreach ($h in $hits) { Write-Output ("KILL " + $h.ProcessId + " " + $h.ExecutablePath); Stop-Process -Id $h.ProcessId -Force -ErrorAction SilentlyContinue }\n'
    + 'if (-not $hits) { Write-Output "NONE" }\n');
  return out.trim();
}

// ---------- عميل CDP بلا تبعية ----------
class Cdp {
  constructor(url, outDir) {
    this.outDir = outDir;
    this.ws = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.consoleErrors = [];
    this.exceptions = [];
    this.ws.addEventListener('message', (event) => this._onMessage(String(event.data)));
  }
  ready() {
    return new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve(), { once: true });
      this.ws.addEventListener('error', () => reject(new Error('فشل اتصال WebSocket بمنفذ التصحيح')), { once: true });
    });
  }
  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(timer);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'warning')) {
      const text = (msg.params.args || []).map((a) => String(a.value !== undefined ? a.value : a.description || '')).join(' ');
      this.consoleErrors.push(msg.params.type + ': ' + text);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails || {};
      this.exceptions.push(d.text + ' ' + ((d.exception && d.exception.description) || ''));
    }
    if (msg.method === 'Log.entryAdded') {
      const e = msg.params.entry || {};
      if (e.level === 'error') this.consoleErrors.push('log: ' + e.text);
    }
  }
  send(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('انتهت مهلة أمر CDP: ' + method));
      }, 60000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('استثناء في الصفحة: ' + ((d.exception && d.exception.description) || d.text));
    }
    return r.result ? r.result.value : undefined;
  }
  async screenshot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(this.outDir, name + '.png');
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return name + '.png';
  }
  close() { try { this.ws.close(); } catch (e) { /* مغلق */ } }
}

// ---------- تصفير مفاتيح satr_* (‏OBS-178) ----------
const RESET_SNIPPET = '(() => { const keys = Object.keys(localStorage)'
  + '.filter((k) => k.indexOf("satr_") === 0);'
  + ' const removed = keys.map((k) => k + "=" + String(localStorage.getItem(k)).slice(0, 60));'
  + ' for (const k of keys) localStorage.removeItem(k); return removed; })()';

/**
 * يُمرَّر `evaluate` لا كائن CDP كي يبقى قابلاً للاختبار بلا Electron.
 * يعيد قائمة `مفتاح=قيمة` بما صُفِّر فعلاً — وهي تُكتب في الأدلة والتقرير.
 */
async function resetSatrStorage(evaluate) {
  const removed = await evaluate(RESET_SNIPPET);
  return Array.isArray(removed) ? removed : [];
}

// ---------- مقتطفات تُقيَّم داخل الصفحة ----------
const PANEL = "document.querySelector('satr-desktop-panel')";
const PROOT = PANEL + '.shadowRoot';

const READ_PANEL = '(() => { const p = ' + PANEL + '; if (!p) return {missing:true};'
  + ' const r = p.shadowRoot;'
  + ' return { open: p.hasAttribute("open"),'
  + '   state: r.querySelector(".state").textContent,'
  + '   enabled: r.querySelector(".enable").checked,'
  + '   selectedText: r.querySelector(".selected-text").textContent,'
  + '   fixed: (r.querySelector(".fixed") || {}).textContent || "",'
  + '   targets: [...r.querySelectorAll(".target")].map((row) => ({'
  + '     label: row.querySelector(".target-label").textContent,'
  + '     title: row.querySelector(".target-title").textContent,'
  + '     id: (row.querySelector(".target-meta .tech") || {}).textContent || "" })),'
  + '   log: [...r.querySelectorAll(".log li")].map((li) => ({'
  + '     time: li.querySelector(".time").textContent,'
  + '     text: li.querySelector(".text").textContent,'
  + '     dir: li.querySelector(".text").getAttribute("dir") || "" })) }; })()';

const READ_SHELL = '(() => ({'
  + ' toggleHidden: document.getElementById("desktopToggle").hidden,'
  + ' toggleText: document.getElementById("desktopToggle").textContent,'
  + ' sendText: document.getElementById("send").textContent,'
  + ' inputValue: document.getElementById("input").value,'
  + ' engine: document.getElementById("engine").value,'
  + ' model: document.getElementById("model").value,'
  + ' cwd: document.getElementById("cwd").value,'
  + ' cost: (document.getElementById("costInfo") || {}).textContent || "",'
  + ' notices: [...document.querySelectorAll(".notice")].map((n) => n.textContent),'
  + ' chatLines: [...document.querySelectorAll(".desktop-line")].map((el) => {'
  + '   const t = el.querySelector(".desktop-text");'
  + '   return { text: t ? t.textContent : "", dir: t ? (t.getAttribute("dir") || "") : "" }; }),'
  + ' toolNames: [...document.querySelectorAll(".tool .name")].map((n) => n.textContent) }))()';

const READ_PERM = '(() => { const d = document.querySelector("satr-perm-dialog");'
  + ' if (!d || !d.hasAttribute("open")) return null; const r = d.shadowRoot;'
  + ' return { tool: r.querySelector(".tool-name").textContent,'
  + '   detail: r.querySelector(".perm-detail").textContent,'
  + '   alwaysHidden: r.querySelector(".always").hidden,'
  + '   turnHidden: r.querySelector(".turn").hidden }; })()';

const CLICK_ALLOW = '(() => { const d = document.querySelector("satr-perm-dialog");'
  + ' if (!d || !d.hasAttribute("open")) return false;'
  + ' d.shadowRoot.querySelector(".allow").click(); return true; })()';

const CLICK_DENY = '(() => { const d = document.querySelector("satr-perm-dialog");'
  + ' if (!d || !d.hasAttribute("open")) return false;'
  + ' d.shadowRoot.querySelector(".deny").click(); return true; })()';

const READ_QUESTION = '(() => { const q = document.querySelector("satr-question-dialog");'
  + ' if (!q || !q.hasAttribute("open")) return null;'
  + ' return { text: q.shadowRoot.textContent.slice(0, 400) }; })()';

const ANSWER_QUESTION = '(() => { const q = document.querySelector("satr-question-dialog");'
  + ' if (!q || !q.hasAttribute("open")) return false;'
  + ' const b = q.shadowRoot.querySelector("button"); if (!b) return false; b.click(); return true; })()';

// آخر رد للوكيل: بنية Markdown المصيَّرة (سيناريو القرائية — docs/internals/66-reply-readability.md)
const READ_ANSWER = '(() => { const wraps = [...document.querySelectorAll(".answer-wrap .md")];'
  + ' const md = wraps[wraps.length - 1]; if (!md) return { missing: true };'
  + ' const nodes = [...md.children].map((el) => ({ tag: el.tagName.toLowerCase(),'
  + '   text: (el.textContent || "").trim().slice(0, 300),'
  + '   dir: el.getAttribute("dir") || "",'
  + '   start: el.getAttribute("start") || "",'
  + '   width: Math.round(el.getBoundingClientRect().width),'
  + '   size: parseFloat(getComputedStyle(el).fontSize) || 0,'
  + '   weight: String(getComputedStyle(el).fontWeight) }));'
  + ' return { text: md.textContent || "", html: md.innerHTML.length, nodes }; })()';

const READ_CONNECTIONS = '(() => { const p = document.querySelector("satr-connections-panel");'
  + ' if (!p) return { missing: true }; const r = p.shadowRoot || p;'
  + ' return { rows: [...r.querySelectorAll(".conn-row")].map((row) => ({'
  + '   service: (row.querySelector(".conn-name") || {}).textContent || "",'
  + '   state: (row.querySelector(".conn-state") || {}).textContent || "" })) }; })()';

// ---------- حلقة الأذونات: تعمل بالتوازي مع الدور ----------
function startPermWatcher(cdp, evidence, mode) {
  let stopped = false;
  let busy = false;
  const decide = mode || (() => 'allow');
  const loop = async () => {
    while (!stopped) {
      await sleep(250);
      if (busy || stopped) continue;
      busy = true;
      try {
        const perm = await cdp.evaluate(READ_PERM);
        if (perm) {
          const k = evidence.perms.length + 1;
          const shot = await cdp.screenshot('perm-' + k);
          const verdict = decide(perm);
          const clicked = await cdp.evaluate(verdict === 'deny' ? CLICK_DENY : CLICK_ALLOW);
          evidence.perms.push(Object.assign({ k, shot, clicked, verdict, at: nowStamp() }, perm));
          log('إذن #' + k + ': ' + perm.tool + ' — «' + (verdict === 'deny' ? 'رفض' : 'سماح') + '» '
            + (clicked ? 'نُقر' : 'تعذّر'));
        } else {
          const q = await cdp.evaluate(READ_QUESTION);
          if (q) {
            const k = evidence.questions.length + 1;
            const shot = await cdp.screenshot('question-' + k);
            const answered = await cdp.evaluate(ANSWER_QUESTION);
            evidence.questions.push({ k, shot, answered, text: q.text, at: nowStamp() });
            log('حوار سؤال #' + k + ' — اختير أول خيار: ' + answered);
          }
        }
      } catch (e) { /* الصفحة قد تكون منشغلة؛ الدورة القادمة تعيد المحاولة */ }
      busy = false;
    }
  };
  const done = loop();
  return { stop: async () => { stopped = true; await done; } };
}

// ---------- انتظار شرط داخل الصفحة ----------
async function waitUntil(cdp, expr, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 15000);
  while (Date.now() < deadline) {
    let v;
    try { v = await cdp.evaluate(expr); } catch (e) { v = false; }
    if (v) return true;
    await sleep(250);
  }
  return false;
}

async function waitForTurnEnd(cdp, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || TURN_TIMEOUT_MS);
  while (Date.now() < deadline) {
    await sleep(2000);
    const s = await cdp.evaluate('document.getElementById("send").textContent');
    if (s === 'إرسال') return true;
  }
  return false;
}

async function sendPrompt(cdp, text) {
  await cdp.evaluate('(() => { const i = document.getElementById("input"); i.value = '
    + JSON.stringify(text) + '; i.dispatchEvent(new Event("input")); return true; })()');
  await sleep(300);
  await cdp.evaluate('document.getElementById("send").click(); true');
}

/**
 * خطوة بشرية: السائق **لا يقرأ ولا يكتب سرّاً**. يطبع التعليمات ثم ينتظر ملف علم
 * `<out>/continue-<n>.txt` يكتبه المالك بعد إتمام يده — أو يعلّمها «متخطّاة بشرياً»
 * حين يُمرَّر `--skip-human`.
 */
async function awaitHuman(ctx, step) {
  if (ctx.opts.skipHuman) {
    log('خطوة ' + step.n + ' بشرية — متخطّاة بـ--skip-human.');
    return { skipped: true, done: false };
  }
  const flag = path.join(ctx.opts.out, 'continue-' + step.n + '.txt');
  log('⏸ خطوة ' + step.n + ' بشرية: ' + step.instructions);
  log('   أنجِزها ثم أنشئ ملف العلم: ' + flag);
  const deadline = Date.now() + 900000; // ربع ساعة سقفاً معلَناً
  while (Date.now() < deadline) {
    if (fs.existsSync(flag)) return { skipped: false, done: true };
    await sleep(2000);
  }
  return { skipped: false, done: false, timedOut: true };
}

// ============================================================================
// السيناريوهات المعلنة
// ============================================================================

/**
 * الخطوة ٥ من `docs/COMPUTER-USE-DESKTOP.md` §١٠: منتقي نافذة سطح ويندوز وسجلّ الأفعال.
 * الخطوات الثماني ومعاييرها منقولة حرفياً من السائق الشخصي الذي أعطى 8/8 (2026-09-12).
 */
const STEP5 = {
  id: 'step5',
  title: 'الخطوة ٥ — منتقي نافذة سطح ويندوز وسجلّ الأفعال',
  needs: ['exe', 'profile', 'note'],
  bite: 'يُعكس معيار الخطوة ٥: يُطلب أن يكون «موافقة دائمة» **ظاهراً** على `desktop_type`، والصحيح أنه مخفي.',
  steps: [
    {
      n: 1,
      title: 'نقر #topMore — كشف زر سطح ويندوز',
      expect: '‏`#desktopToggle` غير مخفي بعد فتح درج الأدوات',
      async act(ctx) {
        await ctx.cdp.evaluate('document.getElementById("topMore").click(); true');
        await sleep(600);
        const shell = await ctx.cdp.evaluate(READ_SHELL);
        return { toggleHidden: shell.toggleHidden, shot: await ctx.cdp.screenshot('step-1') };
      },
      judge(ev) {
        const s = ev.steps['1'] || {};
        return { ok: s.toggleHidden === false,
          actual: s.toggleHidden === false ? 'ظاهر' : 'مخفي ⇒ الحزمة بلا معين' };
      },
    },
    {
      n: 2,
      title: 'نقر #desktopToggle — فتح اللوحة وسرد النوافذ',
      expect: 'اللوحة مفتوحة · صفّ المفكرة بعنوان يحوي step5 · السطر الثابت ظاهر · صفر صفوف سطر/electron',
      async act(ctx) {
        await ctx.cdp.evaluate('document.getElementById("desktopToggle").click(); true');
        await waitUntil(ctx.cdp, PANEL + '.hasAttribute("open")', 8000);
        // المفكرة قد تتأخر في الظهور — حدّث القائمة حتى يظهر صفّ step5 (مهلة 15ث)
        const hasNote = '(() => [...' + PROOT + '.querySelectorAll(".target-title")]'
          + '.some((t) => /step5/i.test(t.textContent)))()';
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline && !(await ctx.cdp.evaluate(hasNote))) {
          await ctx.cdp.evaluate(PROOT + '.querySelector(".refresh").click(); true');
          await sleep(1200);
        }
        const panel = await ctx.cdp.evaluate(READ_PANEL);
        return { open: panel.open, targets: panel.targets, fixed: panel.fixed,
          shot: await ctx.cdp.screenshot('step-2') };
      },
      judge(ev) {
        const s = ev.steps['2'] || {};
        const targets = s.targets || [];
        const noteRow = targets.find((t) => /step5/i.test(t.title));
        // المعيار على **التطبيق المالك** (‏label) لا على العنوان: قياس 2026-09-13 أظهر نافذة
        // «مستكشف الملفات» لمجلد اسمه `radar satr` تُطابق `/satr/` في العنوان فتُقرأ «نافذة سطر
        // معروضة» — إيجابية كاذبة في السائق لا عطل في المنتج (المنتج يستبعد نوافذ عمليته هو).
        const satrRows = targets.filter((t) => /satr|سطر|electron/i.test(t.label));
        const fixedOk = /نوافذ النظام ونافذة سطر والمصغّرة لا تُعرض/.test(s.fixed || '');
        return {
          ok: s.open === true && !!noteRow && fixedOk && satrRows.length === 0,
          actual: 'مفتوحة=' + s.open + ' · المفكرة=' + (noteRow ? '«' + noteRow.title + '»' : 'غائبة')
            + ' · السطر الثابت=' + (fixedOk ? 'ظاهر' : 'غائب') + ' · صفوف سطر/electron=' + satrRows.length
            + ' · إجمالي الصفوف=' + targets.length,
        };
      },
    },
    {
      n: 3,
      title: 'تفعيل .enable — إشعار التفعيل ونقطة الزر',
      expect: 'إشعار عربي بالتفعيل + ● على زر الدرج',
      async act(ctx) {
        // شبكة أمان بعد التصفير: إن بقي العلم مفعّلاً لأي سبب فالنقرة لن تكون انتقالاً (OBS-178)
        let normalized = false;
        if ((await ctx.cdp.evaluate(READ_PANEL)).enabled === true) {
          await ctx.cdp.evaluate('(() => { const e = ' + PROOT + '.querySelector(".enable");'
            + ' e.checked = false; e.dispatchEvent(new Event("change")); return true; })()');
          await waitUntil(ctx.cdp, 'document.getElementById("desktopToggle").textContent.indexOf("●") === -1', 8000);
          normalized = true;
          log('تطبيع: العلم كان مفعّلاً رغم التصفير ⇒ أُطفئ قبل قياس الخطوة ٣');
        }
        const before = (await ctx.cdp.evaluate(READ_SHELL)).notices.length;
        await ctx.cdp.evaluate('(() => { const e = ' + PROOT + '.querySelector(".enable");'
          + ' e.checked = true; e.dispatchEvent(new Event("change")); return true; })()');
        await sleep(1000);
        const shell = await ctx.cdp.evaluate(READ_SHELL);
        const panel = await ctx.cdp.evaluate(READ_PANEL);
        return { toggleText: shell.toggleText, enabled: panel.enabled, state: panel.state, normalized,
          notices: shell.notices.slice(before), allNotices: shell.notices,
          shot: await ctx.cdp.screenshot(ctx.opts.pre ? 'pre-step-3' : 'step-3') };
      },
      judge(ev) {
        const s = ev.steps['3'] || {};
        const notice = (s.notices || []).find((t) => /فُعّل تحكّم سطح المكتب/.test(t));
        const dotOk = /●/.test(s.toggleText || '');
        return {
          ok: !!notice && dotOk,
          actual: 'الإشعار=' + (notice ? '«' + notice.slice(0, 70) + '…»' : 'غائب')
            + ' · نصّ الزر=«' + (s.toggleText || '') + '»'
            + (s.normalized ? ' · طُبّع العلم قبل القياس' : ''),
        };
      },
    },
    {
      n: 4,
      title: 'إرسال قبل اختيار نافذة',
      expect: 'لا يبدأ دور · إشعار «اختر نافذة أولاً» · النص باقٍ في المحرّر',
      async act(ctx) {
        const preText = 'اكتب سطراً في المفكرة واحفظ';
        await ctx.cdp.evaluate('(() => { const e = document.getElementById("engine"); e.value = "sdk";'
          + ' e.dispatchEvent(new Event("change"));'
          + ' const i = document.getElementById("input"); i.value = ' + JSON.stringify(preText) + ';'
          + ' i.dispatchEvent(new Event("input")); return true; })()');
        await sleep(400);
        await ctx.cdp.evaluate('document.getElementById("send").click(); true');
        await sleep(1500);
        const shell = await ctx.cdp.evaluate(READ_SHELL);
        return { sendText: shell.sendText, inputValue: shell.inputValue, engine: shell.engine,
          notices: shell.notices, shot: await ctx.cdp.screenshot('step-4') };
      },
      judge(ev) {
        const s = ev.steps['4'] || {};
        const notice = (s.notices || []).find((t) => /اختر نافذة أولاً/.test(t));
        const kept = s.inputValue === 'اكتب سطراً في المفكرة واحفظ';
        const notStarted = s.sendText === 'إرسال';
        return {
          ok: notStarted && !!notice && kept,
          actual: 'زر الإرسال=«' + s.sendText + '» · الإشعار=' + (notice ? 'ظهر' : 'غائب') + ' · النص محفوظ=' + kept,
        };
      },
    },
    {
      n: 5,
      title: 'اختيار المفكرة + الطلب الحقيقي (دور نموذج واحد)',
      expect: 'لكل أداة desktop_* مربع إذن يذكر النافذة؛ «دائمة» مخفي في أدوات الفعل الأربع وظاهر في القرائية الأربع',
      async act(ctx) {
        await ctx.cdp.evaluate('(() => { const rows = [...' + PROOT + '.querySelectorAll(".target")];'
          + ' const row = rows.find((r) => /step5/i.test(r.querySelector(".target-title").textContent));'
          + ' if (!row) return false; row.querySelector("button").click(); return true; })()');
        await waitUntil(ctx.cdp, '!' + PROOT + '.querySelector(".clear").hidden', 10000);
        const panel = await ctx.cdp.evaluate(READ_PANEL);
        const prompt = 'اكتب في المفكرة المختارة السطر التالي ثم احفظه بـCtrl+S: سطر القبول الآلي ' + nowStamp();
        ctx.evidence.promptSent = prompt;
        await sendPrompt(ctx.cdp, prompt);
        log('أُرسل الطلب — الدور الحقيقي بدأ');
        await sleep(3000);
        return { selectedText: panel.selectedText, shot: await ctx.cdp.screenshot('step-5') };
      },
      judge(ev, bite) {
        const perms = ev.perms || [];
        const desktopPerms = perms.filter((p) => /satr-desktop/.test(p.tool));
        const problems = [];
        for (const p of desktopPerms) {
          const b = bare(p.tool);
          let expectHidden = ACT_TOOLS.includes(b);
          if (bite && b === 'desktop_type') expectHidden = false; // العضّة: معيار معكوس عمداً
          if (READ_TOOLS.includes(b) === false && ACT_TOOLS.includes(b) === false) problems.push('أداة غير معروفة: ' + b);
          if (p.alwaysHidden !== expectHidden) {
            problems.push(b + ': «دائمة» ' + (p.alwaysHidden ? 'مخفي' : 'ظاهر') + ' والمتوقع '
              + (expectHidden ? 'مخفي' : 'ظاهر'));
          }
          if (!/النافذة:/.test(p.detail || '')) problems.push(b + ': التفاصيل لا تذكر النافذة');
        }
        const actPerms = desktopPerms.filter((p) => ACT_TOOLS.includes(bare(p.tool)));
        if (!actPerms.length) problems.push('لم يظهر مربع إذن لأي أداة فعل');
        return {
          ok: problems.length === 0,
          expect: bite ? '⚠ معيار العضّة المعكوس: «دائمة» ظاهر في desktop_type' : null,
          actual: desktopPerms.length + ' مربع إذن لأدوات سطح المكتب (' + actPerms.length + ' منها أفعال)'
            + (problems.length ? ' · مخالفات: ' + problems.join(' ؛ ') : ' · بلا مخالفة'),
        };
      },
    },
    {
      n: 6,
      title: 'مراقبة اللوحة والمحادثة حتى نهاية الدور',
      expect: '≥3 أسطر في اللوحة و≥3 في المحادثة، عربية، dir=rtl',
      async act(ctx) {
        const ended = await waitForTurnEnd(ctx.cdp, TURN_TIMEOUT_MS);
        await sleep(2000);
        const panel = await ctx.cdp.evaluate(READ_PANEL);
        const shell = await ctx.cdp.evaluate(READ_SHELL);
        ctx.evidence.cost = shell.cost;
        ctx.evidence.shell = { model: shell.model, cwd: shell.cwd, engine: shell.engine };
        return { turnEnded: ended, panelLog: panel.log, chatLines: shell.chatLines,
          toolNames: shell.toolNames, notices: shell.notices, shot: await ctx.cdp.screenshot('step-6') };
      },
      judge(ev) {
        const s = ev.steps['6'] || {};
        const panelLog = s.panelLog || [];
        const chatLines = s.chatLines || [];
        const badDir = chatLines.filter((l) => l.dir !== 'rtl');
        const nonArabic = panelLog.concat(chatLines).filter((l) => !hasArabic(l.text));
        return {
          ok: panelLog.length >= 3 && chatLines.length >= 3 && badDir.length === 0 && nonArabic.length === 0,
          actual: 'اللوحة=' + panelLog.length + ' · المحادثة=' + chatLines.length
            + ' · أسطر بلا rtl=' + badDir.length + ' · أسطر بلا عربية=' + nonArabic.length
            + ' · انتهى الدور=' + s.turnEnded,
        };
      },
    },
    {
      n: 7,
      title: 'قراءة ملف المفكرة من القرص',
      expect: 'محتوى الملف تغيّر ويحوي «سطر القبول الآلي»',
      async act(ctx) {
        const fileAfter = fs.readFileSync(ctx.note, 'utf8');
        ctx.evidence.fileAfter = fileAfter;
        const out = { bytesBefore: Buffer.byteLength(ctx.evidence.fileBefore || ''),
          bytesAfter: Buffer.byteLength(fileAfter), shot: await ctx.cdp.screenshot('step-7') };
        try {
          ctx.ps('Add-Type -AssemblyName System.Windows.Forms, System.Drawing\n'
            + '$b = [System.Windows.Forms.SystemInformation]::VirtualScreen\n'
            + '$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height\n'
            + '$g = [System.Drawing.Graphics]::FromImage($bmp)\n'
            + '$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)\n'
            + '$bmp.Save("' + path.join(ctx.opts.out, 'notepad-after.png') + '")\n'
            + '$g.Dispose(); $bmp.Dispose()\n');
          out.screenShot = 'notepad-after.png';
        } catch (e) { out.screenShotError = String((e && e.message) || e); }
        return out;
      },
      judge(ev) {
        const s = ev.steps['7'] || {};
        const changed = ev.fileAfter !== ev.fileBefore;
        const contains = /سطر القبول الآلي/.test(ev.fileAfter || '');
        return {
          ok: changed && contains,
          actual: s.bytesBefore + ' ⇐ ' + s.bytesAfter + ' بايت · تغيّر=' + changed + ' · يحوي العبارة=' + contains,
        };
      },
    },
    {
      n: 8,
      title: 'نقر #newSession — إطفاء التحكم وسحب الاختيار',
      expect: 'إشعارا الإطفاء والسحب · .enable غير مفعّل · «لم تُختر نافذة»',
      async act(ctx) {
        const before = (await ctx.cdp.evaluate(READ_SHELL)).notices.length;
        await ctx.cdp.evaluate('document.getElementById("newSession").click(); true');
        await sleep(2000);
        const panel = await ctx.cdp.evaluate(READ_PANEL);
        const shell = await ctx.cdp.evaluate(READ_SHELL);
        return { enabled: panel.enabled, selectedText: panel.selectedText,
          newNotices: shell.notices.slice(before), notices: shell.notices,
          shot: await ctx.cdp.screenshot('step-8') };
      },
      judge(ev) {
        const s = ev.steps['8'] || {};
        // newSession يستدعي chatEl.reset() فيمسح الخيط: الإشعاران الجديدان يبقيان وحدهما،
        // لذلك يُحكم على الاتحاد لا على الشريحة بعد الطول القديم
        const n8 = (s.newNotices || []).concat(s.notices || []);
        const offNotice = n8.some((t) => /أُوقف تحكّم سطح المكتب تلقائياً/.test(t));
        const clearNotice = n8.some((t) => /سُحب اختيار النافذة|أُلغي اختيار النافذة/.test(t));
        const cleared = /لم تُختر نافذة/.test(s.selectedText || '');
        return {
          ok: offNotice && clearNotice && s.enabled === false && cleared,
          actual: 'إشعار الإطفاء=' + offNotice + ' · إشعار السحب=' + clearNotice
            + ' · مفعّل=' + s.enabled + ' · نصّ الاختيار=«' + (s.selectedText || '').slice(0, 60) + '»',
        };
      },
    },
  ],
  extraReport(ev, L) {
    L.push('## أسطر السجل حرفياً');
    L.push('');
    L.push('### لوحة سطح ويندوز');
    const panelLog = (ev.steps['6'] || {}).panelLog || [];
    if (!panelLog.length) L.push('_لا أسطر._');
    for (const l of panelLog) L.push('- `' + l.time + '` (' + (l.dir || '—') + ') ' + l.text);
    L.push('');
    L.push('### خيط المحادثة');
    const chatLines = (ev.steps['6'] || {}).chatLines || [];
    if (!chatLines.length) L.push('_لا أسطر._');
    for (const l of chatLines) L.push('- (dir=' + (l.dir || '—') + ') ' + l.text);
    L.push('');
    L.push('### بطاقات الأدوات في المحادثة');
    for (const n of ((ev.steps['6'] || {}).toolNames || [])) L.push('- `' + n + '`');
    L.push('');
    L.push('## محتوى ملف المفكرة');
    L.push('');
    L.push('**قبل** (' + Buffer.byteLength(ev.fileBefore || '') + ' بايت):');
    L.push('```');
    L.push(ev.fileBefore || '');
    L.push('```');
    L.push('**بعد** (' + Buffer.byteLength(ev.fileAfter || '') + ' بايت):');
    L.push('```');
    L.push(ev.fileAfter || '');
    L.push('```');
    L.push('لقطة الشاشة الكاملة بعد الخطوة ٧ (المفكرة مرئية): `notepad-after.png`');
    L.push('');
  },
  limits: [
    'السائق يرى **DOM الصفحة** فقط: تخطيط النافذة الأصلية، وحدود WebContentsView، وسلوك الفأرة الحقيقي خارج نطاقه.',
    'لقطة `Page.captureScreenshot` للصفحة لا لإطار النافذة؛ حالة المفكرة نفسها من لقطة الشاشة الكاملة ومن قراءة الملف.',
    'لم يُقس رسوّ الاتجاه بالبكسل — الحكم على `dir` المضبوط على العنصر (‏`applyDir`)، وهو أضعف من مسبار البكسل.',
    'دور نموذج **واحد** يجري؛ نسخة العضّة تعيد الحكم على الأدلة نفسها بلا دور ثانٍ.',
    'نقرات «سماح» آلية: هي **بديل** عن حكم المالك البشري لكل مربع، لا تأكيد له — المربعات مصوَّرة ليراجعها بنفسه.',
  ],
};

/**
 * التوصيلات — الصفوف 11–14 من `docs/FINAL-BATCH-OWNER-CHECKLIST.md` §1.
 * **حدّ صريح**: إدخال الرمز الشخصي (‏PAT) خطوة بشرية؛ السائق لا يقرأ ولا يكتب سرّاً.
 */
const CONNECTIONS = {
  id: 'connections',
  title: 'التوصيلات — الصفوف 11–14 (‏Netlify قراءة · رفض البناء · Supabase قراءة · الفصل)',
  needs: ['exe', 'profile'],
  bite: 'يُعكس معيار الخطوة ٤: يُعدّ خروج طلب البناء بعد الرفض صواباً — والصحيح أن لا يخرج.',
  steps: [
    {
      n: 1,
      human: true,
      title: 'ربط Netlify برمز شخصي (يد المالك)',
      instructions: 'افتح لوحة التوصيلات، سجّل الدخول إلى Netlify عند الحاجة، وألصق الرمز الشخصي في '
        + 'الحقل السري ثم اختر موقعاً تجريبياً. السائق لا يقرأ الرمز ولا يكتبه ولا يصوّر الحقل مكشوفاً.',
      expect: 'الصفّ يظهر «متصل» في لوحة التوصيلات بعد يد المالك (أو يُعلَن متخطّى بشرياً)',
      async act(ctx) {
        const res = await awaitHuman(ctx, this);
        const panel = await ctx.cdp.evaluate(READ_CONNECTIONS);
        return Object.assign({ panel, shot: await ctx.cdp.screenshot('conn-step-1') }, res);
      },
      judge(ev) {
        const s = ev.steps['1'] || {};
        if (s.skipped) return { ok: true, human: 'skipped', actual: 'متخطّاة بشرياً (‏--skip-human)' };
        const rows = ((s.panel || {}).rows) || [];
        const row = rows.find((r) => /netlify/i.test(r.service));
        const ok = !!row && /متصل/.test(row.state || '');
        return { ok, actual: row ? 'Netlify=«' + row.state + '»' : 'صفّ Netlify غائب عن اللوحة' };
      },
    },
    {
      n: 2,
      title: 'طلب قراءة Netlify — inspect و list_deploys',
      expect: 'يطابق ناتج `inspect` و`list_deploys` الحساب والموقع اللذين اختارهما المالك، ويظهر استعمال المحرك الفعلي',
      async act(ctx) {
        const prompt = 'افحص توصيلة Netlify: نفّذ inspect ثم list_deploys للموقع المختار واعرض الحساب واسم الموقع.';
        ctx.evidence.promptSent = prompt;
        await sendPrompt(ctx.cdp, prompt);
        const ended = await waitForTurnEnd(ctx.cdp, TURN_TIMEOUT_MS);
        const shell = await ctx.cdp.evaluate(READ_SHELL);
        return { turnEnded: ended, toolNames: shell.toolNames, cost: shell.cost,
          answer: await ctx.cdp.evaluate(READ_ANSWER), shot: await ctx.cdp.screenshot('conn-step-2') };
      },
      judge(ev) {
        const s = ev.steps['2'] || {};
        const tools = s.toolNames || [];
        const inspect = tools.some((t) => /inspect/i.test(t));
        const deploys = tools.some((t) => /list_deploys/i.test(t));
        const usage = /\$|رمز|إدخال/.test(s.cost || '');
        return {
          ok: s.turnEnded === true && inspect && deploys && usage,
          actual: 'inspect=' + inspect + ' · list_deploys=' + deploys + ' · سطر الاستعمال='
            + (usage ? 'ظهر' : 'غائب') + ' · انتهى الدور=' + s.turnEnded,
        };
      },
    },
    {
      n: 3,
      human: true,
      title: 'تفعيل الكتابة للموقع التجريبي (يد المالك)',
      instructions: 'فعّل صلاحية الكتابة لموقع Netlify التجريبي من لوحة التوصيلات — قرار صلاحية '
        + 'لا يتخذه السائق نيابةً عن المالك.',
      expect: 'يظهر أثر تفعيل الكتابة في اللوحة (أو يُعلَن متخطّى بشرياً)',
      async act(ctx) {
        const res = await awaitHuman(ctx, this);
        const panel = await ctx.cdp.evaluate(READ_CONNECTIONS);
        return Object.assign({ panel, shot: await ctx.cdp.screenshot('conn-step-3') }, res);
      },
      judge(ev) {
        const s = ev.steps['3'] || {};
        if (s.skipped) return { ok: true, human: 'skipped', actual: 'متخطّاة بشرياً (‏--skip-human)' };
        const rows = ((s.panel || {}).rows) || [];
        const row = rows.find((r) => /netlify/i.test(r.service));
        return { ok: !!row && /كتابة/.test(row.state || ''), actual: row ? 'Netlify=«' + row.state + '»' : 'صفّ Netlify غائب' };
      },
    },
    {
      n: 4,
      title: 'طلب بناء ثم **رفض** بطاقة الإذن',
      expect: 'بطاقة إذن البناء تظهر وتُرفض؛ لا يخرج أي طلب بناء بعد الرفض',
      async act(ctx) {
        ctx.permMode = (perm) => (/build|deploy/i.test(perm.tool + ' ' + perm.detail) ? 'deny' : 'allow');
        const prompt = 'أطلق بناءً جديداً لموقع Netlify التجريبي.';
        ctx.evidence.promptSent = prompt;
        await sendPrompt(ctx.cdp, prompt);
        const ended = await waitForTurnEnd(ctx.cdp, TURN_TIMEOUT_MS);
        const shell = await ctx.cdp.evaluate(READ_SHELL);
        ctx.permMode = null;
        return { turnEnded: ended, toolNames: shell.toolNames,
          denied: (ctx.evidence.perms || []).filter((p) => p.verdict === 'deny').map((p) => p.tool),
          answer: await ctx.cdp.evaluate(READ_ANSWER), shot: await ctx.cdp.screenshot('conn-step-4') };
      },
      judge(ev, bite) {
        const s = ev.steps['4'] || {};
        const denied = (s.denied || []).length > 0;
        const answer = ((s.answer || {}).text) || '';
        let noBuild = !/تم البناء|build started|deploy_id/i.test(answer);
        if (bite) noBuild = !noBuild; // العضّة: معيار معكوس عمداً
        return {
          ok: denied && noBuild,
          expect: bite ? '⚠ معيار العضّة المعكوس: يُعدّ خروج طلب البناء بعد الرفض صواباً' : null,
          actual: 'بطاقات مرفوضة=' + (s.denied || []).join('، ') + ' · أثر بناء خارج='
            + (noBuild ? 'لا' : 'نعم') + ' · انتهى الدور=' + s.turnEnded,
        };
      },
    },
    {
      n: 5,
      human: true,
      title: 'ربط Supabase برمز شخصي واختيار مشروع (يد المالك)',
      instructions: 'سجّل الدخول إلى Supabase عند الحاجة، وألصق الرمز الشخصي في الحقل السري ثم اختر '
        + 'مشروعاً تجريبياً. السائق لا يقرأ الرمز ولا يكتبه.',
      expect: 'الصفّ يظهر «متصل» لـSupabase (أو يُعلَن متخطّى بشرياً)',
      async act(ctx) {
        const res = await awaitHuman(ctx, this);
        const panel = await ctx.cdp.evaluate(READ_CONNECTIONS);
        return Object.assign({ panel, shot: await ctx.cdp.screenshot('conn-step-5') }, res);
      },
      judge(ev) {
        const s = ev.steps['5'] || {};
        if (s.skipped) return { ok: true, human: 'skipped', actual: 'متخطّاة بشرياً (‏--skip-human)' };
        const rows = ((s.panel || {}).rows) || [];
        const row = rows.find((r) => /supabase/i.test(r.service));
        return { ok: !!row && /متصل/.test(row.state || ''),
          actual: row ? 'Supabase=«' + row.state + '»' : 'صفّ Supabase غائب عن اللوحة' };
      },
    },
    {
      n: 6,
      title: 'طلب قراءة Supabase — inspect و list_tables',
      expect: 'يطابق `inspect` و`list_tables` المشروع المختار؛ قائمة جداول فارغة مقبولة',
      async act(ctx) {
        const prompt = 'افحص توصيلة Supabase: نفّذ inspect ثم list_tables للمشروع المختار.';
        ctx.evidence.promptSent = prompt;
        await sendPrompt(ctx.cdp, prompt);
        const ended = await waitForTurnEnd(ctx.cdp, TURN_TIMEOUT_MS);
        const shell = await ctx.cdp.evaluate(READ_SHELL);
        return { turnEnded: ended, toolNames: shell.toolNames,
          answer: await ctx.cdp.evaluate(READ_ANSWER), shot: await ctx.cdp.screenshot('conn-step-6') };
      },
      judge(ev) {
        const s = ev.steps['6'] || {};
        const tools = s.toolNames || [];
        const inspect = tools.some((t) => /inspect/i.test(t));
        const tables = tools.some((t) => /list_tables/i.test(t));
        return {
          ok: s.turnEnded === true && inspect && tables,
          actual: 'inspect=' + inspect + ' · list_tables=' + tables + ' · انتهى الدور=' + s.turnEnded,
        };
      },
    },
    {
      n: 7,
      human: true,
      title: 'فصل Netlify وSupabase من اللوحة (يد المالك)',
      instructions: 'افصل التوصيلتين من لوحة التوصيلات — الفصل فعل ملكية يقوم به المالك بنفسه.',
      expect: 'الصفّان يظهران «غير متصل» بعد الفصل (أو يُعلَن متخطّى بشرياً)',
      async act(ctx) {
        const res = await awaitHuman(ctx, this);
        const panel = await ctx.cdp.evaluate(READ_CONNECTIONS);
        return Object.assign({ panel, shot: await ctx.cdp.screenshot('conn-step-7') }, res);
      },
      judge(ev) {
        const s = ev.steps['7'] || {};
        if (s.skipped) return { ok: true, human: 'skipped', actual: 'متخطّاة بشرياً (‏--skip-human)' };
        const rows = ((s.panel || {}).rows) || [];
        const both = ['netlify', 'supabase'].map((name) => rows.find((r) => new RegExp(name, 'i').test(r.service)));
        const ok = both.every((r) => r && /غير متصل/.test(r.state || ''));
        return { ok, actual: both.map((r, i) => (i ? 'Supabase' : 'Netlify') + '=«' + ((r && r.state) || 'غائب') + '»').join(' · ') };
      },
    },
    {
      n: 8,
      title: 'طلب التحقق بعد الفصل — نتيجتا not_connected',
      expect: 'الأداتان تعيدان `not_connected` في المحادثة نفسها بعد الفصل',
      async act(ctx) {
        const prompt = 'تحقق من حالة توصيلتي Netlify وSupabase الآن.';
        ctx.evidence.promptSent = prompt;
        await sendPrompt(ctx.cdp, prompt);
        const ended = await waitForTurnEnd(ctx.cdp, TURN_TIMEOUT_MS);
        const answer = await ctx.cdp.evaluate(READ_ANSWER);
        return { turnEnded: ended, answer, shot: await ctx.cdp.screenshot('conn-step-8') };
      },
      judge(ev) {
        const s = ev.steps['8'] || {};
        const text = ((s.answer || {}).text) || '';
        const hits = (text.match(/not_connected/g) || []).length;
        return { ok: hits >= 2, actual: 'عدد not_connected في الرد=' + hits + ' · انتهى الدور=' + s.turnEnded };
      },
    },
  ],
  limits: [
    'إدخال الرموز الشخصية وفصل التوصيلات خطوات **بشرية معلَنة**: السائق لا يقرأ سرّاً ولا يكتبه ولا يصوّر حقلاً مكشوفاً.',
    'صور هذا السيناريو تُراجَع بعين المالك قبل اعتماد الصفوف 11–14 — النقرة الآلية بديل عن يده لا تأكيد لحكمه.',
    'مطابقة الحساب والموقع والمشروع تقاس بما يعرضه الرد؛ لا يفتح السائق حساب المالك على الويب.',
  ],
};

/**
 * القرائية — من `docs/internals/66-reply-readability.md`: سلّم العناوين والمصيِّر.
 * **دور نموذج واحد** كحدّ: الخطوات 2–8 تقيس الردّ نفسه.
 */
const READABILITY = {
  id: 'readability',
  title: 'القرائية — سلّم العناوين والمصيِّر واتجاه الفقرات',
  needs: ['exe', 'profile'],
  bite: 'يُعكس معيار الخطوة ٤: يُعدّ تسرّب علامات Markdown الحرفية صواباً — والصحيح أن لا تتسرّب.',
  steps: [
    {
      n: 1,
      title: 'إرسال طلب يعيد رداً طويلاً ذا عناوين وقوائم وكود',
      expect: 'يبدأ الدور فعلاً (زر الإرسال يتحوّل عن «إرسال»)',
      async act(ctx) {
        const prompt = 'اشرح بإيجاز بنية مشروع سطر في رد طويل: ابدأ بخلاصة قصيرة، ثم عنوانين `##` '
          + 'وتحتهما `###`، وقائمة مرقمة من ثلاث نقاط، ثم كتلة كود، ثم تكملة القائمة المرقمة، ثم جدولاً من صفّين.';
        ctx.evidence.promptSent = prompt;
        await sendPrompt(ctx.cdp, prompt);
        await sleep(1500);
        const shell = await ctx.cdp.evaluate(READ_SHELL);
        return { sendText: shell.sendText, shot: await ctx.cdp.screenshot('read-step-1') };
      },
      judge(ev) {
        const s = ev.steps['1'] || {};
        return { ok: s.sendText !== 'إرسال', actual: 'زر الإرسال=«' + (s.sendText || '') + '»' };
      },
    },
    {
      n: 2,
      title: 'انتظار نهاية الدور وقراءة الرد المصيَّر',
      expect: 'الدور ينتهي ويصل رد طويل (> 120 كلمة) داخل `.answer-wrap .md`',
      async act(ctx) {
        const ended = await waitForTurnEnd(ctx.cdp, TURN_TIMEOUT_MS);
        await sleep(1500);
        const answer = await ctx.cdp.evaluate(READ_ANSWER);
        const shell = await ctx.cdp.evaluate(READ_SHELL);
        ctx.evidence.cost = shell.cost;
        ctx.evidence.shell = { model: shell.model, cwd: shell.cwd, engine: shell.engine };
        ctx.evidence.answer = answer;
        return { turnEnded: ended, wordCount: words((answer || {}).text), nodes: ((answer || {}).nodes || []).length,
          shot: await ctx.cdp.screenshot('read-step-2') };
      },
      judge(ev) {
        const s = ev.steps['2'] || {};
        return {
          ok: s.turnEnded === true && s.wordCount > 120 && s.nodes > 0,
          actual: 'انتهى الدور=' + s.turnEnded + ' · كلمات=' + s.wordCount + ' · عقد=' + s.nodes,
        };
      },
    },
    {
      n: 3,
      title: 'سلّم العناوين — h2 أكبر من h3 ومن المتن',
      expect: 'يوجد `h2` و`h3`، وحجم `h2` > حجم `h3` > 0، ووزن `h2` ≥ 700',
      async act(ctx) {
        return { nodes: ((ctx.evidence.answer || {}).nodes) || [], shot: await ctx.cdp.screenshot('read-step-3') };
      },
      judge(ev) {
        const nodes = (ev.steps['3'] || {}).nodes || [];
        const h2 = nodes.find((n) => n.tag === 'h2');
        const h3 = nodes.find((n) => n.tag === 'h3');
        const ok = !!h2 && !!h3 && h2.size > h3.size && h3.size > 0 && Number(h2.weight) >= 700;
        return {
          ok,
          actual: 'h2=' + (h2 ? h2.size + 'px/' + h2.weight : 'غائب')
            + ' · h3=' + (h3 ? h3.size + 'px/' + h3.weight : 'غائب'),
        };
      },
    },
    {
      n: 4,
      title: 'صفر علامات Markdown حرفية متسرّبة',
      expect: 'لا يظهر في النص المصيَّر `####` ولا `[نص](رابط)` ولا `&lt;br&gt;`',
      async act(ctx) {
        return { text: ((ctx.evidence.answer || {}).text) || '', shot: await ctx.cdp.screenshot('read-step-4') };
      },
      judge(ev, bite) {
        const text = (ev.steps['4'] || {}).text || '';
        const leaks = [];
        if (/####/.test(text)) leaks.push('####');
        if (/\[[^\]]+\]\([^)]+\)/.test(text)) leaks.push('[نص](رابط)');
        if (/<br>|&lt;br&gt;/.test(text)) leaks.push('br');
        let ok = leaks.length === 0;
        if (bite) ok = !ok; // العضّة: معيار معكوس عمداً
        return {
          ok,
          expect: bite ? '⚠ معيار العضّة المعكوس: يُعدّ تسرّب العلامات الحرفية صواباً' : null,
          actual: leaks.length ? 'تسرّب: ' + leaks.join('، ') : 'بلا تسرّب',
        };
      },
    },
    {
      n: 5,
      title: 'القائمة المرقمة لا تعود إلى 1 بعد كتلة كود (‏OBS-157)',
      expect: 'القائمة `ol` التالية لكتلة كود تحمل `start` يكمل الترقيم لا يعيده إلى 1',
      async act(ctx) {
        return { nodes: ((ctx.evidence.answer || {}).nodes) || [], shot: await ctx.cdp.screenshot('read-step-5') };
      },
      judge(ev) {
        const nodes = (ev.steps['5'] || {}).nodes || [];
        const ols = [];
        for (let i = 0; i < nodes.length; i++) {
          if (nodes[i].tag === 'ol') ols.push({ i, start: nodes[i].start, afterCode: i > 0 && nodes[i - 1].tag === 'pre' });
        }
        const broken = ols.filter((o) => o.afterCode && (!o.start || Number(o.start) <= 1));
        return {
          ok: ols.length > 0 && broken.length === 0,
          actual: 'قوائم مرقمة=' + ols.length + ' · منها بعد كتلة كود='
            + ols.filter((o) => o.afterCode).length + ' · تعود إلى 1=' + broken.length,
        };
      },
    },
    {
      n: 6,
      title: 'اتجاه الفقرات محسوم على العنصر',
      expect: 'كل فقرة وعنوان وعنصر قائمة يحمل `dir` صريحاً (‏rtl أو ltr) — لا فراغ',
      async act(ctx) {
        return { nodes: ((ctx.evidence.answer || {}).nodes) || [], shot: await ctx.cdp.screenshot('read-step-6') };
      },
      judge(ev) {
        const nodes = (ev.steps['6'] || {}).nodes || [];
        const blocks = nodes.filter((n) => ['p', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol'].includes(n.tag));
        const missing = blocks.filter((n) => n.dir !== 'rtl' && n.dir !== 'ltr');
        return {
          ok: blocks.length > 0 && missing.length === 0,
          actual: 'كتل=' + blocks.length + ' · بلا dir صريح=' + missing.length,
        };
      },
    },
    {
      n: 7,
      title: 'عمود النثر مقيَّد والجدول والكود بالعرض الكامل',
      expect: 'عرض الفقرة أضيق من عرض الجدول أو كتلة الكود في الرد نفسه',
      async act(ctx) {
        return { nodes: ((ctx.evidence.answer || {}).nodes) || [], shot: await ctx.cdp.screenshot('read-step-7') };
      },
      judge(ev) {
        const nodes = (ev.steps['7'] || {}).nodes || [];
        const p = nodes.find((n) => n.tag === 'p' && n.width > 0);
        const wide = nodes.find((n) => (n.tag === 'table' || n.tag === 'pre') && n.width > 0);
        return {
          ok: !!p && !!wide && p.width < wide.width,
          actual: 'عرض الفقرة=' + (p ? p.width : '؟') + 'px · عرض الجدول/الكود=' + (wide ? wide.width : '؟') + 'px',
        };
      },
    },
    {
      n: 8,
      title: 'خلاصة أولى قبل أي عنوان ≤ 40 كلمة (توجيه «شكل الرد»)',
      expect: 'أول عقدة نصّية فقرة لا عنوان، وطولها ≤ 40 كلمة',
      async act(ctx) {
        return { nodes: ((ctx.evidence.answer || {}).nodes) || [], shot: await ctx.cdp.screenshot('read-step-8') };
      },
      judge(ev) {
        const nodes = (ev.steps['8'] || {}).nodes || [];
        const first = nodes[0];
        const w = first ? words(first.text) : 0;
        return {
          ok: !!first && first.tag === 'p' && w <= 40,
          actual: 'أول عقدة=' + (first ? first.tag : 'غائبة') + ' · كلماتها=' + w,
        };
      },
    },
  ],
  limits: [
    'دور نموذج **واحد** كحدّ معلَن: الخطوات 2–8 تقيس الرد نفسه؛ عيّنة واحدة لا إحصاء.',
    'القياس على `getBoundingClientRect` و`getComputedStyle` — لا مسبار بكسل لموضع أول محرف (‏قاعدة ٣ في `CLAUDE.md`).',
    'شكل الرد يعتمد على النموذج: سقوط خطوة هنا قد يعني توجيهاً لم يُتبع لا عارضاً مكسوراً — يُفرَّق بالنظر في الصورة.',
  ],
};

const SCENARIOS = Object.freeze({ step5: STEP5, connections: CONNECTIONS, readability: READABILITY });

// ============================================================================
// الحكم — دالة نقية على الأدلة
// ============================================================================
function judge(scenarioId, ev, bite) {
  const scenario = SCENARIOS[scenarioId];
  if (!scenario) throw new Error('سيناريو غير معروف: ' + scenarioId);
  return scenario.steps.map((step) => {
    let verdict;
    try { verdict = step.judge(ev || {}, !!bite) || {}; } catch (e) {
      verdict = { ok: false, actual: 'سقط الحكم باستثناء: ' + String((e && e.message) || e) };
    }
    return {
      n: step.n,
      action: step.title,
      expected: verdict.expect || step.expect,
      actual: String(verdict.actual === undefined ? '' : verdict.actual),
      verdict: verdict.ok ? 'صواب' : 'فشل',
      human: !!step.human,
      shot: ((ev && ev.steps && ev.steps[String(step.n)]) || {}).shot || '',
    };
  });
}

// ============================================================================
// التقرير
// ============================================================================
function esc(s) {
  return String(s === null || s === undefined ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ⏎ ');
}

function report(scenarioId, ev, bite) {
  const scenario = SCENARIOS[scenarioId];
  const rows = judge(scenarioId, ev, bite);
  const pass = rows.filter((r) => r.verdict === 'صواب').length;
  const L = [];
  L.push('# تقرير القبول الآلي — ' + scenario.title);
  L.push('');
  if (bite) {
    L.push('> ⚠ **نسخة العضّة**: أُعيد حكم الأدلة نفسها بمعيار **معكوس عمداً**.');
    L.push('> ' + scenario.bite);
    L.push('> الغرض إثبات أن السائق يسجّل فشلاً ولا يكون حارساً أخضر كاذباً. لا دور نموذج ثانٍ جرى:');
    L.push('> الحكم دالة نقية على `evidence.json` المسجَّل من التشغيل الحقيقي.');
    L.push('');
  }
  L.push('- النسخة: `' + (ev.exe || '?') + '`');
  L.push('- الملف الشخصي: `' + (ev.profile || '?') + '` (نسخة)'
    + (ev.note ? ' · المفكرة: `' + ev.note + '` (نسخة)' : ''));
  L.push('- المحرك: `' + ((ev.shell || {}).engine || '?') + '` · النموذج: `' + ((ev.shell || {}).model || '?')
    + '` · المجلد: `' + ((ev.shell || {}).cwd || '?') + '`');
  L.push('- البداية: ' + ev.startedAt + ' · النهاية: ' + (ev.finishedAt || '?'));
  L.push('- الطلب المُرسل: ' + (ev.promptSent || '—'));
  if (ev.storageKept) {
    L.push('- ⚠ **لم تُصفَّر مفاتيح `satr_*`** (‏`--keep-storage`) — قد يقيس السائق لا-انتقال على أنه فشل (‏OBS-178).');
  } else {
    const keys = ev.storageReset || [];
    L.push('- صُفِّرت مفاتيح satr_*: ' + (keys.length ? keys.map((k) => '`' + k + '`').join(' · ') : '_لا مفتاح_'));
  }
  L.push('');
  L.push('**الخلاصة: ' + pass + '/' + rows.length + ' خطوة صواب.**');
  L.push('');
  L.push('## جدول الخطوات');
  L.push('');
  L.push('| # | الفعل | المتوقع | الفعلي | الحكم | الصورة |');
  L.push('|---|---|---|---|---|---|');
  for (const r of rows) {
    L.push('| ' + r.n + ' | ' + esc(r.action) + (r.human ? ' (يد المالك)' : '') + ' | ' + esc(r.expected)
      + ' | ' + esc(r.actual) + ' | ' + (r.verdict === 'صواب' ? '✅ صواب' : '❌ فشل') + ' | `' + r.shot + '` |');
  }
  L.push('');
  L.push('## مربعات الإذن');
  L.push('');
  if (!(ev.perms || []).length) L.push('_لم يظهر أي مربع إذن._');
  else {
    L.push('| # | الأداة | «دائمة» مخفي | الحكم | نصّ التفاصيل | الوقت | الصورة |');
    L.push('|---|---|---|---|---|---|---|');
    for (const p of ev.perms) {
      L.push('| ' + p.k + ' | `' + esc(p.tool) + '` | ' + (p.alwaysHidden ? 'نعم' : 'لا')
        + ' | ' + (p.verdict === 'deny' ? 'رفض' : 'سماح') + ' | ' + esc(p.detail) + ' | ' + p.at
        + ' | `' + p.shot + '` |');
    }
  }
  L.push('');
  L.push('## ما نقره السائق نيابةً عن المالك');
  L.push('');
  const clicked = (ev.perms || []).filter((p) => p.clicked);
  L.push('- نقرات على بطاقات الإذن: **' + clicked.length + '** من ' + (ev.perms || []).length + ' مربع ظهر.');
  const byTool = {};
  for (const p of clicked) byTool[p.tool] = (byTool[p.tool] || 0) + 1;
  for (const t of Object.keys(byTool)) L.push('  - `' + t + '` × ' + byTool[t]);
  L.push('- حوارات أسئلة أُجيبت بأول خيار: ' + (ev.questions || []).length);
  for (const q of ev.questions || []) L.push('  - #' + q.k + ' (' + q.at + '): ' + esc(q.text.slice(0, 120)));
  const humanRows = rows.filter((r) => r.human);
  if (humanRows.length) {
    L.push('- خطوات **بشرية معلَنة** لم ينفّذها السائق: ' + humanRows.map((r) => '#' + r.n).join('، ')
      + ' — السائق لا يقرأ سرّاً ولا يكتبه.');
  }
  L.push('- كل هذه النقرات وقعت داخل **نسخة القبول المعزولة** (ملف شخصي منسوخ ومنفذ تصحيح خاص) لا في نسخة الإنتاج.');
  L.push('');
  if (typeof scenario.extraReport === 'function') scenario.extraReport(ev, L);
  L.push('## أخطاء console والاستثناءات');
  L.push('');
  if (!(ev.consoleErrors || []).length && !(ev.exceptions || []).length) L.push('_لا شيء._');
  for (const e of ev.consoleErrors || []) L.push('- console: ' + esc(e));
  for (const e of ev.exceptions || []) L.push('- exception: ' + esc(e));
  L.push('');
  L.push('## كلفة الدور');
  L.push('');
  L.push(ev.cost ? '`' + ev.cost + '`' : '_لم يُقرأ سطر الكلفة (‏#costInfo فارغ)._');
  L.push('');
  L.push('## ما لم يُلاحَظ / حدود هذا السائق');
  L.push('');
  for (const line of scenario.limits || []) L.push('- ' + line);
  L.push('');
  return L.join('\n');
}

// ============================================================================
// --dry-run: يطبع الخطوات والمعايير بلا تشغيل
// ============================================================================
function dryRun(scenarioId) {
  const scenario = SCENARIOS[scenarioId];
  if (!scenario) {
    console.error('accept-driver: سيناريو غير معروف «' + scenarioId + '» — المعروف: '
      + Object.keys(SCENARIOS).join('، '));
    return 1;
  }
  const problems = validateScenario(scenario);
  console.log('accept-driver --dry-run: ' + scenario.id + ' — ' + scenario.title);
  console.log('يحتاج: ' + (scenario.needs || []).join('، '));
  console.log('العضّة: ' + scenario.bite);
  console.log('');
  for (const step of scenario.steps) {
    console.log('  ' + step.n + ') ' + step.title + (step.human ? '  [يد المالك]' : ''));
    console.log('     المتوقع: ' + (step.expect || '(غائب!)'));
    if (step.human) console.log('     التعليمات: ' + (step.instructions || '(غائبة!)'));
  }
  console.log('');
  for (const line of scenario.limits || []) console.log('  حدّ: ' + line);
  if (problems.length) {
    console.error('\naccept-driver: السيناريو ناقص — لا يصلح للتشغيل:');
    for (const p of problems) console.error('  - ' + p);
    return 1;
  }
  console.log('\naccept-driver: بنية السيناريو مكتملة (' + scenario.steps.length + ' خطوة).');
  return 0;
}

/** عقد البنية نفسه الذي يحرسه `test:accept-driver` — مُصدَّر كي لا يُعاد اشتقاقه. */
function validateScenario(scenario) {
  const problems = [];
  if (!scenario || !Array.isArray(scenario.steps) || !scenario.steps.length) {
    return ['السيناريو بلا خطوات'];
  }
  const id = scenario.id || '?';
  scenario.steps.forEach((step, index) => {
    const label = '«' + id + '» الخطوة ' + (step && step.n !== undefined ? step.n : '؟');
    if (!step || step.n !== index + 1) problems.push(label + ': الترقيم غير متسلسل (المتوقع ' + (index + 1) + ')');
    if (!step || typeof step.title !== 'string' || !step.title.trim()) problems.push(label + ': بلا عنوان');
    if (!step || typeof step.expect !== 'string' || !step.expect.trim()) problems.push(label + ': بلا `expect`');
    if (!step || typeof step.judge !== 'function') problems.push(label + ': بلا `judge` دالة');
    if (!step || typeof step.act !== 'function') problems.push(label + ': بلا `act` دالة');
    if (step && step.human && (typeof step.instructions !== 'string' || step.instructions.trim().length < 20)) {
      problems.push(label + ': خطوة بشرية بلا نصّ تعليمات عربي كافٍ');
    }
  });
  if (typeof scenario.bite !== 'string' || !scenario.bite.trim()) problems.push('«' + id + '»: بلا وصف عضّة');
  return problems;
}

// ============================================================================
// التشغيل الحي
// ============================================================================
async function waitForPageTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/json/list');
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && /index\.html/.test(String(t.url || '')));
      if (page && page.webSocketDebuggerUrl) return page;
    } catch (e) { lastError = String((e && e.message) || e); }
    await sleep(500);
  }
  throw new Error('انتهت مهلة انتظار هدف الصفحة على منفذ التصحيح. آخر خطأ: ' + lastError);
}

async function runScenario(opts) {
  const scenario = SCENARIOS[opts.scenario];
  const out = opts.out;
  fs.mkdirSync(out, { recursive: true });
  const ps = psRunner(out);
  const needs = scenario.needs || [];
  for (const need of needs) {
    if (need === 'note') continue;
    if (!opts[need]) throw new Error('السيناريو «' + scenario.id + '» يحتاج --' + need);
  }

  // نسخة معزولة من الملف الشخصي — المصدر لا يُعدَّل أبداً
  const profile = path.join(out, 'profile');
  fs.rmSync(profile, { recursive: true, force: true });
  fs.cpSync(opts.profile, profile, { recursive: true });

  // ملف المفكرة (سيناريو الخطوة ٥ وحده) — نسخة أيضاً
  let note = '';
  let notepadPid = 0;
  let fileBefore = '';
  if (needs.includes('note')) {
    const srcNote = opts.note || path.join(path.dirname(path.resolve(opts.profile)), 'step5.txt');
    if (!fs.existsSync(srcNote)) throw new Error('ملف المفكرة غير موجود: ' + srcNote + ' (مرّر --note)');
    note = path.join(out, 'step5.txt');
    fs.copyFileSync(srcNote, note);
    fileBefore = fs.readFileSync(note, 'utf8');
  }

  log('إيقاف نسخ الاختبار (بالمسار): ' + stopBuildInstances(ps, opts.exe).replace(/\s+/g, ' '));
  await sleep(800);

  if (note) {
    const child = spawn('notepad.exe', [note], { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    notepadPid = child.pid;
    log('فُتحت المفكرة (PID ' + notepadPid + ') على ' + note);
    await sleep(1500);
  }

  const satr = spawn(opts.exe, ['--remote-debugging-port=' + opts.port, '--user-data-dir=' + profile],
    { detached: true, stdio: 'ignore' });
  satr.unref();
  const satrPid = satr.pid;
  log('أُطلقت نسخة القبول (PID ' + satrPid + ') بمنفذ التصحيح ' + opts.port);

  const target = await waitForPageTarget(opts.port, 30000);
  log('هدف الصفحة: ' + target.title);
  const cdp = new Cdp(target.webSocketDebuggerUrl, out);
  await cdp.ready();
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  await sleep(2500); // إتمام الإقلاع

  const evidence = {
    scenario: scenario.id,
    startedAt: new Date().toISOString(),
    exe: opts.exe, profile, note, satrPid, notepadPid,
    storageReset: [], storageKept: !!opts.keepStorage,
    fileBefore, fileAfter: null, promptSent: '', steps: {}, perms: [], questions: [],
    consoleErrors: [], exceptions: [], cost: '', shell: {},
  };

  // ---- تصفير مفاتيح satr_* ثم إعادة تحميل الصفحة (‏OBS-178) ----
  if (opts.keepStorage) {
    log('⚠ --keep-storage: لم تُصفَّر مفاتيح satr_* — أي لا-انتقال قد يُقاس فشلاً كاذباً.');
  } else {
    const removed = await resetSatrStorage((expr) => cdp.evaluate(expr));
    evidence.storageReset = removed;
    log('صُفِّرت مفاتيح satr_*: ' + (removed.length ? removed.join(' · ') : '(لا مفتاح)'));
    await cdp.send('Page.reload', { ignoreCache: false });
    await sleep(3500);
  }

  const ctx = { cdp, evidence, opts, ps, note, permMode: null };
  const watcher = startPermWatcher(cdp, evidence, (perm) => (ctx.permMode ? ctx.permMode(perm) : 'allow'));

  try {
    for (const step of scenario.steps) {
      log('خطوة ' + step.n + ': ' + step.title);
      evidence.steps[String(step.n)] = await step.act.call(step, ctx);
      if (opts.pre && step.n >= 3) { log('وضع --pre: توقّف بعد الخطوة ٣ بلا دور نموذج.'); break; }
    }
  } finally {
    await watcher.stop();
    evidence.consoleErrors = cdp.consoleErrors.slice();
    evidence.exceptions = cdp.exceptions.slice();
    evidence.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(out, opts.pre ? 'evidence-pre.json' : 'evidence.json'),
      JSON.stringify(evidence, null, 2), 'utf8');
    cdp.close();
    // التنظيف: ما أطلقناه نحن وحده، بـPID
    try { ps('Stop-Process -Id ' + satrPid + ' -Force -ErrorAction SilentlyContinue'); } catch (e) { /* ماتت */ }
    if (notepadPid) {
      try {
        ps('$p = Get-CimInstance Win32_Process -Filter "ProcessId=' + notepadPid + '"\n'
          + 'if ($p -and $p.Name -eq "notepad.exe") { Stop-Process -Id ' + notepadPid + ' -Force -ErrorAction SilentlyContinue }\n');
      } catch (e) { /* ماتت */ }
    }
    log('أُغلقت نسخة القبول والمفكرة اللتان أطلقهما السائق.');
  }
  return evidence;
}

// ============================================================================
// main
// ============================================================================
async function main(argv) {
  const opts = parseArgs(argv);
  if (!SCENARIOS[opts.scenario]) {
    console.error('accept-driver: سيناريو غير معروف «' + opts.scenario + '» — المعروف: '
      + Object.keys(SCENARIOS).join('، '));
    return 1;
  }
  if (opts.dryRun) return dryRun(opts.scenario);
  if (!opts.out) { console.error('accept-driver: --out إلزامي (كل ما يُكتب داخله).'); return 1; }
  fs.mkdirSync(opts.out, { recursive: true });

  let ev;
  if (opts.report) {
    const file = path.join(opts.out, 'evidence.json');
    if (!fs.existsSync(file)) { console.error('accept-driver: لا أدلة في ' + file); return 1; }
    ev = JSON.parse(fs.readFileSync(file, 'utf8'));
    log('إعادة حكم الأدلة المسجّلة' + (opts.bite ? ' بمعيار معكوس (عضّة)' : ''));
  } else {
    ev = await runScenario(opts);
  }
  if (opts.pre) {
    log('كُتبت أدلة التشغيل التكميلي (‏--pre) في ' + path.join(opts.out, 'evidence-pre.json'));
    return 0;
  }

  const file = path.join(opts.out, opts.bite ? 'report-bite.md' : 'report.md');
  fs.writeFileSync(file, report(opts.scenario, ev, opts.bite), 'utf8');
  const rows = judge(opts.scenario, ev, opts.bite);
  const pass = rows.filter((r) => r.verdict === 'صواب').length;
  log('كُتب التقرير: ' + file);
  log('النتيجة: ' + pass + '/' + rows.length + ' خطوة صواب');
  for (const r of rows) log('  ' + (r.verdict === 'صواب' ? '✅' : '❌') + ' خطوة ' + r.n + ': ' + r.actual);
  return pass === rows.length ? 0 : 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((e) => {
    console.error('[accept-driver] فشل: ' + (e && e.stack ? e.stack : e));
    process.exit(2);
  });
}

module.exports = { SCENARIOS, judge, resetSatrStorage, validateScenario, report, parseArgs, RESET_SNIPPET };
