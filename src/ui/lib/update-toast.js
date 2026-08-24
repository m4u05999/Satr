// إشعار التحديث التلقائي غير الحاجب (المرحلة 17) + الإشعارات العابرة المشتركة.

export function createUpdateToast(elements, satr) {
  const { toast, text, download, restart, dismiss } = elements;
  // زر «ما الجديد؟» اختياري كي لا تنكسر أي واجهة قديمة لا تحمله
  const notes = elements.notes || null;
  let transientToastTimer = 0;
  let pendingVersion = ''; // إصدار آخر تحديث معلن — يُبنى منه رابط ملاحظات الإصدار

  function showTransientNotice(message) {
    clearTimeout(transientToastTimer);
    text.textContent = message;
    download.hidden = true; restart.hidden = true; toast.hidden = false;
    if (notes) notes.hidden = true;
    transientToastTimer = setTimeout(() => { toast.hidden = true; }, 4500);
  }

  function handleUpdateEvent(event) {
    clearTimeout(transientToastTimer);
    if (event.phase === 'available') {
      pendingVersion = event.version || '';
      text.textContent = 'تتوفّر نسخة جديدة' + (event.version ? ' (' + event.version + ')' : '') + '.';
      download.hidden = false; restart.hidden = true; toast.hidden = false;
      // المستخدم لا يُطلب منه تحديث أعمى: يرى ما الجديد قبل أن يقرّر (طلب مالك 2026-08-23)
      if (notes) notes.hidden = false;
    } else if (event.phase === 'progress') {
      text.textContent = 'تنزيل التحديث… ' + (event.percent || 0) + '٪';
      download.hidden = true; restart.hidden = true; toast.hidden = false;
      // «ما الجديد؟» يبقى ظاهراً طوال دورة التحديث: من ينتظر التنزيل قد يريد قراءة
      // الملاحظات، وإخفاؤه هنا كان يعني أن نافذة القراءة تنغلق لحظة اتخاذ القرار.
    } else if (event.phase === 'ready') {
      pendingVersion = event.version || pendingVersion;
      text.textContent = 'التحديث' + (event.version ? ' (' + event.version + ')' : '') + ' جاهز للتثبيت.';
      download.hidden = true; restart.hidden = false; toast.hidden = false;
      if (notes) notes.hidden = false;
    } else if (event.phase === 'none') {
      // ردّ الفحص اليدوي فقط (updater.js لا يبثّه للفحوص التلقائية الصامتة)
      showTransientNotice('أنت على أحدث نسخة من سطر.');
    } else if (event.phase === 'check_failed') {
      showTransientNotice('تعذّر الفحص عن تحديثات — تحقق من اتصال الشبكة.');
    } else if (event.phase === 'error') {
      toast.hidden = true;
      if (notes) notes.hidden = true;
    }
  }

  // حوار «ما الجديد» داخل «سطر». فتح متصفح خارجي كان يخالف قاعدة المشروع المعلنة
  // («افتح الويب داخل معاينة سطر») ويصطدم بتحقق GitHub‏ 2FA لمن هو مسجّل دخول — رغم
  // أن المستودع عام وملاحظاته تُقرأ بلا حساب. الجلب في العملية الرئيسية، والعرض هنا
  // بـtextContent لأن المحتوى خارجي غير موثوق. والمتصفح يبقى خياراً ثانوياً صريحاً.
  const dialog = elements.notesDialog || null;
  const dialogBody = elements.notesBody || null;
  const dialogTitle = elements.notesTitle || null;
  const dialogClose = elements.notesClose || null;
  const dialogExternal = elements.notesExternal || null;

  function closeNotes() {
    if (dialog) dialog.hidden = true;
    document.removeEventListener('keydown', onNotesKey, true);
  }
  function onNotesKey(event) {
    if (event.key === 'Escape') { event.stopPropagation(); closeNotes(); }
  }
  async function openNotes() {
    if (!dialog || !dialogBody) { // تدهور رشيق: بلا حوار نعود للمتصفح
      try { satr.openReleaseNotes(pendingVersion); } catch (e) {}
      return;
    }
    dialogBody.textContent = 'جارٍ الجلب…';
    if (dialogTitle) dialogTitle.textContent = 'ما الجديد' + (pendingVersion ? ' — ' + pendingVersion : '');
    dialog.hidden = false;
    document.addEventListener('keydown', onNotesKey, true);
    try {
      const r = satr.releaseNotes ? await satr.releaseNotes(pendingVersion) : null;
      if (r && r.ok && String(r.notes || '').trim()) {
        dialogBody.textContent = r.notes + (r.truncated ? '\n\n… (قُصّت البقية — افتحها في المتصفح)' : '');
        if (dialogTitle && r.version) dialogTitle.textContent = 'ما الجديد — ' + r.version;
      } else {
        dialogBody.textContent = 'تعذّر جلب ملاحظات هذا الإصدار. جرّب «افتح في المتصفح».';
      }
    } catch (e) {
      dialogBody.textContent = 'تعذّر جلب ملاحظات هذا الإصدار. جرّب «افتح في المتصفح».';
    }
  }

  if (notes) notes.addEventListener('click', openNotes);
  if (dialogClose) dialogClose.addEventListener('click', closeNotes);
  if (dialog) dialog.addEventListener('click', (event) => { if (event.target === dialog) closeNotes(); });
  if (dialogExternal) {
    dialogExternal.addEventListener('click', () => {
      try { satr.openReleaseNotes(pendingVersion); } catch (e) {}
    });
  }

  download.addEventListener('click', () => {
    text.textContent = 'جارٍ بدء التنزيل…';
    download.hidden = true;
    satr.downloadUpdate();
  });
  restart.addEventListener('click', () => satr.restartUpdate());
  dismiss.addEventListener('click', () => {
    clearTimeout(transientToastTimer);
    toast.hidden = true;
  });

  // يُفتح أيضاً من ⚙ بلا انتظار تحديث — لا يستطيع من هو على الأحدث رؤية بطاقة تحديث
  // أصلاً، فكان «ما الجديد» غير قابل للفتح ولا للاختبار حتى يصدر إصدار تالٍ.
  function openNotesFor(version) { pendingVersion = version || pendingVersion; return openNotes(); }

  return { showTransientNotice, handleUpdateEvent, openNotesFor };
}
