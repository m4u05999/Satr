// <satr-terminal-panel> — الطرفية العربية المدمجة (المراحل 8 و15) — تفكيك ت-9.
// **بلا Shadow DOM** (قرار خطة التفكيك §2/3): xterm.js يقيس ويلتقط أحداثاً على DOM
// المستند، وأنماط المنطقة تبقى في base.css كما هي (المحدِّدات #termPanel/… لم تتغير —
// البنية ذاتها تُبنى داخل المكوّن light DOM). المنطقة كانت معزولة ذاتياً بالكامل
// (قناة satr:term + xterm العالمية + localStorage) فانتقلت **حرفياً** من القشرة.
// العقد للخارج: adoptTerm/adoptModelTerm/activateTerm/setTermOpen. تبنّي الطرفية لا
// ينشئ pty جديداً؛ يربط xterm بالمعرّف الحيّ في العملية الرئيسية ويستعيد ذيل خرجه.
// ملاحظة تخطيط: للمكوّن قاعدة display:contents في base.css — غلاف شفاف كي يبقى
// #termPanel ابناً مباشراً لتخطيط body العمودي كما كان.

const MARKUP = `
<section id="termPanel" class="mode-bidi" aria-label="الطرفية المدمجة" hidden>
  <div id="termResizer" title="اسحب لتغيير الارتفاع"></div>
  <div class="term-head">
    <span class="term-dot" id="termDot" aria-hidden="true"></span>
    <!-- شريط التبويبات (المرحلة 15.2): تبويب لكل طرفية + زر ＋ لواحدة جديدة -->
    <div id="termTabs"></div>
    <button id="termNew" type="button" title="طرفية جديدة">＋</button>
    <!-- تنظيف التبويبات المنتهية: تتراكم عبر الجلسات الطويلة (مهام انتهت وخوادم
         أُوقفت) فيمتلئ الشريط بما لا يعمل. يظهر عند وجود تبويبين منتهيَين فأكثر. -->
    <button id="termCloseDead" type="button" title="إغلاق التبويبات المنتهية" hidden>🧹 المنتهية</button>
    <span class="term-shell" id="termShell"></span>
    <span class="spacer"></span>
    <button id="termView" type="button" title="تبديل العارض: عربي (BiDi) / شبكي (xterm)">العرض: عربي</button>
    <button id="termRestart" type="button" title="إنهاء الصدفة الحالية وبدء واحدة جديدة">إعادة تشغيل</button>
    <button id="termClose" type="button" title="إخفاء اللوحة (الطرفيات تبقى تعمل)">✕</button>
  </div>
  <!-- مضيف الطرفيات: عرض (.term-view) لكل تبويب يُنشأ ديناميكياً، النشط وحده ظاهر -->
  <div id="termHost"></div>
  <!-- تنبيه التبديل التلقائي (8.4): يظهر عند إطلاق تطبيق يعكس العربية بنفسه -->
  <div id="termNotice">
    <span id="termNoticeText"></span>
    <span class="spacer"></span>
    <button id="termNoticeBack" type="button">العرض العربي</button>
    <button id="termNoticeClose" type="button" title="إخفاء">✕</button>
  </div>
  <!-- سطر الإدخال (8.3): عابر — يُفرَّغ عند الإرسال وصدى الصدفة هو المعروض الوحيد -->
  <div id="termInputRow">
    <!-- ‏dir يُضبط ديناميكياً (syncInputDir): rtl وهو فارغ كي يُعرض placeholder العربي
         بترتيبه الصحيح، و auto عند الكتابة كي يحسم الأمر اللاتيني اتجاهه بنفسه.
         السبب المثبّت: dir="auto" على حقل فارغ يحسم LTR فينقلب ترتيب أزواج
         «Enter ينفّذ — Ctrl+C يقطع» بصرياً في نص عربي. -->
    <input type="text" id="termInput" dir="rtl" spellcheck="false"
           placeholder="اكتب أمراً… (Enter ينفّذ — Ctrl+C يقطع — ▲▼ التاريخ والحقل فارغ)">
    <button id="termInputMask" type="button" aria-pressed="false"
            aria-label="إخفاء إدخال الطرفية" title="إخفاء الإدخال بصرياً فقط">👁</button>
    <span id="termInputHint" aria-hidden="true">Tab لا يُكمل هنا</span>
  </div>
  <div id="termExited"><span>انتهت جلسة الطرفية.</span><button id="termRestart2" type="button">بدء جلسة جديدة</button></div>
</section>
`;

class SatrTerminalPanel extends HTMLElement {
  connectedCallback() {
    if (this._wired) return; // اتصال متكرر لا يعيد البناء
    this._wired = true;
    this.innerHTML = MARKUP;
    const $ = (id) => document.getElementById(id);

// ما يلي منقول حرفياً من القشرة (المراحل 15 + 8.2 + 8.3) — بلا أي تغيير سلوك
  // ---------- الطرفية المدمجة متعددة التبويبات (المرحلة 15) ----------
  // كل تبويب كائن مستقل: نسخة xterm.js (محرك الحالة) + عرضاه (شبكي + إسقاط BiDi) +
  // معرّف pty + حالة عرض خاصة. النشط وحده ظاهر. الرأس وسطر الإدخال والتنبيه تعمل على
  // التبويب النشط. الخلفية (term.js) متعددة منذ 15.1. التصميم في docs/PHASE8-DESIGN.md.
  const termPanel = $('termPanel'), termHost = $('termHost'), termExited = $('termExited');
  const tabs = [];       // كل التبويبات الحيّة (بترتيب العرض)
  let active = null;     // التبويب النشط
  let tabSeq = 0;
  const TAB_TITLE_MAX = 40;
  const TAB_TITLE_THROTTLE_MS = 120;
  const TAB_TITLE_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

  function sanitizeTabTitle(value) {
    const clean = String(value || '').replace(TAB_TITLE_CONTROLS, '').trim();
    return Array.from(clean).slice(0, TAB_TITLE_MAX).join('');
  }

  function shellTabName(shell) {
    let executable = String(shell || '').trim().replace(/\\/g, '/').split('/').pop() || '';
    executable = executable.replace(/\s+.*$/, '').replace(/\.(?:exe|cmd|bat)$/i, '');
    const known = { pwsh: 'pwsh', powershell: 'PowerShell', cmd: 'cmd', bash: 'bash' };
    return known[executable.toLowerCase()] || sanitizeTabTitle(executable) || 'طرفية';
  }

  function tabDisplayName(tab) {
    if (tab.isModel) return '🤖 النموذج';
    if (tab.isJob) return '🛠 ' + (tab.jobLabel || 'مهمة خلفية');
    return tab.manualName || tab.oscTitle || shellTabName(tab.shell);
  }

  function updateTabLabel(tab) {
    const name = tabDisplayName(tab);
    if (tab.labelEl) tab.labelEl.textContent = name;
    if (tab.renameButton) tab.renameButton.setAttribute('aria-label', 'إعادة تسمية ' + name);
    if (tab.tabEl) tab.tabEl.setAttribute('aria-label', name);
  }

  function queueTabTitle(tab, value) {
    if (tab.isModel || tab.isJob || tab.manualName) return;
    const title = sanitizeTabTitle(value);
    if (!title) return;
    tab.pendingTitle = title;
    if (tab.titleTimer) return;
    tab.titleTimer = setTimeout(() => {
      tab.titleTimer = 0;
      const next = tab.pendingTitle;
      tab.pendingTitle = '';
      if (!next || tab.isModel || tab.isJob || tab.manualName || next === tab.oscTitle) return;
      tab.oscTitle = next;
      updateTabLabel(tab);
    }, TAB_TITLE_THROTTLE_MS);
  }

  // إنشاء تبويب: نسخة xterm + عرضه (طبقتا شبكة وBiDi) + ربط قنواته. بلا pty بعد.
  function makeTab() {
    const view = document.createElement('div'); view.className = 'term-view';
    const grid = document.createElement('div'); grid.className = 'tv-grid';
    const bidi = document.createElement('div'); bidi.className = 'tv-bidi';
    const spacer = document.createElement('div'); spacer.className = 'tv-spacer';
    bidi.appendChild(spacer); view.appendChild(grid); view.appendChild(bidi);
    termHost.appendChild(view);

    const term = new Terminal({
      fontFamily: "'Cascadia Mono', 'Consolas', monospace",
      fontSize: 13.5, scrollback: 5000,
      theme: { background: '#0d0d0c', foreground: '#eeeeec', cursor: '#D9A441' },
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(grid);

    const tab = {
      tabId: 'tab_' + (++tabSeq), id: null, term, fit, view, grid, bidi, spacer,
      shell: '', exited: false, isModel: false, isJob: false, jobLabel: '', cwd: '',
      bidiEls: new Map(), pinned: true, mode: true, userView: true, cellObj: null,
      manualName: '', oscTitle: '', pendingTitle: '', titleTimer: 0,
      inputMasked: false, inputDraft: '',
      tabEl: null, labelEl: null, renameButton: null, renameInput: null,
    };

    // كل كتابة مُحلَّلة ⇐ مزامنة عرض BiDi للتبويب النشط فقط (الخلفية تحدّث buffer صامتاً)
    term.onWriteParsed(() => { if (tab === active) scheduleBidiSync(); });
    term.onResize(() => { if (tab === active) scheduleBidiSync(); });
    term.onTitleChange((title) => queueTabTitle(tab, title));
    // التبديل التلقائي (8.4): الشاشة البديلة ⇐ شبكي، والعودة تسترجع اختيار المستخدم
    term.buffer.onBufferChange((buf) => {
      setTabView(tab, buf.type === 'alternate' ? false : tab.userView, true);
    });
    // إدخال العارض الشبكي الخام ⇐ pty هذا التبويب
    term.onData((data) => { if (tab.id) window.satr.termInput(tab.id, data); });
    term.onResize(({ cols, rows }) => { if (tab.id) window.satr.termResize(tab.id, cols, rows); });
    // التصاق الذيل لعرض BiDi هذا التبويب
    bidi.addEventListener('scroll', () => {
      if (tab !== active) return;
      tab.pinned = bidi.scrollTop + bidi.clientHeight >= bidi.scrollHeight - LINE_H * 1.5;
      scheduleBidiSync();
    });
    bidi.addEventListener('click', () => { if (!window.getSelection().toString()) $('termInput').focus(); });

    tabs.push(tab);
    return tab;
  }

  // بدء pty لتبويب (يفيت أولاً ليولد بأبعاد صحيحة)
  async function startTabPty(tab) {
    tab.fit.fit();
    const r = await window.satr.termStart($('cwd').value.trim(), tab.term.cols, tab.term.rows);
    if (!r || !r.ok) {
      tab.term.writeln('\x1b[31m' + ((r && r.message) || 'تعذّر بدء الطرفية') + '\x1b[0m');
      return false;
    }
    tab.id = r.id; tab.shell = r.shell || '';
    tab.exited = false;
    renderTabs();
    return true;
  }

  // تفعيل تبويب: إظهاره وإخفاء الباقي، ومزامنة الرأس وسطر الإدخال ووضع العرض
  function activateTab(tab) {
    if (!tab) return;
    if (active) active.inputDraft = $('termInput').value;
    active = tab;
    for (const t of tabs) t.view.classList.toggle('active', t === tab);
    renderTabs();
    $('termShell').textContent = tab.shell;
    $('termDot').classList.toggle('dead', tab.exited);
    $('termInput').value = tab.inputDraft;
    $('termInput').disabled = tab.exited;
    $('termRestart').disabled = tab.isJob;
    $('termRestart2').disabled = tab.isJob;
    applyInputMask(tab);
    termExited.classList.toggle('show', tab.exited);
    applyTabView(tab); // يضبط #termPanel + زر العرض + التركيز + المزامنة
  }

  function closeTab(tab) {
    if (tab.id) window.satr.termKill(tab.id);
    if (tab.titleTimer) clearTimeout(tab.titleTimer);
    try { tab.term.dispose(); } catch (e) {}
    tab.view.remove();
    const idx = tabs.indexOf(tab);
    if (idx >= 0) tabs.splice(idx, 1);
    if (tab === active) {
      if (tabs.length) activateTab(tabs[Math.max(0, idx - 1)]);
      else { active = null; setTermOpen(false); } // آخر تبويب أُغلق ⇒ اطوِ اللوحة
    } else { renderTabs(); }
  }

  async function newTab() {
    if (tabs.filter((tab) => !tab.isJob).length >= 8) { showTermNotice('بلغت الحد الأقصى لطرفيات المستخدم (8) — أغلق واحدة أولاً.'); return; }
    const tab = makeTab();
    activateTab(tab);
    const ok = await startTabPty(tab);
    if (ok) { tab.term.reset(); scheduleBidiSync(); applyTabView(tab); }
  }

  // تبنّي pty أنشأته العملية الرئيسية: طرفية النموذج أو مهمة 🛠 أو استعادة بعد reload.
  function adoptTerm(id, label, opts) {
    const existing = tabs.find((tab) => tab.id === id);
    const options = opts && typeof opts === 'object' ? opts : {};
    if (existing) {
      if (options.open !== false) { setTermOpen(true); activateTab(existing); }
      return existing;
    }
    const tab = makeTab();
    tab.id = id; tab.shell = options.shell || ''; tab.cwd = options.cwd || '';
    tab.isModel = options.isModel === true; tab.isJob = options.isJob === true;
    tab.jobLabel = sanitizeTabTitle(label) || (tab.isJob ? 'مهمة خلفية' : '');
    if (typeof options.buffer === 'string' && options.buffer) {
      tab.term.write(options.buffer);
      scanForLocalUrls(options.buffer);
    }
    renderTabs();
    if (options.open !== false) { setTermOpen(true); activateTab(tab); }
    return tab;
  }

  function adoptModelTerm(id, shell) {
    return adoptTerm(id, 'النموذج', { shell, isModel: true, open: true });
  }

  function activateTerm(id) {
    const tab = tabs.find((item) => item.id === id);
    if (!tab) return false;
    setTermOpen(true);
    activateTab(tab);
    return true;
  }

  function beginTabRename(tab) {
    if (!tab || tab.isModel || tab.isJob || !tab.labelEl || tab.renameInput) return;
    const label = tab.labelEl;
    const input = document.createElement('input');
    input.className = 'term-tab-name-input';
    input.type = 'text';
    input.maxLength = TAB_TITLE_MAX;
    input.value = tabDisplayName(tab);
    input.setAttribute('aria-label', 'اسم تبويب الطرفية');
    tab.renameInput = input;
    label.replaceWith(input);

    let finished = false;
    const finish = (commit) => {
      if (finished) return;
      finished = true;
      const name = sanitizeTabTitle(input.value);
      if (commit && name) tab.manualName = name;
      tab.renameInput = null;
      const replacement = document.createElement('span');
      replacement.className = 'term-tab-label';
      replacement.textContent = tabDisplayName(tab);
      input.replaceWith(replacement);
      tab.labelEl = replacement;
      updateTabLabel(tab);
      if (tab.tabEl) tab.tabEl.focus();
    };
    input.addEventListener('click', (event) => event.stopPropagation());
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') { event.preventDefault(); finish(true); }
      else if (event.key === 'Escape') { event.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    input.focus();
    input.select();
  }

  // رسم شريط التبويبات
  function renderTabs() {
    const bar = $('termTabs');
    bar.textContent = '';
    tabs.forEach((t) => {
      const el = document.createElement('div');
      el.className = 'term-tab' + (t === active ? ' active' : '') + (t.exited ? ' dead' : '');
      el.tabIndex = 0;
      el.setAttribute('role', 'tab');
      el.setAttribute('aria-selected', String(t === active));
      const dot = document.createElement('span'); dot.className = 'tdot'; dot.setAttribute('aria-hidden', 'true');
      const lbl = document.createElement('span'); lbl.className = 'term-tab-label'; lbl.textContent = tabDisplayName(t);
      let rename = null;
      if (!t.isModel && !t.isJob) {
        rename = document.createElement('button'); rename.className = 'trename'; rename.type = 'button'; rename.textContent = '✎'; rename.title = 'إعادة تسمية';
        rename.addEventListener('click', (event) => { event.stopPropagation(); beginTabRename(t); });
      }
      const x = document.createElement('button'); x.className = 'tx'; x.type = 'button'; x.textContent = '✕'; x.title = 'إغلاق';
      x.addEventListener('click', (e) => { e.stopPropagation(); closeTab(t); });
      el.appendChild(dot); el.appendChild(lbl); if (rename) el.appendChild(rename); el.appendChild(x);
      el.addEventListener('click', () => { if (t !== active) activateTab(t); });
      el.addEventListener('keydown', (event) => {
        if (event.target !== el) return;
        if (event.key === 'F2' && !t.isModel && !t.isJob) { event.preventDefault(); beginTabRename(t); }
        else if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          if (t !== active) activateTab(t);
        }
      });
      t.tabEl = el; t.labelEl = lbl; t.renameButton = rename;
      updateTabLabel(t);
      bar.appendChild(el);
    });
    // زر التنظيف يظهر عند تراكم منتهيَين فأكثر — لا يُغلق شيئاً حيّاً ولا تلقائياً
    const dead = tabs.filter((t) => t.exited);
    const cleanup = $('termCloseDead');
    if (cleanup) {
      cleanup.hidden = dead.length < 2;
      cleanup.title = 'إغلاق ' + dead.length + ' تبويباً منتهياً';
    }
  }

  // ملاءمة واعية بالوضع للتبويب النشط (إصلاح فقدان الأسطر عند تغيير الحجم — لقطة قبول):
  // في العربي نغيّر الأعمدة فقط (سحب الارتفاع لا يلمس pty)، والشبكي يحتاج ملاءمة كاملة (TUI).
  function fitTerm() {
    const tab = active;
    if (!tab) return;
    if (tab.mode) {
      const d = tab.fit.proposeDimensions();
      if (d && d.cols && d.cols !== tab.term.cols) tab.term.resize(d.cols, tab.term.rows);
    } else {
      tab.fit.fit();
    }
  }

  async function restartTermSession() {
    const tab = active;
    if (!tab) return;
    if (tab.id) { await window.satr.termKill(tab.id); tab.id = null; }
    tab.exited = false;
    tab.term.reset();
    const ok = await startTabPty(tab);
    if (ok) { activateTab(tab); scheduleBidiSync(); }
  }

  function setTermOpen(open) {
    termPanel.hidden = !open;
    $('termToggle').classList.toggle('active', open);
    if (open) {
      if (!tabs.length) newTab();          // أول فتح: أنشئ تبويباً
      else { fitTerm(); activateTab(active || tabs[0]); }
    }
  }
  $('termToggle').addEventListener('click', () => setTermOpen(termPanel.hidden));
  $('termClose').addEventListener('click', () => setTermOpen(false)); // الطرفيات تبقى حيّة
  $('termNew').addEventListener('click', newTab);
  // إغلاق كل المنتهية دفعةً — closeTab نفسها فيمر كل تبويب بمسار الإغلاق المعتاد
  $('termCloseDead').addEventListener('click', () => {
    for (const t of tabs.filter((tab) => tab.exited)) closeTab(t);
  });
  $('termRestart').addEventListener('click', restartTermSession);
  $('termRestart2').addEventListener('click', restartTermSession);

  // م-1 (الدفعة 5): رصد عناوين خوادم التطوير المحلية في خرج أي طرفية (بما فيها
  // طرفية النموذج 🤖) — يبثّ حدث «localhost-url» فتقترح القشرة «افتح المعاينة».
  // كشف إرشادي: عنوان منقسم بين دفعتي بثّ يفوت (نادر — الخوادم تطبعه سطراً واحداً)،
  // و\x1b يقطع المطابقة كي لا تبتلع محارف ANSI الملوّنة.
  const hostEl = this;
  const LOCAL_URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d{2,5})?(?:\/[^\s"'\x1b]*)?/g;
  const seenLocalUrls = new Set();
  const scanForLocalUrls = (chunk) => {
    if (chunk.indexOf('localhost') === -1 && chunk.indexOf('127.0.0.1') === -1) return;
    for (const m of chunk.match(LOCAL_URL_RE) || []) {
      const url = m.replace(/[).,;]+$/, ''); // قصّ ترقيم ذيلي شائع حول العناوين
      if (seenLocalUrls.has(url) || seenLocalUrls.size > 50) continue;
      seenLocalUrls.add(url);
      hostEl.dispatchEvent(new CustomEvent('localhost-url', { detail: url, bubbles: true }));
    }
  };

  // موجّه أحداث pty: يوزّع بالمعرّف على تبويبه (الخلفية متعددة منذ 15.1)
  window.satr.onTerm((ev) => {
    if (!ev) return;
    const tab = tabs.find((t) => t.id === ev.id);
    if (!tab) return;
    if (ev.type === 'data') { tab.term.write(ev.data); scanForLocalUrls(ev.data); } // يحدّث buffer حتى لو التبويب خلفي
    else if (ev.type === 'exit') {
      tab.exited = true;
      hostEl.dispatchEvent(new CustomEvent('term-exit', { detail: { id: tab.id, isJob: tab.isJob }, bubbles: true }));
      renderTabs();
      if (tab === active) {
        termExited.classList.add('show'); $('termDot').classList.add('dead'); $('termInput').disabled = true;
        $('termInputMask').disabled = true;
      }
    }
  });

  // ملاءمة الأبعاد عند تغيير حجم النافذة واللوحة مفتوحة (واعية بالوضع)
  window.addEventListener('resize', () => {
    if (!termPanel.hidden) fitTerm();
  });

  // سحب مقبض اللوحة لتغيير ارتفاعها — يُحفظ في localStorage ويُسترجع عند الإقلاع
  const savedTermH = parseInt(localStorage.getItem('satr_term_height'), 10);
  if (savedTermH >= 140) termPanel.style.height = savedTermH + 'px';
  (function () {
    const resizer = $('termResizer');
    let startY = 0, startH = 0, raf = 0;
    function onMove(e) {
      // السحب لأعلى يزيد الارتفاع (اللوحة ملتصقة بالأسفل)
      const h = Math.min(Math.max(startH + (startY - e.clientY), 140), Math.round(window.innerHeight * 0.8));
      termPanel.style.height = h + 'px';
      // في العربي: لا يُلمس pty (سحب الارتفاع كان يدمّر scrollback عبر إعادة رسم ConPTY)
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; fitTerm(); scheduleBidiSync(); });
    }
    function onUp() {
      resizer.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      localStorage.setItem('satr_term_height', String(termPanel.offsetHeight));
      fitTerm();
      scheduleBidiSync();
    }
    resizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startY = e.clientY; startH = termPanel.offsetHeight;
      resizer.classList.add('dragging');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  })();

  // ---------- عرض BiDi للمخرجات (المرحلة 8.2) ----------
  // إسقاط HTML «نافذي» للقراءة فقط من Buffer نسخة xterm.js الوحيدة:
  // لا يُرسم إلا ما يظهر في نافذة التمرير (+هامش) — أداء محدود بحجم الشاشة لا بحجم
  // الـ scrollback، وقصّ الأسطر القديمة يتولاه سقف scrollback في xterm نفسه (5000).
  // كل سطر عنصر بـ dir=auto: أول حرف قوي يحدد الاتجاه، والمتصفح يتولى BiDi والتشكيل.
  const LINE_H = 20;      // ارتفاع السطر بالبكسل — ثابت ليصح حساب النافذة والفاصل
  const OVERSCAN = 12;    // أسطر إضافية فوق/تحت النافذة لتمرير سلس
  const DEF_FG = '#eeeeec', DEF_BG = '#0d0d0c';
  let bidiRaf = 0;        // إسقاط BiDi يُزامَن للتبويب النشط فقط (حالته داخل الكائن)

  // لوحة ألوان xterm-256: 0–15 من الثيم، 16–231 مكعب ألوان، 232–255 رماديات
  const PALETTE256 = (() => {
    const p = ['#0d0d0c', '#ec5d5e', '#71d083', '#D9A441', '#6E9ECF', '#B07FB0', '#5FA8A8', '#C9C4B8',
               '#5A6470', '#F08A84', '#9CCB86', '#E8BE6A', '#8FB8E8', '#CFA0CF', '#7FC4C4', '#eeeeec'];
    const lv = [0, 95, 135, 175, 215, 255];
    for (let r = 0; r < 6; r++) for (let g = 0; g < 6; g++) for (let b = 0; b < 6; b++)
      p.push('rgb(' + lv[r] + ',' + lv[g] + ',' + lv[b] + ')');
    for (let i = 0; i < 24; i++) { const v = 8 + i * 10; p.push('rgb(' + v + ',' + v + ',' + v + ')'); }
    return p;
  })();

  function rgbCss(v) { return 'rgb(' + ((v >> 16) & 255) + ',' + ((v >> 8) & 255) + ',' + (v & 255) + ')'; }

  // يستخرج مقاطع السطر مجمعةً بنمط موحّد (لون + سمات) + مفتاح بصمة للتحديث التفريقي.
  // cell كائن خلية معاد استخدامه (يُمرَّر من التبويب) لتقليل التخصيص
  function extractLine(line, cellRef) {
    const segs = [];
    let cur = null, key = '', cellObj = cellRef.c;
    for (let x = 0; x < line.length; x++) {
      cellObj = line.getCell(x, cellObj);
      if (!cellObj) break;
      if (cellObj.getWidth() === 0) continue; // النصف الثاني لحرف عريض (CJK)
      const chars = cellObj.getChars() || ' ';
      let fg = null, bg = null;
      if (cellObj.isFgPalette()) fg = PALETTE256[cellObj.getFgColor()] || null;
      else if (cellObj.isFgRGB()) fg = rgbCss(cellObj.getFgColor());
      if (cellObj.isBgPalette()) bg = PALETTE256[cellObj.getBgColor()] || null;
      else if (cellObj.isBgRGB()) bg = rgbCss(cellObj.getBgColor());
      if (cellObj.isInverse()) { const f = fg || DEF_FG; fg = bg || DEF_BG; bg = f; }
      const style = (fg || '') + '|' + (bg || '') + '|' +
        (cellObj.isBold() ? 'b' : '') + (cellObj.isDim() ? 'd' : '') +
        (cellObj.isItalic() ? 'i' : '') + (cellObj.isUnderline() ? 'u' : '') +
        (cellObj.isInvisible() ? 'h' : '');
      if (!cur || cur.style !== style) {
        cur = { style, fg, bg, flags: style.split('|')[2], text: '' };
        segs.push(cur);
      }
      cur.text += chars;
    }
    // قصّ الفراغ الذيلي عديم النمط (الفراغ الملوّن الخلفية يبقى — قد يكون مقصوداً)
    while (segs.length) {
      const last = segs[segs.length - 1];
      if (last.bg) break;
      last.text = last.text.replace(/ +$/, '');
      if (last.text) break;
      segs.pop();
    }
    for (const s of segs) key += s.style + '\u0001' + s.text + '\u0002';
    cellRef.c = cellObj;
    return { key, segs };
  }

  // يعيد بناء عنصر السطر من مقاطعه (يُستدعى فقط عند تغيّر البصمة)
  function buildBidiLine(el, segs) {
    el.textContent = '';
    for (const s of segs) {
      if (!s.style.replace(/\|/g, '')) { el.appendChild(document.createTextNode(s.text)); continue; }
      const span = document.createElement('span');
      span.textContent = s.text;
      if (s.fg) span.style.color = s.fg;
      if (s.bg) span.style.backgroundColor = s.bg;
      const f = s.flags || '';
      if (f.includes('b')) span.style.fontWeight = '600';
      if (f.includes('d')) span.style.opacity = '0.55';
      if (f.includes('i')) span.style.fontStyle = 'italic';
      if (f.includes('u')) span.style.textDecoration = 'underline';
      if (f.includes('h')) span.style.visibility = 'hidden';
      el.appendChild(span);
    }
  }

  // مزامنة عرض BiDi للتبويب النشط: تُرسم الأسطر الظاهرة فقط، والبصمة تمنع إعادة بناء
  // ما لم يتغير. كل حالة الإسقاط (bidiEls/pinned/cellObj) داخل كائن التبويب.
  function bidiSync() {
    bidiRaf = 0;
    const tab = active;
    if (!tab || !tab.mode || termPanel.hidden) return;
    const buf = tab.term.buffer.active;
    const spacer = tab.spacer, host = tab.bidi, bidiEls = tab.bidiEls;
    // قصّ الذيل الفارغ: صفوف نافذة xterm الخالية أسفل المؤشر لا تُحتسب — الالتصاق
    // بالذيل يضع سطر الموجّه أسفل اللوحة بلا مساحة ميتة (لقطة قبول: تكبير اللوحة)
    const cursorAbs = buf.baseY + buf.cursorY;
    let lastIdx = buf.length - 1;
    while (lastIdx > cursorAbs) {
      const l = buf.getLine(lastIdx);
      if (l && l.translateToString(true) !== '') break;
      lastIdx--;
    }
    const total = lastIdx + 1;
    spacer.style.height = (total * LINE_H) + 'px';
    if (tab.pinned) host.scrollTop = host.scrollHeight; // ملتصق بالذيل
    const first = Math.max(0, Math.floor(host.scrollTop / LINE_H) - OVERSCAN);
    const last = Math.min(total - 1, Math.ceil((host.scrollTop + host.clientHeight) / LINE_H) + OVERSCAN);
    for (const [i, rec] of bidiEls) {
      if (i < first || i > last) { rec.el.remove(); bidiEls.delete(i); }
    }
    if (!tab.cellRef) tab.cellRef = { c: null };
    for (let i = first; i <= last; i++) {
      let rec = bidiEls.get(i);
      if (!rec) {
        const el = document.createElement('div');
        el.className = 'bidi-line';
        el.dir = 'auto'; // سطر عربي يُحلّ RTL ويبدأ يميناً، ولاتيني LTR يساراً
        el.style.top = (i * LINE_H) + 'px';
        spacer.appendChild(el);
        rec = { el, key: null };
        bidiEls.set(i, rec);
      }
      const line = buf.getLine(i);
      if (!line) continue;
      // إخفاء سقالة أداة run_in_terminal من عرض النموذج (المرحلة 16.2): أي سطر يحوي
      // علامة الالتقاط __SATR_ (السطر المُغلّف وسطرا البداية/النهاية) يُعرض فارغاً —
      // فيرى المستخدم الخرج النظيف فقط. أمر مستخدم حقيقي لا يحوي هذه العلامة.
      if (line.translateToString(true).indexOf('__SATR_') >= 0) {
        if (rec.key !== 'satr') { rec.key = 'satr'; rec.el.textContent = ''; }
        continue;
      }
      const r = extractLine(line, tab.cellRef);
      if (r.key !== rec.key) { rec.key = r.key; buildBidiLine(rec.el, r.segs); }
    }
  }

  function scheduleBidiSync() {
    if (!bidiRaf) bidiRaf = requestAnimationFrame(bidiSync);
  }

  // تطبيق وضع العرض للتبويب على واجهة اللوحة المشتركة (يُستدعى عند التفعيل والتبديل)
  function applyTabView(tab) {
    termPanel.classList.toggle('mode-bidi', tab.mode);
    termPanel.classList.toggle('mode-grid', !tab.mode);
    $('termView').textContent = tab.mode ? 'العرض: عربي' : 'العرض: شبكي';
    if (tab.mode) {
      tab.pinned = tab.pinned !== false;
      // أعد بناء إسقاط التبويب من الصفر (قد يكون تبويباً بُدّل إليه للتوّ)
      for (const [, rec] of tab.bidiEls) rec.el.remove();
      tab.bidiEls.clear();
      scheduleBidiSync();
      hideTermNotice();
      if (!termPanel.hidden) $('termInput').focus();
    } else {
      tab.fit.fit(); // الشبكي: ملاءمة كاملة (TUI تحتاج شبكة مطابقة)
      if (!termPanel.hidden) tab.term.focus();
    }
  }

  // تبديل عرض تبويب (المرحلة 8.4): userView اختيار المستخدم، التبديل التلقائي لا يمسّه
  function setTabView(tab, bidi, auto) {
    if (!auto) tab.userView = bidi;
    tab.mode = bidi;
    if (tab === active) applyTabView(tab);
  }
  // اختصار: تبديل عرض التبويب النشط (يستعمله الزر والتنبيه والإدخال)
  function setTermView(bidi, auto) { if (active) setTabView(active, bidi, auto); }
  $('termView').addEventListener('click', () => { if (active) setTermView(!active.mode); });

  // شريط تنبيه التبديل التلقائي (لأوامر تعكس العربية بنفسها مثل claude التفاعلي)
  function showTermNotice(text) {
    $('termNoticeText').textContent = text;
    $('termNotice').classList.add('show');
  }
  function hideTermNotice() { $('termNotice').classList.remove('show'); }
  $('termNoticeBack').addEventListener('click', () => setTermView(true));
  $('termNoticeClose').addEventListener('click', hideTermNotice);

  // تطبيقات معروفة تُخرج العربية بترتيب بصري معكوس (ترقيع للطرفيات LTR الغبية) —
  // تظهر معكوسة في عرض BiDi الحقيقي (انعكاس مزدوج، انظر وثيقة التصميم)، وترسم في
  // الشاشة العادية فلا يلتقطها onBufferChange ⇐ نبدّل عند إطلاقها من سطر الإدخال
  const VISUAL_ORDER_APPS = new Set(['claude']);

  // ---------- سطر الإدخال (المرحلة 8.3) ----------
  // الحقل «عابر»: يُفرَّغ عند الإرسال، وصدى الصدفة هو النسخة المعروضة الوحيدة —
  // لا ازدواج بالبناء (قرار الصدى المثبّت في وثيقة التصميم §8.2). زر العين يغيّر عرض
  // الحقل محلياً لكل تبويب فقط؛ لا يكتشف echo ولا يحوّل line-mode إلى إدخال تفاعلي.
  // عقد المفاتيح §8.3:
  const termInputEl = $('termInput');
  const termInputMaskEl = $('termInputMask');

  // اتجاه حقل الإدخال: rtl وهو فارغ (فيُعرض placeholder العربي بترتيبه الصحيح)،
  // و auto عند وجود قيمة (فيحسم الأمر اللاتيني اتجاهه بنفسه كما كان). ‏dir="auto"
  // على حقل فارغ يحسم LTR فينقلب ترتيب الأزواج العربية/اللاتينية في placeholder.
  function syncInputDir() {
    termInputEl.dir = termInputEl.value ? 'auto' : 'rtl';
  }

  function applyInputMask(tab) {
    const masked = !!(tab && tab.inputMasked);
    termInputEl.type = masked ? 'password' : 'text';
    termInputMaskEl.disabled = !tab || tab.exited;
    termInputMaskEl.classList.toggle('active', masked);
    termInputMaskEl.setAttribute('aria-pressed', String(masked));
    termInputMaskEl.setAttribute('aria-label', masked ? 'إظهار إدخال الطرفية' : 'إخفاء إدخال الطرفية');
    termInputMaskEl.title = masked ? 'إظهار الإدخال' : 'إخفاء الإدخال بصرياً فقط';
    syncInputDir(); // يُنادى من activateTab بعد استعادة مسودة التبويب
  }

  termInputEl.addEventListener('input', syncInputDir);

  termInputMaskEl.addEventListener('click', () => {
    if (!active || active.exited) return;
    active.inputMasked = !active.inputMasked;
    applyInputMask(active);
    termInputEl.focus();
  });

  function ptySend(data) {
    if (active && active.id) window.satr.termInput(active.id, data);
    if (active) active.pinned = true; // أي إرسال يعيد الالتصاق بذيل الخرج
    scheduleBidiSync();
  }

  termInputEl.addEventListener('keydown', (e) => {
    if (!active || !active.id) return;
    // Ctrl+C يقطع دائماً (والحقل غير فارغ: يفرّغه أيضاً) — Ctrl+Z وCtrl+D تمريران خامان
    if (e.ctrlKey && !e.shiftKey && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 'c') { e.preventDefault(); termInputEl.value = ''; syncInputDir(); ptySend('\x03'); return; }
      if (k === 'z') { e.preventDefault(); ptySend('\x1a'); return; }
      if (k === 'd') { e.preventDefault(); ptySend('\x04'); return; }
      return; // بقية اختصارات Ctrl (نسخ/لصق…) تبقى للمتصفح
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = termInputEl.value;
      termInputEl.value = '';
      syncInputDir();
      ptySend(v + '\r'); // حقل فارغ ⇐ \r خام («اضغط أي مفتاح» ومحثّات كثيرة)
      // أمر معروف بعكس العربية بصرياً ⇐ تبديل تلقائي للعارض الشبكي مع تنبيه (8.4)
      const cmd = v.trim().split(/\s+/)[0].toLowerCase();
      if (active.mode && VISUAL_ORDER_APPS.has(cmd)) {
        setTermView(false, true);
        showTermNotice('بُدّل للعرض الشبكي: «' + cmd + '» يرسم العربية بنفسه فيظهر معكوساً في العرض العربي.');
      }
      return;
    }
    // أسهم التاريخ: تمرَّر للصدفة فقط والحقل فارغ (غير ذلك: تحرير محلي بمؤشر المتصفح)
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && termInputEl.value === '') {
      e.preventDefault();
      ptySend(e.key === 'ArrowUp' ? '\x1b[A' : '\x1b[B');
      return;
    }
    // إكمال Tab مستحيل بالبناء في وضع الأسطر (الصدفة لم ترَ البادئة) — حدّ موثّق
    if (e.key === 'Tab') { e.preventDefault(); return; }
  });

  // لصق متعدد الأسطر: يُمرَّر خاماً للـ pty فوراً (الصدفة تنفّذ أسطره كما لو طُبعت) —
  // اللصق العادي أحادي السطر يدخل الحقل محلياً كالمعتاد
  termInputEl.addEventListener('paste', (e) => {
    const text = e.clipboardData ? e.clipboardData.getData('text') : '';
    if (text && /\r|\n/.test(text) && active && active.id) {
      e.preventDefault();
      ptySend(text.replace(/\r?\n/g, '\r'));
    }
  });


    // الواجهة العامة للقشرة (حدث model_term من مجرى satr:event)
    this.adoptTerm = adoptTerm;
    this.adoptModelTerm = adoptModelTerm;
    this.activateTerm = activateTerm;
    this.setTermOpen = setTermOpen;
  }
}

customElements.define('satr-terminal-panel', SatrTerminalPanel);
