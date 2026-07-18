// إشعار التحديث التلقائي غير الحاجب (المرحلة 17) + الإشعارات العابرة المشتركة.

export function createUpdateToast(elements, satr) {
  const { toast, text, download, restart, dismiss } = elements;
  let transientToastTimer = 0;

  function showTransientNotice(message) {
    clearTimeout(transientToastTimer);
    text.textContent = message;
    download.hidden = true; restart.hidden = true; toast.hidden = false;
    transientToastTimer = setTimeout(() => { toast.hidden = true; }, 4500);
  }

  function handleUpdateEvent(event) {
    clearTimeout(transientToastTimer);
    if (event.phase === 'available') {
      text.textContent = 'تتوفّر نسخة جديدة' + (event.version ? ' (' + event.version + ')' : '') + '.';
      download.hidden = false; restart.hidden = true; toast.hidden = false;
    } else if (event.phase === 'progress') {
      text.textContent = 'تنزيل التحديث… ' + (event.percent || 0) + '٪';
      download.hidden = true; restart.hidden = true; toast.hidden = false;
    } else if (event.phase === 'ready') {
      text.textContent = 'التحديث' + (event.version ? ' (' + event.version + ')' : '') + ' جاهز للتثبيت.';
      download.hidden = true; restart.hidden = false; toast.hidden = false;
    } else if (event.phase === 'error') {
      toast.hidden = true;
    }
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
