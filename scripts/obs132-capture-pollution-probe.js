#!/usr/bin/env node
/**
 * مسبار OBS-132 — قياس تلوّث خرج `term.runCapture` بالمِحَثّ والصدى.
 *
 * ⚠️ **مسبار قياس لا حارس ولا علاج**: خارج `test:full` عمداً، ولا يعدّل حرفاً في
 * `electron/term.js`. غايته الوحيدة الإجابة على ثلاثة أسئلة بأرقام قابلة لإعادة
 * الإنتاج، بعد أن أثبت تشخيصُ الملاحظة أن **الالتفاف شرطٌ لازم لا كافٍ**:
 *
 *   ① ما شرط التكرار الدقيق؟ (طول السطر مقابل `cols` · حالة التمرير/إعادة رسم ConPTY ·
 *      توقيت وصول الأجزاء · صنف المحارف العربية · طول المِحَثّ)
 *   ② ما نصّ `IndexExpression` — خطأ تحليل حقيقي أم صدى مُعاد رسمه؟
 *   ③ أيّ مرشّحات العلاج الثلاثة أرجح؟
 *
 * **الطريقة**: يستدعي `term.js` الإنتاجي نفسه (بلا نسخة موازية من `cleanOutput`)،
 * ويشترك على مجرى الخرج الخام عبر `term.subscribe` كي يرى ما يراه `runCaptureNow`
 * في `buf` بالضبط. وكل محاولة تحمل **برهان تنفيذ مستقلاً عن نصّ الخرج**: الأمر
 * `Write-Output (1234*5678)` يطبع `7006652` — رقمٌ لا يظهر في صدى الأمر إطلاقاً
 * (الصدى يحمل `1234*5678` نصّاً)، فوجودُه دليلُ تنفيذ، ومطابقتُه وحدها دليلُ نظافة.
 *
 * **الأزرار**: `--quick` يخفّض التكرار · `--repeats=N` يضبطه · `--only=A1,C` يختار
 * المشاهد · `--dump=N` عدد لقطات البايتات الخام للحالات الملوّثة.
 *
 * التشغيل (مسبار — شغّله وحده؛ عدة نسخ Electron تتزاحم على كاش GPU):
 *     node_modules/electron/dist/electron.exe scripts/obs132-capture-pollution-probe.js
 * ⚠️ **لا تشغّله عبر `npx electron` أو `node_modules/.bin/electron.cmd`**: node-pty يُطلق
 * مساعداً (`conpty_console_list_agent.js`) بـ`execPath` نفسه، فيرث أنابيب الغلاف ويُبقيه
 * منتظراً بعد خروج المسبار (مقيس: السجل يكتمل في ثانيتين والغلاف يعلق دقائق). الملفّ
 * التنفيذي مباشرةً يخرج سليماً. ويعمل تحت node أيضاً للمقارنة:
 *     node scripts/obs132-capture-pollution-probe.js
 * (ورسالة `AttachConsole failed` من ذلك المساعد ضجيجٌ معروف عند قتل الطرفيات، لا فشل.)
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// ── تشغيل تحت Electron أو node ─────────────────────────────────────────────────
let electronApp = null;
try {
  const e = require('electron');
  if (e && typeof e === 'object' && e.app) electronApp = e.app;
} catch (err) { /* node عادي — مقصود */ }

const RUNTIME = electronApp ? 'electron ' + process.versions.electron : 'node ' + process.versions.node;

// ── الوسائط ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const hasFlag = (n) => argv.includes('--' + n);
const optOf = (n, d) => {
  const hit = argv.find((a) => a.startsWith('--' + n + '='));
  return hit ? hit.slice(n.length + 3) : d;
};
const QUICK = hasFlag('quick');
const SCALE = Number(optOf('repeats', '0')) || 0; // 0 = الافتراضي لكل مشهد
const DUMP_MAX = Number(optOf('dump', '4')) || 0;
const TRIAL_TIMEOUT = Number(optOf('timeout', '6000')) || 6000;
const ONLY = String(optOf('only', '')).split(',').map((s) => s.trim()).filter(Boolean);
const wanted = (id) => !ONLY.length || ONLY.includes(id);

// ── سجل ملفّي بجانب stdout (درس «الإقلاع المعلَّق»: لا تعتمد على stdout وحده) ────
const OUT_DIR = path.join(ROOT, 'dist');
try { fs.mkdirSync(OUT_DIR, { recursive: true }); } catch (e) {}
const LOG_FILE = path.join(OUT_DIR, 'obs132-capture-pollution.log');
try { fs.writeFileSync(LOG_FILE, ''); } catch (e) {}
function log(s) {
  const line = s === undefined ? '' : String(s);
  process.stdout.write(line + '\n');
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) {}
}

const term = require(path.join(ROOT, 'electron', 'term.js'));

// ── التقاط المجرى الخام لكل طرفية (نفس ما يتراكم في `buf` داخل runCaptureNow) ───
const rawByTerm = new Map();
const chunksByTerm = new Map();
term.subscribe((ev) => {
  if (!ev || ev.type !== 'data') return;
  rawByTerm.set(ev.id, (rawByTerm.get(ev.id) || '') + ev.data);
  const arr = chunksByTerm.get(ev.id) || [];
  arr.push(String(ev.data).length);
  chunksByTerm.set(ev.id, arr);
});
function resetRaw(id) { rawByTerm.set(id, ''); chunksByTerm.set(id, []); }

// ── تنقية ANSI: **نسخة `cleanOutput` حرفياً** كي يقيس المسبار ما يراه الإنتاج ────
function stripAnsiLikeProduction(raw) {
  return String(raw)
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\r/g, '');
}

function escapeCtl(s) {
  return String(s)
    .replace(/\x1b/g, '<ESC>')
    .replace(/\x07/g, '<BEL>')
    .replace(/\r/g, '<CR>')
    .replace(/\n/g, '<LF>\n');
}

// تحليل المجرى الخام لمحاولة واحدة
function analyzeRaw(raw) {
  const s = stripAnsiLikeProduction(raw);
  // **العلامة الحالية هي الأخيرة لا الأولى**: مخزن محاولة ملوّثة يبدأ ببقايا المحاولة
  // السابقة (‏`runCaptureNow` يبدأ بمخزن فارغ لكن ذيل الأمر السابق يصل داخل نافذته)،
  // فأخذُ أول علامة يصف الأمر السابق. وعددُ العلامات المتمايزة نفسه قياسٌ مباشر
  // لتسرّب مادة أمر سابق إلى هذه المحاولة.
  const allToks = [...new Set((s.match(/__SATR_[a-z0-9]+__/g) || []))];
  const tok = allToks.length ? allToks[allToks.length - 1] : null;
  const out = {
    tok,
    tokenCount: allToks.length,
    endMarkerSeen: tok ? s.indexOf(tok + 'E:') >= 0 : false,
    begStandalone: false,
    begLine: null,
    strippedLines: s.split('\n').length,
    rawNewlines: (String(raw).match(/\n/g) || []).length,
    escSeqs: (String(raw).match(/\x1b\[/g) || []).length,
    cursorUp: (String(raw).match(/\x1b\[\d*A/g) || []).length,
    eraseLine: (String(raw).match(/\x1b\[\d*K/g) || []).length,
    cupSeqs: (String(raw).match(/\x1b\[\d*;\d*H/g) || []).length,
    hasIndexExpr: /IndexExpression/.test(s),
    hasParserError: /ParserError|Missing |Unexpected token/.test(s),
    // بقايا خاتمة اللصق المُقوّس `ESC[201~` بعد أن ابتلع المحلّل `ESC[20` وترك `1~` نصّاً:
    // أوضح أثرٍ على أن تسلسل اللصق نفسه تشوّه في طريقه.
    strayPasteTail: (String(raw).match(/(?:^|[^\x1b[0-9])1~/g) || []).length,
    // PSReadLine يلوّن آخر محرف من المِحَثّ أحمر (91) حين يحمل السطر خطأ تحليل.
    redPrompt: /\x1b\[91m/.test(String(raw)),
    indexExprCtx: null,
  };
  const ie = s.indexOf('IndexExpression');
  if (ie >= 0) out.indexExprCtx = s.slice(Math.max(0, ie - 260), ie + 260).replace(/\n/g, ' | ');
  if (!tok) return out;
  const mBeg = tok + 'B';
  const lines = s.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() === mBeg) { out.begStandalone = true; break; }
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].indexOf(mBeg) >= 0) { out.begLine = lines[i]; break; }
  }
  return out;
}

// ── الأمر المقيس ───────────────────────────────────────────────────────────────
const BASE_CMD = 'Write-Output (1234*5678)';
const BASE_EXPECT = '7006652';
// حشو خامل: تعليق PowerShell لا يطبع شيئاً ولا يغيّر الخرج المتوقَّع، ويضبط الطول بدقّة.
function padded(n) { return n > 0 ? BASE_CMD + ' <#' + 'p'.repeat(n) + '#>' : BASE_CMD; }

const dumps = [];
const allTrials = [];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function startProbeTerm(cwd, cols, rows) {
  // `isModel:true` عمداً: عندها يتخطّى `writePasted` مسارَ الحافظة (‏OBS-106) — وهو
  // **نفس** المسار الذي تسلكه طرفية النموذج الحقيقية التي يصفها البلاغ.
  const r = term.startTerm(cwd, cols, rows || 30, { label: 'obs132', isModel: true });
  if (!r.ok) throw new Error('startTerm فشل: ' + (r.error || '') + ' ' + (r.message || ''));
  return r.id;
}

// انتظار استقرار الصدفة: توقّف وصول البايتات مدّة هدوء، بسقف زمني.
async function waitShellIdle(id, quietMs, capMs) {
  const t0 = Date.now();
  let lastLen = -1;
  let lastChange = Date.now();
  for (;;) {
    const len = (rawByTerm.get(id) || '').length;
    if (len !== lastLen) { lastLen = len; lastChange = Date.now(); }
    if (len > 0 && Date.now() - lastChange >= quietMs) return true;
    if (Date.now() - t0 >= capMs) return false;
    await sleep(50);
  }
}

async function trial(scenario, id, cmd, expected, meta) {
  resetRaw(id);
  const t0 = Date.now();
  const res = await term.runCapture(id, cmd, { timeoutMs: TRIAL_TIMEOUT });
  const ms = Date.now() - t0;
  const raw = rawByTerm.get(id) || '';
  const diag = analyzeRaw(raw);
  const out = String((res && res.output) || '');
  const rec = {
    scenario,
    cmdLen: cmd.length,
    ok: !!(res && res.ok),
    exitCode: res ? res.exitCode : null,
    timedOut: !!(res && res.timedOut),
    out,
    polluted: out !== expected,
    executed: out.indexOf(expected) >= 0,
    excess: out.length - expected.length,
    ms,
    rawLen: raw.length,
    chunks: (chunksByTerm.get(id) || []).length,
    diag,
    meta: meta || {},
  };
  allTrials.push(rec);
  if (rec.polluted && dumps.length < DUMP_MAX) {
    let window = '(لا علامة في المجرى)';
    if (diag.tok) {
      const mBeg = diag.tok + 'B';
      const first = raw.indexOf(mBeg);
      const second = first >= 0 ? raw.indexOf(mBeg, first + 1) : -1;
      const at = second >= 0 ? second : first; // ظهور الخرج لا الصدى حيث أمكن
      if (at >= 0) window = escapeCtl(raw.slice(Math.max(0, at - 460), at + 220));
    }
    dumps.push({ rec, window });
  }
  return rec;
}

function rateRow(label, trials) {
  const n = trials.length;
  const bad = trials.filter((t) => t.polluted).length;
  const notExec = trials.filter((t) => !t.executed).length;
  const noStandalone = trials.filter((t) => !t.diag.begStandalone).length;
  const pct = n ? ((bad / n) * 100).toFixed(1) : '0.0';
  const worst = trials.reduce((m, t) => Math.max(m, t.excess), 0);
  const timedOut = trials.filter((t) => t.timedOut).length;
  const stray = trials.filter((t) => t.diag.strayPasteTail > 0).length;
  return { label, n, bad, pct, notExec, noStandalone, worst, timedOut, stray };
}

// حشو بصريّ: يعدّ نقاط Unicode كي لا يختلّ الجدول مع العناوين العربية
function pad(s, n) {
  const str = String(s);
  const visible = [...str].length;
  return str + ' '.repeat(Math.max(1, n - visible));
}

function printTable(title, rows) {
  log('');
  log('  ' + title);
  log('  ' + '-'.repeat(110));
  log('  ' + pad('الحالة', 42) + pad('محاولات', 9) + pad('ملوّث', 7) + pad('النسبة', 9)
    + pad('مهلة', 6) + pad('لصق-مشوّه', 11) + pad('بلا-سطر-علامة', 15) + 'أقصى زيادة');
  for (const r of rows) {
    log('  ' + pad(r.label, 42) + pad(String(r.n), 9) + pad(String(r.bad), 7) + pad(r.pct + '%', 9)
      + pad(String(r.timedOut === undefined ? 0 : r.timedOut), 6)
      + pad(String(r.stray === undefined ? 0 : r.stray), 11)
      + pad(String(r.noStandalone), 15) + String(r.worst));
  }
  log('  ' + '-'.repeat(110));
}

// طول سطر الالتقاط لأمر ما — العلامة الحقيقية 27 محرفاً + حرف الصنف
function captureLineLen(cmd) {
  return term.buildCaptureLine('powershell.exe', 'X'.repeat(28), 'X'.repeat(28), cmd).length - 1;
}

/**
 * **طول الكتابة الفعلي بالبايتات** — وهو المتغيّر الذي يهمّ إن كان القصّ يقع في أنبوب
 * إدخال ConPTY. يُعيد بنية `writePasted` نفسها: `ESC[200~` + الجسم + `ESC[201~` + `CR`.
 * الحرف العربي بايتان في UTF-8، فأمرٌ يساوي نظيره اللاتيني في عدد المحارف يزيد عليه
 * بايتات — وهذا بالضبط ما يفصل «صنف المحرف» عن «طول البايتات».
 */
function writeBytes(cmd) {
  const line = term.buildCaptureLine('powershell.exe', 'X'.repeat(28), 'X'.repeat(28), cmd);
  const body = line.slice(-1) === '\r' ? line.slice(0, -1) : line;
  return Buffer.byteLength('\x1b[200~' + body + '\x1b[201~' + '\r', 'utf8');
}

// حشو خامل حتى يبلغ الأمرُ طولاً بايتياً محدداً بالضبط (كل حرف `p` بايت واحد).
function padToBytes(baseCmd, targetBytes) {
  if (writeBytes(baseCmd) > targetBytes) return null;
  for (let n = 0; n <= 4000; n++) {
    const c = n === 0 ? baseCmd : baseCmd + ' <#' + 'p'.repeat(n) + '#>';
    const b = writeBytes(c);
    if (b === targetBytes) return { cmd: c, bytes: b };
    if (b > targetBytes) return null; // الفجوة الأولى (‏+6) غير قابلة للسدّ
  }
  return null;
}

// قياس طول المِحَثّ فعلياً من الصدفة (لا نفترضه)
async function measurePrompt(id) {
  for (let i = 0; i < 4; i++) {
    const r = await term.runCapture(id, '$s=(prompt); Write-Output $s.Length', { timeoutMs: 15000 });
    const m = String((r && r.output) || '').match(/(?:^|\n)\s*(\d{1,4})\s*(?:\n|$)/);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

// ── المشاهد ────────────────────────────────────────────────────────────────────

async function scenarioA1(rows) {
  const N = SCALE || (QUICK ? 12 : 40);
  const id = startProbeTerm(ROOT, 120, 30);
  await waitShellIdle(id, 600, 12000);
  await trial('warmup', id, BASE_CMD, BASE_EXPECT);
  const trials = [];
  for (let i = 0; i < N; i++) trials.push(await trial('A1', id, BASE_CMD, BASE_EXPECT, { i }));
  term.killTerm(id);
  rows.push(rateRow('A1 طرفية واحدة متكرّرة', trials));
  return trials;
}

async function scenarioA2(rows) {
  const N = SCALE || (QUICK ? 5 : 14);
  const trials = [];
  for (let i = 0; i < N; i++) {
    const id = startProbeTerm(ROOT, 120, 30);
    await waitShellIdle(id, 600, 12000);
    trials.push(await trial('A2', id, BASE_CMD, BASE_EXPECT, { i, fresh: true }));
    term.killTerm(id);
    await sleep(60);
  }
  rows.push(rateRow('A2 طرفية جديدة لكل محاولة', trials));
  return trials;
}

async function scenarioA3(rows) {
  // الأوامر الأولى في طرفية جديدة مقابل ما بعد امتلاء الشاشة — عزل «حالة التمرير».
  const N = SCALE || (QUICK ? 10 : 30);
  const id = startProbeTerm(ROOT, 120, 30);
  await waitShellIdle(id, 600, 12000);
  const early = [];
  const late = [];
  for (let i = 0; i < N; i++) {
    const rec = await trial('A3', id, BASE_CMD, BASE_EXPECT, { i });
    (i < 5 ? early : late).push(rec);
  }
  term.killTerm(id);
  rows.push(rateRow('A3 أوّل 5 أوامر (قبل التمرير)', early));
  rows.push(rateRow('A3 ما بعدها (بعد التمرير)', late));
  return early.concat(late);
}

async function scenarioB(rows) {
  const colsList = QUICK ? [120, 500] : [80, 100, 120, 160, 240, 500];
  const N = SCALE || (QUICK ? 8 : 16);
  const out = [];
  for (const cols of colsList) {
    const id = startProbeTerm(ROOT, cols, 30);
    await waitShellIdle(id, 600, 12000);
    const promptLen = await measurePrompt(id);
    const total = (promptLen || 0) + captureLineLen(BASE_CMD);
    const wraps = Math.max(0, Math.ceil(total / cols) - 1);
    const trials = [];
    for (let i = 0; i < N; i++) trials.push(await trial('B', id, BASE_CMD, BASE_EXPECT, { cols, promptLen, total, wraps }));
    term.killTerm(id);
    rows.push(rateRow('B cols=' + cols + ' (خلايا=' + total + '، التفافات=' + wraps + ')', trials));
    out.push(...trials);
  }
  return out;
}

async function scenarioC(rows, detail) {
  // مسح الطول عبر دورة `cols` كاملة: هل التلوّث تابعٌ للمحاذاة (حتميّ لكل إزاحة)
  // أم عشوائيّ عندها (⇒ توقيت)؟
  const cols = 120;
  const span = QUICK ? 40 : 126;
  const reps = SCALE || (QUICK ? 1 : 2);
  const id = startProbeTerm(ROOT, cols, 30);
  await waitShellIdle(id, 600, 12000);
  const promptLen = await measurePrompt(id);
  const trials = [];
  const byOffset = new Map();
  for (let n = 1; n <= span; n++) {
    const cmd = padded(n);
    const total = (promptLen || 0) + captureLineLen(cmd);
    const offset = total % cols;
    for (let k = 0; k < reps; k++) {
      const rec = await trial('C', id, cmd, BASE_EXPECT, { n, cols, promptLen, total, offset });
      trials.push(rec);
      const cur = byOffset.get(offset) || { n: 0, bad: 0 };
      cur.n++; if (rec.polluted) cur.bad++;
      byOffset.set(offset, cur);
    }
  }
  term.killTerm(id);
  rows.push(rateRow('C مسح الطول (' + span + ' إزاحة × ' + reps + ')', trials));
  detail.offsets = byOffset;
  detail.promptLenC = promptLen;
  return trials;
}

async function scenarioD(rows) {
  // طول المِحَثّ متغيّراً مستقلاً: مجلدات مؤقتة بأطوال مسار مضبوطة.
  const N = SCALE || (QUICK ? 6 : 14);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'obs132-'));
  const targets = QUICK ? [0, 60] : [0, 20, 45, 70];
  const out = [];
  for (const extra of targets) {
    const dir = extra === 0 ? base : path.join(base, 'd'.repeat(extra));
    try { if (extra) fs.mkdirSync(dir, { recursive: true }); } catch (e) { continue; }
    const id = startProbeTerm(dir, 120, 30);
    await waitShellIdle(id, 600, 12000);
    const promptLen = await measurePrompt(id);
    const total = (promptLen || 0) + captureLineLen(BASE_CMD);
    const trials = [];
    for (let i = 0; i < N; i++) trials.push(await trial('D', id, BASE_CMD, BASE_EXPECT, { promptLen, dirLen: dir.length, total }));
    term.killTerm(id);
    rows.push(rateRow('D مِحَثّ=' + promptLen + ' (خلايا=' + total + '، إزاحة=' + (total % 120) + ')', trials));
    out.push(...trials);
  }
  try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) {}
  return out;
}

async function scenarioE(rows) {
  // العربية: نفس الطول المنطقي تقريباً، واختلاف صنف المحارف فقط.
  const N = SCALE || (QUICK ? 8 : 20);
  const id = startProbeTerm(ROOT, 120, 30);
  await waitShellIdle(id, 600, 12000);
  const cases = [
    ['E لاتيني بحت', 'Write-Output (1234*5678) <#aaaaaaaa#>', BASE_EXPECT],
    ['E عربي في التعليق', 'Write-Output (1234*5678) <#سطريعمل#>', BASE_EXPECT],
    ['E عربي في الخرج', 'Write-Output (1234*5678); Write-Output "سطر"', BASE_EXPECT + '\nسطر'],
    ['E عربي بتشكيل', 'Write-Output (1234*5678) <#سَطْرٌ#>', BASE_EXPECT],
  ];
  const out = [];
  for (const c of cases) {
    const trials = [];
    for (let i = 0; i < N; i++) trials.push(await trial('E', id, c[1], c[2], { label: c[0] }));
    rows.push(rateRow(c[0] + ' (خلايا=' + (39 + captureLineLen(c[1])) + ')', trials));
    out.push(...trials);
  }
  term.killTerm(id);
  return out;
}

async function scenarioF(rows, detail) {
  // ② مصدر `IndexExpression`: نُوسّخ الشاشة بخطأ تحليل حقيقي ثم نلتقط أمراً نظيفاً.
  const N = SCALE || (QUICK ? 8 : 18);
  const id = startProbeTerm(ROOT, 120, 30);
  await waitShellIdle(id, 600, 12000);

  const dirty = await trial('F-dirty', id, '$a=@(1,2,3); Write-Output $a[0', BASE_EXPECT, { dirty: true });
  detail.dirtyOutput = dirty.out.slice(0, 900);
  detail.dirtyExit = dirty.exitCode;
  detail.dirtyHasIndexExpr = dirty.diag.hasIndexExpr;

  const trials = [];
  for (let i = 0; i < N; i++) trials.push(await trial('F', id, BASE_CMD, BASE_EXPECT, { afterDirty: true }));
  term.killTerm(id);
  rows.push(rateRow('F بعد تلويث الشاشة بخطأ تحليل', trials));
  return trials;
}

async function scenarioG(rows) {
  // ⑦ **إعادة إنتاج الحالة المبلَّغة حرفياً**: `cwd = D:\sater` (مِحَثّ 13) والأمر
  // `Write-Output "سطر يعمل"` — وهي التوليفة التي أعطت `459` محرفاً بدل `8`.
  const REPRO_CWD = String(optOf('repro-cwd', 'D:\\sater'));
  if (!fs.existsSync(REPRO_CWD)) {
    rows.push({ label: 'G إعادة الإنتاج (المسار غائب)', n: 0, bad: 0, pct: '—', notExec: 0, noStandalone: 0, worst: 0 });
    return [];
  }
  const N = SCALE || (QUICK ? 12 : 60);
  const cmd = 'Write-Output "سطر يعمل"';
  const expect = 'سطر يعمل';
  const id = startProbeTerm(REPRO_CWD, 120, 30);
  await waitShellIdle(id, 600, 12000);
  const promptLen = await measurePrompt(id);
  const total = (promptLen || 0) + captureLineLen(cmd);
  const trials = [];
  for (let i = 0; i < N; i++) trials.push(await trial('G', id, cmd, expect, { promptLen, total, i }));
  term.killTerm(id);
  rows.push(rateRow('G إعادة الإنتاج (مِحَثّ=' + promptLen + '، خلايا=' + total + '، إزاحة=' + (total % 120) + ')', trials));
  return trials;
}

async function scenarioH(rows) {
  // ضغط إعادة الرسم: ارتفاع الشاشة يحدّد كم مرّة يمرّر ConPTY ويعيد رسم الصفوف.
  // شاشة قصيرة ⇒ تمرير عند كل أمر تقريباً؛ طويلة ⇒ تمرير نادر.
  const rowsList = QUICK ? [5, 60] : [4, 8, 16, 30, 60];
  const N = SCALE || (QUICK ? 8 : 20);
  const out = [];
  for (const r of rowsList) {
    const id = startProbeTerm(ROOT, 120, r);
    await waitShellIdle(id, 600, 12000);
    const trials = [];
    for (let i = 0; i < N; i++) trials.push(await trial('H', id, BASE_CMD, BASE_EXPECT, { rows: r }));
    term.killTerm(id);
    rows.push(rateRow('H rows=' + r + ' (ضغط تمرير)', trials));
    out.push(...trials);
  }
  return out;
}

async function scenarioI(rows) {
  // تغيير المقاس قبل كل التقاط مباشرةً: ConPTY يعيد ترتيب الصفوف الملتفّة عند resize،
  // وهو ما تفعله الواجهة فعلاً حين يتغيّر عرض اللوحة.
  const N = SCALE || (QUICK ? 8 : 24);
  const id = startProbeTerm(ROOT, 120, 30);
  await waitShellIdle(id, 600, 12000);
  const trials = [];
  for (let i = 0; i < N; i++) {
    term.resizeTerm(id, i % 2 === 0 ? 100 : 120, 30);
    await sleep(30);
    trials.push(await trial('I', id, BASE_CMD, BASE_EXPECT, { resized: true }));
  }
  term.killTerm(id);
  rows.push(rateRow('I تغيير المقاس قبل كل التقاط', trials));
  return trials;
}

async function scenarioJ(rows) {
  // ⭐ **التجربة الحاسمة**: عاملان متعامدان — صنف المحارف × موضع المحارف — بطول أمر
  // متطابق تماماً (‏23 محرفاً) كي تبقى الإزاحة وعدد الالتفافات ثابتة، فلا يبقى فرقٌ
  // إلا صنفُ المحارف نفسه. وتُضاف حالة رابعة يكون فيها **الصدى لاتينياً والخرجُ عربياً**
  // لتفصل «عربيةٌ في السطر الملتفّ» عن «عربيةٌ في خرج الأمر».
  const N = SCALE || (QUICK ? 10 : 30);
  const REPRO_CWD = String(optOf('repro-cwd', 'D:\\sater'));
  const cwd = fs.existsSync(REPRO_CWD) ? REPRO_CWD : ROOT;
  const cases = [
    ['J1 لاتيني (صدى+خرج)', 'Write-Output "satrwork"', 'satrwork'],
    ['J2 عربي  (صدى+خرج)', 'Write-Output "سطر يعمل"', 'سطر يعمل'],
    // الصدى لاتيني بحت (لا حرف عربي في سطر الأمر)، والخرج عربي — يفصل الصدى عن الخرج.
    ['J3 عربي في الخرج فقط', 'Write-Output ([char]0x633+[char]0x637+[char]0x631)', 'سطر'],
    // عربي في الصدى والخرج لكن قبل حدّ الالتفاف الأول (‏cols=500 ⇒ بلا التفاف).
    ['J4 عربي بلا التفاف (cols=500)', 'Write-Output "سطر يعمل"', 'سطر يعمل'],
  ];
  const out = [];
  for (let c = 0; c < cases.length; c++) {
    const cols = c === 3 ? 500 : 120;
    const id = startProbeTerm(cwd, cols, 30);
    await waitShellIdle(id, 600, 12000);
    const promptLen = await measurePrompt(id);
    const total = (promptLen || 0) + captureLineLen(cases[c][1]);
    const trials = [];
    for (let i = 0; i < N; i++) trials.push(await trial('J', id, cases[c][1], cases[c][2], { case: cases[c][0], cols, promptLen, total }));
    term.killTerm(id);
    rows.push(rateRow(cases[c][0] + ' [خلايا=' + total + '/' + cols + ']', trials));
    out.push(...trials);
  }
  return out;
}

async function scenarioK(rows, detail) {
  // ⭐⭐ **مسح الطول البايتي** — الفرضية التي أنتجها J: العطل ليس في المحارف العربية
  // ولا في الالتفاف، بل في أن كتابةً واحدة إلى أنبوب إدخال ConPTY **تُقصّ عند حدّ
  // بايتي ثابت**؛ فإن وقع القصّ داخل `ESC[201~` (آخر 7 بايتات من الكتابة) رأى
  // PSReadLine `1~` نصّاً فالتصق بالأمر ⇒ خطأ تحليل ⇒ لا علامة نهاية ⇒ مهلة وتلوّث.
  // نمسح بالبايت الواحد فوق الحدّ المرشَّح 256 ونقيس أين يقع الانفجار بالضبط.
  const from = Number(optOf('k-from', '236')) || 236;
  const to = Number(optOf('k-to', '300')) || 300;
  const reps = SCALE || (QUICK ? 1 : 3);
  const base = '1+1';           // أقصر أمرٍ ذو خرج مستقر: كتابة 232 بايت
  const expect = '2';
  const id = startProbeTerm(ROOT, 200, 30); // ‏cols واسع عمداً: نعزل الالتفاف تماماً
  await waitShellIdle(id, 600, 12000);
  const byBytes = new Map();
  const trials = [];
  for (let target = from; target <= to; target++) {
    const built = padToBytes(base, target);
    if (!built) continue;
    for (let k = 0; k < reps; k++) {
      const rec = await trial('K', id, built.cmd, expect, { bytes: built.bytes });
      trials.push(rec);
      const cur = byBytes.get(built.bytes) || { n: 0, bad: 0, to: 0 };
      cur.n++; if (rec.polluted) cur.bad++; if (rec.timedOut) cur.to++;
      byBytes.set(built.bytes, cur);
    }
  }
  term.killTerm(id);
  rows.push(rateRow('K مسح الطول البايتي ' + from + '..' + to + ' (cols=200)', trials));
  detail.byBytes = byBytes;
  return trials;
}

async function scenarioL(rows, detail) {
  // ⭐⭐⭐ **الاختبار القاطع بين «العربية» و«طول البايتات»**: ثلاث حالات —
  //   L1 عربي عند الطول البايتي المشتبَه به · L2 **العربية نفسها** مُزاحة عن ذلك
  //   الطول بالحشو · L3 لاتيني بحت مدفوعٌ إلى الطول نفسه.
  // إن تلوّث L1 وL3 وسَلِم L2 ⇒ السبب طولُ البايتات لا صنفُ المحارف، وينهار مرشّح
  // «العربية» كلياً. وإن تلوّث L1 وL2 وسَلِم L3 ⇒ العكس.
  const N = SCALE || (QUICK ? 10 : 30);
  const REPRO_CWD = String(optOf('repro-cwd', 'D:\\sater'));
  const cwd = fs.existsSync(REPRO_CWD) ? REPRO_CWD : ROOT;
  const arabicCmd = 'Write-Output "سطر يعمل"';
  const suspect = writeBytes(arabicCmd);            // الطول البايتي للحالة المبلَّغة
  const away = suspect + 24;                        // بعيداً عن الحدّ المشتبَه به
  const arabicAway = (function () {
    for (let n = 1; n <= 400; n++) {
      const c = arabicCmd + ' <#' + 'p'.repeat(n) + '#>';
      if (writeBytes(c) === away) return c;
    }
    return null;
  })();
  const latinAt = padToBytes('Write-Output "satrwork"', suspect);
  const cases = [];
  cases.push(['L1 عربي عند ' + suspect + ' بايت', arabicCmd, 'سطر يعمل']);
  if (arabicAway) cases.push(['L2 عربي عند ' + away + ' بايت', arabicAway, 'سطر يعمل']);
  if (latinAt) cases.push(['L3 لاتيني عند ' + suspect + ' بايت', latinAt.cmd, 'satrwork']);
  const out = [];
  for (const c of cases) {
    const id = startProbeTerm(cwd, 200, 30);
    await waitShellIdle(id, 600, 12000);
    const trials = [];
    for (let i = 0; i < N; i++) trials.push(await trial('L', id, c[1], c[2], { case: c[0], bytes: writeBytes(c[1]) }));
    term.killTerm(id);
    rows.push(rateRow(c[0], trials));
    out.push(...trials);
  }
  detail.suspectBytes = suspect;
  return out;
}

// ── التشغيل ────────────────────────────────────────────────────────────────────
async function main() {
  const started = Date.now();
  log('');
  log('════ مسبار OBS-132 — تلوّث خرج runCapture ════');
  log('البيئة        : ' + RUNTIME + ' · ' + process.platform + ' · ' + os.release());
  log('الصدفة        : ' + term.defaultShell());
  log('الوضع         : ' + (QUICK ? 'سريع (--quick)' : 'كامل') + (ONLY.length ? ' · مشاهد=' + ONLY.join(',') : ''));
  log('سطر الالتقاط  : طول=' + captureLineLen(BASE_CMD) + ' محرفاً لأمر طوله ' + BASE_CMD.length
    + ' (زيادة ثابتة ' + (captureLineLen(BASE_CMD) - BASE_CMD.length) + ')');
  log('الأمر المقيس  : ' + BASE_CMD + '  ⇒ يُتوقَّع «' + BASE_EXPECT + '» (لا يظهر في الصدى ⇒ برهان تنفيذ)');
  log('السجل         : ' + LOG_FILE);

  const rows = [];
  const detail = {};

  if (wanted('A1')) await scenarioA1(rows);
  if (wanted('A2')) await scenarioA2(rows);
  if (wanted('A3')) await scenarioA3(rows);
  if (wanted('B')) await scenarioB(rows);
  if (wanted('C')) await scenarioC(rows, detail);
  if (wanted('D')) await scenarioD(rows);
  if (wanted('E')) await scenarioE(rows);
  if (wanted('F')) await scenarioF(rows, detail);
  if (wanted('G')) await scenarioG(rows);
  if (wanted('H')) await scenarioH(rows);
  if (wanted('I')) await scenarioI(rows);
  if (wanted('J')) await scenarioJ(rows);
  if (wanted('K')) await scenarioK(rows, detail);
  if (wanted('L')) await scenarioL(rows, detail);

  printTable('جدول القياس — معدّل التلوّث لكل حالة', rows);

  // ── تجميع عام ────────────────────────────────────────────────────────────────
  const n = allTrials.length;
  const bad = allTrials.filter((t) => t.polluted);
  const notExec = allTrials.filter((t) => !t.executed);
  const noStand = allTrials.filter((t) => !t.diag.begStandalone);
  const badNoStand = bad.filter((t) => !t.diag.begStandalone);
  const badButStand = bad.filter((t) => t.diag.begStandalone);
  const cleanNoStand = allTrials.filter((t) => !t.polluted && !t.diag.begStandalone);
  const idxExpr = allTrials.filter((t) => t.diag.hasIndexExpr);
  const parseErr = allTrials.filter((t) => t.diag.hasParserError);

  log('');
  log('  إجمالي المحاولات               : ' + n);
  log('  ملوّثة                          : ' + bad.length + ' (' + (n ? ((bad.length / n) * 100).toFixed(2) : '0') + '%)');
  log('  لم يُنفَّذ الأمر                  : ' + notExec.length + '   ← «صفر» يعني: العطل في النصّ لا في التنفيذ');
  log('  بلا سطر-علامة مستقل             : ' + noStand.length);
  log('  ملوّثة **و** بلا سطر-علامة       : ' + badNoStand.length + '   ← يطابق آلية OBS-132');
  log('  ملوّثة رغم وجود سطر-علامة       : ' + badButStand.length + '   ← آلية ثانية إن > 0');
  log('  نظيفة رغم غياب سطر-علامة        : ' + cleanNoStand.length + '   ← يعني أن الغياب وحده لا يكفي');
  log('  مجاري تحوي IndexExpression      : ' + idxExpr.length);
  log('  مجاري تحوي أثر خطأ تحليل        : ' + parseErr.length);
  const stray = allTrials.filter((t) => t.diag.strayPasteTail > 0);
  const red = allTrials.filter((t) => t.diag.redPrompt);
  log('  خاتمة لصق مشوّهة (‏1~ نصّاً)      : ' + stray.length
    + '   ← منها ملوّثة: ' + stray.filter((t) => t.polluted).length);
  log('  مِحَثّ أحمر (خطأ تحليل بـPSReadLine): ' + red.length
    + '   ← منها ملوّثة: ' + red.filter((t) => t.polluted).length);
  // اقتران المؤشّرين بالتلوّث: هل تشوّه اللصق شرطٌ كافٍ؟ وهل هو شرطٌ لازم؟
  const badStray = bad.filter((t) => t.diag.strayPasteTail > 0).length;
  log('  ملوّثة ومعها لصق مشوّه          : ' + badStray + ' من ' + bad.length
    + '   ← «=كل الملوّثة» يعني أنه شرطٌ لازم');
  const codes = new Map();
  for (const t of allTrials) codes.set(String(t.exitCode), (codes.get(String(t.exitCode)) || 0) + 1);
  log('  رموز الخروج المرصودة            : ' + [...codes.entries()].map((e) => e[0] + '×' + e[1]).join(' · '));
  const timeouts = allTrials.filter((t) => t.timedOut).length;
  log('  محاولات انتهت بالمهلة           : ' + timeouts);

  // ── ① المحاذاة: هل التلوّث حتميّ لكل إزاحة؟ ─────────────────────────────────
  if (detail.offsets) {
    const allOff = [...detail.offsets.entries()];
    const badOff = allOff.filter((e) => e[1].bad > 0).sort((a, b) => a[0] - b[0]);
    const always = allOff.filter((e) => e[1].n > 1 && e[1].bad === e[1].n).length;
    const some = allOff.filter((e) => e[1].bad > 0 && e[1].bad < e[1].n).length;
    log('');
    log('  ① المحاذاة (‏cols=120، المِحَثّ=' + detail.promptLenC + ')');
    log('     إزاحات مقيسة         : ' + allOff.length);
    log('     تلوّثت في كل تكراراتها: ' + always);
    log('     تلوّثت في بعضها فقط  : ' + some + '   ← «> 0» يعني عدم حتمية ⇒ توقيت لا محاذاة');
    log('     الإزاحات الملوّثة     : ' + (badOff.length ? badOff.map((e) => e[0] + '(' + e[1].bad + '/' + e[1].n + ')').join(' ') : 'لا شيء'));
  }

  // ── ① الطول البايتي: أين ينفجر التلوّث بالضبط؟ ───────────────────────────────
  if (detail.byBytes) {
    const entries = [...detail.byBytes.entries()].sort((a, b) => a[0] - b[0]);
    log('');
    log('  ① الطول البايتي للكتابة الواحدة (‏cols=200 ⇒ الالتفاف معزول)');
    log('     خريطة (بايت:ملوّث/محاولات) — «.» نظيف تماماً:');
    let line = '     ';
    for (const e of entries) {
      const cell = e[0] + ':' + (e[1].bad ? e[1].bad + '/' + e[1].n : '.');
      if (line.length + cell.length > 112) { log(line); line = '     '; }
      line += cell + '  ';
    }
    if (line.trim()) log(line);
    const badB = entries.filter((e) => e[1].bad > 0).map((e) => e[0]);
    log('     أطوال تلوّثت        : ' + (badB.length ? badB.join(', ') : 'لا شيء'));
    if (badB.length) {
      log('     المدى الملوّث        : ' + Math.min(...badB) + '..' + Math.max(...badB)
        + '  (عرضه ' + (Math.max(...badB) - Math.min(...badB) + 1) + ' بايتاً)');
      // خاتمة اللصق `ESC[201~` + `CR` هي آخر 7 بايتات من الكتابة؛ فإن كان القصّ عند
      // حدٍّ ثابت H فالمدى المتوقَّع هو H+1 .. H+7.
      log('     ⇒ حدُّ القصّ المستنتَج : ' + (Math.min(...badB) - 1)
        + '  (المدى المتوقَّع لو كان الحدّ H هو H+1..H+7)');
    }
  }

  // ── علاقة التلوّث بالتوقيت/الأجزاء ───────────────────────────────────────────
  const avg = (arr, f) => (arr.length ? (arr.reduce((s, x) => s + f(x), 0) / arr.length) : 0);
  const clean = allTrials.filter((t) => !t.polluted);
  log('');
  log('  التوقيت والأجزاء (متوسطات)');
  log('     نظيفة (' + clean.length + ') : أجزاء=' + avg(clean, (t) => t.chunks).toFixed(2)
    + ' · بايتات=' + avg(clean, (t) => t.rawLen).toFixed(0)
    + ' · مدّة=' + avg(clean, (t) => t.ms).toFixed(0) + 'ms'
    + ' · أسطر-خام=' + avg(clean, (t) => t.diag.rawNewlines).toFixed(2)
    + ' · CSI=' + avg(clean, (t) => t.diag.escSeqs).toFixed(1));
  log('     ملوّثة (' + bad.length + ') : أجزاء=' + avg(bad, (t) => t.chunks).toFixed(2)
    + ' · بايتات=' + avg(bad, (t) => t.rawLen).toFixed(0)
    + ' · مدّة=' + avg(bad, (t) => t.ms).toFixed(0) + 'ms'
    + ' · أسطر-خام=' + avg(bad, (t) => t.diag.rawNewlines).toFixed(2)
    + ' · CSI=' + avg(bad, (t) => t.diag.escSeqs).toFixed(1));

  // ── ② IndexExpression ────────────────────────────────────────────────────────
  if (detail.dirtyOutput !== undefined) {
    log('');
    log('  ② نصّ خطأ التحليل المتعمَّد (‏$a[0 بلا إغلاق) — رمز الخروج ' + detail.dirtyExit
      + ' · يحوي IndexExpression=' + (detail.dirtyHasIndexExpr ? 'نعم' : 'لا'));
    const dl = String(detail.dirtyOutput).split('\n').slice(0, 14);
    for (const l of dl) log('     | ' + l);
  }
  if (idxExpr.length) {
    log('');
    log('  ② محاولات حوت IndexExpression : ' + idxExpr.length
      + ' — منها نُفِّذ أمرها فعلاً: ' + idxExpr.filter((t) => t.executed).length
      + ' · رموز خروجها: ' + [...new Set(idxExpr.map((t) => t.exitCode))].join(','));
    // النصّ نفسه: هل هو رسالة خطأ من PowerShell أم بقايا صدى مُعاد رسمه؟
    const seen = new Set();
    let shown = 0;
    for (const t of idxExpr) {
      const ctx = t.diag.indexExprCtx;
      if (!ctx || seen.has(ctx.slice(0, 80))) continue;
      seen.add(ctx.slice(0, 80));
      log('     سياق[' + t.scenario + ' · نُفِّذ=' + (t.executed ? 'نعم' : 'لا') + ']: ' + ctx);
      if (++shown >= 3) break;
    }
  }

  // ── لقطات البايتات الخام للحالات الملوّثة ────────────────────────────────────
  if (dumps.length) {
    log('');
    log('  لقطات المجرى الخام حول علامة البداية في حالات ملوّثة (‏' + dumps.length + ')');
    dumps.forEach((d, i) => {
      log('  ── لقطة ' + (i + 1) + ' — مشهد ' + d.rec.scenario + ' · زيادة ' + d.rec.excess
        + ' محرفاً · سطر-علامة مستقل=' + (d.rec.diag.begStandalone ? 'نعم' : 'لا'));
      log('     السطر الحاوي للعلامة: ' + JSON.stringify(String(d.rec.diag.begLine || '').slice(-170)));
      for (const l of d.window.split('\n')) log('     > ' + l);
    });
  }

  log('');
  log('انتهى في ' + ((Date.now() - started) / 1000).toFixed(1) + 'ث — السجل: ' + LOG_FILE);
  log('');

  try { term.killAll(); } catch (e) {}
  return 0; // مسبار قياس: يقيس ولا يفشل
}

function bail(err) {
  log('');
  log('X سقط المسبار: ' + (err && err.stack ? err.stack : err));
  try { term.killAll(); } catch (e) {}
  return 1;
}

process.on('uncaughtException', (e) => { hardExit(bail(e)); });

// خيوط node-pty تُبقي العملية حيّة بعد `app.exit` أحياناً (رُصد: السجل يكتمل ثم تعلق
// العملية) — فالخروج مزدوج: `app.exit` ثم `process.exit` قسراً بعد مهلة قصيرة.
function hardExit(code) {
  const c = code || 0;
  try { if (electronApp) electronApp.exit(c); } catch (e) {}
  setTimeout(() => process.exit(c), 800).unref();
  setTimeout(() => process.exit(c), 2500);
}

if (electronApp) {
  try { electronApp.disableHardwareAcceleration(); } catch (e) {}
  electronApp.on('window-all-closed', () => {});
  electronApp.whenReady()
    .then(() => main())
    .catch(bail)
    .then(hardExit);
} else {
  main().catch(bail).then(hardExit);
}
