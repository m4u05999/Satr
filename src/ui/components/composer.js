// <satr-composer> — ميكانيكا المؤلّف (تفكيك ت-10): المرفقات (لصق + 📎) + شريط عمليات
// الخلفية + قائمتا / (مع مزامنة أوامر CLI) و@ + المسودة وتمدد المحرّر.
// **بلا Shadow DOM** والترميز يبقى في index.html (footer داخل الوسم): القشرة تربط
// عناصر المؤلّف (input/send/engine/…) عند الإقلاع — قبل ترقية أي مكوّن — فبناء
// الترميز هنا كان سيكسرها (قرار موثّق؛ يُعاد النظر عند تحويل القشرة module في ت-13).
// **قرار الحالة المؤجّل حُسم بخيار الخطة الأرجح**: send() تبقى orchestration في القشرة
// — المكوّن يبث «composer-send» (Enter/زر الإرسال) والقشرة تنفّذ وتستهلك واجهته:
// getImages/clearImages/afterSend/setBgProcs/commandsChanged/setCommands (أوامر «/»
// تُحقن بمعاودة نداء — تنفيذها دوال قشرة: فتح لوحات/ضغط/نموذج…). حدث «notice» للخيط.
class SatrComposer extends HTMLElement {
  connectedCallback() {
    if (this._wired) return;
    this._wired = true;
    const $ = (id) => document.getElementById(id);
    const composerHost = this;
    const input = $('input');
    const promptSuggestion = $('promptSuggestion');
    const promptSuggestionText = $('promptSuggestionText');
    const notice = (t) => this.dispatchEvent(new CustomEvent('notice', { detail: t }));
    const emitSend = () => this.dispatchEvent(new CustomEvent('composer-send'));
    let commands = []; // عناصر قائمة «/» الأصلية — تُحقن من القشرة (معاودات نداء تنفيذها هناك)
    let bgProcs = []; // عمليات الخلفية المعمّرة المعروضة في شريط «قيد التشغيل»
    let termJobs = []; // مهام pty المعمّرة المرئية في تبويبات 🛠
    const slashMenu = $('slashMenu');
    let slashIndex = 0, slashFiltered = [];
    let activeDraftCwd = $('cwd').value.trim();

    // placeholder قصير حين يضيق المحرّر (جولة الصقل 2026-08-08): النص الطويل يلتف
    // لسطرين وmin-height تقص ثانيهما — دون التضحية بالتلميح الكامل في العرض الواسع.
    const FULL_PLACEHOLDER = input.getAttribute('placeholder') || '';
    const SHORT_PLACEHOLDER = 'اكتب طلبك… (/ للأوامر، @ للملفات)';
    if (typeof ResizeObserver === 'function' && FULL_PLACEHOLDER) {
      const placeholderRo = new ResizeObserver(() => {
        const w = input.clientWidth;
        if (!w) return; // مخفي — لا قرار
        const want = w < 700 ? SHORT_PLACEHOLDER : FULL_PLACEHOLDER;
        if (input.getAttribute('placeholder') !== want) input.setAttribute('placeholder', want);
      });
      placeholderRo.observe(input);
    }

    // حارس غياب الترميز: fixtures الاختبارات الحية قد تحمل نسخة مؤلّف بلا شريحة الاقتراح،
    // وغيابها لا يجوز أن يُسقط تهيئة المكوّن ودواله العامة.
    function clearPromptSuggestion() {
      if (!promptSuggestion) return;
      promptSuggestion.hidden = true;
      promptSuggestionText.textContent = '';
    }

    if (promptSuggestion) promptSuggestion.addEventListener('click', () => {
      const suggestion = promptSuggestionText.textContent;
      if (!suggestion) return;
      input.value = suggestion;
      clearPromptSuggestion();
      autoResize(); saveDraft(); closeSlash(); closeFiles(); input.focus();
    });

// ما يلي منقول حرفياً من القشرة (لصق الصور + زر الإرفاق + شريط الخلفية + محرّك
// قائمتي / و@ + المسودة) — التغييرات الوحيدة: addNotice⇒notice وsend⇒emitSend
// وCOMMANDS⇒commands المحقونة

  // §5-د-3: زر إرفاق صورة من الجهاز — القشرة تحسم دعم المحرك من capabilities.vision
  $('attachBtn').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', (e) => {
    for (const f of (e.target.files || [])) addImageFile(f);
    e.target.value = ''; // يسمح بإعادة اختيار الملف نفسه
  });

  // ---------- لصق الصور من الحافظة ----------
  let pendingImages = []; // {id, media_type, data(base64), dataUrl}
  const attachmentsBar = $('attachments');
  const ALLOWED_PASTE = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

  function renderAttachments() {
    attachmentsBar.replaceChildren();
    if (!pendingImages.length) { attachmentsBar.classList.remove('open'); return; }
    attachmentsBar.classList.add('open');
    for (const img of pendingImages) {
      const chip = document.createElement('div');
      chip.className = 'attach-chip';
      const im = document.createElement('img'); im.src = img.dataUrl; im.alt = 'صورة مرفقة';
      const rm = document.createElement('button');
      rm.className = 'rm'; rm.textContent = '✕'; rm.title = 'إزالة';
      rm.addEventListener('click', () => {
        pendingImages = pendingImages.filter((p) => p.id !== img.id);
        renderAttachments();
      });
      chip.appendChild(im); chip.appendChild(rm);
      attachmentsBar.appendChild(chip);
    }
  }

  function addImageFile(file) {
    if (!file || !ALLOWED_PASTE.has(file.type)) return;
    if (pendingImages.length >= 6) { notice('الحد الأقصى 6 صور لكل رسالة'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      const comma = dataUrl.indexOf(',');
      if (comma < 0) return;
      pendingImages.push({
        id: 'img_' + Math.random().toString(36).slice(2),
        media_type: file.type,
        data: dataUrl.slice(comma + 1), // base64 خالص بعد الفاصلة
        dataUrl,
      });
      renderAttachments();
    };
    reader.readAsDataURL(file);
  }

  function addImageData(dataUrl, model) {
    const value = String(dataUrl || '');
    const match = value.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
    if (!match || pendingImages.length >= 6) return false;
    // نسخة النموذج (model) تُرسَل للمحرك، والمصغّرة تبقى من dataUrl (عقد 🎯)
    const useModel = model && ALLOWED_PASTE.has(model.media_type) && typeof model.data === 'string' && /^[A-Za-z0-9+/=]+$/.test(model.data);
    pendingImages.push({ id: 'img_' + Math.random().toString(36).slice(2), media_type: useModel ? model.media_type : match[1], data: useModel ? model.data : match[2], dataUrl: value });
    renderAttachments();
    return true;
  }

  input.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    let handled = false;
    for (const it of items) {
      if (it.kind === 'file' && it.type && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) { addImageFile(f); handled = true; }
      }
    }
    if (handled) e.preventDefault(); // لا نلصق بايتات الصورة كنص في المحرّر
  });
  // ---------- شريط عمليات الخلفية قيد التشغيل ----------
  const bgBar = $('bgBar'), bgChips = $('bgChips');

  // المدة المنقضية بصيغة m:ss أو h:mm:ss
  // مدة منقضية بصيغة m:ss أو h:mm:ss — سُمّيت fmtDur بعد أن داستها fmtAge الثانية
  // (دالة الجلسات، تتوقع طابعاً زمنياً لا مدة) بالرفع فظهر «قبل 20642 يوم» في الشريط
  function fmtDur(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h ? h + ':' + pad(m) + ':' + pad(ss) : m + ':' + pad(ss);
  }

  function renderBgBar() {
    bgChips.textContent = '';
    if (!bgProcs.length && !termJobs.length) { bgBar.classList.remove('open'); return; }
    bgBar.classList.add('open');
    for (const job of termJobs) {
      const chip = document.createElement('div');
      chip.className = 'bg-chip job';
      chip.title = job.command || job.label || 'مهمة خلفية';
      const cmd = document.createElement('span');
      cmd.className = 'cmd'; cmd.textContent = '🛠 ' + (job.label || 'مهمة خلفية');
      const age = document.createElement('span');
      age.className = 'age'; age.dataset.start = String(job.startedAt || Date.now());
      age.textContent = fmtDur(Date.now() - Number(age.dataset.start));
      const show = document.createElement('button');
      show.className = 'show'; show.type = 'button'; show.textContent = 'إظهار';
      show.addEventListener('click', () => composerHost.dispatchEvent(new CustomEvent('show-term', { detail: job.id })));
      const kill = document.createElement('button');
      kill.className = 'kill'; kill.type = 'button'; kill.textContent = '✕';
      kill.setAttribute('aria-label', 'إيقاف المهمة');
      kill.addEventListener('click', async () => {
        kill.disabled = true; age.removeAttribute('data-start'); age.textContent = 'يُنهى…';
        await window.satr.termKill(job.id);
        termJobs = termJobs.filter((item) => item.id !== job.id);
        renderBgBar();
      });
      chip.appendChild(cmd); chip.appendChild(age); chip.appendChild(show); chip.appendChild(kill);
      bgChips.appendChild(chip);
    }
    for (const p of bgProcs) {
      const chip = document.createElement('div');
      chip.className = 'bg-chip';
      chip.title = p.command + '  ·  ' + p.count + ' عملية';
      const cmd = document.createElement('span');
      cmd.className = 'cmd'; cmd.textContent = p.command;
      const age = document.createElement('span');
      age.className = 'age'; age.dataset.start = String(p.startedAt);
      age.textContent = fmtDur(Date.now() - p.startedAt);
      const kill = document.createElement('button');
      kill.className = 'kill'; kill.type = 'button'; kill.textContent = '✕';
      kill.setAttribute('aria-label', 'إيقاف العملية');
      kill.addEventListener('click', async () => {
        kill.disabled = true;
        age.removeAttribute('data-start'); // يوقف تحديث الزمن فلا يدوس «يُنهى…»
        age.textContent = 'يُنهى…';
        await window.satr.killBgProc(p.id);
      });
      chip.appendChild(cmd); chip.appendChild(age); chip.appendChild(kill);
      bgChips.appendChild(chip);
    }
  }

  // تحديث الزمن المنقضي كل ثانية دون إعادة بناء الشرائح
  setInterval(() => {
    bgChips.querySelectorAll('.age[data-start]').forEach((el) => {
      el.textContent = fmtDur(Date.now() - Number(el.dataset.start));
    });
  }, 1000);

  $('bgKillAll').addEventListener('click', async () => {
    for (const id of termJobs.map((job) => job.id)) await window.satr.termKill(id);
    for (const id of bgProcs.map((p) => p.id)) await window.satr.killBgProc(id);
  });

  // عند الإقلاع: استرجاع أي عمليات خلفية بقيت من تشغيل سابق
  window.satr.listBgProcs().then((procs) => {
    bgProcs = Array.isArray(procs) ? procs : [];
    renderBgBar();
  }).catch(() => {});
  // ---------- مزامنة أوامر CLI (تكافؤ الدفعة الثانية — البند 1) ----------
  // supportedCommands() يعيد ما يفهمه CLI في هذا المشروع: مهارات مضمّنة (verify/
  // code-review/init/…) ومهارات المستخدم وأوامر أساسية. تُعرض في قائمة «/» وتُرسل
  // كدور عادي (نمط /ضغط المثبت). تُستبعد ما له نسخة عربية أصلية أفضل في «سطر».
  const CLI_CMD_EXCLUDE = new Set(['clear', 'compact', 'context']);
  const SLASH_SECTIONS = [
    { id: 'satr', label: 'أوامر سطر' },
    { id: 'claude', label: 'أوامر Claude Code' },
    { id: 'project', label: 'مهارات المشروع' },
    { id: 'user', label: 'مهاراتك (من ~/.claude)' },
  ];
  let cliCommands = [], cliCmdsCwd = null, cliCmdsLoading = false, cliCmdsVersion = 0;
  let skillSources = new Map(), hideUserSkills = false;
  try { hideUserSkills = localStorage.getItem('satr_hide_user_skills') === '1'; } catch (e) {}

  function sourcesFromSkills(skills) {
    return new Map((Array.isArray(skills) ? skills : [])
      .filter((skill) => skill && skill.name && (skill.source === 'project' || skill.source === 'user'))
      .map((skill) => [String(skill.name), skill.source]));
  }

  function requestSkillSources(cwd) {
    return typeof window.satr.listSkills === 'function'
      ? Promise.resolve(window.satr.listSkills(cwd)).catch(() => [])
      : Promise.resolve([]);
  }

  // تعريب السطر المطويّ للأوامر المضمّنة المعروفة (قاعدة «العربية أولاً») —
  // الوصف الإنجليزي الكامل يبقى في التوسيع (الدرس المصغّر الأصلي)، وأي أمر جديد
  // غير معروف هنا يظهر بوصفه الإنجليزي بدل أن يُحجب. مهارات المستخدم تمرّ بوصف كاتبها.
  const CLI_CMD_AR = {
    'verify': 'تحقق أن تعديلاً برمجياً يعمل فعلاً بتشغيل التطبيق ومراقبة سلوكه',
    'code-review': 'مراجعة التغييرات الحالية بحثاً عن أخطاء وفرص تبسيط',
    'review': 'مراجعة طلب سحب (Pull Request)',
    'security-review': 'مراجعة أمنية كاملة للتغييرات المعلقة على الفرع الحالي',
    'pr-comments': 'معالجة ملاحظات المراجعة على طلب السحب الحالي',
    'release-notes': 'إنشاء ملاحظات إصدار موجزة من التغييرات الحالية',
    'simplify': 'تبسيط الكود المتغيّر: إعادة استخدام وتنظيف وكفاءة (ثم تطبيق الإصلاحات)',
    'debug': 'تشخيص علّة: جمع الأدلة وفرضيات السبب الجذري ثم الإصلاح',
    'init': 'إنشاء ملف CLAUDE.md بتوثيق قاعدة الكود لهذا المشروع',
    'run': 'تشغيل تطبيق المشروع ومعاينة تغيير يعمل فعلياً',
    'batch': 'تنفيذ مهام متكررة على ملفات كثيرة دفعة واحدة بالتوازي',
    'loop': 'تكرار أمر أو مهمة على فترات زمنية (أو بوتيرة ذاتية)',
    'schedule': 'جدولة وكلاء سحابيين يعملون بمواعيد دورية (روتينات)',
    'update-config': 'ضبط إعدادات Claude Code عبر settings.json (أذونات/خطافات/متغيرات)',
    'fewer-permission-prompts': 'تقليل مطالبات الأذونات بإنشاء قائمة سماح من استخدامك الفعلي',
    'reload-skills': 'إعادة تحميل المهارات المكتشفة من القرص',
    'keybindings-help': 'تخصيص اختصارات لوحة المفاتيح',
    'claude-api': 'مرجع Claude API: النماذج والأسعار والبث واستخدام الأدوات',
    'usage': 'تقرير استخدام حسابك وحدود خطتك',
    'usage-credits': 'رصيد الاستخدام الإضافي المتبقي',
    'extra-usage': 'إعدادات الاستخدام الإضافي بعد بلوغ حدود الخطة',
    'insights': 'رؤى وإحصاءات من استخدامك لـ Claude Code',
    'run-skill-generator': 'مولّد مهارات: إنشاء مهارة جديدة بمعالج تفاعلي',
    'heapdump': 'تفريغ ذاكرة عملية Node لتشخيص تسريباتها',
    'goal': 'تحديد هدف الجلسة لتوجيه عمل النموذج',
    'team-onboarding': 'تهيئة إعدادات الفريق المشتركة',
  };

  function cliToItem(c, section) {
    const insert = '/' + c.name + ' ';
    const full = (c.description || '').trim();
    // السطر المطويّ: التعريب المُراجَع إن وُجد، وإلا أول سطر من وصف CLI
    // (بلا رموز وسائط خام [...] و<...>) — قصّه يتولاه CSS
    const ar = section === 'claude' ? (CLI_CMD_AR[c.name] || '') : '';
    const short = ar || full.split('\n')[0].replace(/[\[<][^\]>]*[\]>]/g, '').replace(/\s{2,}/g, ' ').trim();
    return {
      cmd: '/' + c.name,
      en: c.aliases && c.aliases.length ? '/' + c.aliases.join(' /') : '',
      desc: short,
      // الوصف الكامل درسٌ مصغّر لجمهورنا المتعلم — بالتوسيع: التعريب ثم الأصل الإنجليزي
      descFull: (ar ? ar + '\n\n' : '') + full + (c.argumentHint ? '\n\nالوسائط: ' + c.argumentHint : ''),
      cli: true,
      section,
      // إدراج الأمر في المحرّر (مع إتاحة الوسائط) — الإرسال بـ Enter كدور عادي
      run: () => {
        input.value = insert;
        autoResize();
        input.focus();
        input.setSelectionRange(insert.length, insert.length);
      },
    };
  }

  // جلب كسول لكل cwd: القائمة الأصلية تظهر فوراً، وأوامر CLI تلحق حين تصل
  function ensureCliCommands() {
    const cwd = $('cwd').value.trim();
    if (cliCmdsCwd === cwd || cliCmdsLoading) return;
    cliCmdsLoading = true;
    const version = cliCmdsVersion;
    Promise.all([window.satr.listCommands(cwd), requestSkillSources(cwd)]).then(([r, skills]) => {
      if (version !== cliCmdsVersion) return;
      cliCmdsLoading = false;
      cliCmdsCwd = cwd;
      skillSources = sourcesFromSkills(skills);
      if (r && r.ok) {
        cliCommands = r.commands.filter((c) => c.name && !CLI_CMD_EXCLUDE.has(c.name));
        // إن كانت القائمة مفتوحة الآن أعد بناءها لتشمل الواصل حديثاً
        if (slashOpenNow() && input.value.startsWith('/')) openSlash(input.value.slice(1));
      }
    }).catch(() => { if (version === cliCmdsVersion) cliCmdsLoading = false; });
  }

  function allSlashCommands() {
    const grouped = new Map(SLASH_SECTIONS.map((section) => [section.id, []]));
    grouped.get('satr').push(...commands.map((command) => ({ ...command, section: 'satr' })));
    for (const command of cliCommands) {
      const section = skillSources.get(command.name) || 'claude';
      if (section === 'user' && hideUserSkills) continue;
      grouped.get(section).push(cliToItem(command, section));
    }
    return SLASH_SECTIONS.flatMap((section) => grouped.get(section.id));
  }

  // توسيع أوصاف أوامر CLI (قرار قبول 14.1): أكورديون — أمر واحد موسّع، وزرّ «توسيع
  // الكل» في ذيل القائمة. التوسيع لا يسرق Enter (الاختيار دائماً إدراج) ولا الأسهم ▲▼.
  let slashExpandedCmd = null, slashExpandAll = false;

  function toggleSlashExpand(c) {
    if (!c || !c.cli) return;
    slashExpandAll = false;
    slashExpandedCmd = slashExpandedCmd === c.cmd ? null : c.cmd;
    openSlash(input.value.startsWith('/') ? input.value.slice(1) : '');
  }

  function openSlash(filter) {
    ensureCliCommands();
    const f = (filter || '').toLowerCase();
    slashFiltered = allSlashCommands().filter((c) =>
      !f || c.cmd.includes(f) || c.en.toLowerCase().includes('/' + f) || c.en.toLowerCase().includes(f) || c.desc.includes(f)
    );
    if (!slashFiltered.length) return closeSlash();
    slashIndex = Math.min(slashIndex, slashFiltered.length - 1);
    slashMenu.replaceChildren();
    let hasCli = false;
    let renderedSection = null;
    slashFiltered.forEach((c, i) => {
      if (c.section !== renderedSection) {
        renderedSection = c.section;
        const section = SLASH_SECTIONS.find((item) => item.id === renderedSection);
        const separator = document.createElement('div');
        separator.className = 'slash-section';
        separator.dataset.section = renderedSection;
        separator.setAttribute('role', 'presentation');
        separator.textContent = section ? section.label : '';
        slashMenu.appendChild(separator);
      }
      const expanded = c.cli && (slashExpandAll || slashExpandedCmd === c.cmd);
      const el = document.createElement('div');
      el.className = 'slash-item' + (i === slashIndex ? ' active' : '') + (c.cli ? ' cli' : '') + (expanded ? ' expanded' : '');
      el.setAttribute('role', 'option');
      el.dataset.command = c.cmd;
      el.dataset.section = c.section;
      const row = document.createElement('div');
      row.className = 'slash-row';
      const command = document.createElement('span');
      command.className = 'cmd';
      const description = document.createElement('span');
      description.className = 'desc';
      row.appendChild(command);
      row.appendChild(description);
      row.querySelector('.cmd').textContent = c.cmd + (c.en ? ' · ' + c.en : '');
      row.querySelector('.desc').textContent = c.desc;
      el.appendChild(row);
      if (c.cli) {
        hasCli = true;
        const ex = document.createElement('span');
        ex.className = 'slash-expand';
        ex.textContent = '⌄';
        ex.title = 'الوصف الكامل';
        // mousedown على السهم يوسّع فقط — لا يُدرج الأمر
        ex.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); toggleSlashExpand(c); });
        row.appendChild(ex);
        if (expanded) {
          const fd = document.createElement('div');
          fd.className = 'slash-desc-full';
          fd.textContent = c.descFull || c.desc;
          el.appendChild(fd);
        }
      }
      el.addEventListener('mousedown', (e) => { e.preventDefault(); pickSlash(i); });
      slashMenu.appendChild(el);
    });
    // ذيل القائمة: توسيع/طيّ كل أوصاف أوامر CLI (الأوصاف دروس مصغّرة لمن يتعلم الأدوات)
    if (hasCli) {
      const foot = document.createElement('div');
      foot.className = 'slash-foot';
      const all = document.createElement('span');
      all.textContent = slashExpandAll ? 'طيّ الكل' : 'توسيع الكل';
      all.addEventListener('mousedown', (e) => {
        e.preventDefault(); e.stopPropagation();
        slashExpandAll = !slashExpandAll;
        slashExpandedCmd = null;
        openSlash(input.value.startsWith('/') ? input.value.slice(1) : '');
      });
      const hint = document.createElement('span');
      hint.className = 'foot-hint';
      hint.textContent = '⇄ يوسّع المحدد';
      foot.appendChild(all); foot.appendChild(hint);
      slashMenu.appendChild(foot);
    }
    slashMenu.classList.add('open');
    // مع القائمة الطويلة (أوامر CLI المتزامنة): أبقِ العنصر النشط ظاهراً أثناء التنقل
    const act = slashMenu.querySelector('.active');
    if (act) act.scrollIntoView({ block: 'nearest' });
  }
  function closeSlash() { slashMenu.classList.remove('open'); slashIndex = 0; slashExpandedCmd = null; slashExpandAll = false; }
  function pickSlash(i) {
    const c = slashFiltered[i];
    closeSlash();
    input.value = ''; autoResize(); clearDraft();
    if (c) c.run();
    input.focus();
  }
  function slashOpenNow() { return slashMenu.classList.contains('open'); }

  // ---------- منصّة @ لاختيار ملفات المشروع ----------
  const fileMenu = $('fileMenu');
  let fileList = [], fileListCwd = null, fileFiltered = [], fileIndex = 0, currentAt = null;

  // يكتشف رمز @ الملاصق للمؤشر: @ في بداية النص أو بعد مسافة، بلا فراغ حتى المؤشر
  function getAtToken() {
    const pos = input.selectionStart;
    const before = input.value.slice(0, pos);
    const m = before.match(/(?:^|\s)@([^\s@]*)$/);
    if (!m) return null;
    return { query: m[1], start: pos - m[1].length - 1, end: pos };
  }

  // قائمة الملفات تُجلب مرة لكل cwd وتُرشَّح محلياً (العملية الرئيسية تخزّنها مؤقتاً)
  async function ensureFileList() {
    const cwd = $('cwd').value.trim();
    if (fileListCwd === cwd && fileList.length) return;
    fileListCwd = cwd;
    fileList = (await window.satr.listFiles(cwd)) || [];
  }

  // ترتيب: تطابق بداية اسم الملف، ثم تضمّنه، ثم تضمّن المسار — فالأقصر فالأبجدي
  function filterFiles(query) {
    const q = query.toLowerCase();
    if (!q) return fileList.slice(0, 50);
    const scored = [];
    for (const f of fileList) {
      const lower = f.toLowerCase();
      const base = lower.slice(lower.lastIndexOf('/') + 1);
      let score;
      if (base.startsWith(q)) score = 0;
      else if (base.includes(q)) score = 1;
      else if (lower.includes(q)) score = 2;
      else continue;
      scored.push({ f, score });
    }
    scored.sort((a, b) => a.score - b.score || a.f.length - b.f.length || (a.f < b.f ? -1 : 1));
    return scored.slice(0, 50).map((s) => s.f);
  }

  function renderFileMenu() {
    fileMenu.replaceChildren();
    fileFiltered.forEach((f, i) => {
      const slash = f.lastIndexOf('/');
      const el = document.createElement('div');
      el.className = 'file-item' + (i === fileIndex ? ' active' : '');
      el.setAttribute('role', 'option');
      const filename = document.createElement('span');
      filename.className = 'fname';
      const filepath = document.createElement('span');
      filepath.className = 'fpath';
      el.appendChild(filename);
      el.appendChild(filepath);
      el.querySelector('.fname').textContent = slash < 0 ? f : f.slice(slash + 1);
      el.querySelector('.fpath').textContent = slash < 0 ? '' : f.slice(0, slash + 1);
      el.addEventListener('mousedown', (e) => { e.preventDefault(); pickFile(i); });
      fileMenu.appendChild(el);
    });
    fileMenu.classList.add('open');
  }

  async function openFiles(token) {
    currentAt = token;
    fileIndex = 0;
    await ensureFileList();
    const at = getAtToken(); // قد يكون النص تغيّر أثناء انتظار الجلب
    if (!at) { closeFiles(); return; }
    currentAt = at;
    fileFiltered = filterFiles(at.query);
    if (!fileFiltered.length) { closeFiles(); return; }
    renderFileMenu();
  }
  function closeFiles() { fileMenu.classList.remove('open'); fileIndex = 0; currentAt = null; }
  function fileOpenNow() { return fileMenu.classList.contains('open'); }

  function pickFile(i) {
    const f = fileFiltered[i];
    const at = currentAt;
    closeFiles();
    if (!f || !at) return;
    const insert = '@' + f + ' ';
    const before = input.value.slice(0, at.start);
    const after = input.value.slice(at.end);
    input.value = before + insert + after;
    const caret = before.length + insert.length;
    input.setSelectionRange(caret, caret);
    autoResize(); input.focus();
  }

  function autoResize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 220) + 'px';
  }

  // حفظ المسودة لكل مشروع: المسار جزء من المفتاح كي لا تدوس مشاريع المستخدم بعضها.
  const draftKey = (cwd) => 'satr_draft::' + String(cwd || '').trim();
  function saveDraft() {
    try {
      if (!activeDraftCwd) return;
      if (input.value) localStorage.setItem(draftKey(activeDraftCwd), input.value);
      else localStorage.removeItem(draftKey(activeDraftCwd));
    } catch (e) {}
  }
  function clearDraft() {
    try { if (activeDraftCwd) localStorage.removeItem(draftKey(activeDraftCwd)); } catch (e) {}
  }
  function loadDraft(cwd) {
    activeDraftCwd = String(cwd || '').trim();
    let value = '';
    try {
      if (activeDraftCwd) {
        const key = draftKey(activeDraftCwd);
        value = localStorage.getItem(key) || '';
        const legacy = localStorage.getItem('satr_draft');
        if (!value && legacy) { value = legacy; localStorage.setItem(key, legacy); }
        if (legacy) localStorage.removeItem('satr_draft');
      }
    } catch (e) {}
    input.value = value;
    autoResize();
  }
  function switchDraft(cwd) {
    const next = String(cwd || '').trim();
    if (next === activeDraftCwd) return;
    saveDraft();
    loadDraft(next);
  }
  // ترحيل المفتاح العام القديم مرة إلى المشروع الحالي، ثم استعادة مسودته.
  loadDraft(activeDraftCwd);
  $('cwd').addEventListener('change', () => switchDraft($('cwd').value));

  input.addEventListener('input', () => {
    clearPromptSuggestion();
    autoResize();
    saveDraft();
    const v = input.value;
    if (v.startsWith('/')) { closeFiles(); openSlash(v.slice(1)); return; }
    closeSlash();
    const at = getAtToken();
    if (at) openFiles(at);
    else closeFiles();
  });

  input.addEventListener('keydown', (e) => {
    if (fileOpenNow()) {
      if (e.key === 'ArrowDown') { e.preventDefault(); fileIndex = (fileIndex + 1) % fileFiltered.length; renderFileMenu(); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); fileIndex = (fileIndex - 1 + fileFiltered.length) % fileFiltered.length; renderFileMenu(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickFile(fileIndex); return; }
      if (e.key === 'Escape')    { e.preventDefault(); closeFiles(); return; }
    }
    if (slashOpenNow()) {
      if (e.key === 'ArrowDown') { e.preventDefault(); slashIndex = (slashIndex + 1) % slashFiltered.length; openSlash(input.value.slice(1)); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); slashIndex = (slashIndex - 1 + slashFiltered.length) % slashFiltered.length; openSlash(input.value.slice(1)); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickSlash(slashIndex); return; }
      if (e.key === 'Escape')    { e.preventDefault(); closeSlash(); return; }
      // ⇄ على عنصر CLI محدد: توسيع/طيّ وصفه الكامل (لا يسرق Enter ولا ▲▼)
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const c = slashFiltered[slashIndex];
        if (c && c.cli) { e.preventDefault(); toggleSlashExpand(c); return; }
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); emitSend(); }
  });

  $('send').addEventListener('click', emitSend);


    // ---------- الواجهة العامة للقشرة ----------
    this.setCommands = (list) => { commands = Array.isArray(list) ? list : []; };
    this.getImages = () => pendingImages.slice();
    this.addImageData = addImageData;
    this.clearImages = () => { pendingImages = []; renderAttachments(); };
    this.restoreTurn = (text, images) => {
      input.value = String(text || '');
      pendingImages = [];
      for (const image of (Array.isArray(images) ? images : [])) addImageData(image);
      autoResize(); saveDraft(); closeSlash(); closeFiles(); input.focus();
    };
    this.switchDraft = switchDraft;
    // OBS-035: إدراج نص جاهز في المحرّر **بلا إرسال**. لا يدوس ما كتبه المستخدم (يُلحق
    // في سطر جديد) ولا يمسّ الصور المرفقة — بخلاف restoreTurn التي تستبدل الدور كاملاً.
    this.insertPrompt = (text) => {
      const value = String(text || '');
      if (!value) return false;
      const current = input.value;
      input.value = current.trim() ? current.replace(/\s*$/, '') + '\n\n' + value : value;
      autoResize(); saveDraft(); closeSlash(); closeFiles(); input.focus();
      try { input.setSelectionRange(input.value.length, input.value.length); } catch (e) {}
      return true;
    };
    this.showPromptSuggestion = (suggestion) => {
      if (!promptSuggestion) return false;
      const text = typeof suggestion === 'string' ? suggestion.trim().slice(0, 500) : '';
      if (!text) { clearPromptSuggestion(); return false; }
      promptSuggestionText.textContent = text;
      promptSuggestion.hidden = false;
      return true;
    };
    this.clearPromptSuggestion = clearPromptSuggestion;
    // بعد الإرسال: تمدد المحرّر + مسح المسودة + إغلاق القائمتين (input.value تصفّره القشرة)
    this.afterSend = () => { autoResize(); clearDraft(); closeSlash(); closeFiles(); };
    this.setBgProcs = (procs) => { bgProcs = Array.isArray(procs) ? procs : []; renderBgBar(); };
    this.setTermJobs = (jobs) => { termJobs = Array.isArray(jobs) ? jobs : []; renderBgBar(); };
    this.upsertTermJob = (job) => {
      if (!job || !job.id) return;
      termJobs = termJobs.filter((item) => item.id !== job.id).concat(job);
      renderBgBar();
    };
    this.removeTermJob = (id) => { termJobs = termJobs.filter((job) => job.id !== id); renderBgBar(); };
    this.setHideUserSkills = (hide) => {
      hideUserSkills = Boolean(hide);
      if (slashOpenNow() && input.value.startsWith('/')) openSlash(input.value.slice(1));
    };
    // دفعة commands_changed منتصف الجلسة: تحل محل قائمة CLI المخزنة بالكامل
    this.commandsChanged = (list) => {
      if (!Array.isArray(list)) return;
      const cwd = $('cwd').value.trim();
      const sameCwd = cliCmdsCwd === cwd;
      const version = ++cliCmdsVersion;
      cliCmdsLoading = false;
      cliCommands = list
        .map((c) => ({
          name: String(c.name || ''),
          description: String(c.description || ''),
          argumentHint: String(c.argumentHint || ''),
          aliases: Array.isArray(c.aliases) ? c.aliases.map(String) : [],
        }))
        .filter((c) => c.name && !CLI_CMD_EXCLUDE.has(c.name));
      cliCmdsCwd = cwd;
      if (!sameCwd) skillSources = new Map();
      if (slashOpenNow() && input.value.startsWith('/')) openSlash(input.value.slice(1));
      requestSkillSources(cwd).then((skills) => {
        if (version !== cliCmdsVersion || cliCmdsCwd !== cwd) return;
        skillSources = sourcesFromSkills(skills);
        if (slashOpenNow() && input.value.startsWith('/')) openSlash(input.value.slice(1));
      });
    };
  }
}

customElements.define('satr-composer', SatrComposer);
