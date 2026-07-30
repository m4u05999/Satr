// <satr-topbar> — الشريط العلوي وإعدادات ⚙ (تفكيك ت-11): مدير مفاتيح المزوّدين والتكاملات (§5-ب)
// + زر اختيار مجلد المشروع + المجلدات الإضافية (14.4) + آلية المنبثق ⚙ + قسم
// «سطر Enterprise» (الدفعة 3). **بلا Shadow DOM** والترميز يبقى في index.html داخل
// الوسم — القشرة تربط #cwd وأزرار الشريط عند الإقلاع قبل ترقية المكوّنات (نمط ت-10).
// ما يبقى في القشرة عمداً: قائمة المحرك/النماذج (عناصر المؤلّف + تلمس sessionId)،
// زر 📤 (يقرأ حالة الجلسة)، حلقة حفظ الإعدادات العامة، وأزرار اللوحات (كلٌّ في منطقته).
// الواجهة العامة: getExtraDirs() — send() في القشرة تقرؤها لتمريرها للـ SDK.
class SatrTopbar extends HTMLElement {
  connectedCallback() {
    if (this._wired) return;
    this._wired = true;
    const $ = (id) => document.getElementById(id);
    const host = this;

// ما يلي منقول حرفياً من القشرة — بلا تغيير سلوك

  // مركز مفاتيح المزوّدين والتكاملات (§5-ب): إدخال مفاتيح API بصرياً. أمان: القيم لا تُقرأ للواجهة —
  // نعرض «مضبوط/غير مضبوط» فقط. الحفظ فوري (keys.js يُقرأ لحظة الطلب — بلا إعادة تشغيل).
  async function initKeysManager() {
    const provSel = $('keyProvider'), val = $('keyValue'), status = $('keyStatus');
    let keyed = [];
    try {
      const r = await window.satr.providers();
      keyed = [...((r && r.providers) || []), ...((r && r.integrations) || [])].filter((p) => p.keyName);
    } catch (e) {}
    if (!keyed.length) { $('keysMgr').style.display = 'none'; return; }
    provSel.innerHTML = '';
    for (const p of keyed) { const o = document.createElement('option'); o.value = p.keyName; o.textContent = p.label; provSel.appendChild(o); }
    let setNames = new Set();
    async function refresh() {
      try { const r = await window.satr.keysList(); setNames = new Set((r && r.names) || []); } catch (e) {}
      const on = setNames.has(provSel.value);
      status.textContent = on ? 'مضبوط ✓' : 'غير مضبوط';
      status.classList.toggle('set', on);
    }
    provSel.addEventListener('change', refresh);
    $('keySave').addEventListener('click', async () => {
      const v = val.value.trim(); if (!v) return;
      const r = await window.satr.keySet(provSel.value, v);
      if (r && r.ok) { val.value = ''; await refresh(); status.textContent = 'حُفظ ✓ — جرّب الإرسال'; status.classList.add('set'); }
      else { status.textContent = 'تعذّر الحفظ'; status.classList.remove('set'); }
    });
    $('keyClear').addEventListener('click', async () => { await window.satr.keyDelete(provSel.value); val.value = ''; await refresh(); });
    refresh();
  }
  initKeysManager();

  $('pickFolder').addEventListener('click', async () => {
    const p = await window.satr.pickFolder();
    if (p) {
      $('cwd').value = p;
      localStorage.setItem('satr_cwd', p);
      $('cwd').dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  // ---------- المجلدات الإضافية (المرحلة 14.4) ----------
  // تُمنح للنموذج وصولاً بجانب مجلد المشروع (additionalDirectories في SDK) —
  // تُدار من ⚙ وتُحفظ في localStorage، والتحقق النهائي (وجود المجلد) في main.js
  let extraDirs = [];
  try { extraDirs = JSON.parse(localStorage.getItem('satr_extra_dirs') || '[]'); } catch { extraDirs = []; }
  if (!Array.isArray(extraDirs)) extraDirs = [];

  function renderDirChips() {
    const box = $('dirChips');
    box.textContent = '';
    for (const d of extraDirs) {
      const chip = document.createElement('div');
      chip.className = 'dir-chip';
      const p = document.createElement('span'); p.className = 'path'; p.textContent = d; p.title = d;
      const rm = document.createElement('button'); rm.className = 'rm'; rm.type = 'button'; rm.textContent = '✕';
      rm.title = 'إزالة';
      rm.addEventListener('click', () => {
        extraDirs = extraDirs.filter((x) => x !== d);
        localStorage.setItem('satr_extra_dirs', JSON.stringify(extraDirs));
        renderDirChips();
      });
      chip.appendChild(p); chip.appendChild(rm);
      box.appendChild(chip);
    }
  }
  $('addDir').addEventListener('click', async () => {
    const p = await window.satr.pickFolder();
    if (p && !extraDirs.includes(p) && extraDirs.length < 10) {
      extraDirs.push(p);
      localStorage.setItem('satr_extra_dirs', JSON.stringify(extraDirs));
      renderDirChips();
    }
  });
  renderDirChips();

  // لوحة الإعدادات المنبثقة (⚙): تُفتح وتُغلق بالزر، وتُغلق بالنقر خارجها أو بـ Escape
  const settingsPop = $('settingsPop'), settingsBtn = $('settingsBtn');
  function setSettingsOpen(open) {
    settingsPop.hidden = !open;
    settingsBtn.classList.toggle('active', open);
  }
  settingsBtn.addEventListener('click', (e) => { e.stopPropagation(); closeTopPops(); setSettingsOpen(settingsPop.hidden); });
  settingsPop.addEventListener('click', (e) => e.stopPropagation());
  // زر ✕ في رأس اللوحة (دفعة الصقل): كان الإغلاق بالنقر خارجها أو Escape فقط
  $('settingsClose').addEventListener('click', () => { setSettingsOpen(false); settingsBtn.focus(); });
  document.addEventListener('click', () => { if (!settingsPop.hidden) setSettingsOpen(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !settingsPop.hidden) setSettingsOpen(false); });

  // منبثقا ملخص تغييرات الجلسة والاختصارات — أسطح خفيفة غير حاجبة في الشريط.
  const changesPop = $('sessionChangesPop'), changesBtn = $('sessionChangesToggle');
  const shortcutsPop = $('shortcutsPop'), shortcutsBtn = $('shortcutsToggle');
  let sessionChanges = [];
  function closeTopPops() { changesPop.hidden = true; shortcutsPop.hidden = true; }
  function toggleTopPop(target) {
    const willOpen = target.hidden;
    setSettingsOpen(false);
    closeTopPops();
    target.hidden = !willOpen;
  }
  changesBtn.addEventListener('click', (event) => { event.stopPropagation(); toggleTopPop(changesPop); });
  shortcutsBtn.addEventListener('click', (event) => { event.stopPropagation(); toggleTopPop(shortcutsPop); });
  changesPop.addEventListener('click', (event) => event.stopPropagation());
  shortcutsPop.addEventListener('click', (event) => event.stopPropagation());
  document.addEventListener('click', closeTopPops);
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeTopPops(); });

  function renderSessionChanges() {
    const list = $('sessionChangesList');
    const count = $('sessionChangesCount');
    list.replaceChildren();
    count.textContent = String(sessionChanges.length);
    count.hidden = sessionChanges.length === 0;
    changesBtn.classList.toggle('active', sessionChanges.length > 0);
    if (!sessionChanges.length) {
      const empty = document.createElement('div'); empty.className = 'session-changes-empty';
      empty.textContent = 'لا تغييرات مسجّلة في هذه الجلسة بعد.'; list.appendChild(empty); return;
    }
    for (const change of sessionChanges) {
      const row = document.createElement('button'); row.type = 'button'; row.className = 'session-change-row';
      const rel = document.createElement('span'); rel.className = 'session-change-path'; rel.dir = 'ltr'; rel.textContent = change.rel;
      const totals = document.createElement('span'); totals.className = 'session-change-counts'; totals.dir = 'ltr';
      totals.textContent = '+' + change.added + ' −' + change.removed;
      row.appendChild(rel); row.appendChild(totals);
      row.addEventListener('click', () => {
        closeTopPops();
        host.dispatchEvent(new CustomEvent('session-diff-open', { bubbles: true, detail: change.card }));
      });
      list.appendChild(row);
    }
  }
  renderSessionChanges();

  // ---------- سجل نشاط Community المحلي ----------
  const ACTIVITY_LABELS = {
    prompt: () => 'بدأ طلب جديد',
    tool: (entry) => 'استخدم الوكيل أداة ' + (entry.tool || 'غير معروفة'),
    file_edit: (entry) => 'عُدّل ' + (entry.rel || 'ملف') + ' (+' + (entry.added || 0) + '/-' + (entry.removed || 0) + ')',
    permission: (entry) => (entry.allow ? 'سُمح' : 'رُفض') + ' استخدام ' + (entry.tool || 'أداة'),
    result: (entry) => (entry.is_error ? 'اكتمل الطلب بخطأ' : 'اكتمل الطلب بنجاح')
      + (entry.duration_ms ? ' خلال ' + (entry.duration_ms / 1000).toFixed(1) + 'ث' : ''),
  };
  function renderActivity(result) {
    const box = $('activityList');
    box.textContent = '';
    const entries = result && Array.isArray(result.entries) ? result.entries : [];
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'activity-empty';
      empty.textContent = result && result.error === 'bad_cwd' ? 'اختر مجلد مشروع أولاً.' : 'لا يوجد نشاط مسجّل لهذا المشروع.';
      box.appendChild(empty);
      return;
    }
    for (const entry of entries) {
      const row = document.createElement('div'); row.className = 'activity-item';
      const time = document.createElement('span'); time.className = 'activity-time';
      time.textContent = new Date(entry.ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      const description = document.createElement('bdi'); description.className = 'activity-text'; description.dir = 'auto';
      const formatter = ACTIVITY_LABELS[entry.kind];
      description.textContent = (formatter ? formatter(entry) : 'نشاط') + ' · ' + (entry.engine || 'sdk');
      row.appendChild(time); row.appendChild(description); box.appendChild(row);
    }
  }
  async function refreshActivity() {
    const cwd = $('cwd').value.trim();
    if (!cwd || !window.satr.activityList) { renderActivity({ error: 'bad_cwd', entries: [] }); return; }
    try { renderActivity(await window.satr.activityList(cwd)); }
    catch { renderActivity({ entries: [] }); }
  }
  $('activityRefresh').addEventListener('click', refreshActivity);
  $('activityClear').addEventListener('click', async () => {
    const cwd = $('cwd').value.trim();
    if (!cwd || !window.satr.activityClear) return;
    if (!window.confirm('مسح سجل النشاط المحلي لهذا المشروع؟')) return;
    await window.satr.activityClear(cwd, true);
    await refreshActivity();
  });

  // ---------- قسم «سطر Enterprise» في ⚙ (الدفعة 3) ----------
  // يظهر لهوية بناء Enterprise حتى عند فشل الوحدة؛ الإحصاءات لا تُجلب إلا بترخيص نشط
  let eeLoaded = false;
  async function initEeSection() {
    try {
      const f = await window.satr.features();
      if (!f || f.edition !== 'enterprise') return; // بناء مجتمعي — القسم يبقى مخفياً
      $('eeSection').hidden = false;
      const lic = $('eeLicense');
      if (!f.enterprise || f.runtimeStatus !== 'ready') {
        lic.textContent = 'إصدار Enterprise — تعذّر تحميل الوحدة التجارية، والقدرات معطّلة';
        lic.style.color = 'var(--red)';
        return;
      }
      const inf = f.info || {};
      if (inf.licensed) {
        lic.textContent = '✓ مرخّص' + (inf.org ? ' — ' + inf.org : '') + (inf.exp ? ' (حتى ' + inf.exp + ')' : '');
        lic.style.color = 'var(--green)';
      } else {
        lic.textContent = 'غير مرخّص — القدرات معطّلة';
        lic.style.color = 'var(--text-dim)';
      }
      eeLoaded = !!inf.licensed;
    } catch (e) { /* البناء المجتمعي أو فشل معزول — لا شيء */ }
  }
  async function refreshEeStats() {
    if (!eeLoaded) return;
    try {
      const u = await window.satr.eeUsage();
      const parts = [];
      for (const [prov, s] of Object.entries((u && u.today) || {})) {
        parts.push(prov + ': ' + s.turns + ' دور، ' + (s.input_tokens + s.output_tokens) + ' رمز'
          + (s.cost_usd ? '، $' + s.cost_usd.toFixed(3) : ''));
      }
      $('eeUsageBox').textContent = 'استهلاك اليوم — ' + (parts.length ? parts.join(' · ') : 'لا شيء بعد');
    } catch (e) { $('eeUsageBox').textContent = ''; }
    try {
      const a = await window.satr.eeAudit();
      $('eeAuditBox').textContent = 'سجل التدقيق — ' + ((a && a.todayCount) || 0) + ' حدثاً اليوم، في: ' + ((a && a.path) || '');
    } catch (e) { $('eeAuditBox').textContent = ''; }
  }
  settingsBtn.addEventListener('click', () => {
    if (!settingsPop.hidden) { refreshActivity(); refreshEeStats(); }
  });
  initEeSection();

    // الواجهة العامة للقشرة
    this.getExtraDirs = () => extraDirs.slice();
    this.setSessionChanges = (changes) => {
      sessionChanges = Array.isArray(changes) ? changes.slice() : [];
      renderSessionChanges();
    };
  }
}

customElements.define('satr-topbar', SatrTopbar);
