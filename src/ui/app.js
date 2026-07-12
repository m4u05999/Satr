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
      // لا اختيار محفوظ: اتبع تفضيل النظام أول مرة
      saved = (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
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
  let gated = true; // محجوب حتى يؤكّد فحص أول التشغيل توفّر Claude Code (مانع إطلاق)

  // ---------- إعدادات محفوظة ----------
  ['cwd', 'model', 'perm', 'engine', 'effort'].forEach((id) => {
    const el = $(id);
    const saved = localStorage.getItem('satr_' + id);
    if (saved !== null) el.value = saved;
    el.addEventListener('change', () => localStorage.setItem('satr_' + id, el.value));
  });

  // ---------- بوابة أول التشغيل: انتقلت لمكوّن <satr-gate> (تفكيك ت-8) ----------
  // المكوّن يفحص ويرسم ويعيد الفحص ذاتياً (يبدأ عند اتصاله)؛ عند الجهوز يخفي نفسه
  // ويُصدر «gate-ready {version}» — القشرة ترفع حجب الإرسال وتعرض شريط النجاح
  // (banner عنصر مشترك ملكها). المستمع يُربط قبل ترقية المكوّن فلا سباق.
  document.querySelector('satr-gate').addEventListener('gate-ready', (e) => {
    gated = false;
    const b = $('banner');
    b.className = 'ok'; b.textContent = '✓ Claude Code جاهز — ' + ((e.detail && e.detail.version) || '');
    setTimeout(() => { b.style.display = 'none'; }, 4000);
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
  $('model').addEventListener('change', () => localStorage.setItem('satr_model_' + $('engine').value, $('model').value));
  loadProviders();

  // ---------- مدير المفاتيح + زر اختيار المجلد: انتقلا لمكوّن <satr-topbar> (تفكيك ت-11) ----------
  const topbarEl = document.querySelector('satr-topbar');

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
  const executionEl = document.querySelector('satr-execution-panel');
  function addNotice(text) { chatEl.addNotice(text); }

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
      await window.satr.stop();
      if (currentBlock && !currentBlock.done) currentBlock.stopped();
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

  // ---------- التحديث التلقائي (المرحلة 17 + موافقة صريحة 2026-07-12) ----------
  // إشعار لا يقاطع بموافقة في كل خطوة: «متوفّر» ⇐ زرّ «نزّل الآن» ⇐ تقدّم ⇐ «جاهز»
  // ⇐ زرّ «أعد التشغيل الآن». لا تنزيل ولا تثبيت تلقائيان (المستخدم يملك كل خطوة).
  function handleUpdateEvent(ev) {
    const toast = $('updateToast'), txt = $('updateText');
    const download = $('updateDownload'), restart = $('updateRestart');
    if (ev.phase === 'available') {
      txt.textContent = 'تتوفّر نسخة جديدة' + (ev.version ? ' (' + ev.version + ')' : '') + '.';
      download.hidden = false; restart.hidden = true; toast.hidden = false;
    } else if (ev.phase === 'progress') {
      txt.textContent = 'تنزيل التحديث… ' + (ev.percent || 0) + '٪';
      download.hidden = true; restart.hidden = true; toast.hidden = false;
    } else if (ev.phase === 'ready') {
      txt.textContent = 'التحديث' + (ev.version ? ' (' + ev.version + ')' : '') + ' جاهز للتثبيت.';
      download.hidden = true; restart.hidden = false; toast.hidden = false;
    } else if (ev.phase === 'error') {
      toast.hidden = true; // فشل صامت — لا نزعج المستخدم (يبقى التثبيت اليدوي متاحاً)
    }
  }
  $('updateDownload').addEventListener('click', () => {
    $('updateText').textContent = 'جارٍ بدء التنزيل…';
    $('updateDownload').hidden = true;
    window.satr.downloadUpdate();
  });
  $('updateRestart').addEventListener('click', () => window.satr.restartUpdate());
  $('updateDismiss').addEventListener('click', () => { $('updateToast').hidden = true; });

  // إشعار اكتمال الدور: انتقل لمكوّن <satr-chat> (ت-12) — chatEl.notifyTurnDone(isError)

  // ---------- استقبال أحداث Claude من العملية الرئيسية ----------
  window.satr.onEvent((ev) => {
    // طلبات الأذونات تُعالج دائماً ولو كانت الكتلة منتهية
    if (ev.type === 'permission_request') {
      permEl.request({ id: ev.id, tool: ev.tool, detail: permDetailText(ev.input) });
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
    // أداة open_preview (م-1-ب): النموذج طلب عرض عنوان في المعاينة المدمجة —
    // اللوحة تفتح وتبلّغ مستطيلها فيُنشأ العرض الأصلي (العنوان تحقق منه agent.js)
    if (ev.type === 'preview_open' && ev.url) {
      if (previewEl.openWith) previewEl.openWith(ev.url);
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
      memoryEl.open($('cwd').value.trim(), ev.candidate);
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
    if (ev.type === 'execution_update') {
      executionEl.handleEvent(ev);
      return;
    }
    const block = currentBlock;
    if (!block || block.done) return;
    if (ev.type === 'stream_text') {
      if (ev.text) block.addDelta(ev.text, ev.phase);
      return;
    }
    if (ev.type === 'system' && ev.subtype === 'commands_changed') {
      // دفعة تحديث لقائمة أوامر CLI منتصف الجلسة — التطبيع والفلترة داخل المكوّن (ت-10)
      if (composerEl.commandsChanged) composerEl.commandsChanged(ev.commands);
    } else if (ev.type === 'system' && ev.subtype === 'compact_boundary') {
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
      previewDirty = true; // م-1-ج: عُدّل ملف في هذا الدور ⇒ المعاينة تحتاج تحديثاً عند انتهائه
    } else if (ev.type === 'result') {
      if (ev.session_id) {
        sessionId = ev.session_id;
        $('sessionInfo').textContent = 'جلسة: ' + sessionId.slice(0, 8);
      }
      if (ev.is_error && ev.result) {
        if (deadSessionRecovery(ev.result)) block.error('تعذّر استئناف الجلسة السابقة — بدأت جلسة جديدة، أعد الإرسال.');
        else block.error(String(ev.result));
      }
      block.finish(ev);
      // م-1-ج: تحديث المعاينة تلقائياً بعد دور عدّل ملفات (المكوّن يقرّر فعلياً حسب وضعه)
      if (previewDirty) { previewDirty = false; if (previewEl.reloadIfLive) previewEl.reloadIfLive(); }
      chatEl.notifyTurnDone(!!ev.is_error);
    } else if (ev.type === 'spawn_error') {
      if (deadSessionRecovery(ev.text)) block.error('تعذّر استئناف الجلسة السابقة — بدأت جلسة جديدة، أعد الإرسال.');
      else {
        const eng = $('engine').value;
        const name = eng === 'codex' ? 'Codex' : 'claude';
        block.error('فشل تشغيل أمر ' + name + ' — تأكد أنه مثبت ومسجّل دخوله.\n' + (ev.text || ''));
      }
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
    if (previewEl && previewEl.holdForDialog) previewEl.holdForDialog(e.detail);
  });
  function permDetailText(inp) {
    const d = chatEl.toolDetail(inp);
    if (d) return d;
    try { return JSON.stringify(inp || {}, null, 1).slice(0, 1000); } catch { return ''; }
  }
  function closePermDialog() { if (permEl.closeAll) permEl.closeAll(); }

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
        ? '🖱️ وضع تحكّم المتصفح مفعّل — الوكيل يقود المعاينة بلا إذن لكل فعل (أفعال المتصفح فقط).'
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
      await window.satr.stop();
      if (currentBlock && !currentBlock.done) currentBlock.stopped();
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
      browserControl: browserControlOn, // وضع تحكّم المتصفح (محرك SDK فقط)
    });
    if (r && r.error) {
      currentBlock.error(r.message || r.error);
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
    { cmd: '/تنفيذ-معزول', en: '/execute-isolated', desc: 'تنفيذ تعديل داخل git worktree مؤقت بلا دمج', sdkOnly: true, run: () => openExecution() },
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
    $('model').value = v; localStorage.setItem('satr_model', v);
    addNotice('✓ تم اختيار نموذج ' + label);
  }
  function setPerm(v, label) {
    $('perm').value = v; localStorage.setItem('satr_perm', v);
    addNotice('✓ ' + label);
  }
  function newSession() {
    // 1.3: «جلسة جديدة» على محوّل أعمى تنسى مؤشر الاستئناف على القرص (سجلّه يبقى للتنظيف)
    const engNow = $('engine').value;
    if (isBlindEngine(engNow)) { try { window.satr.forgetChat(engNow); } catch (e) {} }
    sessionId = null; currentBlock = null;
    if (composerEl.clearImages) composerEl.clearImages();
    $('sessionInfo').textContent = 'لا جلسة';
    chatEl.reset(); // حالة الفراغ + تصفير الكلفة التراكمية وشريطها (داخل المكوّن منذ ت-12)
    // إطفاء تلقائي لوضع تحكّم المتصفح: لا نحمل صلاحية قيادة تلقائية لمهمة جديدة صامتاً
    if (browserControlOn) { setBrowserControl(false, false); addNotice('🖱️ أُوقف وضع تحكّم المتصفح تلقائياً مع الجلسة الجديدة.'); }
  }
  $('newSession').addEventListener('click', newSession);

  // ---------- لوحة الجلسات: انتقلت إلى مكوّن <satr-sessions-panel> (تفكيك ت-4) ----------
  // المكوّن يملك الجلب والدمج والبحث والعرض؛ الاستئناف (حالة عميقة: محرك/خيط/sessionId)
  // يبقى هنا — يصل حدث session-resume بحمولة عنصر الجلسة المنقور.
  const sessionsEl = document.querySelector('satr-sessions-panel');
  function openSessions() { sessionsEl.open(providersCache); }
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
    if (data.cwd) { $('cwd').value = data.cwd; localStorage.setItem('satr_cwd', data.cwd); }
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
    if (data.cwd) { $('cwd').value = data.cwd; localStorage.setItem('satr_cwd', data.cwd); }
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
  // Escape يغلق اللوحات المفكّكة التي كانت تملك معالجه (توجيه Escape يبقى في القشرة
  // — قرار خطة التفكيك). لوحة الوكلاء خارج القائمة: لم يكن لها معالج أصلاً (تطابق حرفي).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    for (const tag of ['satr-skills-panel', 'satr-mcp-panel', 'satr-context-panel', 'satr-sessions-panel', 'satr-memory-panel', 'satr-research-panel', 'satr-execution-panel']) {
      const el = document.querySelector(tag);
      if (el && el.close) el.close();
    }
  });

  // ---------- لوحة /وكلاء: انتقلت إلى مكوّن <satr-agents-panel> (تفكيك ت-1) ----------
  // القشرة تكتفي بالفتح بمجلد المشروع الحالي — الإغلاق والتحديث داخل المكوّن
  function openAgents() {
    document.querySelector('satr-agents-panel').open($('cwd').value.trim());
  }

  // ---------- لوحة الملفات + البحث: انتقلتا لمكوّن <satr-files-panel> (تفكيك ت-6) ----------
  // المكوّن يملك الشجرة (بناء كسول) وبحث المحتوى (4.6) — فتح ملف يصل حدثاً «file-open»
  // {rel, line} فتفتح القشرة العارض (يُفكّك في ت-7). توهج زر 📄 ملك القشرة.
  const filesEl = document.querySelector('satr-files-panel');

  function openFilesPanel() {
    $('filesToggle').classList.add('active');
    filesEl.open($('cwd').value.trim());
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
    gitEl.open($('cwd').value.trim());
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
    document.querySelector('satr-skills-panel').open($('cwd').value.trim());
  }

  function openMemory() {
    memoryEl.open($('cwd').value.trim());
  }

  function openResearch() {
    researchEl.open($('cwd').value.trim());
  }

  function openExecution() {
    executionEl.open($('cwd').value.trim());
  }

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
  function openMcp() { mcpEl.open($('cwd').value.trim()); }
  function openContext() { contextEl.open($('cwd').value.trim(), sessionId, busy); }
  mcpEl.addEventListener('panel-refresh', openMcp);
  contextEl.addEventListener('panel-refresh', openContext);
  mcpEl.addEventListener('notice', (e) => addNotice(e.detail));

  // ---------- قائمتا / و@ والمسودة: انتقلت الميكانيكا لمكوّن <satr-composer> (تفكيك ت-10) ----------
  // القشرة تحقن عناصر «/» الأصلية (معاودات نداء تنفيذها هنا) وتستقبل «composer-send»
  // (Enter/زر الإرسال) فتنفّذ send() — قرار الحالة حُسم بخيار الخطة الأرجح.
  const composerEl = document.querySelector('satr-composer');
  applyEngineCommands($('engine').value); // أوامر «/» حسب المحرك (تُخفي Claude-الخاصة مع Codex)
  composerEl.addEventListener('composer-send', send);
  composerEl.addEventListener('notice', (e) => addNotice(e.detail));
  // ---------- لوحة المعاينة المدمجة (م-1 — الدفعة 5) ----------
  // المكوّن يملك اللوحة كاملة (زر 🌐 يربطه بنفسه — نمط الطرفية)؛ القشرة توصّل فقط
  // اقتراح localhost: الطرفية ترصد عناوين خوادم التطوير في خرجها وتبثّ «localhost-url»
  // فتعرض القشرة إشعاراً بزرّ «افتح المعاينة» (مرة لكل عنوان في عمر الجلسة).
  const previewEl = document.querySelector('satr-preview-panel');
  let previewDirty = false; // م-1-ج: عُدّل ملف في الدور الجاري ⇒ حدّث المعاينة عند انتهائه
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
    input.value = ctx;
    send();
  });

  // ---------- الطرفية المدمجة: انتقلت لمكوّن <satr-terminal-panel> (تفكيك ت-9) ----------
  // بلا Shadow DOM (قرار الخطة: xterm يقيس DOM المستند وأنماط المنطقة في base.css كما
  // هي). المنطقة كانت معزولة ذاتياً (قناة satr:term + xterm العالمية) فانتقلت حرفياً؛
  // زر 🖥️ يربطه المكوّن بنفسه، وmodel_term يصل عبر adoptModelTerm (انظر مجرى الأحداث).
  // ---------- المجلدات الإضافية + منبثق ⚙ + قسم Enterprise: انتقلت لمكوّن <satr-topbar> (تفكيك ت-11) ----------
  // send() تقرأ المجلدات عبر topbarEl.getExtraDirs().

  input.focus();
}
