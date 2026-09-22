'use strict';
/* صفحة اختبار لوحة الجلسات الحيّة — تشغّل المكوّن الإنتاجي تحت CSP الفعلية.
   العطل المحروس (‏OBS-068): 22 مشروعاً متشابكة زمنياً في قائمة واحدة، وجلسات
   الأدوات مختلطة بجلسات المستخدم — ومنها ما جرى داخل مجلد مشروع حقيقي فلا يكشفه
   المسار، وهو ما يعالجه الوسم وقت الإنشاء (البند ب). */

window.__panelProgress = 'boot';
// الحالة لا تتسرّب بين التشغيلات: المكوّن يقرأ التفضيل عند بنائه
// (‏`sessions-panel.js:145`) — أي قبل أن تبلغ كتلةُ الاختبار سطرَ المسح — فتشغيلٌ سقط
// بعد إطفاء مرشّح الأدوات كان يُفشل التالي **زوراً** بفحص لا علاقة له بالتغيير.
// هنا يقع المسح قبل تحميل وحدة المكوّن (‏script كلاسيكي يسبق `type="module"`).
localStorage.removeItem('satr_sessions_show_tools');
localStorage.removeItem('satr_sessions_open_groups');
const violations = [];
document.addEventListener('securitypolicyviolation', (e) => {
  violations.push(String(e.violatedDirective || '') + ' ' + String(e.blockedURI || ''));
});

const CWD = 'D:\\proj\\alpha';
const HOUR = 3600000;
const now = Date.now();
const S = (id, cwd, title, hoursAgo, extra) => Object.assign(
  { id, project: cwd.replace(/[\\:]/g, '-'), cwd, title, mtime: now - hoursAgo * HOUR }, extra || {});

// أرشيف يتجاوز ميزانية الفرد عمداً — وإلا صار فحص الطيّ بلا معنى (المستخدم الحقيقي
// عنده 22 مشروعاً و143 جلسة). مشاريع حقيقية + مسارا أدوات + محادثة محوّل.
const many = (prefix, cwd, count, baseHours) => Array.from({ length: count }, (_, i) =>
  S(prefix + i, cwd, 'جلسة ' + prefix + ' رقم ' + i, baseHours + i));
const CLAUDE = [
  S('a1', CWD, 'أكمل واجهة الدفع', 1),
  S('a2', 'd:/PROJ/ALPHA/', 'أصلح اختبار البناء', 3),
  S('a3', CWD, 'راجع العقود', 30),
  S('b1', 'D:\\proj\\beta', 'ابدأ مشروع بيتا', 5),
  S('b2', 'D:\\proj\\beta', 'أضف صفحة الهبوط', 50),
  ...many('d', 'D:\\proj\\delta', 5, 20),
  ...many('e', 'D:\\proj\\epsilon', 5, 60),
  ...many('z', 'D:\\proj\\zeta', 5, 200),
  S('g1', 'D:\\proj\\gamma', 'تحليل بيانات', 300),
  S('t1', 'C:\\Users\\U\\.satr\\worktrees\\abc123\\wt-xyz-1', 'عامل تنفيذ معزول', 2),
  S('t2', 'C:\\Users\\U\\AppData\\Local\\Temp\\satr-review-QQ\\workspace', 'مراجع أعمى', 4),
  // ‏OBS-068 ب: جلسات أدوات جرت **داخل مجلد مشروع حقيقي** — لا يميّزها المسار إطلاقاً
  // (المخطط والعصف لا يستعملان worktree). `p1` موسومة فتُخفى، و`p2` توأمها بلا وسم
  // فتظهر — وهو الفرق الذي يثبت أن الإخفاء من الوسم لا من تخمين المجلد.
  S('p1', CWD, 'مخطط مهام غرفة العمليات', 6),
  S('p2', CWD, 'راجع خطة الإصدار', 7),
  S('p3', CWD, 'عصف ثلاثي مثبّت', 9),
  // ‏OBS-135: جلسة بلا `cwd` — `sessions.js` يلتقطه من رأس الملف (‏64ك.ب) فقط وقد
  // يغيب. يجب أن تنضمّ لمجموعة مشروعها عبر `project` المُرمَّز، لا أن تشقّ مجموعة
  // ثانية باسم المجلد فيبدو الطيّ معطوباً ونصفُ المشروع «مختفياً».
  { id: 'o1', project: CWD.replace(/[\\:]/g, '-'), cwd: '', title: 'جلسة بلا مجلد مسجَّل', mtime: now - 2 * HOUR },
];
const CHATS = [{ id: 'c1', provider: 'openai', title: 'صف الصورة', mtime: now - 8 * HOUR }];
const CODEX = [{ id: 'cx1', cwd: CWD, title: 'جلسة Codex للإجراءات', mtime: now - 10 * HOUR }];
const CONVERSATIONS = [
  { id: 'conv-main', cwd: CWD, engine: 'sdk', title: 'عنوان الكتالوج',
    mtime: now - HOUR / 2, sessionId: 'a1', bindings: { sdk: 'a1' },
    previousBindings: { sdk: ['b1'] }, archived: false },
  { id: 'conv-tool', cwd: CWD, engine: 'sdk', title: 'محادثة أداة موحدة',
    mtime: now - 6 * HOUR, sessionId: 'p1', bindings: { sdk: 'p1' }, archived: false },
  { id: 'conv-local', cwd: 'D:\\proj\\local-only', engine: 'sdk', title: 'سجل محلي بلا جلسة محرك',
    mtime: now - 11 * HOUR, sessionId: '', bindings: {}, archived: false },
];

const meta = { entries: {
  a1: { title: 'عنوان أصيل مخصّص', pinned: true },
  'conv-main': { title: 'عنوان محادثة مخصّص' },
  a3: { pinned: true },
  p1: { kind: 'tool' },
  // موسومة **ومثبّتة**: التثبيت قرار صريح من المستخدم فيغلب مرشّح الأدوات كما هو اليوم.
  p3: { kind: 'tool', pinned: true },
} };

window.satr = {
  listSessions: async () => CLAUDE.map((x) => ({ ...x })),
  listChats: async () => CHATS.map((x) => ({ ...x })),
  listCodexSessions: async () => CODEX.map((x) => ({ ...x })),
  listKimiSessions: async () => { throw new Error('kimi-list-test'); },
  listConversations: async () => ({ ok: true, conversations: CONVERSATIONS.map((x) => ({ ...x })),
    errors: ['unreadable_conversation'] }),
  sessionMetaList: async () => ({ entries: JSON.parse(JSON.stringify(meta.entries)) }),
  sessionMetaSet: async (id, patch) => {
    const next = Object.assign({}, meta.entries[id]);
    if (Object.prototype.hasOwnProperty.call(patch, 'pinned')) {
      if (patch.pinned === true) next.pinned = true;
      else if (patch.preservePinnedFalse === true) next.pinned = false;
      else delete next.pinned;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'title')) {
      if (patch.title) next.title = patch.title; else delete next.title;
    }
    if (Object.keys(next).length) meta.entries[id] = next; else delete meta.entries[id];
    return { ok: true, entry: meta.entries[id] || null };
  },
  forkCodexSession: async () => ({ ok: false }),
  archiveCodexSession: async () => ({ ok: false }),
  deleteCodexSession: async () => ({ ok: false }),
};

const PROVIDERS = [{ name: 'openai', label: 'OpenAI (Responses)' }];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function view(root) {
  const nodes = [...root.querySelectorAll('.grp, .sess')];
  return {
    groups: nodes.filter((n) => n.classList.contains('grp'))
      .map((n) => ({
        name: n.querySelector('.name').textContent,
        count: n.querySelector('.count').textContent,
        expanded: n.querySelector('.caret').textContent === '▾',
        current: n.classList.contains('current'),
      })),
    rows: nodes.filter((n) => n.classList.contains('sess')).length,
    order: nodes.map((n) => n.classList.contains('grp') ? 'G:' + n.querySelector('.name').textContent : 'r'),
    tally: root.querySelector('.tally').textContent,
  };
}

(async () => {
  const checks = [];
  const fail = (m) => { throw new Error(m); };
  try {
    await customElements.whenDefined('satr-sessions-panel');
    const el = document.getElementById('panel');
    const root = el.shadowRoot;
    localStorage.removeItem('satr_sessions_show_tools');

    window.__panelProgress = 'open';
    await el.open(PROVIDERS, CWD);
    await sleep(30);
    let v = view(root);

    // 1) التجميع وقع فعلاً — لا قائمة مسطّحة
    if (!v.groups.length) fail('لم تُرسم أي مجموعة');
    checks.push('grouped');

    // 1‑ب) ‏OBS-135: الجلسة بلا `cwd` تنضمّ لمجموعة مشروعها ولا تشقّ مجموعة ثانية
    //      باسم المجلد المُرمَّز. الفحص على **الانتماء** لا على مجرد الظهور: صفٌّ يظهر
    //      في المجموعة الخطأ كان سيمرّ لو اكتفينا بوجود العنوان في الصفحة.
    const encoded = CWD.replace(/[\\:]/g, '-');
    if (v.groups.some((g) => g.name === encoded)) {
      fail('المشروع انشقّ مجموعة ثانية باسم المجلد المُرمَّز: ' + encoded);
    }
    const groupTitles = (name) => {
      const nodes = [...root.querySelectorAll('.grp, .sess')];
      const start = nodes.findIndex((n) => n.classList.contains('grp')
        && n.querySelector('.name').textContent === name);
      if (start < 0) return null;
      const out = [];
      for (let i = start + 1; i < nodes.length && !nodes[i].classList.contains('grp'); i++) {
        out.push(nodes[i].querySelector('.t').textContent);
      }
      return out;
    };
    const alphaTitles = groupTitles(CWD);
    if (!alphaTitles) fail('مجموعة المشروع الحالي غائبة');
    if (!alphaTitles.includes('جلسة بلا مجلد مسجَّل')) {
      fail('الجلسة بلا cwd لم تنضمّ لمجموعة مشروعها: ' + JSON.stringify(alphaTitles));
    }
    checks.push('orphan-joins-project');

    // 2) جلسات الأدوات مخفية افتراضياً (‏t1 وt2 خارج العدّ)
    if (v.groups.some((g) => /worktrees|Temp/i.test(g.name))) fail('جلسات الأدوات ظاهرة رغم الإخفاء الافتراضي');
    // 2‑ب) الوسم (‏OBS-068 ب): جلسة أداة **داخل مجلد مشروع حقيقي** تُخفى، وتوأمها غير
    //      الموسوم يبقى ظاهراً، والموسومة المثبّتة تنجو. المسار وحده لا يميّز الثلاث.
    //      يسبق فحصَ العدّاد عمداً: انحرافُ رقمٍ لا يقول أيّ جلسة تسرّبت.
    const titles = () => [...root.querySelectorAll('.sess .t')].map((n) => n.textContent);
    if (titles().includes('مخطط مهام غرفة العمليات')) fail('الجلسة الموسومة أداةً ظهرت رغم الإخفاء');
    if (!titles().includes('راجع خطة الإصدار')) fail('جلسة مستخدم بلا وسم أُخفيت — تخمينٌ لا وسم');
    if (!titles().includes('عصف ثلاثي مثبّت')) fail('الموسومة المثبّتة أُخفيت — التثبيت قرار صريح');
    checks.push('tagged-tool-hidden-untagged-visible');

    if (v.tally !== '26 من 29') fail('العدّاد لا يعلن الإخفاء: ' + v.tally);
    checks.push('tools-hidden-by-default');

    // 3) المثبّتة أولاً، ثم المشروع الحالي
    if (v.order[0] !== 'G:📌 المثبّتة') fail('المثبّتة ليست أول مجموعة: ' + v.order[0]);
    const firstProject = v.groups.filter((g) => g.name !== '📌 المثبّتة')[0];
    if (firstProject.name !== CWD) fail('المشروع الحالي ليس أول المشاريع: ' + firstProject.name);
    if (!firstProject.current) fail('المشروع الحالي بلا وسم current');
    checks.push('pinned-and-current-first');

    // 4) المشروع الحالي مفرود، والأقدم مطويّ حين يتجاوز الأرشيف ميزانية الفرد.
    //    (‏لا «كل ما عدا الحالي مطوي»: أرشيف صغير يُفرد كله عمداً — القاعدة الصلبة
    //     كانت تُظهر لوحة رؤوس فارغة حين لا جلسات للمشروع الحالي.)
    if (!firstProject.expanded) fail('المشروع الحالي مطوي');
    if (!v.groups.some((g) => !g.expanded)) fail('لم تُطوَ أي مجموعة رغم تجاوز الميزانية');
    checks.push('current-expanded-others-collapsed');

    // 5) الطيّ يقلّل الصفوف فعلاً — لا تجميلاً
    const rowsBefore = v.rows;
    const head = [...root.querySelectorAll('.grp')].find((n) => n.querySelector('.name').textContent === CWD);
    head.click(); await sleep(20);
    if (view(root).rows >= rowsBefore) fail('الطيّ لم يُخفِ صفوفاً');
    head.click(); await sleep(20);
    if (view(root).rows !== rowsBefore) fail('الفرد لم يُعِد الصفوف');
    checks.push('collapse-toggles-rows');

    // 6) مرشّح الأدوات يكشفها عند إطفائه
    const box = root.querySelector('.hidetools');
    box.checked = false; box.dispatchEvent(new Event('change'));
    await sleep(20);
    v = view(root);
    if (!v.groups.some((g) => /worktrees/i.test(g.name))) fail('إطفاء المرشّح لم يُظهر جلسات الأدوات');
    if (v.tally !== '29 جلسة') fail('العدّاد لم يعد كاملاً: ' + v.tally);
    if (!titles().includes('محادثة أداة موحدة')) fail('إطفاء المرشّح لم يُظهر المحادثة الموسومة');
    box.checked = true; box.dispatchEvent(new Event('change'));
    await sleep(20);
    checks.push('tools-filter-toggles');

    // 7) البحث يصل جلسة في مجموعة مطوية — جوهر العطل المُبلَّغ
    const search = root.querySelector('.panel-search input');
    search.value = 'الهبوط'; search.dispatchEvent(new Event('input'));
    await sleep(20);
    v = view(root);
    if (v.rows !== 1) fail('البحث لم يُعِد نتيجة واحدة: ' + v.rows);
    if (!v.groups.every((g) => g.expanded)) fail('البحث لم يفرد المجموعات المطابقة');
    if (!v.groups.some((g) => g.name === 'D:\\proj\\beta')) fail('نتيجة البحث ليست في مجموعتها');
    checks.push('search-reaches-collapsed');

    search.value = ''; search.dispatchEvent(new Event('input'));
    await sleep(20);

    // 8) محادثة المحوّل تُجمَّع باسم المزوّد لا بمجلد
    if (!view(root).groups.some((g) => g.name === 'OpenAI (Responses)')) fail('محادثة المحوّل بلا مجموعة مزوّد');
    checks.push('chat-grouped-by-provider');

    // 9) توحيد مسار Windows والكتالوج: current/previous bindings بلا تكرار، مع وراثة metadata.
    const shown = titles();
    if ([...root.querySelectorAll('.grp')].some((head) => head.getAttribute('role') !== 'button'
      || !head.hasAttribute('aria-expanded'))) fail('رأس المجموعة بلا حالة وصولية');
    if (view(root).groups.filter((g) => g.name.toLowerCase() === CWD.toLowerCase()).length !== 1
      || view(root).groups.some((g) => g.name.includes('/'))) fail('توحيد case/slash لمسار Windows فشل');
    checks.push('windows-path-normalized');
    if (!shown.includes('عنوان محادثة مخصّص') || shown.includes('ابدأ مشروع بيتا')
      || shown.includes('محادثة أداة موحدة') || !shown.includes('سجل محلي بلا جلسة محرك')) {
      fail('دمج الكتالوج أو وراثة metadata/وسم الأداة فشل: ' + JSON.stringify(shown));
    }
    const status = root.querySelector('.meta-status').textContent;
    if (!status.includes('Kimi Code') || !status.includes('تعذّرت قراءة بعض المحادثات من الكتالوج')
      || status.includes('unreadable_conversation')) fail('أخطاء السرد لم تُعرّب أو لم تظهر');
    checks.push('catalog-dedup-meta-errors');

    // 10) الاستئناف يحمل سجل conversation، وحفظ بياناته الجانبية يستعمل conv-id.
    let resumed = null;
    el.addEventListener('session-resume', (e) => { resumed = e.detail; }, { once: true });
    const conversationRow = [...root.querySelectorAll('.sess')]
      .find((row) => row.querySelector('.t').textContent === 'عنوان محادثة مخصّص');
    conversationRow.click(); await sleep(20);
    if (!resumed || resumed.kind !== 'conversation' || resumed.id !== 'conv-main') fail('حمولة conversation خاطئة');
    if (!conversationRow.classList.contains('pinned')) fail('المحادثة لم ترث تثبيت الجلسة الأصلية');
    if (!conversationRow.querySelector('.m').textContent.startsWith('Claude Code')) fail('اسم محرك sdk لم يُعرّب');
    conversationRow.querySelector('.pin').click(); await sleep(20);
    if (meta.entries['conv-main'].pinned !== false) fail('pinned:false الصريح لم يتقدم على الموروث');
    if (meta.entries['conv-main'].preservePinnedFalse !== undefined) fail('العلم الانتقالي تسرّب إلى metadata');
    await el.open(PROVIDERS, CWD); await sleep(20);
    let refreshed = [...root.querySelectorAll('.sess')]
      .find((row) => row.querySelector('.t').textContent === 'عنوان محادثة مخصّص');
    if (!refreshed || refreshed.classList.contains('pinned')) fail('إعادة الفتح تجاهلت pinned:false المحفوظ');
    refreshed.querySelector('.pin').click(); await sleep(20);
    if (meta.entries['conv-main'].pinned !== true) fail('pinned:true لم يُحفظ بمعرف conv-id');
    refreshed = [...root.querySelectorAll('.sess')]
      .find((row) => row.querySelector('.t').textContent === 'عنوان محادثة مخصّص');
    window.prompt = () => '';
    refreshed.querySelector('.rename').click(); await sleep(20);
    const afterClear = [...root.querySelectorAll('.sess .t')].map((node) => node.textContent);
    if (!afterClear.includes('عنوان أصيل مخصّص') || afterClear.includes('عنوان محادثة مخصّص')) {
      fail('مسح عنوان المحادثة أعاد displayTitle القديم بدل inheritedTitle');
    }
    checks.push('conversation-resume-and-meta-id');
    checks.push('catalog-inherited-title-and-pin');
    checks.push('row-click-resumes');

    // 11) خمسة أزرار Codex لا تزاحم العنوان: اثنان أساسيان وثلاثة في صف ثانٍ مسمّى.
    const codexRow = [...root.querySelectorAll('.sess')]
      .find((row) => row.querySelector('.t').textContent === 'جلسة Codex للإجراءات');
    if (!codexRow || codexRow.querySelectorAll('.sess-actions button').length !== 2) fail('صف العنوان مزدحم');
    if (codexRow.querySelector('.sess-main').getBoundingClientRect().width
      < codexRow.getBoundingClientRect().width * 0.5) fail('العنوان فقد نصف عرض الصف');
    const secondary = [...codexRow.querySelectorAll('.sess-more button')];
    if (secondary.length !== 3 || secondary.some((button) => !button.getAttribute('aria-label'))) {
      fail('الإجراءات الثانوية أو أسماؤها الوصولية ناقصة');
    }
    secondary[0].click(); await sleep(10);
    if (!root.querySelector('.meta-status').textContent.includes('تفريع')) fail('خطأ التفريع ابتُلع');
    window.confirm = () => true;
    secondary[1].click(); await sleep(10);
    if (!root.querySelector('.meta-status').textContent.includes('أرشفة')) fail('خطأ الأرشفة ابتُلع');
    secondary[2].click(); await sleep(10);
    if (!root.querySelector('.meta-status').textContent.includes('حذف')) fail('خطأ الحذف ابتُلع');
    checks.push('secondary-actions-and-errors');

    // 12) طي آخر مجموعة يبقى صريحاً ولو صار Set فارغاً، ويُستعاد؛ JSON التالف يعود إلى auto.
    let active = el; let activeRoot = root;
    for (let attempts = 0; attempts < activeRoot.querySelectorAll('.grp').length + 1; attempts++) {
      const expanded = [...activeRoot.querySelectorAll('.grp')]
        .find((head) => head.querySelector('.caret').textContent === '▾');
      if (!expanded) break;
      expanded.click(); await sleep(5);
    }
    if (activeRoot.querySelectorAll('.sess').length) fail('طي آخر مجموعة عاد إلى auto');
    const saved = JSON.parse(localStorage.getItem('satr_sessions_open_groups'));
    if (!saved.customized || saved.open.length) fail('حالة طي الجميع لم تُحفظ صراحة');
    active.remove();
    active = document.createElement('satr-sessions-panel'); document.body.appendChild(active);
    await active.open(PROVIDERS, CWD); await sleep(20); activeRoot = active.shadowRoot;
    if (activeRoot.querySelectorAll('.sess').length) fail('حالة الطي لم تُستعد');
    active.remove(); localStorage.setItem('satr_sessions_open_groups', '{broken');
    active = document.createElement('satr-sessions-panel'); document.body.appendChild(active);
    await active.open(PROVIDERS, CWD); await sleep(20); activeRoot = active.shadowRoot;
    if (!activeRoot.querySelectorAll('.sess').length) fail('JSON التالف لم يعد إلى auto');
    checks.push('collapse-persists-and-corruption-recovers');

    // 13) غياب API الجديد لا يكسر المصادر الأصلية ولا يخفي سجلاً بلا binding.
    active.remove(); delete window.satr.listConversations;
    localStorage.removeItem('satr_sessions_open_groups');
    active = document.createElement('satr-sessions-panel'); document.body.appendChild(active);
    await active.open(PROVIDERS, CWD); await sleep(20); activeRoot = active.shadowRoot;
    const fallback = [...activeRoot.querySelectorAll('.sess .t')].map((node) => node.textContent);
    if (!fallback.includes('عنوان أصيل مخصّص') || !fallback.includes('ابدأ مشروع بيتا')) fail('fallback الأصلي انكسر');
    checks.push('native-fallback');

    window.__panelResult = { pass: true, checks, violations };
  } catch (error) {
    window.__panelResult = { pass: false, error: String(error && error.message || error), checks, violations };
  }
})();
