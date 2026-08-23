import { createUpdateToast } from '../../src/ui/lib/update-toast.js';

const violations = [];
window.addEventListener('securitypolicyviolation', (event) => {
  violations.push({ directive: event.effectiveDirective, blockedURI: event.blockedURI });
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const toast = document.getElementById('updateToast');
    const text = document.getElementById('updateText');
    const download = document.getElementById('updateDownload');
    const restart = document.getElementById('updateRestart');
    const dismiss = document.getElementById('updateDismiss');
    const notes = document.getElementById('updateNotes');
    const background = document.getElementById('backgroundAction');
    const backgroundCount = document.getElementById('backgroundCount');
    const calls = { download: 0, restart: 0, notes: 0, notesVersion: null };
    const satr = {
      downloadUpdate() { calls.download++; },
      openReleaseNotes(version) { calls.notes++; calls.notesVersion = version; },
      restartUpdate() { calls.restart++; },
    };
    const { showTransientNotice, handleUpdateEvent } = createUpdateToast({
      toast, text, download, restart, dismiss, notes,
    }, satr);
    const checks = [];

    background.addEventListener('click', () => {
      backgroundCount.textContent = String(Number(backgroundCount.textContent) + 1);
    });

    showTransientNotice('إشعار عابر للاختبار');
    assert(!toast.hidden && download.hidden && restart.hidden,
      'الإشعار العابر يجب أن يستخدم التوست نفسه ويخفي زري التحديث.');
    checks.push('shared-transient-toast');

    handleUpdateEvent({ type: 'update', phase: 'available', version: '3.2.1' });
    assert(!toast.hidden && text.textContent.includes('تتوفّر نسخة جديدة') && text.textContent.includes('3.2.1'),
      'available لم يعرض النص العربي ورقم النسخة.');
    assert(!download.hidden && restart.hidden && download.textContent === 'نزّل الآن',
      'available لم يعرض زر التنزيل وحده.');
    const backgroundRect = background.getBoundingClientRect();
    const hit = document.elementFromPoint(
      backgroundRect.left + backgroundRect.width / 2,
      backgroundRect.top + backgroundRect.height / 2,
    );
    assert(hit === background || background.contains(hit), 'التوست حجب عنصراً آخر في الصفحة.');
    hit.click();
    assert(backgroundCount.textContent === '1', 'العنصر المستقل لم يبق قابلاً للنقر مع ظهور التوست.');
    assert(!notes.hidden && notes.textContent === 'ما الجديد؟',
      'زر «ما الجديد؟» لم يظهر مع إشعار توفّر التحديث.');
    checks.push('notes-visible-available');
    checks.push('available-nonblocking');

    download.click();
    assert(calls.download === 1, 'زر التنزيل لم يستدع downloadUpdate مرة واحدة.');
    assert(download.hidden && text.textContent === 'جارٍ بدء التنزيل…',
      'زر التنزيل لم ينتقل إلى حالة بدء التنزيل.');
    assert(!notes.hidden, 'زر «ما الجديد؟» يجب أن يبقى ظاهراً أثناء التنزيل — القراءة مفيدة أثناء الانتظار.');
    checks.push('download-consent');

    handleUpdateEvent({ type: 'update', phase: 'progress', percent: 67 });
    assert(!toast.hidden && text.textContent.includes('67٪') && download.hidden && restart.hidden,
      'progress لم يعرض النسبة وحدها مع إخفاء الزرين.');
    checks.push('progress');

    handleUpdateEvent({ type: 'update', phase: 'ready', version: '3.2.1' });
    assert(!toast.hidden && text.textContent.includes('جاهز للتثبيت') && text.textContent.includes('3.2.1'),
      'ready لم يعرض النص العربي ورقم النسخة.');
    assert(download.hidden && !restart.hidden && restart.textContent === 'أعد التشغيل الآن',
      'ready لم يعرض زر إعادة التشغيل وحده.');
    assert(!notes.hidden, 'زر «ما الجديد؟» يجب أن يبقى ظاهراً عند جاهزية التحديث.');
    notes.click();
    assert(calls.notes === 1, 'زر «ما الجديد؟» لم يستدع openReleaseNotes مرة واحدة.');
    assert(calls.notesVersion === '3.2.1',
      'openReleaseNotes لم يتلقّ إصدار التحديث المعلن: ' + calls.notesVersion);
    checks.push('notes-opens-release');
    restart.click();
    assert(calls.restart === 1, 'زر إعادة التشغيل لم يستدع restartUpdate مرة واحدة.');
    checks.push('ready-restart');

    const readyText = text.textContent;
    handleUpdateEvent({ type: 'update', phase: 'error', message: 'RAW_UPDATE_FAILURE' });
    assert(toast.hidden, 'error يجب أن يخفي التوست صامتاً.');
    assert(text.textContent === readyText && !text.textContent.includes('RAW_UPDATE_FAILURE'),
      'error سرّب نص الخطأ الخام إلى التوست.');
    checks.push('silent-error');

    // ردّا الفحص اليدوي (جولة الصقل 2026-08-08): none = أحدث نسخة، check_failed = تعذّر
    handleUpdateEvent({ type: 'update', phase: 'none' });
    assert(!toast.hidden && text.textContent.includes('أحدث نسخة') && download.hidden && restart.hidden,
      'none لم يعرض إشعار «أنت على أحدث نسخة» العابر بلا أزرار.');
    handleUpdateEvent({ type: 'update', phase: 'check_failed' });
    assert(!toast.hidden && text.textContent.includes('تعذّر الفحص') && download.hidden && restart.hidden,
      'check_failed لم يعرض إشعار تعذّر الفحص العابر.');
    checks.push('manual-check-feedback');

    handleUpdateEvent({ type: 'update', phase: 'available', version: '3.2.2' });
    dismiss.click();
    assert(toast.hidden, 'زر الإخفاء لم يخف التوست.');
    checks.push('dismiss');

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert(violations.length === 0, 'رُصد securitypolicyviolation.');
    checks.push('zero-csp-violations');
    window.__updateUiResult = { pass: true, checks, calls, violations };
  } catch (error) {
    window.__updateUiResult = {
      pass: false,
      error: error && error.stack ? error.stack : String(error),
      violations,
    };
  }
});
