// <satr-gate> — بوابة أول التشغيل (مانع إطلاق — المرحلة 6) — تفكيك ت-8.
// «سطر» يعتمد كلياً على Claude Code المثبّت عالمياً، فتحجب البوابة المحادثة حتى يتوفّر.
// المكوّن ذاتي بالكامل: يفحص عند الاتصال (satr.preflight — بالقوة ليلتقط تثبيتاً جرى
// بعد الإقلاع)، يرسم الخطوات العربية بأزرار نسخ الأوامر، و«أعد الفحص» داخلي.
// عند الجهوز يخفي نفسه ويُصدر «gate-ready {version}» — القشرة ترفع حجب الإرسال
// (gated) وتعرض شريط النجاح (banner عنصر مشترك ملكها).
import { sheet } from '../lib/sheet.js';
import { controlsSheet } from '../lib/panel.css.js';

const INSTALL_CMD = 'npm install -g @anthropic-ai/claude-code';
const LOGIN_CMD = 'claude auth login';

const ownSheet = sheet(`
  :host {
    position: fixed; inset: 0; z-index: var(--z-system);
    background: var(--bg);
    display: flex; align-items: center; justify-content: center;
    padding: 28px; overflow-y: auto;
  }
  :host([hidden]) { display: none; }
  .gate-card {
    width: 100%; max-width: 560px; background: var(--surface);
    border: 1px solid var(--border); border-radius: var(--radius-xl); padding: 30px 30px 24px;
  }
  .gate-logo { font-size: 30px; font-weight: 700; color: var(--gold); display: flex; align-items: baseline; gap: 4px; justify-content: center; margin-bottom: 18px; user-select: none; }
  .gate-logo .cursor { display: inline-block; width: 13px; height: 26px; background: var(--gold); animation: blink 1.1s steps(1) infinite; transform: translateY(3px); }
  @keyframes blink { 50% { opacity: 0; } }
  h1 { font-size: 21px; font-weight: 700; text-align: center; margin-bottom: 8px; }
  .gate-sub { color: var(--text-dim); font-size: 14px; text-align: center; margin-bottom: 22px; }
  .gate-steps { list-style: none; display: flex; flex-direction: column; gap: 14px; margin-bottom: 22px; }
  .gate-step { display: flex; gap: 12px; align-items: flex-start; }
  .gate-mark { flex: 0 0 24px; width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; border: 1px solid var(--border); margin-top: 2px; }
  .gate-mark.done { background: var(--green-soft); color: var(--green); border-color: transparent; }
  .gate-mark.todo { background: var(--gold-soft); color: var(--gold); border-color: transparent; }
  .gate-body { flex: 1; min-width: 0; }
  .gate-body .t { font-size: 14.5px; font-weight: 600; margin-bottom: 3px; }
  .gate-body .d { font-size: 13px; color: var(--text-dim); }
  .gate-body .d a { color: var(--gold); }
  .gate-cmd { display: flex; align-items: stretch; gap: 6px; margin-top: 8px; }
  .gate-cmd code {
    flex: 1; direction: ltr; text-align: left; font-family: var(--mono); font-size: 12.5px;
    background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-md);
    padding: 8px 10px; color: var(--text); overflow-x: auto; white-space: nowrap; user-select: all;
  }
  .gate-cmd button { flex: 0 0 auto; font-size: 12px; padding: 6px 12px; }
  .gate-actions { display: flex; justify-content: center; }
  .recheck { background: var(--gold); color: var(--on-gold); border-color: var(--gold); font-weight: 700; padding: 9px 26px; font-size: 14px; }
  .recheck:hover { filter: brightness(1.07); }
  .recheck:disabled { opacity: .55; cursor: default; }
  .gate-foot { text-align: center; color: var(--text-dim); font-size: 12px; margin-top: 20px; line-height: 1.7; }
`);

// نسخ نص أمر للحافظة مع تأكيد بصري قصير (يعمل بلا اتصال — لا CSP يمنعه)
async function copyCmd(text, btn) {
  try { await navigator.clipboard.writeText(text); }
  catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e2) {}
    document.body.removeChild(ta);
  }
  const old = btn.textContent; btn.textContent = 'نُسخ ✓';
  setTimeout(() => { btn.textContent = old; }, 1400);
}

class SatrGate extends HTMLElement {
  constructor() {
    super();
    const r = this.attachShadow({ mode: 'open' });
    r.adoptedStyleSheets = [controlsSheet, ownSheet];
    r.innerHTML =
      '<div class="gate-card">' +
        '<div class="gate-logo">سطر<span class="cursor" aria-hidden="true"></span></div>' +
        '<h1>جارٍ التحقق من المتطلّبات…</h1>' +
        '<p class="gate-sub">لحظة من فضلك</p>' +
        '<ol class="gate-steps"></ol>' +
        '<div class="gate-actions"><button class="recheck">أعد الفحص</button></div>' +
        '<p class="gate-foot">«سطر» يشغّل Claude Code في الخلفية ويعرض محادثتك بالعربية بشكل سليم.<br>يكفي تثبيت Claude Code مرة واحدة على جهازك.</p>' +
      '</div>';
    this._title = r.querySelector('h1');
    this._sub = r.querySelector('.gate-sub');
    this._steps = r.querySelector('.gate-steps');
    this._btn = r.querySelector('.recheck');
    this._btn.addEventListener('click', () => this._run());
  }

  connectedCallback() {
    // إظهار حالة «جارٍ التحقق» فوراً ريثما يعود الفحص (المضيف ظاهر افتراضياً)
    this._run();
  }

  // بناء صفّ خطوة: علامة حالة + عنوان + وصف (يقبل عقدة) + أمر اختياري بزر نسخ
  _step(state, title, descNode, cmd) {
    const li = document.createElement('li'); li.className = 'gate-step';
    const mark = document.createElement('div');
    mark.className = 'gate-mark ' + (state === 'done' ? 'done' : 'todo');
    mark.textContent = state === 'done' ? '✓' : '•';
    const body = document.createElement('div'); body.className = 'gate-body';
    const t = document.createElement('div'); t.className = 't'; t.textContent = title;
    const d = document.createElement('div'); d.className = 'd';
    if (typeof descNode === 'string') d.textContent = descNode; else if (descNode) d.appendChild(descNode);
    body.appendChild(t); body.appendChild(d);
    if (cmd) {
      const row = document.createElement('div'); row.className = 'gate-cmd';
      const code = document.createElement('code'); code.textContent = cmd; code.dir = 'ltr';
      const cp = document.createElement('button'); cp.textContent = 'نسخ'; cp.title = 'نسخ الأمر';
      cp.addEventListener('click', () => copyCmd(cmd, cp));
      row.appendChild(code); row.appendChild(cp);
      body.appendChild(row);
    }
    li.appendChild(mark); li.appendChild(body);
    return li;
  }

  // جاهز: إخفاء البوابة وإعلام القشرة (ترفع الحجب وتعرض شريط النجاح)
  _ready(version, claude) {
    this.hidden = true;
    this.dispatchEvent(new CustomEvent('gate-ready', { detail: {
      version: version || '',
      outdated: !!(claude && claude.outdated),
      recommended: (claude && claude.recommended) || '',
    } }));
  }

  // رسم الخطوات من نتيجة الفحص حين يكون claude غير متوفّر
  _render(r) {
    this.hidden = false;
    const claudeOk = !!(r && r.claude && r.claude.ok);
    const loggedOut = claudeOk && r.claude.authChecked && r.claude.loggedIn === false;
    this._title.textContent = loggedOut ? 'مطلوب: تسجيل الدخول إلى Claude Code' : 'مطلوب: Claude Code';
    this._sub.textContent = loggedOut
      ? 'انتهت جلسة Claude Code أو سُجّل الخروج منها. سجّل الدخول ثم اضغط «أعد الفحص».'
      : '«سطر» يحتاج Claude Code مثبّتاً على جهازك ليعمل. اتبع الخطوات ثم اضغط «أعد الفحص».';
    this._steps.innerHTML = '';

    // الخطوة 1: Node.js (يلزم npm لتثبيت Claude Code)
    if (r && r.node && r.node.ok) {
      this._steps.appendChild(this._step('done', 'Node.js مثبّت', 'الإصدار ' + (r.node.version || '') + ' — جاهز.'));
    } else {
      const link = document.createElement('span');
      link.appendChild(document.createTextNode('نزّل النسخة الموصى بها (LTS) من '));
      const a = document.createElement('a'); a.href = 'https://nodejs.org/'; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'nodejs.org';
      link.appendChild(a); link.appendChild(document.createTextNode(' وثبّتها، ثم أعد الفحص.'));
      this._steps.appendChild(this._step('todo', 'ثبّت Node.js', link));
    }

    // الخطوة 2: تثبيت Claude Code عبر npm
    this._steps.appendChild(this._step(
      claudeOk ? 'done' : 'todo',
      'ثبّت Claude Code',
      claudeOk ? ('مثبّت — ' + (r.claude.version || '')) : 'افتح الطرفية (PowerShell) ونفّذ هذا الأمر مرة واحدة:',
      claudeOk ? null : INSTALL_CMD
    ));

    // الخطوة 3: تسجيل الدخول — preflight يفحص `claude auth status` بلا قراءة أي token.
    const authReady = claudeOk && (!r.claude.authChecked || r.claude.loggedIn === true);
    this._steps.appendChild(this._step(
      authReady ? 'done' : 'todo',
      authReady ? 'Claude Code مسجّل الدخول' : 'سجّل الدخول إلى Claude Code',
      authReady ? 'المصادقة جاهزة.' : 'شغّل الأمر التالي في الطرفية واتبع خطوات تسجيل الدخول، ثم أعد الفحص:',
      authReady ? null : LOGIN_CMD
    ));
  }

  async _run() {
    this._btn.disabled = true; this._btn.textContent = 'جارٍ الفحص…';
    let r = null;
    try { r = await window.satr.preflight(); } catch (e) { r = null; }
    this._btn.disabled = false; this._btn.textContent = 'أعد الفحص';
    const claudeReady = r && r.claude && r.claude.ok
      && (!r.claude.authChecked || r.claude.loggedIn === true);
    if (claudeReady) this._ready(r.claude.version, r.claude);
    else this._render(r);
  }
}

customElements.define('satr-gate', SatrGate);
