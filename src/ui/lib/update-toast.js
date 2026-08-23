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
      if (notes) notes.hidden = true;
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

  if (notes) {
    // الرابط يُبنى في العملية الرئيسية من إعداد النشر — لا URL يعبر من هنا
    notes.addEventListener('click', () => {
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

  return { showTransientNotice, handleUpdateEvent };
}
