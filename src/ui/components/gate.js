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
    border: 1px solid var(--border); border-radius: var(--radius-xl); padding: var(--space-6) var(--space-6) var(--space-5);
  }
  .gate-logo { font-size: 30px; font-weight: 700; color: var(--gold); display: flex; align-items: baseline; gap: var(--space-1); justify-content: center; margin-bottom: var(--space-4); user-select: none; }
  .gate-logo .cursor { display: inline-block; width: 13px; height: 26px; background: var(--gold); animation: blink 1.1s steps(1) infinite; transform: translateY(3px); }
  @keyframes blink { 50% { opacity: 0; } }
  h1 { font-size: 21px; font-weight: 700; text-align: center; margin-bottom: var(--space-2); }
  .gate-sub { color: var(--text-dim); font-size: 14px; text-align: center; margin-bottom: var(--space-5); }
  .gate-steps { list-style: none; display: flex; flex-direction: column; gap: var(--space-4); margin-bottom: var(--space-5); }
  .gate-step { display: flex; gap: var(--space-3); align-items: flex-start; }
  .gate-mark { flex: 0 0 24px; width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; border: 1px solid var(--border); margin-top: 2px; }
  .gate-mark.done { background: var(--green-soft); color: var(--green); border-color: transparent; }
  .gate-mark.todo { background: var(--gold-soft); color: var(--gold); border-color: transparent; }
  .gate-body { flex: 1; min-width: 0; }
  .gate-body .t { font-size: 14.5px; font-weight: 600; margin-bottom: 3px; }
  .gate-body .d { font-size: 13px; color: var(--text-dim); }
  .gate-body .d a { color: var(--gold); }
  .gate-cmd { display: flex; align-items: stretch; gap: var(--space-1h); margin-top: var(--space-2); }
  .gate-cmd code {
    flex: 1; direction: ltr; text-align: left; font-family: var(--mono); font-size: 12.5px;
    background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-md);
    padding: var(--space-2) var(--space-2h); color: var(--text); overflow-x: auto; white-space: nowrap; user-select: all;
  }
  .gate-cmd button { flex: 0 0 auto; font-size: 12px; padding: var(--space-1h) var(--space-3); }
  .gate-actions { display: flex; justify-content: center; }
  .recheck { background: var(--gold); color: var(--on-gold); border-color: var(--gold); font-weight: 700; padding: var(--space-2h) var(--space-5); font-size: 14px; }
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
        '<p class="gate-foot">«سطر» يشغّل محرّك الذكاء الاصطناعي في الخلفية ويعرض محادثتك بالعربية بشكل سليم.<br>يكفي تثبيت محرّك واحد مرة واحدة على جهازك.</p>' +
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

  // جاهز: إخفاء البوابة وإعلام القشرة (ترفع الحجب وتعرض شريط النجاح).
  // `preferred`/`readyEngines` تصفان **أي** محرك جاهز — القشرة تستعملهما لتصحيح منتقي
  // المحرك إن كان اختيار المستخدم المحفوظ غير جاهز، فلا يفشل أول طلب صامتاً.
  _ready(r) {
    const claude = (r && r.claude) || {};
    const engines = (r && Array.isArray(r.engines)) ? r.engines : [];
    const preferred = (r && r.preferred) || 'sdk';
    const chosen = engines.find((engine) => engine.id === preferred) || null;
    this.hidden = true;
    this.dispatchEvent(new CustomEvent('gate-ready', { detail: {
      version: claude.version || '',
      outdated: !!claude.outdated,
      recommended: claude.recommended || '',
      preferred,
      readyEngines: (r && Array.isArray(r.readyEngines)) ? r.readyEngines.slice() : [],
      engineLabel: chosen ? chosen.label : 'Claude Code',
    } }));
  }

  // رسم الخطوات حين لا يجهز **أي** محرك. يكفي واحد من الثلاثة ليفتح التطبيق، فالخطوات
  // تُعرض بديلةً لا متتابعة: لكل محرك حالته وأمره الخاص (تثبيت أو تسجيل دخول).
  _render(r) {
    this.hidden = false;
    const engines = (r && Array.isArray(r.engines) && r.engines.length) ? r.engines : null;
    // محرك مثبّت لكنه غير مسجّل ⇒ رسالة أدقّ من «ثبّت»: المستخدم على بعد خطوة واحدة.
    const anyInstalled = engines ? engines.some((engine) => engine.installed) : !!(r && r.claude && r.claude.ok);
    this._title.textContent = anyInstalled ? 'مطلوب: تسجيل الدخول إلى محرّكك' : 'مطلوب: محرّك ذكاء اصطناعي واحد';
    this._sub.textContent = anyInstalled
      ? 'المحرّك مثبّت لكنه غير مسجّل الدخول. سجّل الدخول ثم اضغط «أعد الفحص».'
      : '«سطر» يشغّل محرّكاً في الخلفية ويعرض محادثتك بالعربية. يكفي واحد من هذه المحرّكات — اختر أيّها شئت.';
    this._steps.innerHTML = '';

    // الخطوة الأولى: Node.js — يلزم npm لتثبيت محرّكَي Claude Code وCodex
    if (r && r.node && r.node.ok) {
      this._steps.appendChild(this._step('done', 'Node.js مثبّت', 'الإصدار ' + (r.node.version || '') + ' — جاهز.'));
    } else {
      const link = document.createElement('span');
      link.appendChild(document.createTextNode('نزّل النسخة الموصى بها (LTS) من '));
      const a = document.createElement('a'); a.href = 'https://nodejs.org/'; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'nodejs.org';
      link.appendChild(a); link.appendChild(document.createTextNode(' وثبّتها، ثم أعد الفحص.'));
      this._steps.appendChild(this._step('todo', 'ثبّت Node.js', link));
    }

    // خطوة لكل محرك. غياب `engines` يعني استجابة preflight قديمة ⇒ نتراجع إلى مسار
    // Claude وحده بالسلوك السابق حرفياً (تدهور رشيق، لا شاشة فارغة).
    if (!engines) {
      const claudeOk = !!(r && r.claude && r.claude.ok);
      this._steps.appendChild(this._step(
        claudeOk ? 'done' : 'todo', 'ثبّت Claude Code',
        claudeOk ? ('مثبّت — ' + (r.claude.version || '')) : 'افتح الطرفية (PowerShell) ونفّذ هذا الأمر مرة واحدة:',
        claudeOk ? null : INSTALL_CMD));
      const authReady = claudeOk && (!r.claude.authChecked || r.claude.loggedIn === true);
      this._steps.appendChild(this._step(
        authReady ? 'done' : 'todo',
        authReady ? 'Claude Code مسجّل الدخول' : 'سجّل الدخول إلى Claude Code',
        authReady ? 'المصادقة جاهزة.' : 'شغّل الأمر التالي في الطرفية ثم أعد الفحص:',
        authReady ? null : LOGIN_CMD));
      return;
    }

    engines.forEach((engine, index) => {
      const recommended = index === 0 ? ' — الموصى به' : '';
      if (engine.state === 'logged_out') {
        this._steps.appendChild(this._step('todo', engine.label + ' — مثبّت، يلزم تسجيل الدخول',
          'شغّل هذا الأمر في الطرفية واتبع خطواته، ثم أعد الفحص:', engine.login));
      } else {
        this._steps.appendChild(this._step('todo', 'ثبّت ' + engine.label + recommended,
          'افتح الطرفية (PowerShell) ونفّذ هذا الأمر مرة واحدة:', engine.install));
      }
    });
  }

  async _run() {
    this._btn.disabled = true; this._btn.textContent = 'جارٍ الفحص…';
    let r = null;
    try { r = await window.satr.preflight(); } catch (e) { r = null; }
    this._btn.disabled = false; this._btn.textContent = 'أعد الفحص';
    // `ready` هو عقد الجاهزية الجديد (أي محرك يكفي). غيابه = preflight قديم ⇒ نعود
    // إلى شرط Claude وحده كما كان، فلا تنكسر نسخة قديمة من العملية الرئيسية.
    const open = (r && typeof r.ready === 'boolean')
      ? r.ready
      : !!(r && r.claude && r.claude.ok && (!r.claude.authChecked || r.claude.loggedIn === true));
    if (open) this._ready(r);
    else this._render(r);
  }
}

customElements.define('satr-gate', SatrGate);
