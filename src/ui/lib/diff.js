// بناء بطاقة الفرق (Diff) — المرحلة 3، وحدة مشتركة منذ تفكيك ت-5.
// ثلاثة مستهلكين بعقد واحد: خيط المحادثة (file_edit) + حفظ العارض (بطاقة خارج الدور)
// + لوحة git ± (noUndo). بطاقة قابلة للطيّ: ترويسة عربية (وسم + عدّاد + تراجع)
// وجسم كود LTR ملوّن — أو مرآة RTL كاملة للملفات العربية (rtl-doc).
// `notify(text)` اختيارية: تُستدعى بنتيجة التراجع (القشرة تمرّر addNotice).
import { HL_CFG } from './highlight.js';

export function buildDiff(ev, notify) {
  const note = typeof notify === 'function' ? notify : () => {};
  const box = document.createElement('div');
  box.className = 'diff';
  // اتجاه جسم الفرق (الدفعة 4 — ملاحظة مالك من قبول 2.2): نفس قاعدة العارض —
  // امتداد كود معروف = LTR دائماً؛ غيره بإحصاء محارف الأسطر المعروضة (عربي غالب ⇐ مرآة RTL)
  const ext = ((ev.rel || '').split('.').pop() || '').toLowerCase();
  if (!HL_CFG[ext]) {
    let ar = 0, lat = 0;
    for (const ln of (ev.lines || [])) {
      const t = ln.text || '';
      ar += (t.match(/[؀-ۿ]/g) || []).length;
      lat += (t.match(/[A-Za-z]/g) || []).length;
    }
    if (ar > 0 && ar >= lat * 0.5) box.classList.add('rtl-doc');
  }

  const head = document.createElement('div'); head.className = 'diff-head';
  const toggle = document.createElement('button');
  toggle.className = 'diff-toggle'; toggle.textContent = '▾';
  toggle.title = 'طيّ/فتح الفرق';
  const file = document.createElement('span');
  file.className = 'diff-file'; file.dir = 'ltr'; file.textContent = ev.rel;
  const tag = document.createElement('span');
  tag.className = 'diff-tag';
  tag.textContent = ev.isDelete ? 'حُذف' : (ev.isNew ? 'ملف جديد' : (ev.tool === 'Write' || ev.tool === 'write_file' ? 'كتابة' : 'تعديل'));
  const counts = document.createElement('span');
  counts.className = 'diff-counts'; counts.dir = 'ltr';
  const a = document.createElement('span'); a.className = 'a'; a.textContent = '+' + ev.added;
  const d = document.createElement('span'); d.className = 'd'; d.textContent = '−' + ev.removed;
  counts.appendChild(a); counts.appendChild(d);
  const undo = document.createElement('button');
  undo.className = 'diff-undo'; undo.textContent = 'تراجع';
  undo.title = 'إعادة الملف لما قبل هذا التعديل';
  // بطاقات لوحة git (4.7) عرض فقط: لا لقطة «سطر» وراءها والتراجع عنها = checkout مدمّر
  if (ev.noUndo) undo.hidden = true;

  head.appendChild(toggle); head.appendChild(file);
  head.appendChild(tag); head.appendChild(counts); head.appendChild(undo);

  const body = document.createElement('div'); body.className = 'diff-body';
  for (const ln of (ev.lines || [])) {
    const row = document.createElement('div');
    if (ln.t === '@') {                          // علامة طيّ لأسطر مخفية
      row.className = 'dl gap'; row.textContent = '⋯';
      body.appendChild(row); continue;
    }
    const cls = ln.t === '+' ? 'add' : ln.t === '-' ? 'del' : '';
    row.className = 'dl' + (cls ? ' ' + cls : '');
    const lnEl = document.createElement('span'); lnEl.className = 'ln';
    lnEl.textContent = ln.t === '+' ? (ln.new || '') : (ln.old || '');
    const sg = document.createElement('span'); sg.className = 'sg';
    sg.textContent = ln.t === '+' ? '+' : ln.t === '-' ? '−' : ' ';
    const tx = document.createElement('span'); tx.className = 'tx';
    tx.textContent = ln.text || '';
    row.appendChild(lnEl); row.appendChild(sg); row.appendChild(tx);
    body.appendChild(row);
  }

  box.appendChild(head); box.appendChild(body);
  if (ev.truncated) {
    const note2 = document.createElement('div');
    note2.className = 'diff-note';
    note2.textContent = 'عُرض جزء من الفرق فقط (التغييرات أطول من أن تُعرض كاملة).';
    box.appendChild(note2);
  }

  // الطيّ/الفتح
  const flip = () => box.classList.toggle('collapsed');
  toggle.addEventListener('click', flip);
  head.addEventListener('click', (e) => {
    // النقر على الترويسة يطوي، عدا زر التراجع
    if (e.target === undo) return;
    if (e.target !== toggle) flip();
  });

  // التراجع — يعيد الملف فعلياً عبر العملية الرئيسية
  undo.addEventListener('click', async () => {
    undo.disabled = true;
    const prev = undo.textContent;
    undo.textContent = 'جارٍ…';
    const r = await window.satr.undoEdit(ev.id);
    if (r && r.ok) {
      box.classList.add('undone');
      undo.textContent = 'أُعيد ✓';
      note('✓ أُعيد الملف لما قبل التعديل: ' + ev.rel);
      // تحديث المعاينة بعد التراجع (طلب مالك): القشرة تلتقطه وتستدعي reloadIfLive.
      // حدّ: مشاريع ذات خطوة بناء تحتاج إعادة توليد أيضاً — reload وحده لا يكفيها.
      box.dispatchEvent(new CustomEvent('preview-refresh', { bubbles: true }));
    } else {
      undo.disabled = false;
      undo.textContent = prev;
      const why = r && r.error === 'expired'
        ? 'انتهت صلاحية اللقطة — لم يعد بالإمكان التراجع.'
        : (r && r.error ? ': ' + r.error : '');
      note('✗ تعذّر التراجع عن ' + ev.rel + (why ? ' — ' + why : ''));
    }
  });

  return box;
}
