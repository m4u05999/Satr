import { formatPermissionDetail } from './lib/permission-detail.js';
import { createUpdateToast } from './lib/update-toast.js';

// قشرة الإقلاع والتوجيه (Orchestration) — وحدة ES منذ التنظيف النهائي ت-13
// (كانت IIFE كلاسيكية طوال التفكيك — قرار ت-0 لتفادي مفاجآت strict mode).
// نطاق الوحدة معزول وstrict أصلاً فلا لفّ ولا 'use strict'. تعمل قبل وحدات
// المكوّنات (ترتيب الوسوم في index.html) وتتفاعل معها بالأحداث وmethods عامة.
// ما تملكه: حالة التطبيق (sessionId/busy/currentBlock/cwd/engine) + مجرى أحداث
// satr:event + send/compact + قائمة المحرك والنماذج + الاستئناف + التصدير + التحديث.
{
  const $ = (id) => document.getElementById(id);
  const input = $('input'), sendBtn = $('send');

  // ---------- الوضع الفاتح/الداكن (دفعة «وضع فاتح») ----------
  // يُطبَّق مبكراً (أول المنطق) لتقليل ومضة الثيمة. الاختيار في localStorage
  // (satr_theme=light|dark)؛ وإن غاب يتبع تفضيل النظام (prefers-color-scheme) كافتراضي.
  // الزر اليدوي يغلب النظام ويُحفظ. الثيمة على <html> فتعبر حدود Shadow بالوراثة.
  function applyTheme(theme) {
    const light = theme === 'light';
    document.documentElement.dataset.theme = light ? 'light' : 'dark';
    const btn = $('themeToggle');
    if (btn) { btn.textContent = light ? '☀️' : '🌙'; btn.title = light ? 'التبديل للوضع الداكن' : 'التبديل للوضع الفاتح'; }
  }
  (function initTheme() {
    let saved = localStorage.getItem('satr_theme');
    if (saved !== 'light' && saved !== 'dark') {
      // لا اختيار محفوظ: الافتراضي الوضع الداكن دائماً (قرار المالك — لا يتبع تفضيل النظام)
      saved = 'dark';
    }
    applyTheme(saved);
    const btn = $('themeToggle');
    if (btn) btn.addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
      localStorage.setItem('satr_theme', next);
      applyTheme(next);
    });
  })();
  let sessionId = null, busy = false, currentBlock = null;
  let sessionCwd = null;     // المجلد الذي وُلدت فيه الجلسة الحالية (جلسات Claude Code مرتبطة بمجلدها)
  let lastSentPrompt = '';   // آخر طلب أُرسل — يُستعاد للمحرّر عند فشل استئناف جلسة ميتة
  let lastUserTurn = { prompt: '', images: [] }; // مصدر زر إعادة المحاولة (نص + صور كما أُرسلت)
  let gated = true; // محجوب حتى يؤكّد فحص أول التشغيل توفّر Claude Code (مانع إطلاق)

  // ---------- إعدادات محفوظة ----------
  ['cwd', 'model', 'perm', 'engine', 'effort'].forEach((id) => {
    const el = $(id);
    const saved = localStorage.getItem('satr_' + id);
    if (saved !== null) el.value = saved;
    el.addEventListener('change', () => localStorage.setItem('satr_' + id, el.value));
  });
  const EFFORT_CYCLE = ['low', 'medium', 'high', 'xhigh', 'max', ''];
  const PERMISSION_CYCLE = ['default', 'acceptEdits', 'plan', 'auto'];
  const PERMISSION_LABELS = {
    default: 'افتراضي', acceptEdits: 'قبول التعديلات', plan: 'تخطيط فقط', auto: 'تلقائي ذكي',
    bypassPermissions: 'تجاوز كل الأذونات',
  };
  function selectedValueLabel(select) {
    return select.value || 'default';
  }
  function syncAwareness() {
    const model = $('awarenessModel'), effort = $('awarenessEffort'), permission = $('awarenessPerm');
    if (model) model.textContent = 'model: ' + selectedValueLabel($('model'));
    if (effort) effort.textContent = 'effort: ' + ($('effort').value || 'default');
    if (permission) {
      const mode = $('perm').value || 'default';
      permission.textContent = 'الأذونات: ' + (PERMISSION_LABELS[mode] || mode);
      permission.classList.toggle('mode-warning', mode === 'acceptEdits' || mode === 'auto');
      permission.classList.toggle('mode-plan', mode === 'plan');
    }
  }
  function cycleSelect(select, values) {
    const index = values.indexOf(select.value);
    select.value = values[(index + 1 + values.length) % values.length];
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }
  $('awarenessModel').addEventListener('click', () => {
    const select = $('model');
    select.focus();
    if (typeof select.showPicker === 'function') {
      try { select.showPicker(); } catch (error) { select.click(); }
    } else select.click();
  });
  $('awarenessEffort').addEventListener('click', () => cycleSelect($('effort'), EFFORT_CYCLE));
  $('awarenessPerm').addEventListener('click', () => cycleSelect($('perm'), PERMISSION_CYCLE));
  $('awarenessContext').addEventListener('click', () => openContext());
  $('effort').addEventListener('change', syncAwareness);
  $('perm').addEventListener('change', syncAwareness);
  syncAwareness();
  // خيار منخفض اللمس في ⚙: مهارات المستخدم تبقى ظاهرة افتراضياً، ويخفيها المستخدم
  // من قائمة «/» فقط عند الحاجة. البناء بـ DOM آمن كي لا نزيد ترميز topbar الثابت.
  (function initUserSkillsVisibility() {
    const field = document.createElement('div');
    field.className = 'field';
    const label = document.createElement('label');
    label.htmlFor = 'hideUserSkills';
    label.textContent = 'إخفاء مهارات المستخدم من قائمة /';
    const checkbox = document.createElement('input');
    checkbox.id = 'hideUserSkills';
    checkbox.type = 'checkbox';
    try { checkbox.checked = localStorage.getItem('satr_hide_user_skills') === '1'; } catch (e) {}
    checkbox.addEventListener('change', () => {
      try { localStorage.setItem('satr_hide_user_skills', checkbox.checked ? '1' : '0'); } catch (e) {}
      customElements.whenDefined('satr-composer').then(() => {
        const composer = document.querySelector('satr-composer');
        if (composer && composer.setHideUserSkills) composer.setHideUserSkills(checkbox.checked);
      });
    });
    field.appendChild(label);
    field.appendChild(checkbox);
    const effort = $('effort').closest('.field');
    effort.insertAdjacentElement('afterend', field);
  })();
  // الموجة 4: تنبيه أمني عند تفعيل «تلقائي ذكي» (auto). محتوى الويب غير الموثوق قد يحقن
  // أوامر؛ فالأدوات القرائية تُوافَق تلقائياً لكن التنفيذ/الكتابة تبقى خلف مربع الإذن العربي.
  $('perm').addEventListener('change', () => {
    if ($('perm').value !== 'auto') return;
    const b = $('banner');
    b.className = 'warn';
    b.textContent = '⚠️ وضع «تلقائي ذكي»: يُوافَق على القراءة تلقائياً، والتنفيذ والكتابة تبقى تسألك. احذر محتوى الويب غير الموثوق (حقن أوامر). محرك SDK فقط.';
    setTimeout(() => { b.style.display = 'none'; }, 12000);
  });

  // ---------- بوابة أول التشغيل: انتقلت لمكوّن <satr-gate> (تفكيك ت-8) ----------
  // المكوّن يفحص ويرسم ويعيد الفحص ذاتياً (يبدأ عند اتصاله)؛ عند الجهوز يخفي نفسه
  // ويُصدر «gate-ready {version}» — القشرة ترفع حجب الإرسال وتعرض شريط النجاح
  // (banner عنصر مشترك ملكها). المستمع يُربط قبل ترقية المكوّن فلا سباق.
  document.querySelector('satr-gate').addEventListener('gate-ready', (e) => {
    gated = false;
    const b = $('banner'); const d = e.detail || {};
    if (d.outdated) {
      // الموجة 3: إصدار Claude Code أقدم من الموصى به — إرشاد غير حاجب (لا تحديث تلقائي؛
      // «سطر» يعتمد المثبّت العالمي عمداً). يبقى ظاهراً أطول ليلحظه المستخدم.
      b.className = 'note';
      b.textContent = '⚠️ Claude Code ' + (d.version || '') + ' — للنماذج الأحدث (Sonnet 5 فأعلى) حدّث: npm i -g @anthropic-ai/claude-code';
      setTimeout(() => { b.style.display = 'none'; }, 12000);
    } else {
      b.className = 'ok'; b.textContent = '✓ Claude Code جاهز — ' + (d.version || '');
      setTimeout(() => { b.style.display = 'none'; }, 4000);
    }
  });

  // بناء قائمة «المحرك» ديناميكياً من طبقة المزوّد (satr:providers): sdk (خاص) + المحوّلات.
  // §5-د-2: النماذج تتبع المحرك المختار (لكل مزوّد نماذجه). فشل الجلب ⇒ خيارات ثابتة احتياطية.
  const CLAUDE_MODELS = [
    { value: '', label: 'الافتراضي' }, { value: 'claude-fable-5', label: 'Fable 5' },
    { value: 'opus', label: 'Opus' }, { value: 'sonnet', label: 'Sonnet' }, { value: 'haiku', label: 'Haiku' },
  ];
  // نماذج Codex الحديثة (المرحلة 1): تُدرَج يدوياً لأن model/list في Codex قديم ولا
  // يُظهر 5.6 (خلل موثّق openai/codex#31873) لكنها تعمل بتمرير -m صراحةً. مؤكَّدة حيّاً
  // على اشتراك ChatGPT Plus بعد تحديث الـ CLI. لا نماذج قديمة (قرار المالك).
  const CODEX_MODELS = [
    { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol (الأقوى)' },
    { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra (متوازن)' },
    { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna (الأسرع)' },
    { value: 'gpt-5.5', label: 'GPT-5.5' },
  ];
  let providersCache = [];
  // محوّل «أعمى» (1.3): غير sdk/codex وليس من عائلة claude — له ذاكرة على القرص تُستأنف.
  // sdk وcodex محرّكان أصيلان (أذونات حية) فليسا أعميين. فشل جلب المزوّدين ⇒ احتياطي بالاسم.
  function isBlindEngine(e) {
    if (e === 'sdk' || e === 'codex') return false;
    const p = providersCache.find((x) => x.name === e);
    return p ? p.family !== 'claude' : (e !== 'cli');
  }
  // مجموعة مخزن الجلسات: يُصفَّر sessionId عند تغيّرها لأن المُعرّف لا يصلح عبر المخازن.
  // sdk وcli يتشاركان ~/.claude (نفس المجموعة)؛ codex مستقل (~/.codex)؛ وكل محوّل أعمى
  // مستقل (~/.satr/chats/<provider>). التبديل داخل المجموعة يُبقي الجلسة، وبينها يبدأ نظيفاً.
  function sessionGroup(e) {
    if (e === 'sdk' || e === 'cli') return 'claude';
    return e || '';
  }
  // استئناف آخر جلسة للمحوّل — المؤشر على **القرص** مع ملفات الذاكرة (satr:lastChat)
  // لا في localStorage (ثبت بالاختبار أنه قد لا يُكتب للقرص فيضيع المؤشر)
  async function restoreAdapterSession() {
    const e = $('engine').value;
    if (!isBlindEngine(e)) return;
    let sid = null;
    try { const r = await window.satr.lastChat(e); sid = (r && r.sid) || null; } catch (err) {}
    if (sid && !sessionId) {
      sessionId = sid;
      $('sessionInfo').textContent = 'جلسة: ' + sid.slice(0, 8) + ' (مستأنفة)';
      loadTaskLedger(e, sid);
      loadCheckpoint(e, sid);
    }
  }
  function modelsForEngine(engine) {
    if (engine === 'sdk') return CLAUDE_MODELS; // محرك SDK الخاص (خارج السجلّ)
    if (engine === 'codex') return CODEX_MODELS; // محرك Codex الأصيل (خارج السجلّ)
    const p = providersCache.find((x) => x.name === engine);
    return (p && p.models && p.models.length) ? p.models : [{ value: '', label: 'الافتراضي' }];
  }
  function rebuildModels() {
    const engine = $('engine').value, mSel = $('model');
    const saved = localStorage.getItem('satr_model_' + engine) || '';
    mSel.innerHTML = '';
    for (const m of modelsForEngine(engine)) {
      const o = document.createElement('option'); o.value = m.value; o.textContent = m.label; mSel.appendChild(o);
    }
    if ([...mSel.options].some((o) => o.value === saved)) mSel.value = saved;
    syncAwareness();
  }
  async function loadProviders() {
    const sel = $('engine');
    let list = [];
    try { const r = await window.satr.providers(); if (r && Array.isArray(r.providers)) list = r.providers; } catch (e) {}
    if (list.length) {
      providersCache = list;
      const saved = localStorage.getItem('satr_engine') || sel.value || 'sdk';
      sel.innerHTML = '';
      const add = (v, l) => { const o = document.createElement('option'); o.value = v; o.textContent = l; sel.appendChild(o); };
      add('sdk', 'SDK — بث وأذونات حية'); // محرك SDK الخاص (ليس محوّلاً في السجلّ)
      add('codex', 'Codex — OpenAI (بث وأذونات)'); // محرك Codex الأصيل (خاص ثانٍ)
      for (const p of list) add(p.name, p.label || p.name);
      if ([...sel.options].some((o) => o.value === saved)) sel.value = saved;
    }
    rebuildModels();
    applyEngineCommands($('engine').value); // أوامر «/» للمحرك المستعاد (المرحلة 4)
    if ($('engine').value === 'codex') checkCodexReady(); // إرشاد إن كان Codex المستعاد غير جاهز
    restoreAdapterSession(); // 1.3: استئناف محادثة المحوّل بعد إعادة التشغيل
    lastEngine = $('engine').value;
  }
  let lastEngine = null; // لتمييز مغادرة محوّل أعمى عند التبديل
  $('engine').addEventListener('change', async () => {
    const e = $('engine').value;
    localStorage.setItem('satr_engine', e);
    rebuildModels();
    applyEngineCommands(e); // إخفاء أوامر Claude-الخاصة مع Codex (المرحلة 4)
    if (e === 'codex') checkCodexReady(); // إرشاد إن لم يكن Codex جاهزاً
    // تصفير الجلسة عند تغيّر مخزن الجلسات: المُعرّف لا يصلح عبر المخازن (مُعرّف Claude في
    // Codex ⇒ thread/resume يفشل ويبدأ خيطاً جديداً؛ ومُعرّف Codex في Claude ⇒ «No
    // conversation found»). sdk↔cli يتشاركان ~/.claude فلا يُصفَّران. المحوّل الأعمى
    // يستأنف آخر جلسته من القرص؛ Codex وsdk يبدآن نظيفَين (يُستأنفان من /جلسات — قرار مطابقة).
    if (sessionGroup(e) !== sessionGroup(lastEngine)) {
      sessionId = null;
      if (isBlindEngine(e)) await restoreAdapterSession(); // لا أثر لغير الأعمى (يعود مبكراً)
      $('sessionInfo').textContent = sessionId
        ? ('جلسة: ' + sessionId.slice(0, 8) + ' (مستأنفة)')
        : 'لا جلسة';
      if (!sessionId) chatEl.clearTaskLedger();
      if (!sessionId) chatEl.clearCheckpoint();
    }
    lastEngine = e;
  });
  $('model').addEventListener('change', () => {
    localStorage.setItem('satr_model_' + $('engine').value, $('model').value);
    syncAwareness();
  });
  loadProviders();

  // ---------- مدير المفاتيح + زر اختيار المجلد: انتقلا لمكوّن <satr-topbar> (تفكيك ت-11) ----------
  const topbarEl = document.querySelector('satr-topbar');
  const sessionChanges = new Map();
  function sessionChangesPayload() {
    return [...sessionChanges.entries()].map(([rel, change]) => ({ rel, ...change }));
  }
  function renderSessionChanges() {
    if (topbarEl.setSessionChanges) topbarEl.setSessionChanges(sessionChangesPayload());
  }
  function resetSessionChanges() {
    sessionChanges.clear();
    renderSessionChanges();
  }
  function recordSessionChange(event) {
    if (!event || !event.rel) return;
    const previous = sessionChanges.get(event.rel);
    const added = (previous ? previous.added : 0) + (Number(event.added) || 0);
    const removed = (previous ? previous.removed : 0) + (Number(event.removed) || 0);
    const isNew = previous ? previous.isNew : event.isNew === true;
    const lastId = event.id || (previous && previous.lastId) || '';
    sessionChanges.set(event.rel, {
      added, removed, isNew, lastId,
      card: { ...event, id: lastId, added, removed, isNew },
    });
    renderSessionChanges();
  }
  customElements.whenDefined('satr-topbar').then(renderSessionChanges);
  topbarEl.addEventListener('session-diff-open', (event) => {
    if (event.detail) chatEl.addStandaloneDiff(event.detail);
  });

  // ---------- لصق الصور وزر الإرفاق: انتقلا لمكوّن <satr-composer> (تفكيك ت-10) ----------
  // المكوّن يملك pendingImages والمصغّرات؛ القشرة تقرأ getImages() عند الإرسال
  // وتصفّر بـ clearImages() (إرسال/جلسة جديدة/استئناف محادثة محوّل).

  // ---------- خيط المحادثة: انتقل لمكوّن <satr-chat> (تفكيك ت-12) ----------
  // المكوّن (light DOM — بلا Shadow، قرار الخطة §2/3) يملك: الماركداون المدمج، أزرار
  // النسخ، الالتصاق الذكي (⬇ الأحدث)، بطاقات المستخدم/المساعد/الفرق/الوكلاء/الضغط،
  // إشعار اكتمال الدور، وعدّاد الكلفة (#costInfo). وهو من يستورد buildDiff مباشرة —
  // سقط آخر مستهلك لجسر window.SatrUI هنا (أُزيل الجسر كلياً في ت-13).
  // **يبقى في القشرة عمداً**: مجرى أحداث satr:event (orchestration يلمس sessionId/
  // busy/currentBlock — يستدعي methods كتلة newAssistantBlock بعقدها الحرفي)،
  // deadSessionRecovery (تلمس حالة القشرة والمحرّر)، وengineLabel (تقرأ providersCache).
  const chatEl = document.querySelector('satr-chat');
  const memoryEl = document.querySelector('satr-memory-panel');
  const researchEl = document.querySelector('satr-research-panel');
  const opsRoomEl = document.querySelector('satr-ops-room');
  const opsDialogEl = document.querySelector('satr-ops-dialog');
  const verifyConfigEl = document.querySelector('satr-verify-config-dialog');
  const previewEl = document.querySelector('satr-preview-panel');
  function addNotice(text) { chatEl.addNotice(text); }

  // منسّق الأسطح الواحد: لوحة رئيسية واحدة، سجل active/held/hidden، واستعادة تركيز
  // وقياس المعاينة الأصلية من موضعها الفعلي بعد كل انتقال.
  const surfaceCoordinator = (() => {
    const registry = new Map();
    let activePanel = '';
    let activeDialog = '';
    let dialogEpoch = 0;
    let layoutRemeasureTimer = 0;

    const midRow = document.getElementById('midRow');
    const layoutProperties = new Set(['width', 'min-width', 'max-width', 'flex-basis']);
    function previewSurface() { return previewEl; }
    function remeasurePreview() {
      const preview = previewSurface();
      if (preview && preview.remeasure) preview.remeasure();
    }
    function layoutSettleDelay() {
      const raw = getComputedStyle(document.documentElement).getPropertyValue('--dur').trim();
      const value = parseFloat(raw);
      const duration = Number.isFinite(value) ? value * (raw.endsWith('ms') ? 1 : 1000) : 180;
      return Math.max(32, Math.ceil(duration) + 32);
    }
    function remeasurePreviewAfterLayout() {
      clearTimeout(layoutRemeasureTimer);
      layoutRemeasureTimer = setTimeout(remeasurePreview, layoutSettleDelay());
    }
    midRow.addEventListener('transitionend', (event) => {
      if (!layoutProperties.has(event.propertyName)) return;
      clearTimeout(layoutRemeasureTimer);
      remeasurePreview();
    }, true);
    function register(name, element, category) {
      if (!element) return;
      const record = { name, element, category, state: 'hidden', source: null, restore: true };
      registry.set(name, record);
      if (category === 'panel') {
        new MutationObserver(() => {
          const open = element.hasAttribute('open');
          if (open) { record.state = activeDialog ? 'held' : 'active'; activePanel = name; return; }
          const shouldRestore = record.state !== 'hidden' && record.restore;
          record.state = 'hidden';
          if (activePanel === name) activePanel = '';
          if (shouldRestore && record.source && record.source.isConnected && record.source.focus) {
            requestAnimationFrame(() => {
              if (record.source && record.source.isConnected && record.source.focus) record.source.focus();
            });
          }
          record.restore = true; remeasurePreviewAfterLayout();
        }).observe(element, { attributes: true, attributeFilter: ['open'] });
      }
    }
    function closeRecord(record, restore) {
      if (!record || !record.element.hasAttribute('open')) return;
      record.restore = restore !== false;
      if (record.element.close) record.element.close(); else record.element.removeAttribute('open');
    }
    function openPanel(name, source, opener) {
      const target = registry.get(name);
      if (!target || target.category !== 'panel') return;
      const alreadyOpen = target.element.hasAttribute('open');
      for (const record of registry.values()) {
        if (record.category === 'panel' && record !== target) closeRecord(record, false);
      }
      if (!alreadyOpen) target.source = source && source.focus ? source : document.activeElement;
      target.restore = true; target.state = activeDialog ? 'held' : 'active'; activePanel = name;
      opener(target.element);
      remeasurePreviewAfterLayout();
      requestAnimationFrame(() => {
        if (target.element.focusInitial) target.element.focusInitial();
      });
    }
    function closeActivePanel() {
      if (activeDialog || !activePanel) return false;
      const record = registry.get(activePanel); closeRecord(record, true); return !!record;
    }
    function closePanel(name, restore) {
      const record = registry.get(name);
      if (!record || record.category !== 'panel') return false;
      closeRecord(record, restore); return true;
    }
    function setDialog(name, visible, source) {
      if (visible) {
        dialogEpoch++;
        activeDialog = name;
        const preview = previewSurface();
        if (preview && preview.holdForDialog) preview.holdForDialog(true);
        for (const record of registry.values()) if (record.state === 'active') record.state = 'held';
        const dialog = registry.get(name);
        if (dialog) { dialog.state = 'active'; dialog.source = source && source.focus ? source : document.activeElement; }
        return;
      }
      const dialog = registry.get(name);
      const focusTarget = dialog && dialog.source;
      const closedEpoch = ++dialogEpoch;
      if (dialog) dialog.state = 'hidden';
      activeDialog = '';
      for (const record of registry.values()) if (record.state === 'held') record.state = 'active';
      const preview = previewSurface();
      if (preview && preview.holdForDialog) preview.holdForDialog(false);
      requestAnimationFrame(() => {
        remeasurePreview();
        if (closedEpoch === dialogEpoch && !activeDialog
          && focusTarget && focusTarget.isConnected && focusTarget.focus) focusTarget.focus();
      });
    }
    async function confirm(options) {
      setDialog('ops-dialog', true, options && options.source);
      try { return await opsDialogEl.openDialog(options); }
      finally { setDialog('ops-dialog', false); }
    }
    function snapshot() {
      return [...registry.values()].map((record) => ({
        name: record.name, category: record.category, state: record.state,
      }));
    }
    return { register, openPanel, closePanel, closeActivePanel, setDialog, confirm, snapshot };
  })();

  for (const [name, selector] of [
    ['sessions', 'satr-sessions-panel'], ['files', 'satr-files-panel'], ['git', 'satr-git-panel'],
    ['skills', 'satr-skills-panel'], ['agents', 'satr-agents-panel'], ['mcp', 'satr-mcp-panel'],
    ['context', 'satr-context-panel'], ['memory', 'satr-memory-panel'], ['research', 'satr-research-panel'],
    ['ops-room', 'satr-ops-room'],
  ]) surfaceCoordinator.register(name, document.querySelector(selector), 'panel');
  surfaceCoordinator.register('ops-dialog', opsDialogEl, 'dialog');
  surfaceCoordinator.register('permission-dialog', document.querySelector('satr-perm-dialog'), 'dialog');
  surfaceCoordinator.register('question-dialog', document.querySelector('satr-question-dialog'), 'dialog');
  surfaceCoordinator.register('verify-config-dialog', verifyConfigEl, 'dialog');

  // تحت العتبة الواسعة يبقى سطح جانبي واحد فقط؛ 120rem تبقي للدردشة عرضاً عملياً.
  const MULTI_SURFACE_MEDIA = '(min-width: 120rem)';
  const multiSurfaceQuery = window.matchMedia(MULTI_SURFACE_MEDIA);
  const chatColumnEl = document.getElementById('chatColumn');
  let drawerModalActive = false;
  function syncOpsDrawerModal() {
    const active = opsRoomEl.hasAttribute('open') && opsRoomEl.hasAttribute('drawer');
    if (active === drawerModalActive) return;
    drawerModalActive = active;
    chatColumnEl.inert = active;
    if (previewEl.holdForDrawer) previewEl.holdForDrawer(active);
  }
  function enforceSingleSideSurface(opening) {
    if (multiSurfaceQuery.matches || !opsRoomEl.hasAttribute('open') || !previewEl.hasAttribute('open')) return;
    if (opening === 'ops-room' && opsRoomEl.hasAttribute('drawer')) return;
    if (opening === 'preview') surfaceCoordinator.closePanel('ops-room', false);
    else if (previewEl.close) previewEl.close();
  }
  new MutationObserver(() => {
    syncOpsDrawerModal();
    if (opsRoomEl.hasAttribute('open')) enforceSingleSideSurface('ops-room');
  }).observe(opsRoomEl, { attributes: true, attributeFilter: ['open', 'drawer'] });
  new MutationObserver(() => {
    if (previewEl.hasAttribute('open')) enforceSingleSideSurface('preview');
  }).observe(previewEl, { attributes: true, attributeFilter: ['open'] });
  multiSurfaceQuery.addEventListener('change', (event) => {
    if (!event.matches) enforceSingleSideSurface('ops-room');
  });

  async function loadTaskLedger(engine, sid) {
    if (!engine || !sid) { chatEl.clearTaskLedger(); return; }
    try {
      const ledger = await window.satr.taskLedger(engine, sid);
      if (ledger && ledger.session_id === sid) chatEl.showTaskLedger(ledger);
      else chatEl.clearTaskLedger();
    } catch (e) { /* أفضل جهد: فشل ledger لا يمنع استئناف المحادثة */ }
  }

  async function loadCheckpoint(engine, sid) {
    if (!engine || !sid) { chatEl.clearCheckpoint(); return; }
    try {
      const checkpoint = await window.satr.checkpointLatest(engine, sid);
      if (checkpoint && checkpoint.session_id === sid) chatEl.showCheckpoint(checkpoint);
      else chatEl.clearCheckpoint();
    } catch (e) { /* metadata checkpoint أفضل جهد ولا تمنع استئناف المحادثة */ }
  }

  chatEl.addEventListener('task-action', async (event) => {
    const detail = event.detail || {};
    if (detail.action === 'pause' && busy) {
      if (currentBlock && !currentBlock.done) { currentBlock.stopped(); currentBlock.showRetry(); }
      await window.satr.stop();
      endRun();
    }
    try {
      const ledger = await window.satr.taskAction(detail.engine, detail.sessionId, detail.action);
      if (!ledger) { addNotice('تعذّر تغيير حالة سجل المهام'); return; }
      chatEl.showTaskLedger(ledger);
      addNotice(detail.action === 'pause'
        ? '⏸ أُوقفت الخطة والدور الجاري — حالتها محفوظة'
        : '▶ استؤنفت الخطة — أرسل طلباً للمتابعة');
    } catch (e) { addNotice('تعذّر تغيير حالة سجل المهام'); }
  });

  chatEl.addEventListener('checkpoint-verify', async (event) => {
    const detail = event.detail || {};
    if (busy) { addNotice('أوقف الدور الجاري قبل تشغيل تحقق checkpoint سابق'); return; }
    try {
      const result = await window.satr.verifyCheckpoint(
        detail.engine, detail.sessionId, detail.checkpointId, $('cwd').value.trim(), []);
      if (!result || !result.ok) {
        if (result && result.error === 'denied') addNotice('أُلغي تشغيل التحقق');
        else if (result && result.error === 'notfound') addNotice('لا يوجد ملف .satr/verify.json في المشروع');
        else addNotice('تعذّر تشغيل التحقق: ' + ((result && result.error) || 'خطأ غير معروف'));
      }
    } catch (e) { addNotice('تعذّر تشغيل التحقق'); }
  });

  chatEl.addEventListener('checkpoint-restore', async (event) => {
    const detail = event.detail || {};
    if (busy) { addNotice('أوقف الدور الجاري قبل استعادة checkpoint'); return; }
    if (!confirm('استعادة هذا checkpoint ستعكس تعديلات الدور بالترتيب العكسي. هل تريد المتابعة؟')) return;
    try {
      const result = await window.satr.checkpointRestore(
        detail.engine, detail.sessionId, detail.checkpointId, $('cwd').value.trim());
      if (result && result.checkpoint) chatEl.showCheckpoint(result.checkpoint);
      if (result && result.ok) addNotice('✓ استُعيد checkpoint بنجاح (' + result.restored.length + ' تعديلات)');
      else addNotice('⚠ تعذّرت الاستعادة الكاملة: ' + ((result && result.error) || 'خطأ غير معروف'));
    } catch (e) { addNotice('⚠ تعذّرت استعادة checkpoint'); }
  });

  // اسم المحرك المعروض في رأس الرد — يتبع المحرك المختار (لا يُنسب DeepSeek لـ Claude)
  function engineLabel() {
    const e = $('engine').value;
    if (e === 'sdk') return 'Claude Code';
    if (e === 'cli') return 'Claude Code (CLI)';
    if (e === 'codex') return 'Codex';
    const p = providersCache.find((x) => x.name === e);
    return (p && p.label) ? p.label : (e || 'النموذج');
  }

  // كتلة رد المساعد صارت داخل مكوّن <satr-chat> (ت-12) — نفس العقد الحرفي؛
  // القشرة تحتفظ بالمقبض في currentBlock وتستدعي methods منه في مجرى الأحداث.

  // تعافٍ من جلسة ميتة: Claude Code لم يعد يجد المحادثة (حُذفت، أو عُلّق معرّفها
  // بمجلد آخر قبل إصلاح الوقاية) — نصفّر الجلسة ونعيد الطلب للمحرّر بدل التكرار للأبد
  function deadSessionRecovery(text) {
    if (!/No conversation found with session ID/i.test(String(text || ''))) return false;
    sessionId = null;
    sessionCwd = null;
    $('sessionInfo').textContent = 'لا جلسة';
    if (lastSentPrompt && !input.value.trim()) input.value = lastSentPrompt;
    addNotice('⚠ الجلسة السابقة لم تعد محفوظة لدى Claude Code — بدأت جلسة جديدة وأعدت طلبك إلى المحرّر: اضغط إرسال');
    return true;
  }

  function isClaudeAuthError(text) {
    return /Failed to authenticate|OAuth session expired|could not be refreshed/i.test(String(text || ''));
  }

  function claudeAuthErrorMessage() {
    return 'انتهت جلسة Claude Code وتعذّر تجديدها. شغّل `claude auth login` في الطرفية، أكمل تسجيل الدخول، ثم أعد تشغيل الطلب.';
  }

  // ---------- التحديث التلقائي (المرحلة 17 + موافقة صريحة 2026-07-12) ----------
  // إشعار لا يقاطع بموافقة في كل خطوة: «متوفّر» ⇐ زرّ «نزّل الآن» ⇐ تقدّم ⇐ «جاهز»
  // ⇐ زرّ «أعد التشغيل الآن». لا تنزيل ولا تثبيت تلقائيان (المستخدم يملك كل خطوة).
  const { showTransientNotice, handleUpdateEvent } = createUpdateToast({
    toast: $('updateToast'),
    text: $('updateText'),
    download: $('updateDownload'),
    restart: $('updateRestart'),
    dismiss: $('updateDismiss'),
  }, window.satr);

  // إشعار اكتمال الدور: انتقل لمكوّن <satr-chat> (ت-12) — chatEl.notifyTurnDone(isError)

  // ---------- استقبال أحداث Claude من العملية الرئيسية ----------
  window.satr.onEvent((ev) => {
    // طلبات الأذونات تُعالج دائماً ولو كانت الكتلة منتهية
    if (ev.type === 'permission_request') {
      permEl.request({
        id: ev.id, tool: ev.tool, detail: ev.detail || permDetailText(ev.tool, ev.input),
        requester: ev.requester || '', turnEligible: ev.turnEligible === true,
        alwaysEligible: ev.alwaysEligible !== false, alwaysLabel: ev.alwaysLabel || '',
      });
      return;
    }
    if (ev.type === 'preview_recording_saved') {
      addNotice('🎥 حُفظ تسجيل المعاينة في: ' + ev.path);
      return;
    }
    if (ev.type === 'preview_recording_failed') {
      addNotice('تعذّر حفظ تسجيل المعاينة' + (ev.filename ? ': ' + ev.filename : ''));
      return;
    }
    // أسئلة الاختيار (AskUserQuestion) — تُعالج دائماً أيضاً (تنتظر رد المستخدم أثناء الدور)
    if (ev.type === 'question_request') {
      questionEl.ask({ id: ev.id, questions: ev.questions });
      return;
    }
    // التسليم البشري (browser_handoff): الوكيل سلّم قيادة المعاينة — شريط 🤝 في اللوحة
    // ينتظر «استلمت»/«إلغاء». handoff_end يخفيه (يغطي أيضاً حسم إيقاف الدور من المحرك).
    if (ev.type === 'handoff_request' && ev.id) {
      if (previewEl.showHandoff) previewEl.showHandoff(ev.id, ev.reason, ev.mode);
      return;
    }
    if (ev.type === 'handoff_end') {
      if (previewEl.hideHandoff) previewEl.hideHandoff();
      return;
    }
    if (ev.type === 'testsprite_progress') {
      const completed = Number.isInteger(ev.completed) && ev.completed >= 0 ? ev.completed : 0;
      const total = Number.isInteger(ev.total) && ev.total >= 0 ? ev.total : 0;
      const counts = `نجح ${Number(ev.passed) || 0} · فشل ${Number(ev.failed) || 0} · تخطّى ${Number(ev.skipped) || 0}`;
      if (ev.phase === 'preparing') {
        showTransientNotice('🧪 يجري تجهيز TestSprite والتحقق من الخطة…');
      } else if (ev.phase === 'complete') {
        addNotice(`🧪 اكتمل TestSprite من ملف النتائج: ${completed}/${total} — ${counts}`);
      } else {
        showTransientNotice(`🧪 TestSprite: اكتملت ${completed}/${total} — ${counts}`);
      }
      return;
    }
    // عمليات الخلفية مستقلة عن الدور: تصل حتى بعد انتهاء التشغيل، فتُعالَج قبل حارس الكتلة
    if (ev.type === 'bg_procs') {
      if (composerEl.setBgProcs) composerEl.setBgProcs(ev.procs);
      return;
    }
    // طرفية النموذج (16.2): أداة run_in_terminal أنشأت pty — نتبنّاه كتبويب مرئي.
    // مستقل عن الدور (قد يصل قبل currentBlock) فيُعالَج قبل حارس الكتلة.
    if (ev.type === 'model_term' && ev.id) {
      const t = document.querySelector('satr-terminal-panel');
      if (t && t.adoptModelTerm) t.adoptModelTerm(ev.id, ev.shell);
      return;
    }
    if (ev.type === 'bg_term' && ev.id) {
      const terminal = document.querySelector('satr-terminal-panel');
      if (terminal && terminal.adoptTerm) {
        terminal.adoptTerm(ev.id, ev.label, { shell: ev.shell, cwd: ev.cwd, isJob: true, open: true });
      }
      if (composerEl.upsertTermJob) composerEl.upsertTermJob({ ...ev, startedAt: Date.now() });
      if (previewEl.refreshServerStatus) previewEl.refreshServerStatus();
      return;
    }
    // أداة open_preview (م-1-ب): النموذج طلب عرض عنوان في المعاينة المدمجة —
    // اللوحة تفتح وتبلّغ مستطيلها فيُنشأ العرض الأصلي (العنوان تحقق منه agent.js)
    if (ev.type === 'preview_open' && ev.url) {
      if (previewEl.openWith) previewEl.openWith(ev.url, { agent: true });
      return;
    }
    // التحديث التلقائي (17): مستقل عن الدور — إشعار لطيف أسفل النافذة
    if (ev.type === 'update') {
      handleUpdateEvent(ev);
      return;
    }
    if (ev.type === 'task_update') {
      chatEl.showTaskLedger(ev);
      return;
    }
    if (ev.type === 'checkpoint_update') {
      chatEl.showCheckpoint(ev);
      return;
    }
    if (ev.type === 'verification_result') {
      chatEl.showVerification(ev);
      return;
    }
    if (ev.type === 'memory_candidate' && ev.candidate) {
      surfaceCoordinator.openPanel('memory', document.activeElement,
        () => memoryEl.open($('cwd').value.trim(), ev.candidate));
      addNotice('🧠 اقترح النموذج ذاكرة جديدة — لن تُحفظ حتى توافق من اللوحة.');
      return;
    }
    if (ev.type === 'memory_rejected') {
      addNotice('🔒 رُفض اقتراح ذاكرة لأنه قد يحتوي سراً أو قيمة غير آمنة؛ لم يُحفظ ولم يُعرض.');
      return;
    }
    if (ev.type === 'research_update') {
      researchEl.handleEvent(ev);
      return;
    }
    if (ev.type === 'execution_team_update') {
      opsRoomEl.handleEvent(ev);
      return;
    }
    if (ev.type === 'execution_review_update') {
      opsRoomEl.handleEvent(ev);
      return;
    }
    if (ev.type === 'execution_verification_update') {
      opsRoomEl.handleEvent(ev);
      return;
    }
    if (ev.type === 'ops_brainstorm_update' || ev.type === 'ops_plan_update') {
      opsRoomEl.handleEvent(ev);
      return;
    }
    if (ev.type === 'ops_room_update') {
      opsRoomEl.handleEvent(ev);
      if (chatEl.showOpsEvent) chatEl.showOpsEvent(ev.entry);
      return;
    }
    if (ev.type === 'system' && ev.subtype === 'commands_changed') {
      // حدث كتالوج مستقل عن عمر كتلة الرد: يستبدل الكاش حتى لو وصل بين دورين.
      if (composerEl.commandsChanged) composerEl.commandsChanged(ev.commands);
      return;
    }
    const block = currentBlock;
    if (!block || block.done) return;
    if (ev.type === 'stream_text') {
      if (ev.text) block.addDelta(ev.text, ev.phase);
      return;
    }
    if (ev.type === 'system' && ev.subtype === 'compact_boundary') {
      block.compacted(ev.compact_metadata);
    } else if (ev.type === 'system' && ev.session_id) {
      sessionId = ev.session_id;
      $('sessionInfo').textContent = 'جلسة: ' + sessionId.slice(0, 8);
      // 1.3: مؤشر الاستئناف يكتبه المحوّل نفسه على القرص (chats.save) — لا حفظ هنا
    } else if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
      // parent_tool_use_id (المرحلة 14.2): رسائل الوكيل الفرعي تتوجه لبطاقة وكيلها
      for (const c of ev.message.content) {
        if (c.type === 'text' && c.text && c.text.trim()) block.addText(c.text, ev.parent_tool_use_id, c.phase || ev.phase);
        else if (c.type === 'tool_use') {
          block.addTool(c.id, c.name, c.input, ev.parent_tool_use_id);
          // مؤشّر «الوكيل يقود المتصفح» (الخيار 2): يتجاهل ما ليس أداة متصفح داخل المكوّن
          if (previewEl.flashAgentActivity) previewEl.flashAgentActivity(c.name);
        }
      }
    } else if (ev.type === 'user' && ev.message && Array.isArray(ev.message.content)) {
      for (const c of ev.message.content) {
        if (c.type === 'tool_result') block.toolDone(c.tool_use_id, !!c.is_error);
      }
    } else if (ev.type === 'file_edit') {
      block.addDiff(ev);
      recordSessionChange(ev);
      previewDirty = true; // م-1-ج: عُدّل ملف في هذا الدور ⇒ المعاينة تحتاج تحديثاً عند انتهائه
    } else if (ev.type === 'result') {
      if (ev.session_id) {
        sessionId = ev.session_id;
        $('sessionInfo').textContent = 'جلسة: ' + sessionId.slice(0, 8);
      }
      if (ev.is_error && ev.result) {
        if (deadSessionRecovery(ev.result)) block.error('تعذّر استئناف الجلسة السابقة — بدأت جلسة جديدة، أعد الإرسال.');
        else if (isClaudeAuthError(ev.result)) block.error(claudeAuthErrorMessage());
        else block.error(String(ev.result));
      }
      block.finish(ev);
      if (ev.is_error) block.showRetry();
      refreshAwarenessContext();
      // م-1-ج: تحديث المعاينة تلقائياً بعد دور عدّل ملفات (المكوّن يقرّر فعلياً حسب وضعه)
      if (previewDirty) { previewDirty = false; if (previewEl.reloadIfLive) previewEl.reloadIfLive(); }
      chatEl.notifyTurnDone(!!ev.is_error);
    } else if (ev.type === 'spawn_error') {
      if (deadSessionRecovery(ev.text)) block.error('تعذّر استئناف الجلسة السابقة — بدأت جلسة جديدة، أعد الإرسال.');
      else if (isClaudeAuthError(ev.text)) block.error(claudeAuthErrorMessage());
      else {
        const eng = $('engine').value;
        const name = eng === 'codex' ? 'Codex' : 'claude';
        block.error('فشل تشغيل أمر ' + name + ' — تأكد أنه مثبت ومسجّل دخوله.\n' + (ev.text || ''));
      }
      block.showRetry();
      endRun();
    } else if (ev.type === 'proc_done') {
      block.finish(null);
      endRun();
    }
  });

  // ---------- شريط عمليات الخلفية: انتقل لمكوّن <satr-composer> (تفكيك ت-10) ----------
  // المكوّن يملك العرض والقتل والاسترجاع عند الإقلاع؛ حدث bg_procs يصله عبر setBgProcs.

  function endRun() {
    if (currentBlock) currentBlock.done = true;
    busy = false;
    sendBtn.textContent = 'إرسال';
    sendBtn.classList.remove('stop');
    closePermDialog();
    closeQuestionDialog();
    // شريط التسليم البشري لا يعيش بعد الدور (المحرك فكّ الانتظار بالإلغاء عند الإيقاف)
    if (previewEl && previewEl.hideHandoff) previewEl.hideHandoff();
    if (previewEl && previewEl.hideSecretRequest) previewEl.hideSecretRequest();
    input.focus();
  }

  // ---------- مربع الأذونات: انتقل لمكوّن <satr-perm-dialog> (تفكيك ت-8) ----------
  // المكوّن يملك الطابور والعرض والرد (satr.permission مباشرة + حدث notice للخيط)؛
  // نص التفاصيل تحضّره القشرة هنا — toolDetail صارت method عامة على مكوّن المحادثة
  // (ت-12: بطاقات الأدوات تستهلكها داخله) والأذونات لا تصل إلا أثناء دور جارٍ
  // فالمكوّن مُرقّى حتماً لحظة الاستدعاء.
  const permEl = document.querySelector('satr-perm-dialog');
  permEl.addEventListener('notice', (e) => addNotice(e.detail));
  // إصلاح احتجاب المربع خلف المعاينة (لقطة مالك): تنزوي المعاينة أثناء ظهوره ثم تعود
  permEl.addEventListener('perm-visible', (e) => {
    surfaceCoordinator.setDialog('permission-dialog', !!e.detail);
  });
  function permDetailText(tool, inp) {
    const browserDetail = formatPermissionDetail(tool, inp);
    if (browserDetail) return browserDetail;
    const d = chatEl.toolDetail(inp);
    if (d) return d;
    try { return JSON.stringify(inp || {}, null, 1).slice(0, 1000); } catch { return ''; }
  }
  function closePermDialog() { if (permEl.closeAll) permEl.closeAll(); }

  // ---------- أسئلة الاختيار العربية: مكوّن <satr-question-dialog> (AskUserQuestion، SDK) ----------
  // المكوّن يملك العرض والرد بمؤشرات (satr.answerQuestion مباشرة + حدث notice للخيط).
  const questionEl = document.querySelector('satr-question-dialog');
  questionEl.addEventListener('notice', (e) => addNotice(e.detail));
  questionEl.addEventListener('perm-visible', (e) => {
    surfaceCoordinator.setDialog('question-dialog', !!e.detail);
  });
  function closeQuestionDialog() { if (questionEl.closeAll) questionEl.closeAll(); }

  // ---------- وضع تحكّم المتصفح (نمط Comet) ----------
  // زرّ بجوار الإرسال يمنح الوكيل صلاحية قيادة المعاينة (يوافق تلقائياً على أفعال المتصفح
  // الثماني فقط — لا الطرفية ولا الملفّات). معطّل افتراضياً، حالته ظاهرة، تُحفظ محلياً.
  let browserControlOn = false;
  let paintBrowserControl = () => {};
  // مصدر واحد لتغيير الحالة (زرّ + إطفاء تلقائي عند جلسة جديدة). notify=إشعار في المحادثة.
  function setBrowserControl(on, notify) {
    const was = browserControlOn;
    browserControlOn = !!on;
    try { localStorage.setItem('satr_browser_control', browserControlOn ? '1' : '0'); } catch (e) {}
    paintBrowserControl();
    if (notify && was !== browserControlOn && chatEl.addActionNotice) {
      chatEl.addActionNotice(browserControlOn
        ? '🖱️ وضع تحكّم المتصفح مفعّل — الأفعال العادية على النطاقات الموثوقة تلقائية، والحفظ والنشر والإرسال والأفعال الحسّاسة تُسأل كل مرة.'
        : 'أُوقف وضع تحكّم المتصفح — عاد الإذن اليدوي لكل فعل متصفح.');
    }
  }
  (function initBrowserControl() {
    const btn = $('browserCtl');
    if (!btn) return;
    try { browserControlOn = localStorage.getItem('satr_browser_control') === '1'; } catch (e) {}
    paintBrowserControl = () => {
      btn.classList.toggle('active', browserControlOn);
      btn.setAttribute('aria-pressed', browserControlOn ? 'true' : 'false');
      // مؤشّر دائم أوضح: نقطة حالة إلى جانب التسمية حين يكون الوضع مفعّلاً
      btn.textContent = browserControlOn ? '🖱️ متصفح ●' : '🖱️ متصفح';
    };
    paintBrowserControl();
    btn.addEventListener('click', () => setBrowserControl(!browserControlOn, true));
  })();

  // ---------- الإرسال ----------
  async function send() {
    if (gated) return; // المحادثة محجوبة حتى تجتاز بوابة أول التشغيل
    if (busy) {
      if (currentBlock && !currentBlock.done) { currentBlock.stopped(); currentBlock.showRetry(); }
      await window.satr.stop();
      endRun();
      return;
    }
    const prompt = input.value.trim();
    const engine = $('engine').value;
    let images = composerEl.getImages ? composerEl.getImages() : [];
    // الصور مدعومة في المحرّكين الأصيلين (SDK وCodex) — نماذج Codex تقبل الصور.
    // المحوّلات العمياء (REST) لا تدعمها: ننبّه ونتجاهلها.
    if (engine !== 'sdk' && engine !== 'codex' && images.length) {
      addNotice('الصور مدعومة في محرّكي SDK وCodex فقط — لم تُرسَل الصور المرفقة');
      images = [];
    }
    if (!prompt && !images.length) return;
    // وقاية: جلسات Claude Code مرتبطة بمجلدها — تغيير مجلد المشروع مع جلسة حيّة
    // يجعل --resume يفشل بـ «No conversation found» (لقطة قبول). مجلد جديد ⇐ جلسة جديدة.
    const cwdNow = $('cwd').value.trim();
    if (sessionId && sessionCwd && cwdNow !== sessionCwd) {
      sessionId = null;
      $('sessionInfo').textContent = 'لا جلسة';
      addNotice('📁 تغيّر مجلد المشروع — بدأت جلسة جديدة (جلسات Claude Code مرتبطة بمجلدها)');
    }
    sessionCwd = cwdNow;
    lastSentPrompt = prompt;
    lastUserTurn = { prompt, images: images.map((image) => image.dataUrl) };
    input.value = '';
    if (composerEl.afterSend) composerEl.afterSend(); // تمدد + مسودة + إغلاق القائمتين
    if (composerEl.clearImages) composerEl.clearImages();
    chatEl.addUserMsg(prompt, images.map((i) => i.dataUrl));

    busy = true;
    previewDirty = false; // م-1-ج: بداية دور جديد — لا تعديل بعد
    sendBtn.textContent = 'إيقاف';
    sendBtn.classList.add('stop');
    currentBlock = chatEl.newAssistantBlock(engineLabel());

    const skillsSel = await computeSkillsPayload();

    const r = await window.satr.send({
      prompt,
      cwd: $('cwd').value.trim(),
      sessionId,
      model: $('model').value,
      permissionMode: $('perm').value,
      engine,
      skills: skillsSel,
      effort: $('effort').value,
      extraDirs: topbarEl.getExtraDirs ? topbarEl.getExtraDirs() : [],
      images: images.map((i) => ({ media_type: i.media_type, data: i.data })),
      browserControl: browserControlOn, // تفويض صريح لأدوات المتصفح في محركي SDK وCodex
    });
    if (r && r.error) {
      currentBlock.error(r.message || r.error);
      currentBlock.showRetry();
      endRun();
      return;
    }
    // 1.1 — شفافية حقن @الملفات للمحوّلات: ماذا أُرفق فعلاً وماذا تُخطّي ولماذا.
    // التنبيه يُدرج **قبل** بطاقة الرد (فوق الرد بجانب رسالة المستخدم) لا في ذيل المحادثة
    const noticeBeforeReply = (text) =>
      chatEl.addNoticeBefore(text, currentBlock && currentBlock.el);
    if (r && Array.isArray(r.injectedFiles) && r.injectedFiles.length) {
      const parts = r.injectedFiles.map((f) => f.rel + (f.truncated ? ' (قُصّ)' : ''));
      noticeBeforeReply('📎 أُرفق للنموذج: ' + parts.join('، '));
    }
    if (r && Array.isArray(r.skippedFiles) && r.skippedFiles.length) {
      const why = { outside: 'خارج مجلد المشروع', binary: 'ملف ثنائي', total: 'تجاوز السقف الإجمالي', error: 'تعذّرت قراءته' };
      const parts = r.skippedFiles.map((f) => f.rel + ' (' + (why[f.reason] || f.reason) + ')');
      noticeBeforeReply('⚠️ لم يُرفق: ' + parts.join('، '));
    }
  }

  // ---------- ضغط المحادثة (/ضغط) ----------
  // يرسل /compact عبر محرك SDK كدور عادي؛ النموذج يلخّص ويُصدر compact_boundary
  // ثم result، والجلسة تبقى نفسها فتكمل المحادثة. (محرك SDK فقط — يلخّص فعلياً.)
  async function compactConversation() {
    if (busy) { addNotice('انتظر انتهاء الطلب الجاري قبل ضغط المحادثة'); return; }
    if (!sessionId) { addNotice('لا توجد محادثة لضغطها بعد — ابدأ بإرسال رسالة أولاً'); return; }
    const cwd = $('cwd').value.trim();
    addNotice('⏳ جارٍ ضغط المحادثة…');
    busy = true;
    sendBtn.textContent = 'إيقاف';
    sendBtn.classList.add('stop');
    currentBlock = chatEl.newAssistantBlock(engineLabel());
    const skillsSel = await computeSkillsPayload();
    const r = await window.satr.send({
      prompt: '/compact',
      cwd,
      sessionId,
      model: $('model').value,
      permissionMode: $('perm').value,
      engine: 'sdk', // الضغط مدعوم في محرك SDK فقط
      skills: skillsSel,
      images: [],
    });
    if (r && r.error) { currentBlock.error(r.message || r.error); endRun(); }
  }

  // ---------- قائمة الأوامر / ----------
  const COMMANDS = [
    { cmd: '/جديدة',   en: '/new',    desc: 'بدء جلسة جديدة (مسح المحادثة الحالية)', run: () => newSession() },
    { cmd: '/جلسات',   en: '/sessions', desc: 'تصفح الجلسات المحفوظة واستئنافها',     run: () => openSessions() },
    { cmd: '/ذاكرة',   en: '/memory', desc: 'مراجعة ذاكرة المشروع الشخصية والبحث والتعديل والحذف', run: () => openMemory() },
    { cmd: '/بحث',     en: '/research', desc: 'تشغيل 1–3 باحثين للقراءة فقط وإعادة خلاصة ومصادر', sdkOnly: true, run: () => openResearch() },
    { cmd: '/غرفة-العمليات', en: '/ops-room', desc: 'تنفيذ معزول ومراجعة وتحقق ودمج صريح', sdkOnly: true, run: () => openOpsRoom() },
    { cmd: '/مهارات',  en: '/skills', desc: 'عرض المهارات المكتشفة واختيار المُفعَّل منها', sdkOnly: true, run: () => openSkills() },
    { cmd: '/وكلاء',   en: '/agents', desc: 'عرض الوكلاء الفرعيين المكتشفين (المشروع والمستخدم)', sdkOnly: true, run: () => openAgents() },
    { cmd: '/موصلات',  en: '/mcp',     desc: 'حالة موصّلات MCP وإعادة الاتصال والتفعيل', sdkOnly: true, run: () => openMcp() },
    { cmd: '/سياق',    en: '/context', desc: 'عرض امتلاء نافذة السياق وتوزيع الرموز',    sdkOnly: true, run: () => openContext() },
    { cmd: '/ضغط',     en: '/compact', desc: 'ضغط المحادثة (تلخيصها) لتوفير السياق',     sdkOnly: true, run: () => compactConversation() },
    { cmd: '/فيبل',    en: '/fable',  desc: 'التبديل إلى نموذج Fable 5',            sdkOnly: true, run: () => setModel('claude-fable-5', 'Fable 5') },
    { cmd: '/أوبس',    en: '/opus',   desc: 'التبديل إلى نموذج Opus',               sdkOnly: true, run: () => setModel('opus', 'Opus') },
    { cmd: '/سونيت',   en: '/sonnet', desc: 'التبديل إلى نموذج Sonnet',             sdkOnly: true, run: () => setModel('sonnet', 'Sonnet') },
    { cmd: '/هايكو',   en: '/haiku',  desc: 'التبديل إلى نموذج Haiku',              sdkOnly: true, run: () => setModel('haiku', 'Haiku') },
    { cmd: '/تخطيط',   en: '/plan',   desc: 'وضع التخطيط فقط — تحليل بدون تنفيذ',     run: () => setPerm('plan', 'وضع التخطيط') },
    { cmd: '/تنفيذ',   en: '/edit',   desc: 'قبول التعديلات تلقائياً',                run: () => setPerm('acceptEdits', 'قبول التعديلات تلقائياً') },
    { cmd: '/مجلد',    en: '/folder', desc: 'اختيار مجلد المشروع',                   run: () => $('pickFolder').click() },
    { cmd: '/كودكس-حالة', en: '/codex-status', desc: 'عرض حالة تثبيت Codex وتسجيل الدخول', run: () => showCodexStatus() },
  ];

  // قائمة أوامر «/» حسب المحرك: أوامر Claude-الخاصة (sdkOnly) تُخفى مع Codex (المرحلة 4)
  // لأنها تنادي دوال تحكّم Claude SDK (موصلات/سياق/مهارات/وكلاء/ضغط) أو نماذج Claude.
  function applyEngineCommands(engine) {
    const el = document.querySelector('satr-composer');
    if (!el) return;
    const list = engine === 'codex' ? COMMANDS.filter((c) => !c.sdkOnly) : COMMANDS;
    customElements.whenDefined('satr-composer').then(() => { if (el.setCommands) el.setCommands(list); });
  }
  // إرشاد مضمّن حين يُختار Codex وهو غير جاهز (لا يحجب الإطلاق — Claude بوابة الإطلاق).
  async function checkCodexReady() {
    let s = null;
    try { s = await window.satr.codexStatus(); } catch (e) { return; }
    if (!s) return;
    if (!s.installed) {
      addNotice('⚠️ Codex غير مثبَّت. ثبّته بالأمر:  npm install -g @openai/codex  ثم أعد المحاولة.');
    } else if (!s.auth || !s.auth.ok) {
      addNotice('⚠️ Codex غير مسجَّل الدخول. نفّذ في الطرفية:  codex login  (اشتراك ChatGPT) ثم أعد المحاولة.');
    }
  }

  async function showCodexStatus() {
    let status = null;
    try { status = await window.satr.codexStatus(); } catch (e) {
      addNotice('✗ تعذّر التحقق من حالة Codex');
      return;
    }
    if (!status || !status.installed) {
      addNotice('⚠️ Codex غير مثبَّت، وغير مسجَّل الدخول.');
    } else if (!status.auth || !status.auth.ok) {
      addNotice('⚠️ Codex مثبَّت، لكنه غير مسجَّل الدخول.');
    } else if (status.auth.method === 'chatgpt') {
      addNotice('✓ Codex مثبَّت ومسجَّل الدخول عبر اشتراك ChatGPT.');
    } else if (status.auth.method === 'apikey') {
      addNotice('✓ Codex مثبَّت ومسجَّل الدخول عبر مفتاح API.');
    } else {
      addNotice('⚠️ Codex مثبَّت ومسجَّل الدخول بطريقة غير معروفة.');
    }
  }

  function setModel(v, label) {
    $('model').value = v;
    $('model').dispatchEvent(new Event('change', { bubbles: true }));
    addNotice('✓ تم اختيار نموذج ' + label);
  }
  function setPerm(v, label) {
    $('perm').value = v;
    $('perm').dispatchEvent(new Event('change', { bubbles: true }));
    addNotice('✓ ' + label);
  }
  function newSession() {
    // 1.3: «جلسة جديدة» على محوّل أعمى تنسى مؤشر الاستئناف على القرص (سجلّه يبقى للتنظيف)
    const engNow = $('engine').value;
    if (isBlindEngine(engNow)) { try { window.satr.forgetChat(engNow); } catch (e) {} }
    sessionId = null; currentBlock = null; lastUserTurn = { prompt: '', images: [] };
    if (composerEl.clearImages) composerEl.clearImages();
    $('sessionInfo').textContent = 'لا جلسة';
    chatEl.reset(); // حالة الفراغ + تصفير الكلفة التراكمية وشريطها (داخل المكوّن منذ ت-12)
    resetSessionChanges();
    if (previewEl.resetTaskTrace) previewEl.resetTaskTrace();
    // إطفاء تلقائي لوضع تحكّم المتصفح: لا نحمل صلاحية قيادة تلقائية لمهمة جديدة صامتاً
    if (browserControlOn) { setBrowserControl(false, false); addNotice('🖱️ أُوقف وضع تحكّم المتصفح تلقائياً مع الجلسة الجديدة.'); }
  }
  $('newSession').addEventListener('click', newSession);

  // ---------- لوحة الجلسات: انتقلت إلى مكوّن <satr-sessions-panel> (تفكيك ت-4) ----------
  // المكوّن يملك الجلب والدمج والبحث والعرض؛ الاستئناف (حالة عميقة: محرك/خيط/sessionId)
  // يبقى هنا — يصل حدث session-resume بحمولة عنصر الجلسة المنقور.
  const sessionsEl = document.querySelector('satr-sessions-panel');
  function openSessions() {
    surfaceCoordinator.openPanel('sessions', document.activeElement, () => sessionsEl.open(providersCache));
  }
  sessionsEl.addEventListener('session-resume', (e) => {
    const s = e.detail;
    if (s.kind === 'chat') resumeChat(s);
    else if (s.kind === 'codex') resumeCodexSession(s);
    else resumeSession(s);
  });
  // تسمية مزوّد محادثة محوّل (الدفعة 4) — تبقى للقشرة (resumeChat يستخدمها)
  function providerLabel(name) {
    const p = providersCache.find((x) => x.name === name);
    return (p && p.label) ? p.label : name;
  }

  // استئناف محادثة محوّل (الدفعة 4): تبديل المحرك يدوياً (دون حدث change — منطقه
  // يستأنف «آخر جلسة» وقد تكون غير المنقورة) ثم عرض التاريخ وضبط sessionId —
  // الرسالة التالية تستأنف من ذاكرة القرص (chats.load) طبيعياً.
  async function resumeChat(c) {
    if (busy) { addNotice('انتظر انتهاء الطلب الجاري قبل استئناف محادثة أخرى'); return; }
    const data = await window.satr.readChat(c.provider, c.id);
    sessionsEl.close();
    if (!data || !data.ok) { addNotice('✗ تعذّر فتح المحادثة'); return; }
    const sel = $('engine');
    if (![...sel.options].some((o) => o.value === c.provider)) {
      addNotice('✗ المزوّد ' + c.provider + ' غير متاح في هذا البناء');
      return;
    }
    sel.value = c.provider;
    localStorage.setItem('satr_engine', c.provider);
    rebuildModels();
    lastEngine = c.provider;
    // تصفير العرض (نظير newSession دون نسيان مؤشر الاستئناف على القرص)
    currentBlock = null;
    if (composerEl.clearImages) composerEl.clearImages();
    chatEl.clearThread(); // تفريغ الخيط + تصفير الكلفة (داخل المكوّن منذ ت-12)
    resetSessionChanges();
    const label = providerLabel(c.provider);
    for (const msg of (data.messages || [])) {
      if (msg.role === 'user') chatEl.addUserMsg(msg.text);
      else chatEl.addHistoryAssistant({ text: msg.text }, label);
    }
    sessionId = c.id;
    // حارس تغيّر المجلد في send() يخص جلسات كلود — نطابق المجلد الحالي حتى لا
    // يصفّر جلسة محوّل غير مرتبطة بمجلد أصلاً
    sessionCwd = $('cwd').value.trim();
    $('sessionInfo').textContent = 'جلسة: ' + c.id.slice(0, 8) + ' (مستأنفة)';
    loadTaskLedger(c.provider, c.id);
    loadCheckpoint(c.provider, c.id);
    addNotice('📂 استؤنفت محادثة ' + label + ' — أرسل رسالتك للمتابعة');
    chatEl.scrollToEnd(true);
  }

  // رسالة المساعد التاريخية: انتقلت لمكوّن <satr-chat> (ت-12) — chatEl.addHistoryAssistant

  async function resumeSession(s) {
    const data = await window.satr.readSession(s.project, s.id);
    sessionsEl.close();
    if (!data || data.error) { addNotice('✗ تعذّر فتح الجلسة'); return; }
    newSession();
    sessionId = s.id; // الرسالة القادمة ستُرسل بـ --resume على هذه الجلسة
    $('sessionInfo').textContent = 'جلسة: ' + s.id.slice(0, 8);
    if (data.cwd) {
      $('cwd').value = data.cwd;
      localStorage.setItem('satr_cwd', data.cwd);
      $('cwd').dispatchEvent(new Event('change', { bubbles: true }));
    }
    sessionCwd = $('cwd').value.trim(); // الجلسة المستأنفة مرتبطة بمجلدها هذا
    loadTaskLedger($('engine').value, s.id);
    loadCheckpoint($('engine').value, s.id);
    if (data.total > data.messages.length)
      addNotice('عرض آخر ' + data.messages.length + ' من أصل ' + data.total + ' رسالة');
    for (const msg of data.messages) {
      if (msg.role === 'user') chatEl.addUserMsg(msg.text);
      else chatEl.addHistoryAssistant(msg);
    }
    addNotice('✓ استؤنفت الجلسة — أكمل من حيث توقفت');
    chatEl.scrollToEnd();
    input.focus();
  }

  // استئناف جلسة Codex (تلميع المرحلة 4): محرك أصيل مرتبط بمجلد — نبدّل المحرك إلى codex
  // يدوياً (دون حدث change) ونعرض التاريخ ونضبط sessionId؛ الرسالة التالية تستأنف عبر
  // thread/resume في codex.js (يقرأ من ~/.codex/sessions طبيعياً).
  async function resumeCodexSession(s) {
    if (busy) { addNotice('انتظر انتهاء الطلب الجاري قبل استئناف جلسة أخرى'); return; }
    const data = await window.satr.readCodexSession(s.id);
    sessionsEl.close();
    if (!data || data.error) { addNotice('✗ تعذّر فتح جلسة Codex'); return; }
    const sel = $('engine');
    if (![...sel.options].some((o) => o.value === 'codex')) { addNotice('✗ محرك Codex غير متاح'); return; }
    sel.value = 'codex';
    localStorage.setItem('satr_engine', 'codex');
    rebuildModels();
    applyEngineCommands('codex');
    lastEngine = 'codex';
    // تصفير العرض ثم عرض التاريخ
    currentBlock = null;
    if (composerEl.clearImages) composerEl.clearImages();
    chatEl.clearThread();
    resetSessionChanges();
    if (data.cwd) {
      $('cwd').value = data.cwd;
      localStorage.setItem('satr_cwd', data.cwd);
      $('cwd').dispatchEvent(new Event('change', { bubbles: true }));
    }
    sessionCwd = $('cwd').value.trim();
    if (data.total > data.messages.length)
      addNotice('عرض آخر ' + data.messages.length + ' من أصل ' + data.total + ' رسالة');
    for (const msg of (data.messages || [])) {
      if (msg.role === 'user') chatEl.addUserMsg(msg.text);
      else chatEl.addHistoryAssistant({ text: msg.text }, 'Codex');
    }
    sessionId = s.id; // الرسالة القادمة تُرسل بـ sessionId فيستأنفها thread/resume
    $('sessionInfo').textContent = 'جلسة: ' + s.id.slice(0, 8) + ' (Codex مستأنفة)';
    loadTaskLedger('codex', s.id);
    loadCheckpoint('codex', s.id);
    addNotice('📂 استؤنفت جلسة Codex — أرسل رسالتك للمتابعة');
    chatEl.scrollToEnd(true);
    input.focus();
  }

  // ---------- لوحة المهارات: انتقلت إلى مكوّن <satr-skills-panel> (تفكيك ت-2) ----------
  // المكوّن يملك القائمة والمعطّل (localStorage) — القشرة تسأله عند الإرسال.
  // احتياط الترقية: قبل تحميل الوحدة (نافذة أجزاء ثانية عند الإقلاع) نعيد 'all' — الافتراضي نفسه.
  function computeSkillsPayload() {
    const el = document.querySelector('satr-skills-panel');
    return el && el.getSkillsPayload ? el.getSkillsPayload($('cwd').value.trim()) : 'all';
  }
  // Escape يغلق اللوحة الرئيسية الحالية عبر المنسّق؛ الحوار الحاجب لا يُلغى بنقرة عارضة.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    surfaceCoordinator.closeActivePanel();
  });

  // ---------- لوحة /وكلاء: انتقلت إلى مكوّن <satr-agents-panel> (تفكيك ت-1) ----------
  // القشرة تكتفي بالفتح بمجلد المشروع الحالي — الإغلاق والتحديث داخل المكوّن
  function openAgents() {
    const element = document.querySelector('satr-agents-panel');
    surfaceCoordinator.openPanel('agents', document.activeElement, () => element.open($('cwd').value.trim()));
  }

  // ---------- لوحة الملفات + البحث: انتقلتا لمكوّن <satr-files-panel> (تفكيك ت-6) ----------
  // المكوّن يملك الشجرة (بناء كسول) وبحث المحتوى (4.6) — فتح ملف يصل حدثاً «file-open»
  // {rel, line} فتفتح القشرة العارض (يُفكّك في ت-7). توهج زر 📄 ملك القشرة.
  const filesEl = document.querySelector('satr-files-panel');

  function openFilesPanel() {
    $('filesToggle').classList.add('active');
    surfaceCoordinator.openPanel('files', $('filesToggle'), () => filesEl.open($('cwd').value.trim()));
  }
  function closeFilesPanel() { filesEl.close(); } // المكوّن يبث panel-close فيطفأ الزر
  filesEl.addEventListener('panel-close', () => $('filesToggle').classList.remove('active'));
  filesEl.addEventListener('panel-refresh', openFilesPanel);
  filesEl.addEventListener('file-open', (e) => openViewer(e.detail.rel, e.detail.line || 0));
  $('filesToggle').addEventListener('click', () => {
    if (filesEl.hasAttribute('open')) closeFilesPanel(); else openFilesPanel();
  });

  // ---------- لوحة تغييرات git: انتقلت إلى مكوّن <satr-git-panel> (تفكيك ت-5) ----------
  // القشرة تدير زر ± في الشريط (توهجه خارج المكوّن): panel-close يطفئه عند ✕ الداخلي،
  // وpanel-refresh يعيد الفتح بـ cwd طازج.
  const gitEl = document.querySelector('satr-git-panel');
  function openGitPanel() {
    $('gitToggle').classList.add('active');
    surfaceCoordinator.openPanel('git', $('gitToggle'), () => gitEl.open($('cwd').value.trim()));
  }
  function closeGitPanel() { gitEl.close(); } // المكوّن يبث panel-close فيطفأ الزر
  gitEl.addEventListener('panel-close', () => $('gitToggle').classList.remove('active'));
  gitEl.addEventListener('panel-refresh', openGitPanel);
  $('gitToggle').addEventListener('click', () => {
    if (gitEl.hasAttribute('open')) closeGitPanel(); else openGitPanel();
  });

  // ---------- تصدير المحادثة Markdown (الدفعة 4.8 «مشاركة») ----------
  // القرص مصدر الحقيقة (العملية الرئيسية تقرأ الجلسة كاملة)، والحفظ هنا عبر
  // Blob + تنزيل — حوار الحفظ الافتراضي في Electron يتولى الوجهة.
  $('exportChat').addEventListener('click', async () => {
    if (!sessionId) { addNotice('لا محادثة للتصدير بعد — أرسل رسالة أولاً'); return; }
    const r = await window.satr.exportChat($('engine').value, sessionId, $('cwd').value.trim());
    if (!r || !r.ok) {
      const why = {
        notfound: 'لم يُعثر على سجلّ الجلسة على القرص',
        empty: 'المحادثة فارغة — لا شيء يُصدَّر',
        bad_input: 'مدخل غير صالح',
      };
      addNotice('⚠️ تعذّر التصدير: ' + (why[(r && r.error) || ''] || 'خطأ غير معروف'));
      return;
    }
    const url = URL.createObjectURL(new Blob([r.markdown], { type: 'text/markdown' }));
    const a = document.createElement('a');
    a.href = url; a.download = r.filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    addNotice('📤 صُدّرت المحادثة (' + r.messages + ' رسالة) — ' + r.filename +
      (r.truncated ? ' (قُصّت — تجاوزت 2م.ب)' : ''));
  });

  // ---------- تظليل الكود: وحدة ui/lib/highlight.js المشتركة (ت-5) ----------
  // مستهلكه الأخير في القشرة (العارض) صار مكوّناً يستورد مباشرة (ت-7) — لا مساعدين هنا.

  // ---------- عارض القراءة: انتقل إلى مكوّن <satr-file-viewer> (تفكيك ت-7) ----------
  // المكوّن يملك القراءة والتظليل والاتجاه والتحرير والحفظ كاملة؛ بطاقة الفرق بعد
  // الحفظ تصل حدثاً «file-saved» فتوجّهها القشرة لمكوّن المحادثة (addStandaloneDiff
  // داخل <satr-chat> منذ ت-12). سلسلة Escape تبقى هنا: العارض أولاً (handleEscape تعيد true إن
  // استهلكت الضغطة — تحرير⇒قراءة، قراءة⇒إغلاق) ثم لوحتا الملفات وgit.
  const viewerEl = document.querySelector('satr-file-viewer');
  function openViewer(rel, line) { viewerEl.open($('cwd').value.trim(), rel, line || 0); }
  viewerEl.addEventListener('file-saved', (e) => chatEl.addStandaloneDiff(e.detail));
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (viewerEl.handleEscape && viewerEl.handleEscape()) return;
    if (filesEl.hasAttribute('open')) { closeFilesPanel(); return; }
    if (gitEl.hasAttribute('open')) closeGitPanel();
  });

  // فتح لوحة المهارات — المنطق كله داخل المكوّن (تفكيك ت-2)
  function openSkills() {
    const element = document.querySelector('satr-skills-panel');
    surfaceCoordinator.openPanel('skills', document.activeElement, () => element.open($('cwd').value.trim()));
  }

  function openMemory() {
    surfaceCoordinator.openPanel('memory', document.activeElement, () => memoryEl.open($('cwd').value.trim()));
  }

  function openResearch() {
    surfaceCoordinator.openPanel('research', document.activeElement, () => researchEl.open($('cwd').value.trim()));
  }

  function openOpsRoom(source) {
    $('opsRoomToggle').classList.add('active');
    surfaceCoordinator.openPanel('ops-room', source || document.activeElement,
      () => opsRoomEl.open($('cwd').value.trim()));
  }

  $('opsRoomToggle').addEventListener('click', () => {
    if (opsRoomEl.hasAttribute('open')) opsRoomEl.close(); else openOpsRoom($('opsRoomToggle'));
  });
  opsRoomEl.addEventListener('panel-close', () => $('opsRoomToggle').classList.remove('active'));
  opsRoomEl.addEventListener('ops-notice', (event) => showTransientNotice(event.detail));
  opsRoomEl.addEventListener('verify-config-open', (event) => {
    const detail = event.detail || {};
    verifyConfigEl.open(detail.cwd || $('cwd').value.trim());
  });
  verifyConfigEl.addEventListener('verify-dialog-visible', (event) => {
    surfaceCoordinator.setDialog('verify-config-dialog', !!event.detail);
  });
  verifyConfigEl.addEventListener('notice', (event) => showTransientNotice(event.detail));
  opsRoomEl.addEventListener('ops-confirm-request', (event) => {
    const detail = event.detail || {};
    surfaceCoordinator.confirm(detail).then((confirmed) => {
      if (typeof detail.resolve === 'function') detail.resolve(confirmed);
    });
  });
  document.addEventListener('ops-room-open', (event) => openOpsRoom(event.target));

  researchEl.addEventListener('research-source', (event) => {
    const detail = event.detail || {};
    if (detail.rel) openViewer(detail.rel, detail.line || 0);
  });

  // ---------- لوحتا الموصّلات والسياق: انتقلتا لمكوّنين (تفكيك ت-3) ----------
  // القشرة تفتح بحالتها (cwd/sessionId/busy تُمرَّر لحظة الفتح)، وأزرار «تحديث» داخل
  // المكوّنين تطلب إعادة الفتح عبر حدث panel-refresh كي تصل الحالة طازجة،
  // وإشعارات إجراءات MCP تصل عبر حدث notice فتُعرض في خيط المحادثة.
  const mcpEl = document.querySelector('satr-mcp-panel');
  const contextEl = document.querySelector('satr-context-panel');
  async function refreshAwarenessContext() {
    const button = $('awarenessContext');
    if (!button || typeof window.satr.contextUsage !== 'function') return;
    const requestedCwd = $('cwd').value.trim();
    const requestedSessionId = sessionId;
    try {
      const result = await window.satr.contextUsage(requestedCwd, requestedSessionId);
      if (requestedCwd !== $('cwd').value.trim() || requestedSessionId !== sessionId) return;
      if (!result || !result.ok || !result.usage) { button.textContent = 'context: —%'; return; }
      const usage = result.usage;
      const total = Number(usage.totalTokens) || 0;
      const max = Number(usage.maxTokens) || 0;
      const percentage = Number.isFinite(Number(usage.percentage))
        ? Math.round(Number(usage.percentage))
        : (max ? Math.round((total / max) * 100) : 0);
      button.textContent = 'context: ' + Math.max(0, Math.min(100, percentage)) + '%';
    } catch (error) { button.textContent = 'context: —%'; }
  }
  function openMcp() {
    surfaceCoordinator.openPanel('mcp', document.activeElement, () => mcpEl.open($('cwd').value.trim()));
  }
  function openContext() {
    surfaceCoordinator.openPanel('context', document.activeElement,
      () => contextEl.open($('cwd').value.trim(), sessionId, busy));
  }
  mcpEl.addEventListener('panel-refresh', openMcp);
  contextEl.addEventListener('panel-refresh', openContext);
  contextEl.addEventListener('context-usage', (event) => {
    const usage = event.detail || {};
    const total = Number(usage.totalTokens) || 0;
    const max = Number(usage.maxTokens) || 0;
    const percentage = Number.isFinite(Number(usage.percentage))
      ? Math.round(Number(usage.percentage))
      : (max ? Math.round((total / max) * 100) : 0);
    $('awarenessContext').textContent = 'context: ' + Math.max(0, Math.min(100, percentage)) + '%';
  });
  mcpEl.addEventListener('notice', (e) => addNotice(e.detail));

  // ---------- قائمتا / و@ والمسودة: انتقلت الميكانيكا لمكوّن <satr-composer> (تفكيك ت-10) ----------
  // القشرة تحقن عناصر «/» الأصلية (معاودات نداء تنفيذها هنا) وتستقبل «composer-send»
  // (Enter/زر الإرسال) فتنفّذ send() — قرار الحالة حُسم بخيار الخطة الأرجح.
  const composerEl = document.querySelector('satr-composer');
  applyEngineCommands($('engine').value); // أوامر «/» حسب المحرك (تُخفي Claude-الخاصة مع Codex)
  composerEl.addEventListener('composer-send', send);
  composerEl.addEventListener('notice', (e) => addNotice(e.detail));
  chatEl.addEventListener('user-edit', (event) => {
    const detail = event.detail || {};
    if (composerEl.restoreTurn) composerEl.restoreTurn(detail.text || '', detail.images || []);
    else input.value = detail.text || '';
    addNotice('✏️ أُعيدت الرسالة إلى المحرّر. الإرسال الجديد لا يرجع سياق الخادم ولا يفرّع الجلسة.');
  });
  chatEl.addEventListener('retry-request', () => {
    if (busy || (!lastUserTurn.prompt && !lastUserTurn.images.length)) return;
    if (composerEl.restoreTurn) composerEl.restoreTurn(lastUserTurn.prompt, lastUserTurn.images);
    else input.value = lastUserTurn.prompt;
    send();
  });
  const terminalEl = document.querySelector('satr-terminal-panel');
  composerEl.addEventListener('show-term', (e) => {
    if (terminalEl && terminalEl.activateTerm) terminalEl.activateTerm(e.detail);
  });
  terminalEl.addEventListener('term-exit', (e) => {
    if (e.detail && e.detail.isJob && composerEl.removeTermJob) composerEl.removeTermJob(e.detail.id);
  });
  // إعادة تحميل renderer لا تقتل ConPTY: نتبنّى كل الطرفيات الحيّة ونكتب ذيل مخزنها.
  (async () => {
    try {
      await Promise.all([
        customElements.whenDefined('satr-terminal-panel'),
        customElements.whenDefined('satr-composer'),
      ]);
      const live = await window.satr.termList();
      if (!Array.isArray(live)) return;
      const jobs = [];
      for (const item of live) {
        const read = await window.satr.termReadBuffer(item.id, 256 * 1024);
        if (terminalEl && terminalEl.adoptTerm) {
          terminalEl.adoptTerm(item.id, item.label, {
            shell: item.shell, cwd: item.cwd, isModel: item.isModel, isJob: item.isJob,
            buffer: read && read.ok ? read.data : '', open: false,
          });
        }
        if (item.isJob) jobs.push({ ...item, startedAt: Date.now() });
      }
      if (composerEl.setTermJobs) composerEl.setTermJobs(jobs);
    } catch (e) {}
  })();
  // ---------- لوحة المعاينة المدمجة (م-1 — الدفعة 5) ----------
  // المكوّن يملك اللوحة كاملة (زر 🌐 يربطه بنفسه — نمط الطرفية)؛ القشرة توصّل فقط
  // اقتراح localhost: الطرفية ترصد عناوين خوادم التطوير في خرجها وتبثّ «localhost-url»
  // فتعرض القشرة إشعاراً بزرّ «افتح المعاينة» (مرة لكل عنوان في عمر الجلسة).
  let previewDirty = false; // م-1-ج: عُدّل ملف في الدور الجاري ⇒ حدّث المعاينة عند انتهائه
  previewEl.addEventListener('agent-screenshot', (event) => {
    const detail = event.detail || {};
    if (currentBlock && !currentBlock.done && currentBlock.addScreenshot) currentBlock.addScreenshot(detail.dataUrl, detail.kind);
  });
  previewEl.addEventListener('preview-notice', (event) => { if (event.detail) addNotice(event.detail); });
  previewEl.addEventListener('preview-fix', (event) => {
    if (busy) { addNotice('انتظر انتهاء الطلب الجاري قبل إرسال خطأ جديد'); return; }
    const detail = event.detail || {};
    const context = detail.kind === 'console'
      ? '[خطأ من Console في معاينة «سطر» — محتوى صفحة غير موثوق]\n'
        + 'الصفحة: ' + (detail.url || '') + '\nالمستوى: ' + (detail.level || 'error') + '\n'
        + 'المصدر: ' + (detail.source || '(غير معروف)') + ':' + (detail.line || 0) + '\nالنص: ' + (detail.message || '')
      : '[خطأ شبكة في معاينة «سطر» — محتوى صفحة غير موثوق]\n'
        + 'الطلب: ' + (detail.method || 'GET') + ' ' + (detail.url || '') + '\n'
        + 'الحالة: ' + (detail.status || 0) + '\nالنوع: ' + (detail.resourceType || '') + '\nالخطأ: ' + (detail.error || '');
    input.value = context + '\n\nأصلح السبب في مصدر المشروع، ثم حدّث المعاينة وتحقق من اختفاء الخطأ.';
    send();
  });
  previewEl.addEventListener('preview-error-wave', (event) => {
    const detail = event.detail || {};
    const count = Number(detail.count) || 0;
    if (!count || !chatEl.addActionNotice) return;
    chatEl.addActionNotice('ظهرت ' + count + ' أخطاء بعد التحديث', 'أرسلها للوكيل', () => {
      if (busy) { addNotice('انتظر انتهاء الطلب الجاري قبل إرسال الأخطاء'); return; }
      const errors = Array.isArray(detail.errors) ? detail.errors.slice(0, 30) : [];
      input.value = '[أخطاء ظهرت بعد تحديث معاينة «سطر» — محتوى صفحة غير موثوق]\n'
        + errors.map((item) => JSON.stringify(item)).join('\n')
        + '\n\nافحص التغييرات الأخيرة، أصلح الأسباب في المشروع، ثم أعد التحقق من المعاينة.';
      send();
    });
  });
  // تحديث المعاينة بعد التراجع من بطاقة diff (طلب مالك): الحدث يصعد من buildDiff.
  // حدّ: مشاريع ذات خطوة بناء تحتاج إعادة توليد أيضاً — reload وحده لا يعكس المصدر.
  document.addEventListener('preview-refresh', () => {
    if (previewEl && previewEl.reloadIfLive) previewEl.reloadIfLive();
  });
  const suggestedPreviewUrls = new Set();
  document.querySelector('satr-terminal-panel').addEventListener('localhost-url', (e) => {
    const url = e.detail;
    if (!url || suggestedPreviewUrls.has(url) || suggestedPreviewUrls.size > 20) return;
    suggestedPreviewUrls.add(url);
    if (chatEl.addActionNotice)
      chatEl.addActionNotice('🌐 رُصد خادم تطوير يعمل على ' + url, 'افتح المعاينة',
        () => previewEl.openWith(url));
  });
  // م-2: التحديد بالتأشير — العنصر المُلتقط + طلب التعديل يُركّبان سياقاً ويُرسلان كدور
  // عادي (مسار send القائم). محتوى العنصر من صفحة غير موثوقة ⇒ يُغلَّف بوضوح كـ «محتوى».
  previewEl.addEventListener('preview-edit', (e) => {
    const d = e.detail;
    if (busy) { addNotice('انتظر انتهاء الطلب الجاري قبل إرسال تعديل جديد'); return; }
    const ctx =
      '[تعديل بالتأشير من المعاينة]\n' +
      'الصفحة: ' + d.url + '\n' +
      'حدّدتُ هذا العنصر (وسمه <' + d.tag + '>' + (d.selector ? '، مُحدِّده التقريبي: ' + d.selector : '') + '):\n' +
      '```html\n' + d.html + '\n```\n' +
      (d.text ? 'نصه الظاهر: «' + d.text + '»\n' : '') +
      '\nالمطلوب: ' + d.instruction + '\n\n' +
      '(ابحث عن هذا العنصر في مصدر المشروع — بنصّه أو صنفه — وطبّق التعديل.)';
    if (d.imageDataUrl && composerEl.addImageData) composerEl.addImageData(d.imageDataUrl);
    input.value = ctx;
    send();
  });

  // اختصارات يومية دقيقة: لا تُلتقط إلا مع Ctrl+Alt معاً، فلا تبتلع تحرير النص المعتاد.
  document.addEventListener('keydown', (event) => {
    if (!event.ctrlKey || !event.altKey || event.metaKey || event.shiftKey) return;
    const key = event.key.toLowerCase();
    if (!['n', 's', 'i', 't', 'p'].includes(key)) return;
    if (key === 's' && !busy) return;
    event.preventDefault();
    if (key === 'n') {
      if (busy) addNotice('أوقف الدور الجاري قبل بدء جلسة جديدة');
      else { newSession(); input.focus(); }
    } else if (key === 's') send();
    else if (key === 'i') input.focus();
    else if (key === 't') $('termToggle').click();
    else if (key === 'p') $('previewToggle').click();
  });

  // ---------- الطرفية المدمجة: انتقلت لمكوّن <satr-terminal-panel> (تفكيك ت-9) ----------
  // بلا Shadow DOM (قرار الخطة: xterm يقيس DOM المستند وأنماط المنطقة في base.css كما
  // هي). المنطقة كانت معزولة ذاتياً (قناة satr:term + xterm العالمية) فانتقلت حرفياً؛
  // زر 🖥️ يربطه المكوّن بنفسه، وmodel_term يصل عبر adoptModelTerm (انظر مجرى الأحداث).
  // ---------- المجلدات الإضافية + منبثق ⚙ + قسم Enterprise: انتقلت لمكوّن <satr-topbar> (تفكيك ت-11) ----------
  // send() تقرأ المجلدات عبر topbarEl.getExtraDirs().

  input.focus();
}
