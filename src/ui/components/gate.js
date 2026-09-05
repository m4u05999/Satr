// <satr-gate> — بوابة أول التشغيل (مانع إطلاق — المرحلة 6) — تفكيك ت-8.
// تفتح البوابة بمحرك أصيل جاهز أو بمحوّل REST له مفتاح محفوظ. المكوّن ذاتي بالكامل:
// يفحص عند الاتصال، ويرسم خطوات المحركات ومسار حفظ مفتاح مجاني، و«أعد الفحص» داخلي
// يطلب تجاوز كاش جاهزية Codex ليلتقط تسجيلاً جرى بعد الإقلاع.
// عند الجهوز يخفي نفسه ويُصدر «gate-ready {version}» — القشرة ترفع حجب الإرسال
// (gated) وتعرض شريط النجاح (banner عنصر مشترك ملكها).
import { sheet } from '../lib/sheet.js';
import { controlsSheet } from '../lib/panel.css.js';
import { textDir, applyDir } from '../lib/text-dir.js';

// `npm.cmd` لا `npm`: في PowerShell يسبق `npm.ps1` ملفَّ `npm.cmd` في ترتيب الأوامر،
// و`ExecutionPolicy` الافتراضية لعميل ويندوز تحجب السكربتات — فيفشل الأمر **حتى وهو
// منسوخ بيد المستخدم**. مصدر الحقيقة `electron/readiness.js` (‏NPM_BIN)؛ هذا احتياط
// مسار preflight القديم وحده.
const INSTALL_CMD = 'npm.cmd install -g @anthropic-ai/claude-code';
const LOGIN_CMD = 'claude auth login';

// نسخة محلية كانت تضبط `dir` وحدها، فلم ترث علاج `text-align` (‏OBS-128) — وهي بعينها
// الحالة التي حذّر منها استخراج `text-dir.js`: «نسخُ المنطق يعني تباعده بصمت». الفرق
// الوحيد الباقي عن `applyDir` المشتركة هو الافتراض `rtl` عند غياب الحسم (نصّ بلا حروف
// قوية)، وهو مقصود هنا: البوابة عربية، فالسقوط إليها لا إلى «بلا اتجاه».
function applyTextDirection(el, text) {
  const source = typeof text === 'string' ? text : (el.textContent || '');
  applyDir(el, textDir(source) ? source : 'ا');
}

const ownSheet = sheet(`
  :host {
    position: fixed; inset: 0; z-index: var(--z-system);
    background: var(--bg);
    display: flex; align-items: flex-start; justify-content: center;
    padding: 28px; overflow-y: auto;
  }
  :host([hidden]) { display: none; }
  .gate-card {
    width: 100%; max-width: 560px; background: var(--surface);
    border: 1px solid var(--border); border-radius: var(--radius-xl); padding: var(--space-6) var(--space-6) var(--space-5);
    margin-block: auto;
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
  .gate-key { margin-top: var(--space-5); padding-top: var(--space-5); border-top: 1px solid var(--border); }
  .gate-key[hidden] { display: none; }
  .gate-key h2 { margin: 0 0 var(--space-2); color: var(--text); font-size: 17px; text-align: center; }
  .gate-key p { margin: 0 0 var(--space-2); color: var(--text-dim); font-size: 13px; line-height: 1.7; }
  .gate-key a { color: var(--text); text-decoration-color: var(--gold); direction: ltr; unicode-bidi: isolate; }
  .gate-key-fields { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-2); margin-top: var(--space-3); }
  .gate-key-field { display: grid; gap: var(--space-1); min-width: 0; }
  .gate-key-field label { color: var(--text-dim); font-size: 12px; }
  .gate-key-field select, .gate-key-field input {
    width: 100%; min-width: 0; background: var(--bg); border: 1px solid var(--border);
    border-radius: var(--radius-md); padding: var(--space-2) var(--space-2h); color: var(--text);
    font-family: var(--sans); font-size: 13px; outline: none;
  }
  .gate-key-field select:focus, .gate-key-field input:focus { border-color: var(--gold); }
  .gate-key-field input { direction: ltr; text-align: left; font-family: var(--mono); }
  .save-key { background: var(--gold); color: var(--on-gold); border-color: var(--gold); font-weight: 700; }
  .save-key:disabled { opacity: .55; cursor: default; }
  .gate-key-error { min-height: 1.7em; margin-top: var(--space-2); color: var(--red); }
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
        '<section class="gate-key" hidden>' +
          '<h2>أو ابدأ الآن بمفتاح API مجاني</h2>' +
          '<p class="gate-key-intro">مفتاح API هو رمز خاص يربط «سطر» بحسابك لدى مزوّد الذكاء الاصطناعي. أنشئه ثم الصقه هنا، ولا تشاركه مع أحد.</p>' +
          '<p class="gate-key-links">تمنحك <a href="https://build.nvidia.com/" target="_blank" rel="noopener">NVIDIA NIM</a> و<a href="https://console.groq.com/" target="_blank" rel="noopener">Groq</a> مفتاحاً مجانياً بإنشاء حساب فقط، بلا بطاقة ائتمان.</p>' +
          '<p class="gate-key-limits">حدود الطبقة المجانية: Groq نحو 30 طلباً و8000 رمز في الدقيقة، وNVIDIA NIM نحو 40 طلباً في الدقيقة — تكفي للتجربة والمهام القصيرة. وعند بلوغ الحدّ ينتظر «سطر» ثم يعيد المحاولة.</p>' +
          '<div class="gate-key-fields">' +
            '<div class="gate-key-field"><label for="gateKeyProvider">اختر المزوّد</label><select id="gateKeyProvider"></select></div>' +
            '<div class="gate-key-field"><label for="gateKeyValue">مفتاح API</label><input id="gateKeyValue" type="password" dir="ltr" autocomplete="off" spellcheck="false" placeholder="الصق المفتاح هنا"></div>' +
            '<button class="save-key">احفظ وابدأ</button>' +
          '</div>' +
          '<p class="gate-key-error" role="status" aria-live="polite"></p>' +
        '</section>' +
        '<p class="gate-foot">«سطر» يشغّل محرّك الذكاء الاصطناعي في الخلفية ويعرض محادثتك بالعربية بشكل سليم.<br>يكفي محرّك جاهز أو مفتاح API محفوظ؛ لا تحتاج إلى إعدادهما معاً.</p>' +
      '</div>';
    this._title = r.querySelector('h1');
    this._sub = r.querySelector('.gate-sub');
    this._steps = r.querySelector('.gate-steps');
    this._btn = r.querySelector('.recheck');
    this._keySection = r.querySelector('.gate-key');
    this._keySelect = r.querySelector('#gateKeyProvider');
    this._keyInput = r.querySelector('#gateKeyValue');
    this._keySave = r.querySelector('.save-key');
    this._keyError = r.querySelector('.gate-key-error');
    this._keyProviders = null;
    this._keyProvidersPromise = null;
    for (const el of [this._title, this._sub, r.querySelector('.gate-foot'),
      r.querySelector('.gate-key h2'), r.querySelector('.gate-key-intro'),
      r.querySelector('.gate-key-links'), r.querySelector('.gate-key-limits'),
      r.querySelector('label[for="gateKeyProvider"]'),
      r.querySelector('label[for="gateKeyValue"]')]) {
      applyTextDirection(el);
    }
    this._btn.addEventListener('click', () => this._run(true));
    this._keySave.addEventListener('click', () => this._saveKey());
  }

  connectedCallback() {
    // إظهار حالة «جارٍ التحقق» فوراً ريثما يعود الفحص (المضيف ظاهر افتراضياً)
    this._run();
  }

  async _loadKeyProviders() {
    if (this._keyProviders) return this._keyProviders;
    if (!this._keyProvidersPromise) {
      this._keyProvidersPromise = (async () => {
        try {
          const result = typeof window.satr.providers === 'function' ? await window.satr.providers() : null;
          const list = result && Array.isArray(result.providers) ? result.providers : [];
          const freeOrder = new Map([['nvidia', 0], ['groq', 1]]);
          this._keyProviders = list
            .map((provider, index) => ({ provider, index }))
            .filter(({ provider }) => provider && typeof provider.name === 'string' && provider.name
              && typeof provider.keyName === 'string' && provider.keyName)
            .sort((a, b) => (freeOrder.get(a.provider.name) ?? 2) - (freeOrder.get(b.provider.name) ?? 2)
              || a.index - b.index)
            .map(({ provider }) => provider);
        } catch (e) { this._keyProviders = []; }
        return this._keyProviders;
      })();
    }
    return this._keyProvidersPromise;
  }

  async _renderKeySetup() {
    this._keySection.hidden = true;
    const providers = await this._loadKeyProviders();
    if (this.hidden || !providers.length) return;
    this._keySelect.innerHTML = '';
    for (const provider of providers) {
      const option = document.createElement('option');
      option.value = provider.name;
      const baseLabel = typeof provider.label === 'string' && provider.label ? provider.label : provider.name;
      option.textContent = (provider.name === 'nvidia' || provider.name === 'groq') && !baseLabel.includes('مجاني')
        ? baseLabel + ' — مجاني'
        : baseLabel;
      applyTextDirection(option);
      this._keySelect.appendChild(option);
    }
    this._keySection.hidden = false;
  }

  _setKeyError(message) {
    this._keyError.textContent = message;
    applyTextDirection(this._keyError, message);
  }

  async _saveKey() {
    const provider = Array.isArray(this._keyProviders)
      ? this._keyProviders.find((item) => item.name === this._keySelect.value)
      : null;
    let value = this._keyInput.value.trim();
    this._keyInput.value = '';
    this._setKeyError('');
    if (!provider || !value) {
      value = '';
      this._setKeyError('ألصق المفتاح أولاً، ثم اضغط «احفظ وابدأ».');
      return;
    }
    this._keySave.disabled = true;
    this._keySave.textContent = 'جارٍ الحفظ…';
    try {
      const saving = window.satr.keySet(provider.keyName, value);
      value = '';
      const result = await saving;
      if (!result || result.ok !== true) {
        this._setKeyError('تعذّر حفظ المفتاح. تأكّد من المفتاح وحاول مرة أخرى.');
        return;
      }
      await this._run();
    } catch (e) {
      this._setKeyError('تعذّر حفظ المفتاح. حاول مرة أخرى.');
    } finally {
      value = '';
      this._keySave.disabled = false;
      this._keySave.textContent = 'احفظ وابدأ';
    }
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
    applyTextDirection(t, title); applyTextDirection(d);
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
    applyTextDirection(li);
    return li;
  }

  // جاهز: إخفاء البوابة وإعلام القشرة (ترفع الحجب وتعرض شريط النجاح).
  // `preferred`/`readyEngines` تصفان **أي** محرك جاهز — القشرة تستعملهما لتصحيح منتقي
  // المحرك إن كان اختيار المستخدم المحفوظ غير جاهز، فلا يفشل أول طلب صامتاً.
  _ready(r) {
    const claude = (r && r.claude) || {};
    const engines = (r && Array.isArray(r.engines)) ? r.engines : [];
    const keyProviders = (r && Array.isArray(r.keyProviders)) ? r.keyProviders : [];
    const preferred = (r && r.preferred) || 'sdk';
    const chosen = engines.find((engine) => engine.id === preferred)
      || keyProviders.find((provider) => provider.name === preferred) || null;
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
  async _render(r) {
    this.hidden = false;
    const engines = (r && Array.isArray(r.engines) && r.engines.length) ? r.engines : null;
    // محرك مثبّت لكنه غير مسجّل ⇒ رسالة أدقّ من «ثبّت»: المستخدم على بعد خطوة واحدة.
    const anyInstalled = engines ? engines.some((engine) => engine.installed) : !!(r && r.claude && r.claude.ok);
    this._title.textContent = anyInstalled ? 'مطلوب: تسجيل الدخول إلى محرّكك' : 'مطلوب: محرّك ذكاء اصطناعي واحد';
    this._sub.textContent = anyInstalled
      ? 'المحرّك مثبّت لكنه غير مسجّل الدخول. سجّل الدخول ثم اضغط «أعد الفحص».'
      : '«سطر» يشغّل محرّكاً في الخلفية ويعرض محادثتك بالعربية. يكفي واحد من هذه المحرّكات — اختر أيّها شئت.';
    applyTextDirection(this._title); applyTextDirection(this._sub);
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
    } else {
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
    await this._renderKeySetup();
  }

  async _run(force = false) {
    this._btn.disabled = true; this._btn.textContent = 'جارٍ الفحص…';
    let r = null;
    try { r = await window.satr.preflight(force ? { force: true } : undefined); } catch (e) { r = null; }
    this._btn.disabled = false; this._btn.textContent = 'أعد الفحص';
    // `ready` هو عقد الجاهزية الجديد (أي محرك يكفي). غيابه = preflight قديم ⇒ نعود
    // إلى شرط Claude وحده كما كان، فلا تنكسر نسخة قديمة من العملية الرئيسية.
    const open = (r && typeof r.ready === 'boolean')
      ? r.ready
      : !!(r && r.claude && r.claude.ok && (!r.claude.authChecked || r.claude.loggedIn === true));
    if (open) this._ready(r);
    else await this._render(r);
  }
}

customElements.define('satr-gate', SatrGate);
