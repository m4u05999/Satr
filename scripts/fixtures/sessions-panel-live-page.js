'use strict';
/* صفحة اختبار لوحة الجلسات الحيّة — تشغّل المكوّن الإنتاجي تحت CSP الفعلية.
   العطل المحروس (‏OBS-068): 22 مشروعاً متشابكة زمنياً في قائمة واحدة، وجلسات
   الأدوات مختلطة بجلسات المستخدم. */

window.__panelProgress = 'boot';
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
  S('a2', CWD, 'أصلح اختبار البناء', 3),
  S('a3', CWD, 'راجع العقود', 30),
  S('b1', 'D:\\proj\\beta', 'ابدأ مشروع بيتا', 5),
  S('b2', 'D:\\proj\\beta', 'أضف صفحة الهبوط', 50),
  ...many('d', 'D:\\proj\\delta', 5, 20),
  ...many('e', 'D:\\proj\\epsilon', 5, 60),
  ...many('z', 'D:\\proj\\zeta', 5, 200),
  S('g1', 'D:\\proj\\gamma', 'تحليل بيانات', 300),
  S('t1', 'C:\\Users\\U\\.satr\\worktrees\\abc123\\wt-xyz-1', 'عامل تنفيذ معزول', 2),
  S('t2', 'C:\\Users\\U\\AppData\\Local\\Temp\\satr-review-QQ\\workspace', 'مراجع أعمى', 4),
];
const CHATS = [{ id: 'c1', provider: 'openai', title: 'صف الصورة', mtime: now - 8 * HOUR }];

const meta = { entries: { a3: { pinned: true } } };

window.satr = {
  listSessions: async () => CLAUDE.map((x) => ({ ...x })),
  listChats: async () => CHATS.map((x) => ({ ...x })),
  listCodexSessions: async () => [],
  listKimiSessions: async () => [],
  sessionMetaList: async () => ({ entries: JSON.parse(JSON.stringify(meta.entries)) }),
  sessionMetaSet: async (id, patch) => {
    meta.entries[id] = Object.assign({}, meta.entries[id], patch);
    return { ok: true, entry: meta.entries[id] };
  },
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

    // 2) جلسات الأدوات مخفية افتراضياً (‏t1 وt2 خارج العدّ)
    if (v.groups.some((g) => /worktrees|Temp/i.test(g.name))) fail('جلسات الأدوات ظاهرة رغم الإخفاء الافتراضي');
    if (v.tally !== '22 من 24') fail('العدّاد لا يعلن الإخفاء: ' + v.tally);
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
    if (v.tally !== '24 جلسة') fail('العدّاد لم يعد كاملاً: ' + v.tally);
    box.checked = true; box.dispatchEvent(new Event('change'));
    await sleep(20);
    checks.push('tools-filter-toggles');

    // 7) البحث يصل جلسة في مجموعة مطوية — جوهر العطل المُبلَّغ
    const search = root.querySelector('.panel-search input');
    search.value = 'بيتا'; search.dispatchEvent(new Event('input'));
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

    // 9) النقر يُصدر session-resume بحمولة الجلسة
    let resumed = null;
    el.addEventListener('session-resume', (e) => { resumed = e.detail; }, { once: true });
    root.querySelector('.sess').click();
    await sleep(20);
    if (!resumed || !resumed.id) fail('النقر لم يُصدر session-resume');
    checks.push('row-click-resumes');

    window.__panelResult = { pass: true, checks, violations };
  } catch (error) {
    window.__panelResult = { pass: false, error: String(error && error.message || error), checks, violations };
  }
})();
