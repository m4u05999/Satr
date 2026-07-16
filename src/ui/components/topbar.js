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
    if (p) { $('cwd').value = p; localStorage.setItem('satr_cwd', p); }
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
  settingsBtn.addEventListener('click', (e) => { e.stopPropagation(); setSettingsOpen(settingsPop.hidden); });
  settingsPop.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => { if (!settingsPop.hidden) setSettingsOpen(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !settingsPop.hidden) setSettingsOpen(false); });

  // ---------- قسم «سطر Enterprise» في ⚙ (الدفعة 3) ----------
  // يظهر فقط إن حُمِّلت الطبقة (satr:features)؛ الترخيص والاستهلاك والتدقيق تُحدَّث عند فتح ⚙
  let eeLoaded = false;
  async function initEeSection() {
    try {
      const f = await window.satr.features();
      if (!f || !f.enterprise) return; // بناء مجتمعي — القسم يبقى مخفياً
      $('eeSection').hidden = false;
      const inf = f.info || {};
      const lic = $('eeLicense');
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
  settingsBtn.addEventListener('click', () => { if (!settingsPop.hidden) refreshEeStats(); });
  initEeSection();

    // الواجهة العامة للقشرة
    this.getExtraDirs = () => extraDirs.slice();
  }
}

customElements.define('satr-topbar', SatrTopbar);
